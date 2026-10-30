import { describe, expect, it } from 'vitest'
import type { AiProvider, AiTerminalContext } from '@shared/models/ai'
import {
  buildChatRequest,
  buildModelsRequest,
  openAiUrl,
  resolveStreamFormat
} from '../src/main/ai/adapters'
import { composeMessages, renderContextBlock, resolveContextLines, sanitizeTerminalOutput, tailLines } from '../src/main/ai/context'
import { AiRequestError, requestJson, streamRequest } from '../src/main/ai/http'
import { buildPreview } from '@renderer/features/ai/prompt-preview'

/**
 * 请求构造 + 上下文注入 + 重试策略。
 *
 * 两个「跨进程一致性」断言是这里的重点：
 * 1. 渲染层预览的「将要发送的内容」必须**逐字等于**主进程真正发出去的 system 消息
 *    （否则用户确认的和实际发的不是同一段文本，二次确认就成了摆设）；
 * 2. 各供应商的鉴权头/URL/流格式差异必须对得上（用错头的表现是 401，最容易误判成 key 错）。
 */

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'p1',
    name: 'test',
    kind: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4.1-mini',
    apiKeyRef: 'vault:ai-key:p1:abcd',
    temperature: 0.3,
    maxTokens: 2048,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

describe('buildChatRequest：各供应商真实差异', () => {
  const messages = [
    { role: 'system' as const, content: 'SYS' },
    { role: 'user' as const, content: '你好' }
  ]

  it('OpenAI 兼容：Bearer + /chat/completions + stream_options', () => {
    const request = buildChatRequest({ provider: provider({ kind: 'openai' }), apiKey: 'sk-x', messages })
    expect(request.url).toBe('https://api.example.com/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer sk-x')
    expect(request.headers.accept).toBe('text/event-stream')
    const body = JSON.parse(request.body ?? '{}')
    expect(body.stream).toBe(true)
    expect(body.messages).toHaveLength(2)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('自建 baseUrl 没有 /v1 时自动补（vLLM / LM Studio 常见）', () => {
    expect(openAiUrl('http://127.0.0.1:8000', '/chat/completions')).toBe('http://127.0.0.1:8000/v1/chat/completions')
    expect(openAiUrl('http://127.0.0.1:8000/v1/', '/models')).toBe('http://127.0.0.1:8000/v1/models')
    expect(buildChatRequest({ provider: provider({ baseUrl: 'https://api.deepseek.com' }), apiKey: 'k', messages }).url).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
  })

  it('Anthropic：x-api-key + anthropic-version，system 提到顶层，url 不带 /v1 重复', () => {
    const request = buildChatRequest({ provider: provider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }), apiKey: 'sk-ant-x', messages })
    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers['x-api-key']).toBe('sk-ant-x')
    expect(request.headers['anthropic-version']).toBe('2023-06-01')
    expect(request.headers.authorization).toBeUndefined()
    const body = JSON.parse(request.body ?? '{}')
    expect(body.system).toBe('SYS')
    expect(body.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true)
    expect(body.max_tokens).toBe(2048)
    expect(request.format).toBe('sse-anthropic')
  })

  it('Gemini 原生：x-goog-api-key + :streamGenerateContent?alt=sse + contents/parts', () => {
    const gemini = provider({
      kind: 'openai-compatible',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash'
    })
    expect(resolveStreamFormat(gemini)).toBe('sse-gemini')
    const request = buildChatRequest({ provider: gemini, apiKey: 'AIza-x', messages })
    // 用 Bearer 会得到 401 API_KEY_INVALID，所以这里断言的是「必须用 Google 自己的头」
    expect(request.headers['x-goog-api-key']).toBe('AIza-x')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse'
    )
    const body = JSON.parse(request.body ?? '{}')
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: '你好' }] })
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] })
  })

  it('Gemini 的 OpenAI 兼容入口仍走 Bearer', () => {
    const geminiOpenAi = provider({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-2.0-flash'
    })
    const request = buildChatRequest({ provider: geminiOpenAi, apiKey: 'AIza-x', messages })
    expect(request.headers.authorization).toBe('Bearer AIza-x')
    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
    expect(request.format).toBe('sse-openai')
  })

  it('Ollama 本地：/api/chat + NDJSON + 无鉴权头', () => {
    const request = buildChatRequest({
      provider: provider({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' }),
      apiKey: null,
      messages
    })
    expect(request.url).toBe('http://127.0.0.1:11434/api/chat')
    expect(request.format).toBe('ndjson-ollama')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.headers.accept).toBe('application/x-ndjson')
    const body = JSON.parse(request.body ?? '{}')
    expect(body.options).toEqual({ temperature: 0.3, num_predict: 2048 })
  })

  it('Ollama 前面挂了 OpenAI 兼容反代（baseUrl 带版本段）时切回 SSE', () => {
    const request = buildChatRequest({
      provider: provider({ kind: 'ollama', baseUrl: 'http://gateway.local/v1' }),
      apiKey: 'proxy-token',
      messages
    })
    expect(request.format).toBe('sse-openai')
    expect(request.url).toBe('http://gateway.local/v1/chat/completions')
    expect(request.headers.authorization).toBe('Bearer proxy-token')
  })

  it('自定义额外 headers 会带上（OpenRouter 的排序/来源标识靠它）', () => {
    const request = buildChatRequest({
      provider: provider(),
      apiKey: 'k',
      messages,
      extraHeaders: { 'http-referer': 'https://termans.app', 'x-title': 'Termans' }
    })
    expect(request.headers['http-referer']).toBe('https://termans.app')
    expect(request.headers['x-title']).toBe('Termans')
  })

  it('测试连接用 GET /models（Ollama 用 /api/tags，Gemini 用最小 generateContent）', () => {
    expect(buildModelsRequest({ provider: provider(), apiKey: 'k' }).url).toBe('https://api.example.com/v1/models')
    expect(
      buildModelsRequest({ provider: provider({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), apiKey: null }).url
    ).toBe('http://127.0.0.1:11434/api/tags')
    const gemini = buildModelsRequest({
      provider: provider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.0-flash' }),
      apiKey: 'AIza-x'
    })
    expect(gemini.url).toContain(':generateContent')
    expect(gemini.method).toBe('POST')
  })
})

describe('上下文注入：只带最近 N 行 + 主机信息', () => {
  const messy = '\u001b[32m$ ls\u001b[0m\r\nfile-a\r\nfile-b\r\n\u001b]0;title\u0007$ pwd\r\n/srv/app\r\n'

  it('剥掉 ANSI/OSC 转义与 CR，避免把控制字符塞给模型', () => {
    const clean = sanitizeTerminalOutput(messy)
    expect(clean).not.toContain('\u001b')
    expect(clean).not.toContain('\r')
    expect(clean).toContain('$ ls')
    expect(clean).toContain('/srv/app')
  })

  it('tailLines 只保留最后 N 行，且不超过字符上限', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line-${i}`).join('\n')
    const tail = tailLines(text, 200)
    expect(tail.split('\n')).toHaveLength(200)
    expect(tail.startsWith('line-100')).toBe(true)
    expect(tail.endsWith('line-299')).toBe(true)
    // 字符上限优先：超出时从头部丢弃（尾部才是用户当前关心的）
    const capped = tailLines('x'.repeat(500) + '\n' + 'y'.repeat(100), 200, 120)
    expect(capped.length).toBeLessThanOrEqual(120)
    expect(capped.endsWith('y')).toBe(true)
  })

  it('contextLines 默认 200（任务要求），越界被夹紧', () => {
    expect(resolveContextLines(undefined)).toBe(200)
    expect(resolveContextLines(null)).toBe(200)
    expect(resolveContextLines(80)).toBe(80)
    expect(resolveContextLines(0)).toBe(0)
    expect(resolveContextLines(9999)).toBe(500)
    expect(resolveContextLines(-5)).toBe(0)
  })

  it('上下文块包含主机/用户/系统/行数，并标注「不可信输入」', () => {
    const block = renderContextBlock({
      hostLabel: 'deploy@prod-web-1',
      cwd: '/srv/app',
      os: 'Ubuntu 24.04',
      recentOutput: 'line-1\nline-2',
      contextLines: 200
    })
    expect(block).toContain('<terminal_context>')
    expect(block).toContain('host: deploy@prod-web-1')
    expect(block).toContain('cwd: /srv/app')
    expect(block).toContain('os: Ubuntu 24.04')
    // 标注的是「注入窗口」大小（用户配的 200 行），不是实际行数：预览里必须与设置一致
    expect(block).toContain('recent_output (last 200 lines, untrusted)')
    expect(block).toContain('line-2')
    expect(block).toContain('</terminal_context>')
  })

  it('关闭上下文（contextLines=0）时不注入任何终端内容', () => {
    const context: AiTerminalContext = {
      sessionId: 's1',
      hostLabel: 'deploy@prod-web-1',
      cwd: '/srv/app',
      recentOutput: 'SECRET-TOKEN-IN-OUTPUT'
    }
    const messages = composeMessages({
      messages: [{ role: 'user', content: 'hi' }],
      context,
      contextLines: 0
    })
    const system = messages[0].content
    expect(system).not.toContain('SECRET-TOKEN-IN-OUTPUT')
    expect(system).not.toContain('<terminal_context>')
    expect(messages).toHaveLength(2)
  })
})

describe('预览一致性：用户确认的内容 == 真正发送的内容', () => {
  const context: AiTerminalContext = {
    sessionId: 's1',
    hostLabel: 'deploy@prod-web-1',
    cwd: '/srv/app',
    recentOutput: '\u001b[31mERROR\u001b[0m boom\nline-2\nline-3'
  }
  const messages = [
    { role: 'user' as const, content: '构建为什么失败？' }
  ]

  it('渲染层 buildPreview 的 messages 与主进程 composeMessages 逐字相同', () => {
    const preview = buildPreview({ messages, context, contextLines: 200, os: 'Ubuntu 24.04' })
    const composed = composeMessages({ messages, context, contextLines: 200, os: 'Ubuntu 24.04' })
    expect(preview.messages).toEqual(composed)
    expect(preview.includesTerminal).toBe(true)
    // 预览文本里也要有终端内容，否则用户根本没看到「将要发送什么」
    expect(preview.text).toContain('deploy@prod-web-1')
    expect(preview.text).toContain('ERROR boom')
    expect(preview.text).not.toContain('\u001b')
  })

  it('带自定义提示词模板时同样一致（模板进 system，不额外多一条 system 消息）', () => {
    const withTemplate = [
      { role: 'system' as const, content: '请用中文解释，最多 5 行。' },
      { role: 'user' as const, content: '解释这段报错' }
    ]
    const preview = buildPreview({ messages: withTemplate, context, contextLines: 50, os: null })
    const composed = composeMessages({ messages: withTemplate, context, contextLines: 50, os: null })
    expect(preview.messages).toEqual(composed)
    expect(preview.messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(preview.messages[0].content).toContain('请用中文解释')
  })
})

describe('重试与超时（429/5xx 一次退避）', () => {
  function request() {
    return buildChatRequest({
      provider: provider({ kind: 'openai' }),
      apiKey: 'sk-x',
      messages: [{ role: 'user', content: 'hi' }]
    })
  }

  function bodyStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let index = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(chunks[index]))
        index += 1
      }
    })
  }

  async function collect(gen: AsyncGenerator<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder()
    let text = ''
    for await (const bytes of gen) text += decoder.decode(bytes, { stream: true })
    return text
  }

  it('429 后自动重试一次并成功交付内容', async () => {
    let calls = 0
    const retries: number[] = []
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) return new Response('{"error":{"message":"rate limited"}}', { status: 429 })
      return new Response(bodyStream(['data: {"a":1}\n\n']), { status: 200 })
    }) as unknown as typeof fetch

    const text = await collect(
      streamRequest({
        request: request(),
        signal: new AbortController().signal,
        fetchImpl,
        sleep: async () => undefined,
        onRetry: (info) => retries.push(info.status ?? 0)
      })
    )
    expect(calls).toBe(2)
    expect(retries).toEqual([429])
    expect(text).toContain('{"a":1}')
  })

  it('5xx 重试一次后仍失败时抛出可重试错误（并带上供应商原文）', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('{"error":{"message":"upstream exploded"}}', { status: 503 })
    }) as unknown as typeof fetch

    await expect(
      collect(
        streamRequest({
          request: request(),
          signal: new AbortController().signal,
          fetchImpl,
          sleep: async () => undefined
        })
      )
    ).rejects.toMatchObject({ kind: 'http', status: 503, retryable: true })
    expect(calls).toBe(2)
  })

  it('401 不重试（认证错误重试一万次也一样）', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('{"error":{"message":"invalid key"}}', { status: 401 })
    }) as unknown as typeof fetch

    await expect(
      collect(streamRequest({ request: request(), signal: new AbortController().signal, fetchImpl }))
    ).rejects.toMatchObject({ kind: 'http', status: 401, retryable: false })
    expect(calls).toBe(1)
  })

  it('连接超时抛出 timeout（retryable），不会挂死', async () => {
    const fetchImpl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch
    await expect(
      collect(
        streamRequest({
          request: request(),
          signal: new AbortController().signal,
          fetchImpl,
          connectTimeoutMs: 20,
          maxRetries: 0
        })
      )
    ).rejects.toBeInstanceOf(AiRequestError)
  })

  it('取消后抛出 aborted（不是 network），上层据此区分「用户取消」与「网络断了」', async () => {
    const controller = new AbortController()
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }) as unknown as typeof fetch
    const pending = collect(streamRequest({ request: request(), signal: controller.signal, fetchImpl, maxRetries: 0 }))
    setTimeout(() => controller.abort(), 5)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('requestJson 不把 HTTP 状态码当异常（测试连接要自己展示原因）', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 })) as unknown as typeof fetch
    const response = await requestJson(request(), { fetchImpl })
    expect(response.ok).toBe(false)
    expect(response.status).toBe(401)
    expect(response.text).toContain('bad key')
  })
})

/**
 * AC-9 回归：思考强度改造（`reasoning_effort` / `thinking` / `thinkingConfig`）只在
 * `buildBody` 末尾追加，**不得**动既有字段。这里对四家的老字段各断言一次，
 * 是「同一次改造把 temperature/max_tokens 挤掉」这类事故的唯一探测器。
 */
describe('思考强度改造不破坏既有请求体（AC-9）', () => {
  const messages = [{ role: 'user' as const, content: '你好' }]

  it('传 reasoning_effort 后 OpenAI 的 temperature / max_tokens / stream_options 原样保留', () => {
    const body = JSON.parse(
      buildChatRequest({ provider: provider({ kind: 'openai' }), apiKey: 'sk-x', messages, reasoningEffort: 'high' }).body ?? '{}'
    )
    expect(body.reasoning_effort).toBe('high')
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(2048)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('Anthropic 抬 max_tokens 只影响本次请求：入参 provider 对象不被改写', () => {
    const anthropic = provider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })
    const snapshot = JSON.stringify(anthropic)
    const body = JSON.parse(buildChatRequest({ provider: anthropic, apiKey: 'sk-x', messages, reasoningEffort: 'high' }).body ?? '{}')
    expect(body.max_tokens).toBeGreaterThan(2048)
    expect(JSON.stringify(anthropic)).toBe(snapshot)
  })

  it('Gemini / Ollama 的既有字段（temperature、maxOutputTokens、num_predict）不被改造动到', () => {
    const gemini = JSON.parse(
      buildChatRequest({
        provider: provider({ kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        apiKey: 'sk-x',
        messages,
        reasoningEffort: 'low'
      }).body ?? '{}'
    )
    expect(gemini.generationConfig.temperature).toBe(0.3)
    expect(gemini.generationConfig.maxOutputTokens).toBe(2048)
    const ollama = JSON.parse(
      buildChatRequest({
        provider: provider({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }),
        apiKey: null,
        messages,
        reasoningEffort: 'medium'
      }).body ?? '{}'
    )
    expect(ollama.options).toEqual({ temperature: 0.3, num_predict: 2048 })
    expect(ollama.stream).toBe(true)
  })
})
