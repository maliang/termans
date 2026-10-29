import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, findBuiltinTheme, resolveBuiltinTheme } from '@renderer/theme/builtin'
import { CONTRAST_PAIRS, auditContrast, bodyContrastRatio, contrastProblems } from '@renderer/theme/contrast'

/**
 * 主题可读性冒烟（SPEC M-06）。
 *
 * 拿不到浏览器的 computed style 也没关系：对比度是纯算术，能在 node 里算得比肉眼更准。
 * 这里断言的是**硬底线**（`pair.min`），编辑器里低于 `pair.recommended` 只给黄色警告。
 */
describe('内置主题对比度', () => {
  it('审计覆盖 12 组配对，且每组都有 min/recommended', () => {
    expect(CONTRAST_PAIRS.length).toBe(12)
    for (const pair of CONTRAST_PAIRS) {
      expect(pair.min).toBeGreaterThan(0)
      expect(pair.recommended).toBeGreaterThanOrEqual(pair.min)
    }
  })

  for (const theme of BUILTIN_THEMES) {
    it(`${theme.id}: 12 组配对都不低于硬底线`, () => {
      const results = auditContrast(resolveBuiltinTheme(theme))
      expect(results.length).toBe(CONTRAST_PAIRS.length)
      for (const result of results) {
        expect(
          result.failsMin,
          `${theme.id} ${result.pair.id} 仅 ${result.ratio}:1（底线 ${result.pair.min}，前景 ${result.foreground} / 背景 ${result.background}）`
        ).toBe(false)
        expect(result.ratio).toBeGreaterThan(0)
        expect(['AAA', 'AA', 'AA-large', 'fail']).toContain(result.level)
      }
    })

    it(`${theme.id}: 正文与三种背景层 ≥ 4.5:1`, () => {
      const results = auditContrast(resolveBuiltinTheme(theme))
      for (const id of ['body-app', 'body-surface', 'body-elevated', 'secondary-surface'] as const) {
        const result = results.find((item) => item.pair.id === id)!
        expect(result.ratio, `${theme.id} ${id} = ${result.ratio}:1`).toBeGreaterThanOrEqual(4.5)
      }
      expect(bodyContrastRatio(resolveBuiltinTheme(theme))).toBeGreaterThanOrEqual(4.5)
    })

    // 曾经的浅色主按钮偏差（白字 #ffffff 落在 #c86a08 上 = 3.80:1）已修：浅色块改用纯黑字
    // `--ts-accent-contrast: #000000`（5.52:1）。豁免表因此被删除，这里对所有内置主题一律要求 ≥ 4.5:1，
    // 谁再把品牌琥珀底上的字改浅就会直接红。
    it(`${theme.id}: 主按钮文字（常态 + hover 态）≥ 4.5:1`, () => {
      for (const id of ['button', 'button-hover'] as const) {
        const result = auditContrast(resolveBuiltinTheme(theme)).find((item) => item.pair.id === id)!
        expect(
          result.ratio,
          `${theme.id} ${id} ${result.ratio}:1（前景 ${result.foreground} / 背景 ${result.background}）`
        ).toBeGreaterThanOrEqual(4.5)
      }
    })
  }

  it('弱化文案在四种主题、三种背景层上都 ≥ 4.5:1（2026-10-30 用户反馈「提示看不清」后的回归）', () => {
    for (const theme of BUILTIN_THEMES) {
      const results = auditContrast(resolveBuiltinTheme(theme))
      for (const id of ['muted-app', 'muted-surface', 'muted-elevated'] as const) {
        const result = results.find((item) => item.pair.id === id)!
        expect(
          result.ratio,
          `${theme.id} ${id} = ${result.ratio}:1（前景 ${result.foreground} / 背景 ${result.background}）`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('高对比主题的正文对比度显著高于默认深色（不是换个名字而已）', () => {
    const dark = bodyContrastRatio(resolveBuiltinTheme(findBuiltinTheme('termans-dark')!))
    const high = bodyContrastRatio(resolveBuiltinTheme(findBuiltinTheme('termans-contrast')!))
    expect(high).toBeGreaterThan(dark)
    expect(high).toBeGreaterThanOrEqual(20)
  })

  it('contrastProblems 只挑出「低于底线或有警告」的配对', () => {
    const light = resolveBuiltinTheme(findBuiltinTheme('termans-light')!)
    const problems = contrastProblems(light)
    const ids = problems.map((item) => item.pair.id)
    // 主按钮 5.52:1 已达建议值，不再进警告；浅色主题里琥珀落在浅底上的 accent-app（3.58:1）
    // 不破 3:1 底线但低于建议值 4.5 → 必须出现在警告里，这条用于守住「只警告不阻止」的路径。
    expect(ids).not.toContain('button')
    expect(ids).toContain('accent-app')
    expect(ids).not.toContain('body-app')
    for (const problem of problems) expect(problem.failsMin || problem.warns).toBe(true)
  })
})
