import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANTHROPIC_MIN_MAX_TOKENS,
  ANTHROPIC_THINKING_BUDGET,
  REASONING_EFFORTS,
  REASONING_EFFORT_DEFAULT,
  anthropicEffectiveMaxTokens,
  anthropicMinMaxTokens,
  isGeminiEndpoint,
  reasoningEffortSchema,
  resolveReasoningMode
} from '@shared'
import { resolveStreamFormat } from '../src/main/ai/adapters'
import { LIST_MODELS_MESSAGE_MAX_LENGTH, clipFailureMessage } from '../src/main/ai/service'

const repoRoot = resolve(__dirname, '..')

/**
 * 思考强度映射表（r2 AC-8 / AC-9）的单点契约。
 *
 * 这里只测 `src/shared/reasoning.ts` 这张表本身，不重复 `tests/ai-reasoning.test.ts`
 * （那条走 adapters 断言「请求体里到底发了什么键」）。分成两层的理由：
 * - 本文件守「判定对不对」：哪种供应商走哪种协议、预算值是多少；
 * - ai-reasoning.test.ts 守「有没有真的发出去」：判定对了但适配器不发，照样是坏功能。
 *
 * 判定一旦漂移，最典型的症状是界面显示「支持思考强度」而请求里一个键都没有，
 * 或者反过来对 DeepSeek/自建网关乱发 `reasoning_effort` 换来 400 —— 两种都只有这一层能钉住。
 */

describe('思考强度三档', () => {
  it('档位顺序与默认值固定', () => {
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high'])
    expect(REASONING_EFFORT_DEFAULT).toBe('medium')
    expect(reasoningEffortSchema.parse('high')).toBe('high')
    expect(() => reasoningEffortSchema.parse('ultra')).toThrow()
  })

  it('Anthropic 预算与 max_tokens 下限是固定值，且下限始终大于预算', () => {
    expect(ANTHROPIC_THINKING_BUDGET).toEqual({ low: 1024, medium: 4096, high: 16384 })
    expect(ANTHROPIC_MIN_MAX_TOKENS).toEqual({ low: 2048, medium: 5120, high: 17408 })
    for (const level of REASONING_EFFORTS) {
      // schema 要求 budget_tokens ≥ 1024 且严格小于 max_tokens，否则服务端 400
      expect(ANTHROPIC_THINKING_BUDGET[level]).toBeGreaterThanOrEqual(1024)
      expect(ANTHROPIC_MIN_MAX_TOKENS[level]).toBeGreaterThan(ANTHROPIC_THINKING_BUDGET[level] + 1024 - 1)
    }
  })

  it('max_tokens 只抬不降（用户存的值更大时原样保留）', () => {
    expect(anthropicEffectiveMaxTokens('low', 1000)).toBe(2048)
    expect(anthropicEffectiveMaxTokens('high', 2048)).toBe(17408)
    expect(anthropicEffectiveMaxTokens('medium', 32_000)).toBe(32_000)
    // 转发层（src/main/ai/index.ts）用的是另一个名字，必须是同一个实现
    expect(anthropicMinMaxTokens).toBe(anthropicEffectiveMaxTokens)
  })
})

describe('供应商 → 思考强度协议', () => {
  const cases: Array<{
    title: string
    input: { kind: 'openai' | 'anthropic' | 'openai-compatible' | 'ollama'; baseUrl: string }
    expected: { mode: string; reason: string }
  }> = [
    {
      title: 'OpenAI 走 reasoning_effort',
      input: { kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
      expected: { mode: 'openai-effort', reason: 'openai' }
    },
    {
      title: 'Anthropic 走 thinking.budget_tokens',
      input: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
      expected: { mode: 'anthropic-thinking', reason: 'anthropic' }
    },
    {
      title: 'Ollama 不发任何推理键',
      input: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      expected: { mode: 'none', reason: 'ollama' }
    },
    {
      title: 'Gemini 兼容层走 thinkingConfig.thinkingBudget',
      input: { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
      expected: { mode: 'gemini-budget', reason: 'gemini' }
    },
    {
      title: 'Gemini 的 /openai 子路径按 OpenAI 格式处理，因此不发 thinkingConfig',
      input: { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      expected: { mode: 'none', reason: 'unknown-endpoint' }
    },
    {
      title: 'DeepSeek 等兼容端点不在白名单内，宁可不发也不乱发',
      input: { kind: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1' },
      expected: { mode: 'none', reason: 'unknown-endpoint' }
    },
    {
      title: '兼容端点指向本机 11434 时按 Ollama 处理',
      input: { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' },
      expected: { mode: 'none', reason: 'ollama' }
    },
    {
      title: '半截地址不抛错（用户还在输入）',
      input: { kind: 'openai-compatible', baseUrl: 'api.example.com' },
      expected: { mode: 'none', reason: 'unknown-endpoint' }
    }
  ]

  for (const testCase of cases) {
    it(testCase.title, () => {
      expect(resolveReasoningMode(testCase.input)).toEqual(testCase.expected)
    })
  }
})

describe('读模型失败原文的长度上限（AC-10）', () => {
  it('超过 300 字截断成 300 字，短文本原样返回', () => {
    expect(LIST_MODELS_MESSAGE_MAX_LENGTH).toBe(300)
    expect(clipFailureMessage('x'.repeat(500))).toHaveLength(300)
    expect(clipFailureMessage('invalid api key')).toBe('invalid api key')
    expect(clipFailureMessage('')).toBe('')
  })
})

/**
 * QA D-1：「是不是 Gemini」曾经是两份事实 —— `src/shared/reasoning.ts` 与
 * `src/main/ai/adapters.ts` 各写一遍 `GEMINI_HOST`，一致性只靠注释约定。
 * 任一处漂移的症状是「按 Gemini 发了 thinkingConfig，却按 OpenAI 解析流」的静默错配，
 * 而且 adapters 的单测与 shared 的单测各自都绿。这里用两条断言把它钉住：
 * ① 行为孪生：同一 baseUrl 下 `resolveStreamFormat(...)==='sse-gemini'` 必须恒等于 `isGeminiEndpoint(...)`；
 * ② 事实单点：主机名常量只允许出现在 shared 一处（适配器必须复用，不得自带副本）。
 */
describe('Gemini 端点判定是单点事实（QA D-1 回归守卫）', () => {
  const GEMINI_HOST_LITERAL = 'generativelanguage.googleapis.com'

  // 三种形态：Gemini 原生、Gemini 的 /openai 兼容子路径（必须按 OpenAI）、无关主机
  const baseUrls = [
    'https://generativelanguage.googleapis.com/v1beta',
    'https://generativelanguage.googleapis.com/v1beta/openai',
    'https://api.deepseek.com/v1'
  ]

  it('resolveStreamFormat 与 isGeminiEndpoint 对同一 baseUrl 结论必须一致', () => {
    for (const baseUrl of baseUrls) {
      const provider = { kind: 'openai-compatible' as const, baseUrl }
      expect(
        { baseUrl, geminiStream: resolveStreamFormat(provider) === 'sse-gemini' },
        '流格式判定与「发不发 thinkingConfig」的判定漂移了'
      ).toEqual({ baseUrl, geminiStream: isGeminiEndpoint(baseUrl) })
    }
  })

  it('主机名常量只允许出现在 src/shared/reasoning.ts 一处', () => {
    const sites = ['src/shared/reasoning.ts', 'src/main/ai/adapters.ts'].map((rel) => ({
      rel,
      count: readFileSync(resolve(repoRoot, rel), 'utf8').split(GEMINI_HOST_LITERAL).length - 1
    }))
    expect(sites.find((site) => site.rel === 'src/shared/reasoning.ts')?.count).toBe(1)
    // 修复前这里是 2（adapters.ts 自带一份）；再出现第二份说明判定又被复制了
    expect(sites.reduce((sum, site) => sum + site.count, 0)).toBe(1)
  })
})
