import { describe, expect, it } from 'vitest'
import { clampFontSize, FALLBACK_MONO_STACK, FONT_SIZE_MAX, FONT_SIZE_MIN, hexOr, nextFontSize, resolveFontFamily } from './xterm-options'

/**
 * 这些用例都跑在 node（vitest environment=node，没有 DOM），所以只测纯换算逻辑；
 * `buildTerminalOptions` / `readTerminalTheme` 需要真实 getComputedStyle，交给 e2e。
 */
describe('字号缩放', () => {
  it('clampFontSize：夹在 8..40 之间，小数四舍五入，非数字退回下限', () => {
    expect(clampFontSize(4)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(999)).toBe(FONT_SIZE_MAX)
    expect(clampFontSize(13.4)).toBe(13)
    expect(clampFontSize(13.5)).toBe(14)
    expect(clampFontSize(Number.NaN)).toBe(FONT_SIZE_MIN)
    expect(clampFontSize(Number.POSITIVE_INFINITY)).toBe(FONT_SIZE_MIN)
  })

  it('nextFontSize：逐步增减，撞到上下限后不再变小/变大', () => {
    expect(nextFontSize(13, 1)).toBe(14)
    expect(nextFontSize(13, -1)).toBe(12)
    expect(nextFontSize(FONT_SIZE_MAX, 1)).toBe(FONT_SIZE_MAX)
    expect(nextFontSize(FONT_SIZE_MIN, -1)).toBe(FONT_SIZE_MIN)
  })
})

describe('resolveFontFamily', () => {
  const readVar = (name: string): string => (name === '--ts-font-mono' ? '  "JetBrains Mono", monospace  ' : '')

  it('var(--ts-font-mono) 解析成计算后的字体栈（前后空白去掉）', () => {
    expect(resolveFontFamily('var(--ts-font-mono)', readVar)).toBe('"JetBrains Mono", monospace')
  })

  it('变量没定义时退回兜底 mono 字体栈', () => {
    expect(resolveFontFamily('var(--ts-font-missing)', readVar)).toBe(FALLBACK_MONO_STACK)
  })

  it('已经是具体字体名时原样使用；空串退回兜底', () => {
    expect(resolveFontFamily('Menlo, monospace', readVar)).toBe('Menlo, monospace')
    expect(resolveFontFamily('   ', readVar)).toBe(FALLBACK_MONO_STACK)
  })
})

describe('hexOr（搜索装饰色只认 #RRGGBB）', () => {
  it('六位十六进制原样返回（大小写都认）', () => {
    expect(hexOr('#2F6FD0', '#000000')).toBe('#2F6FD0')
    expect(hexOr('  #abcdef ', '#000000')).toBe('#abcdef')
  })

  it('rgba()/简写/空值都退回兜底色——否则 addon 会静默丢掉高亮', () => {
    expect(hexOr('rgba(76, 141, 255, 0.35)', '#123456')).toBe('#123456')
    expect(hexOr('#fff', '#123456')).toBe('#123456')
    expect(hexOr('', '#123456')).toBe('#123456')
    expect(hexOr(null, '#123456')).toBe('#123456')
    expect(hexOr(undefined, '#123456')).toBe('#123456')
  })
})
