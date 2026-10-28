import { describe, expect, it } from 'vitest'
import { aiProviderKindSchema } from '@shared/models/ai'
import { PROVIDER_PRESETS, findPreset, matchPresetByBaseUrl, presetToInput } from '@renderer/features/ai/presets'
import { resolveStreamFormat } from '../src/main/ai/adapters'

/**
 * 预设与契约的一致性。
 *
 * 有两件事必须钉住，否则会在「接线时才发现」：
 * 1. 预设的 `kind` 必须落在契约枚举里（`src/shared/models/ai.ts` 只有 4 个值，没有 gemini）；
 * 2. Gemini 默认走**官方 OpenAI 兼容端 + Bearer**，不是靠 URL 嗅探的原生协议——
 *    原生协议只作为兜底预设保留，这样 UI 里的「供应商类型」不用多一个枚举值。
 */

describe('supplier presets 与 shared 契约一致', () => {
  it('每个预设的 kind 都在 aiProviderKindSchema 枚举里', () => {
    const allowed = new Set(aiProviderKindSchema.options)
    for (const preset of PROVIDER_PRESETS) {
      expect(allowed.has(preset.kind), `预设 ${preset.id} 的 kind=${preset.kind} 不在契约枚举里`).toBe(true)
    }
  })

  it('每个预设的 baseUrl 是合法 URL、默认模型在模型列表里', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => new URL(preset.baseUrl), `预设 ${preset.id} 的 baseUrl 非法`).not.toThrow()
      expect(preset.models, `预设 ${preset.id} 没有模型列表`).not.toHaveLength(0)
      expect(preset.models, `预设 ${preset.id} 的默认模型不在列表里`).toContain(preset.defaultModel)
    }
  })

  it('预设 id 唯一（UI 用 id 做 select 的 value）', () => {
    const ids = PROVIDER_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('presetToInput 产出可直接提交的 AiProviderInput（id=new，无 key）', () => {
    const input = presetToInput(findPreset('deepseek')!)
    expect(input.id).toBe('new')
    expect(input.apiKeyRef).toBeNull()
    expect(input.enabled).toBe(true)
    expect(input.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(input.kind).toBe('openai-compatible')
  })

  it('按 baseUrl 反查预设（编辑已有供应商时显示来源）', () => {
    expect(matchPresetByBaseUrl('https://api.deepseek.com/v1/')?.id).toBe('deepseek')
    expect(matchPresetByBaseUrl('https://example.invalid/v1')).toBeUndefined()
  })
})

describe('Gemini：默认兼容端 + Bearer，原生协议仅兜底', () => {
  it('gemini 预设指向官方 OpenAI 兼容端', () => {
    const gemini = findPreset('gemini')!
    expect(gemini.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(gemini.kind).toBe('openai-compatible')
  })

  it('gemini 预设解析成 OpenAI 帧（Bearer 鉴权），不走原生特判', () => {
    const gemini = findPreset('gemini')!
    expect(
      resolveStreamFormat({ kind: gemini.kind, baseUrl: gemini.baseUrl } as never)
    ).toBe('sse-openai')
  })

  it('gemini-native 兜底预设才走原生事件流（x-goog-api-key）', () => {
    const native = findPreset('gemini-native')!
    expect(native.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(resolveStreamFormat({ kind: native.kind, baseUrl: native.baseUrl } as never)).toBe('sse-gemini')
  })
})
