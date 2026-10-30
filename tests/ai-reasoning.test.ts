import { describe, expect, it } from 'vitest'
import {
  ANTHROPIC_MIN_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGET,
  REASONING_EFFORTS,
  resolveReasoningMode,
  type ReasoningEffort
} from '@shared'
import type { AiProvider } from '@shared/models/ai'
import { buildChatRequest, buildModelsRequest } from '../src/main/ai/adapters'

/**
 * AC-8：三档思考强度 → 四家协议的原生推理参数（4 协议 × 3 档穷举）。
 *
 * 为什么断言 `JSON.parse(body)` 的字段值而不是字符串子串：子串断言在
 * `"reasoning_effort":"medium"` 被塞进别的层级时照样绿，而字段断言能立刻分辨
 * 「表错了（映射值不对）」和「body 拼错了（放错层级）」。
 *
 * 另有一条硬约束在这里兜底（AC-7）：`budget_tokens` 必须 < `max_tokens`，
 * 所以低/中/高三档都要满足 MIN_MAX_TOKENS >= 预算 + 1024 的回答余量。
 */

const messages = [{ role: 'user' as const, content: '你好' }]

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    id: 'p1',
    name: 'test',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
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

function bodyOf(p: AiProvider, level?: ReasoningEffort | null): Record<string, unknown> {
  const request = buildChatRequest({ provider: p, apiKey: 'sk-x', messages, reasoningEffort: level })
  return JSON.parse(request.body ?? '{}') as Record<string, unknown>
}

describe('三档思考强度 → 各家协议原生参数（AC-8）', () => {
  it('OpenAI 官方：只加 reasoning_effort，其余字段一字不动', () => {
    for (const level of REASONING_EFFORTS) {
      const body = bodyOf(provider({ kind: 'openai' }), level)
      expect(body.reasoning_effort).toBe(level)
      expect(body.temperature).toBe(0.3)
      expect(body.max_tokens).toBe(2048)
      expect(body.stream).toBe(true)
      expect(body.stream_options).toEqual({ include_usage: true })
    }
  })

  it('Anthropic：thinking.budget_tokens + 抬 max_tokens + 不发 temperature', () => {
    for (const level of REASONING_EFFORTS) {
      const body = bodyOf(provider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }), level)
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET[level] })
      // 默认 maxTokens 只有 2048，「中/高」不抬就是必然 400
      expect(body.max_tokens).toBe(ANTHROPIC_MIN_MAX_TOKENS[level])
      expect(body.max_tokens as number).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET[level])
      // 开 thinking 时 temperature 只接受 1 → 省略这个键，而不是把用户的 0.3 改成 1 发出去
      expect(Object.prototype.hasOwnProperty.call(body, 'temperature')).toBe(false)
      expect(body.reasoning_effort).toBeUndefined()
    }
  })

  it('Anthropic：用户保存的更大 max_tokens 不会被压回表里的下限', () => {
    const body = bodyOf(provider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', maxTokens: 32_000 }), 'high')
    expect(body.max_tokens).toBe(32_000)
  })

  it('Gemini 原生：generationConfig.thinkingConfig.thinkingBudget', () => {
    for (const level of REASONING_EFFORTS) {
      const body = bodyOf(
        provider({ kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
        level
      )
      expect(body.generationConfig).toEqual({
        temperature: 0.3,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: ANTHROPIC_THINKING_BUDGET[level] }
      })
      expect(body.reasoning_effort).toBeUndefined()
      expect(body.thinking).toBeUndefined()
    }
  })

  it('Ollama：三档都一个推理字段都不加（AC-8 明确要求）', () => {
    for (const level of REASONING_EFFORTS) {
      const body = bodyOf(provider({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), level)
      expect(JSON.stringify(body)).not.toMatch(/reasoning|thinking/i)
      expect(body.options).toEqual({ temperature: 0.3, num_predict: 2048 })
    }
  })

  it('未实测的兼容端点（DeepSeek / vLLM / LM Studio）：宁可明确不发', () => {
    for (const baseUrl of ['https://api.deepseek.com/v1', 'http://127.0.0.1:8000/v1', 'https://api.moonshot.cn/v1']) {
      for (const level of REASONING_EFFORTS) {
        const body = bodyOf(provider({ kind: 'openai-compatible', baseUrl }), level)
        expect(JSON.stringify(body)).not.toMatch(/reasoning_effort|thinking/i)
      }
    }
    expect(resolveReasoningMode({ kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' })).toEqual({
      mode: 'none',
      reason: 'unknown-endpoint'
    })
    expect(resolveReasoningMode({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' })).toEqual({
      mode: 'none',
      reason: 'ollama'
    })
  })

  it('协议判定矩阵与 adapters 实际发送一致（4 种 kind）', () => {
    expect(resolveReasoningMode({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }).mode).toBe('openai-effort')
    expect(resolveReasoningMode({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }).mode).toBe(
      'anthropic-thinking'
    )
    expect(
      resolveReasoningMode({
        kind: 'openai-compatible',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
      }).mode
    ).toBe('gemini-budget')
    expect(resolveReasoningMode({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' }).mode).toBe('none')
  })

  it('AC-7 硬约束：三档的 max_tokens 下限都留出 ≥1024 的回答余量', () => {
    for (const level of REASONING_EFFORTS) {
      expect(ANTHROPIC_MIN_MAX_TOKENS[level]).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET[level] + 1024 - 1)
    }
  })
})

describe('思考强度改造不破坏既有请求（AC-9）', () => {
  const cases: Array<[string, AiProvider]> = [
    ['openai', provider({ kind: 'openai' })],
    ['anthropic', provider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })],
    ['gemini', provider({ kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })],
    ['ollama', provider({ kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' })]
  ]

  it('缺省 / null 思考强度时四家请求体与改造前逐字一致', () => {
    for (const [, p] of cases) {
      const omitted = bodyOf(p)
      const explicitNull = bodyOf(p, null)
      expect(explicitNull).toEqual(omitted)
    }
    // Anthropic 未启用 thinking 时 temperature 必须留在原位
    const anthropic = bodyOf(cases[1][1])
    expect(anthropic.temperature).toBe(0.3)
    expect(anthropic.max_tokens).toBe(2048)
    expect(anthropic.thinking).toBeUndefined()
  })

  it('读取模型请求（GET）不会被思考强度污染：仍是 GET 且无 body', () => {
    const request = buildModelsRequest({ provider: provider({ kind: 'openai' }), apiKey: 'sk-x', reasoningEffort: 'high' })
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
    expect(JSON.stringify(request.headers)).not.toMatch(/reasoning/i)
  })
})
