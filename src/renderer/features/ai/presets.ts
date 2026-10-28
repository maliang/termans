/**
 * 供应商预设（渲染层）。
 *
 * 目的：让用户「选一个供应商 → 填 key → 可用」，而不是自己拼 baseURL。
 * 每个预设都对应 docs/ai-providers.md 里的实测差异（鉴权头、流格式、路径拼接规则）。
 *
 * 注意：模型的**可用清单随供应商发版变化**，这里的 models 只是「常用值 + 下拉提示」，
 * UI 允许自由输入（自定义模型名是硬需求，自建网关尤其需要）。
 */
import type { AiProviderKind } from '@shared'

export interface ProviderPreset {
  id: string
  /** 展示名（品牌名不翻译） */
  name: string
  kind: AiProviderKind
  baseUrl: string
  models: string[]
  defaultModel: string
  /** 是否必须有 API key（本地 Ollama 不需要） */
  needsKey: boolean
  /** 建议附加的请求头（OpenRouter 的归属头、Azure 的 api-version 等） */
  extraHeaders?: Record<string, string>
  /** 预设说明（英文原文，与 docs/ai-providers.md 一致；UI 直接展示，避免三处维护） */
  note: string
  docsUrl: string
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'],
    defaultModel: 'gpt-4.1-mini',
    needsKey: true,
    note: 'Official API. `Authorization: Bearer`, SSE with `stream_options.include_usage` for token usage.',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat'
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    needsKey: true,
    note: 'OpenAI-compatible base URL must keep `/v1`. `deepseek-reasoner` returns `reasoning_content` which is ignored by the panel.',
    docsUrl: 'https://api-docs.deepseek.com/'
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    kind: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0711-preview', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'moonshot-v1-8k',
    needsKey: true,
    note: 'OpenAI-compatible. Context window depends on the model suffix (-8k/-32k/-128k).',
    docsUrl: 'https://platform.moonshot.cn/docs'
  },
  {
    id: 'dashscope',
    name: '通义千问 (DashScope)',
    kind: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-coder-plus'],
    defaultModel: 'qwen-plus',
    needsKey: true,
    note: 'OpenAI-compatible endpoint lives under `/compatible-mode/v1`; do not point at the native DashScope path.',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-4.1-mini', 'anthropic/claude-sonnet-4', 'deepseek/deepseek-chat', 'google/gemini-2.5-flash'],
    defaultModel: 'openai/gpt-4.1-mini',
    needsKey: true,
    extraHeaders: { 'HTTP-Referer': 'https://termans.app', 'X-Title': 'Termans' },
    note: 'Model ids are namespaced (`vendor/model`). Attribution headers are optional but recommended.',
    docsUrl: 'https://openrouter.ai/docs'
  },
  {
    id: 'vllm',
    name: 'vLLM (self-hosted)',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    models: ['Qwen/Qwen2.5-Coder-7B-Instruct'],
    defaultModel: 'Qwen/Qwen2.5-Coder-7B-Instruct',
    needsKey: false,
    note: 'Self-hosted. Model must match `--served-model-name`. A dummy key is fine if the gateway requires one.',
    docsUrl: 'https://docs.vllm.ai/'
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    kind: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: ['local-model'],
    defaultModel: 'local-model',
    needsKey: false,
    note: 'OpenAI-compatible on port 1234. `GET /v1/models` lists the loaded model ids.',
    docsUrl: 'https://lmstudio.ai/docs/app/api'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    models: ['qwen2.5-coder:7b', 'llama3.2', 'deepseek-coder-v2', 'mistral'],
    defaultModel: 'qwen2.5-coder:7b',
    needsKey: false,
    note: 'Native API `/api/chat` speaks NDJSON (not SSE) and streams usage in the final frame. Use `http://127.0.0.1:11434/v1` to talk to its OpenAI-compatible endpoint instead.',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md'
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
    needsKey: true,
    note: 'Messages API. Auth uses `x-api-key` + `anthropic-version: 2023-06-01` (no Bearer). `system` is a top-level field, and usage arrives in `message_start` / `message_delta` events.',
    docsUrl: 'https://docs.anthropic.com/en/api/messages'
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'openai-compatible',
    // 官方 OpenAI 兼容端：Bearer 鉴权、OpenAI 帧。默认走这条，UI 里不必为 Gemini 多一个供应商类型。
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    note: 'Official OpenAI-compatible endpoint (Bearer auth). Use this unless the shim is blocked.',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai'
  },
  {
    id: 'gemini-native',
    name: 'Google Gemini (native protocol)',
    kind: 'openai-compatible',
    // 兜底路径：兼容端不可用（或需要原生字段）时用原生 :streamGenerateContent + x-goog-api-key。
    // uri 不含 /openai 时 Termans 会自动切到 Gemini 原生适配器（docs/ai-providers.md §2）。
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    note: 'Fallback: native `:streamGenerateContent?alt=sse` with `x-goog-api-key`. Only if the OpenAI shim fails.',
    docsUrl: 'https://ai.google.dev/api/generate-content'
  }
]

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/** 根据 baseUrl 反查预设（编辑已有供应商时用来显示「来自哪个预设」） */
export function matchPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  return PROVIDER_PRESETS.find((preset) => preset.baseUrl.toLowerCase() === normalized)
}

/** 生成「新供应商」的初始值（id 传 'new'，由主进程生成真实 id） */
export function presetToInput(preset: ProviderPreset): {
  id: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  apiKeyRef: null
  temperature: number
  maxTokens: number
  enabled: boolean
} {
  return {
    id: 'new',
    name: preset.name,
    kind: preset.kind,
    baseUrl: preset.baseUrl,
    model: preset.defaultModel,
    apiKeyRef: null,
    temperature: 0.2,
    maxTokens: 2048,
    enabled: true
  }
}
