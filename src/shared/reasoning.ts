import { z } from 'zod'
import type { AiProviderKind } from './models/ai'

/**
 * 「思考强度」的全部映射知识，**只允许存在于这一个文件**（r2 AC-8 / AC-9）。
 *
 * 为什么单独成文件：三档强度要落到四种协议字段上（OpenAI `reasoning_effort`、
 * Anthropic `thinking.budget_tokens`、Gemini `thinkingConfig.thinkingBudget`、其它一律不发），
 * 主进程（`src/main/ai/adapters.ts`）与渲染层（思考强度控件 / 供应商卡片）必须拿到同一张表。
 * 任何一处在别处重写 `kind === 'ollama'` 之类的判断，都会让「界面上显示支持、实际没发」这类
 * 静默不一致重新出现 —— 所以判断入口只有 `resolveReasoningMode`。
 *
 * 依赖方向是单向的：本文件只从 `models/ai` 取 `AiProviderKind` 类型，
 * `models/settings` 反过来引用 `reasoningEffortSchema`（设置字段），不成环。
 */

/** 三档强度，顺序即 UI 分段控件的显示顺序 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** 全局默认档；DEFAULT_SETTINGS.ai.reasoningEffort 与本值必须一致 */
export const REASONING_EFFORT_DEFAULT: ReasoningEffort = 'medium'

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS)

/** 实际发到请求体上的四种协议形态（none = 该端点不支持，什么键都不发） */
export type ReasoningMode = 'openai-effort' | 'anthropic-thinking' | 'gemini-budget' | 'none'

/**
 * 判定理由，仅用于「界面解释为什么这个供应商不支持」这段文案，
 * 不参与发键决策（发键只看 `mode`）。`unknown-endpoint` = OpenAI 兼容端点但不在白名单里。
 */
export type ReasoningModeReason = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'unknown-endpoint'

export interface ReasoningPlan {
  mode: ReasoningMode
  reason: ReasoningModeReason
}

/** Anthropic 扩展思考的预算（schema 要求 budget_tokens ≥ 1024 且 < max_tokens） */
export const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  low: 1024,
  medium: 4096,
  high: 16384
}

/**
 * Anthropic 请求的 `max_tokens` 下限 = budget + 1024。
 * 用户存的 maxTokens 常常只有 2048/4096，直接开思考会被服务端以 400 拒绝，
 * 所以本次请求取 `max(用户值, 下限)`，**不回写配置**（用户的设置不该被悄悄改动）。
 */
export const ANTHROPIC_MIN_MAX_TOKENS: Record<ReasoningEffort, number> = {
  low: 2048,
  medium: 5120,
  high: 17408
}

/**
 * Gemini 走 OpenAI 兼容层时的真实主机名。
 * 唯一定义处：主进程的 `adapters.resolveStreamFormat` 不再自带一份，直接调用 `isGeminiEndpoint`。
 */
const GEMINI_HOST = 'generativelanguage.googleapis.com'
/** 走 Gemini 原生 /openai 兼容子路径时必须按 OpenAI 处理 */
const GEMINI_OPENAI_PATH = /\/openai$/i
/** Ollama 默认端口；手工填的兼容端点靠它识别成本地模型 */
const OLLAMA_DEFAULT_PORT = '11434'

interface EndpointShape {
  hostname: string
  port: string
  pathname: string
}

function parseEndpoint(baseUrl: string): EndpointShape | null {
  try {
    const url = new URL(baseUrl)
    return { hostname: url.hostname.toLowerCase(), port: url.port, pathname: url.pathname }
  } catch {
    // 用户可能填了半截地址（还没校验）；此时按「不认识的端点」处理，不抛错打断输入
    return null
  }
}

/**
 * 是否为 Gemini 端点（同主机名 + 排除 `/openai` 后缀）。
 *
 * 这是「是不是 Gemini」的**唯一事实**：`resolveReasoningMode` 用它决定发不发 `thinkingConfig`，
 * `src/main/ai/adapters.ts` 的 `resolveStreamFormat` 也直接调用它决定按哪种格式解析流。
 * 两处若各写一份判定、任一处漂移，就会出现「发了 Gemini 字段、却按 OpenAI 格式读响应」的哑火，
 * 所以这里只导出函数、不再另存常量副本（守卫在 tests/reasoning-map.test.ts 的孪生一致性用例）。
 */
export function isGeminiEndpoint(baseUrl: string): boolean {
  const endpoint = parseEndpoint(baseUrl)
  if (!endpoint) return false
  return endpoint.hostname === GEMINI_HOST && !GEMINI_OPENAI_PATH.test(endpoint.pathname)
}

/** 是否为本地 Ollama（kind 已声明，或主机名/端口命中默认值） */
export function isOllamaEndpoint(baseUrl: string): boolean {
  const endpoint = parseEndpoint(baseUrl)
  if (!endpoint) return false
  return endpoint.hostname.includes('ollama') || endpoint.port === OLLAMA_DEFAULT_PORT
}

/**
 * 唯一的「供应商 → 支持哪种思考强度协议」判定。
 * 兼容端点白名单固定为空：DeepSeek / vLLM / LM Studio 之类一律 `none`，
 * 乱发 `reasoning_effort` 只会换来 400（宁可少发，也不静默把请求搞坏）。
 */
export function resolveReasoningMode(input: { kind: AiProviderKind; baseUrl: string }): ReasoningPlan {
  switch (input.kind) {
    case 'anthropic':
      return { mode: 'anthropic-thinking', reason: 'anthropic' }
    case 'openai':
      return { mode: 'openai-effort', reason: 'openai' }
    case 'ollama':
      return { mode: 'none', reason: 'ollama' }
    case 'openai-compatible':
    default:
      if (isGeminiEndpoint(input.baseUrl)) return { mode: 'gemini-budget', reason: 'gemini' }
      if (isOllamaEndpoint(input.baseUrl)) return { mode: 'none', reason: 'ollama' }
      return { mode: 'none', reason: 'unknown-endpoint' }
  }
}

/** 本次请求实际使用的 max_tokens（Anthropic 开思考时抬到下限，其余供应商原样） */
export function anthropicEffectiveMaxTokens(level: ReasoningEffort, maxTokens: number): number {
  return Math.max(maxTokens, ANTHROPIC_MIN_MAX_TOKENS[level])
}

/**
 * 兼容别名：`src/main/ai/index.ts`（r1 已落盘的转发层）用的是这个名字。
 * 只做别名、不另写一份实现，避免「两张表各算一次」。
 */
export const anthropicMinMaxTokens = anthropicEffectiveMaxTokens
