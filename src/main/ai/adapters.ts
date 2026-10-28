/**
 * 供应商适配器：把「统一的聊天请求」翻译成各家的 HTTP 请求，并把各家的流式帧
 * 还原成统一的增量文本 / 用量。
 *
 * 真实差异（详见 docs/ai-providers.md，逐条经过实测/官方文档核对）：
 * | 维度 | OpenAI 兼容 | Anthropic Messages | Gemini generateContent | Ollama |
 * | 鉴权头 | `Authorization: Bearer <key>` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` | `x-goog-api-key: <key>` | 无（反代可加 Bearer） |
 * | 路径 | `/v1/chat/completions`（base 自带版本段就不重复拼） | `/v1/messages` | `/v1beta/models/<model>:streamGenerateContent?alt=sse` | `/api/chat` |
 * | system 消息 | messages 里 role=system | 顶层 `system` 字段（不能进 messages） | 顶层 `systemInstruction.parts[]` | messages 里 role=system |
 * | max tokens | `max_tokens` | `max_tokens`（必填） | `generationConfig.maxOutputTokens` | `options.num_predict` |
 * | 流格式 | SSE，帧内含 `data: {...}`，末帧 `data: [DONE]` | SSE，帧带 `event:` 名（message_start / content_block_delta / message_delta / message_stop / error） | SSE（必须 `alt=sse`，否则是 JSON 数组分块） | NDJSON，一行一个 JSON |
 * | 增量位置 | `choices[0].delta.content` | `delta.text`（仅 `text_delta`） | `candidates[0].content.parts[*].text` | `message.content` |
 * | 用量 | `usage.{prompt,completion}_tokens`（需 `stream_options.include_usage` 或末帧） | `message_start.message.usage.input_tokens` / `message_delta.usage.output_tokens` | `usageMetadata.{promptTokenCount,candidatesTokenCount}` | `prompt_eval_count` / `eval_count`（末帧） |
 * | 停止标记 | `[DONE]` | `message_stop` | 流自然结束 | `done: true` |
 */
import type { AiMessage, AiProvider, AiUsage } from '@shared/models/ai'
import { parseJsonPayload, isDoneSentinel, SseDecoder, NdjsonDecoder, type StreamChunk, type StreamDecoder } from './stream'

export type StreamFormat = 'sse-openai' | 'sse-anthropic' | 'sse-gemini' | 'ndjson-ollama'

export interface BuiltRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body: string | null
  format: StreamFormat
}

export interface AdapterInput {
  provider: AiProvider
  apiKey: string | null
  /** 自定义额外 header（OpenRouter 的来源标识、自建网关的租户头等）；不需要时省略 */
  extraHeaders?: Record<string, string>
  /** 已由主进程组装好的消息（含 system 提示与终端上下文） */
  messages: AiMessage[]
}

export interface InterpretedChunk {
  /** 本次增量文本 */
  delta?: string
  /** 本次新增的用量（逐字段合并） */
  usage?: Partial<AiUsage>
  /** 供应商显式结束 */
  done?: boolean
  /** 供应商在流中回传的错误（原文，未脱敏） */
  error?: string
}

const ANTHROPIC_VERSION = '2023-06-01'
const GEMINI_HOST = 'generativelanguage.googleapis.com'

/* ------------------------------ URL 归一化 ------------------------------ */

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return trimmed
  return trimmed.replace(/\/+$/, '')
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** base 是否已带版本段（`/v1`、`/v1beta`、`/v4`…） */
function hasVersionSegment(path: string): boolean {
  return /\/v\d+(?:[a-z0-9]+)?(?:\/|$)/i.test(path)
}

/** 拼接 OpenAI 风格路径；base 已带版本段时不再插 `/v1` */
export function openAiUrl(baseUrl: string, suffix: '/chat/completions' | '/models'): string {
  const base = normalizeBaseUrl(baseUrl)
  const path = safePath(base)
  // /v1beta/openai、/compatible-mode/v1、/api/v1 都算「已带版本段」
  if (hasVersionSegment(path) || /\/openai$/i.test(path)) return `${base}${suffix}`
  return `${base}/v1${suffix}`
}

/** Anthropic：`/v1/messages`；base 已带 `/v1` 就只补 `/messages` */
export function anthropicUrl(baseUrl: string, suffix: '/messages' | '/models'): string {
  const base = normalizeBaseUrl(baseUrl)
  const path = safePath(base)
  if (hasVersionSegment(path)) return `${base}${suffix}`
  return `${base}/v1${suffix}`
}

/** Gemini：`/v1beta/models/<model>:<action>` */
export function geminiUrl(baseUrl: string, model: string, action: 'streamGenerateContent' | 'generateContent'): string {
  const base = normalizeBaseUrl(baseUrl)
  const path = safePath(base)
  const root = hasVersionSegment(path) ? base : `${base}/v1beta`
  const query = action === 'streamGenerateContent' ? '?alt=sse' : ''
  return `${root}/models/${encodeURIComponent(model)}:${action}${query}`
}

/** Ollama：`/api/chat` 与 `/api/tags`（base 带 `/v1` 时说明用的是 OpenAI 兼容端点） */
export function ollamaUrl(baseUrl: string, suffix: '/api/chat' | '/api/tags'): string {
  return `${normalizeBaseUrl(baseUrl)}${suffix}`
}

/* ------------------------------ 格式判定 ------------------------------ */

export function resolveStreamFormat(provider: Pick<AiProvider, 'kind' | 'baseUrl'>): StreamFormat {
  const host = safeHost(provider.baseUrl)
  const path = safePath(provider.baseUrl)
  switch (provider.kind) {
    case 'anthropic':
      return 'sse-anthropic'
    case 'ollama':
      // 显式用 Ollama 的 OpenAI 兼容端点（base 以 /v1 结尾）时走 OpenAI 格式
      return hasVersionSegment(path) ? 'sse-openai' : 'ndjson-ollama'
    case 'openai-compatible':
      // Gemini 的 OpenAI 兼容端点带 /openai 后缀，仍按 OpenAI 处理
      if (host === GEMINI_HOST && !/\/openai$/i.test(path)) return 'sse-gemini'
      return 'sse-openai'
    case 'openai':
    default:
      return 'sse-openai'
  }
}

export function createDecoder(format: StreamFormat): StreamDecoder {
  switch (format) {
    case 'ndjson-ollama':
      return new NdjsonDecoder()
    case 'sse-openai':
    case 'sse-anthropic':
    case 'sse-gemini':
    default:
      return new SseDecoder()
  }
}

/** 只有明确支持 `stream_options.include_usage` 的供应商才带，否则会被 400 拒 */
function supportsStreamOptions(provider: Pick<AiProvider, 'kind' | 'baseUrl'>): boolean {
  if (provider.kind !== 'openai') return /openrouter\.ai$/i.test(safeHost(provider.baseUrl))
  return true
}

/* ------------------------------ 请求构造 ------------------------------ */

export function buildChatRequest(input: AdapterInput): BuiltRequest {
  const { provider, apiKey, extraHeaders } = input
  const format = resolveStreamFormat(provider)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: format === 'ndjson-ollama' ? 'application/x-ndjson' : 'text/event-stream',
    ...extraHeaders
  }
  if (apiKey) {
    switch (provider.kind) {
      case 'anthropic':
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = ANTHROPIC_VERSION
        break
      case 'ollama':
        // 本地 Ollama 不需要 key；若配了则视为反代鉴权
        headers.authorization = `Bearer ${apiKey}`
        break
      default:
        // Gemini 原生 API 认 `x-goog-api-key`，不接受 OpenAI 风格的 Bearer；
        // 用错头会得到 401 API_KEY_INVALID——最难排查的一类「key 明明是对的」。
        if (format === 'sse-gemini') headers['x-goog-api-key'] = apiKey
        else headers.authorization = `Bearer ${apiKey}`
        break
    }
  }
  if (provider.kind === 'anthropic') {
    // Anthropic 要求浏览器直连场景显式声明，主进程不需要，但不影响
    headers['anthropic-dangerous-direct-browser-access'] ??= 'false'
  }

  const body = buildBody(input, format)
  return {
    url: chatUrl(provider),
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    format
  }
}

function chatUrl(provider: AiProvider): string {
  switch (provider.kind) {
    case 'anthropic':
      return anthropicUrl(provider.baseUrl, '/messages')
    case 'ollama':
      return hasVersionSegment(safePath(provider.baseUrl))
        ? openAiUrl(provider.baseUrl, '/chat/completions')
        : ollamaUrl(provider.baseUrl, '/api/chat')
    case 'openai-compatible':
      if (resolveStreamFormat(provider) === 'sse-gemini') return geminiUrl(provider.baseUrl, provider.model, 'streamGenerateContent')
      return openAiUrl(provider.baseUrl, '/chat/completions')
    case 'openai':
    default:
      return openAiUrl(provider.baseUrl, '/chat/completions')
  }
}

function buildBody(input: AdapterInput, format: StreamFormat): Record<string, unknown> {
  const { provider, messages } = input
  switch (format) {
    case 'sse-anthropic': {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }))
      const body: Record<string, unknown> = {
        model: provider.model,
        max_tokens: provider.maxTokens,
        temperature: provider.temperature,
        stream: true,
        messages: turns
      }
      if (system) body.system = system
      return body
    }
    case 'sse-gemini': {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n')
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      const body: Record<string, unknown> = {
        contents,
        generationConfig: { temperature: provider.temperature, maxOutputTokens: provider.maxTokens }
      }
      if (system) body.systemInstruction = { parts: [{ text: system }] }
      return body
    }
    case 'ndjson-ollama':
      return {
        model: provider.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        options: { temperature: provider.temperature, num_predict: provider.maxTokens }
      }
    case 'sse-openai':
    default: {
      const body: Record<string, unknown> = {
        model: provider.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        temperature: provider.temperature,
        max_tokens: provider.maxTokens
      }
      if (supportsStreamOptions(provider)) body.stream_options = { include_usage: true }
      return body
    }
  }
}

/** 「测试连接」用的最小请求：GET /models（OpenAI 兼容）或 1 token 的 chat */
export function buildModelsRequest(input: Omit<AdapterInput, 'messages'>): BuiltRequest {
  const { provider, apiKey, extraHeaders } = input
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders }
  if (apiKey) {
    if (provider.kind === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = ANTHROPIC_VERSION
    } else if (resolveStreamFormat(provider) === 'sse-gemini') {
      headers['x-goog-api-key'] = apiKey
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
  }
  switch (provider.kind) {
    case 'anthropic':
      // Anthropic 的 GET /v1/models 已 GA，无需额外参数
      return { url: anthropicUrl(provider.baseUrl, '/models'), method: 'GET', headers, body: null, format: 'sse-openai' }
    case 'ollama':
      return { url: ollamaUrl(provider.baseUrl, '/api/tags'), method: 'GET', headers, body: null, format: 'ndjson-ollama' }
    case 'openai-compatible':
      if (resolveStreamFormat(provider) === 'sse-gemini') {
        return { url: geminiUrl(provider.baseUrl, provider.model, 'generateContent'), method: 'POST', headers, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } }), format: 'sse-gemini' }
      }
      return { url: openAiUrl(provider.baseUrl, '/models'), method: 'GET', headers, body: null, format: 'sse-openai' }
    case 'openai':
    default:
      return { url: openAiUrl(provider.baseUrl, '/models'), method: 'GET', headers, body: null, format: 'sse-openai' }
  }
}

/* ------------------------------ 流帧解释 ------------------------------ */

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null
  error?: { message?: string; type?: string } | string
}

interface AnthropicEvent {
  type?: string
  delta?: { type?: string; text?: string; stop_reason?: string | null }
  message?: { usage?: { input_tokens?: number | null; output_tokens?: number | null } }
  usage?: { input_tokens?: number | null; output_tokens?: number | null }
  error?: { message?: string; type?: string }
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string; status?: string }
}

interface OllamaChunk {
  message?: { content?: string }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

function pickUsage(prompt: number | null | undefined, completion: number | null | undefined): Partial<AiUsage> | undefined {
  const usage: Partial<AiUsage> = {}
  if (typeof prompt === 'number') usage.promptTokens = prompt
  if (typeof completion === 'number') usage.completionTokens = completion
  return Object.keys(usage).length > 0 ? usage : undefined
}

/** 把一帧解释成统一增量；无法识别的帧返回空对象（忽略，不报错） */
export function interpretChunk(format: StreamFormat, chunk: StreamChunk): InterpretedChunk {
  if (format === 'sse-openai' && isDoneSentinel(chunk.data)) return { done: true }
  const payload = parseJsonPayload<unknown>(chunk.data)
  if (payload === undefined) {
    // 残缺 / 非 JSON 载荷：交给上层按「流中断」处理
    return { error: `无法解析的流式帧：${chunk.data.slice(0, 120)}` }
  }
  switch (format) {
    case 'sse-openai': {
      const data = payload as OpenAiChunk
      if (data.error) {
        return { error: typeof data.error === 'string' ? data.error : data.error.message ?? '供应商返回未知错误' }
      }
      const choice = data.choices?.[0]
      const out: InterpretedChunk = {}
      const text = choice?.delta?.content
      if (typeof text === 'string' && text.length > 0) out.delta = text
      const usage = data.usage ? pickUsage(data.usage.prompt_tokens, data.usage.completion_tokens) : undefined
      if (usage) out.usage = usage
      if (choice?.finish_reason) out.done = true
      return out
    }
    case 'sse-anthropic': {
      const data = payload as AnthropicEvent
      if (data.type === 'error' || data.error) {
        return { error: data.error?.message ?? 'Anthropic 返回未知错误' }
      }
      const out: InterpretedChunk = {}
      if (data.type === 'message_start') {
        const usage = pickUsage(data.message?.usage?.input_tokens, data.message?.usage?.output_tokens)
        if (usage) out.usage = usage
      } else if (data.type === 'content_block_delta') {
        if (data.delta?.type === 'text_delta' && typeof data.delta.text === 'string') out.delta = data.delta.text
      } else if (data.type === 'message_delta') {
        const usage = pickUsage(data.usage?.input_tokens, data.usage?.output_tokens)
        if (usage) out.usage = usage
        if (data.delta?.stop_reason) out.done = true
      } else if (data.type === 'message_stop') {
        out.done = true
      }
      return out
    }
    case 'sse-gemini': {
      // 非 alt=sse 的网关可能把数组整包塞进一个 data 帧
      const frames = Array.isArray(payload) ? (payload as GeminiChunk[]) : [payload as GeminiChunk]
      const out: InterpretedChunk = {}
      for (const frame of frames) {
        if (frame.error) return { error: frame.error.message ?? 'Gemini 返回未知错误' }
        const parts = frame.candidates?.[0]?.content?.parts ?? []
        const text = parts.map((p) => p.text ?? '').join('')
        if (text) out.delta = (out.delta ?? '') + text
        if (frame.usageMetadata) {
          out.usage = pickUsage(frame.usageMetadata.promptTokenCount ?? null, frame.usageMetadata.candidatesTokenCount ?? null)
        }
        if (frame.candidates?.[0]?.finishReason) out.done = true
      }
      return out
    }
    case 'ndjson-ollama':
    default: {
      const data = payload as OllamaChunk
      if (data.error) return { error: data.error }
      const out: InterpretedChunk = {}
      if (data.message?.content) out.delta = data.message.content
      if (data.done) {
        out.done = true
        const usage = pickUsage(data.prompt_eval_count ?? null, data.eval_count ?? null)
        if (usage) out.usage = usage
      }
      return out
    }
  }
}

/**
 * 「测试连接」时的响应校验：这些端点成功时应返回 2xx 且是 JSON。
 * 返回 null 表示可用，否则返回一句可直接展示给用户的说明。
 */
export function describeModelsResponse(status: number): string | null {
  return status >= 200 && status < 300 ? null : `HTTP ${status}`
}
