import { describe, expect, it, vi } from 'vitest'
import { ANSI_TOKENS } from '@shared'
import { findBuiltinTheme, resolveBuiltinTheme } from '@renderer/theme/builtin'
import {
  XTERM_ANSI_KEYS,
  applyXtermTheme,
  buildXtermTheme,
  getXtermTheme,
  registerXterm,
  registeredTerminalCount,
  setActiveTokens,
  subscribeXtermTheme,
  type XtermTerminalLike
} from '@renderer/theme/xterm'

/**
 * xterm 配色联动（SPEC M-01 的「切主题不重建终端」）。
 *
 * 关键事实：只改 CSS 变量 xterm **不会**重绘（它在构造时把主题读进渲染器），
 * 必须重新赋值 `terminal.options.theme`。这里用假终端验证：
 * 切主题 → 已注册终端拿到新的 theme 对象且调用了 refresh，而 terminal 实例本身没被替换。
 */
function fakeTerminal(rows = 24) {
  const refresh = vi.fn()
  const terminal: XtermTerminalLike = { options: {}, rows, refresh }
  return { terminal, refresh }
}

const dark = resolveBuiltinTheme(findBuiltinTheme('termans-dark')!)
const light = resolveBuiltinTheme(findBuiltinTheme('termans-light')!)

describe('buildXtermTheme', () => {
  it('映射语义 token 到 ITheme 的 foreground/background/cursor/selection', () => {
    const theme = buildXtermTheme(dark)
    expect(theme.background).toBe(dark['--ts-bg-app'])
    expect(theme.foreground).toBe(dark['--ts-text-primary'])
    expect(theme.cursor).toBe(dark['--ts-accent'])
    expect(theme.cursorAccent).toBe(dark['--ts-accent-contrast'])
    expect(theme.selectionBackground).toBe(dark['--ts-selection'])
    expect(theme.selectionInactiveBackground).toBe(dark['--ts-selection'])
    // xterm 6 用的是扁平字段（不是 v4 时代的 scrollbarSlider 对象）
    expect(theme.scrollbarSliderBackground).toBe(dark['--ts-border-strong'])
    expect(theme.scrollbarSliderHoverBackground).toBe(dark['--ts-text-muted'])
    expect(theme.scrollbarSliderActiveBackground).toBe(dark['--ts-text-primary'])
  })

  it('16 色 ANSI palette 顺序与 xterm 索引一致', () => {
    const theme = buildXtermTheme(dark)
    expect(XTERM_ANSI_KEYS.length).toBe(16)
    ANSI_TOKENS.forEach((token, index) => {
      const key = XTERM_ANSI_KEYS[index]!
      expect(theme[key as keyof typeof theme], `ANSI ${index} (${token})`).toBe(dark[token])
    })
  })

  it('不同主题产出不同的 palette（不是空实现）', () => {
    const darkTheme = buildXtermTheme(dark)
    const lightTheme = buildXtermTheme(light)
    expect(darkTheme.background).not.toBe(lightTheme.background)
    expect(darkTheme.black).not.toBe(lightTheme.black)
    expect(darkTheme.brightWhite).not.toBe(lightTheme.brightWhite)
  })
})

describe('已打开终端的即时重绘', () => {
  it('registerXterm 立即套用当前主题，并在切主题时刷新而不换实例', () => {
    setActiveTokens(dark)
    const { terminal, refresh } = fakeTerminal()
    const before = getXtermTheme()

    const unregister = registerXterm(terminal)
    expect(registeredTerminalCount()).toBe(1)
    expect(terminal.options.theme).toEqual(before)
    expect(refresh).toHaveBeenCalledTimes(1)

    setActiveTokens(light)
    expect(terminal.options.theme?.background).toBe(light['--ts-bg-app'])
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenLastCalledWith(0, 23)

    unregister()
    expect(registeredTerminalCount()).toBe(0)
    setActiveTokens(dark)
    expect(terminal.options.theme?.background).toBe(light['--ts-bg-app'])
  })

  it('每次切主题都赋新对象（xterm 靠引用变化感知，改了旧对象不生效）', () => {
    const { terminal } = fakeTerminal()
    const unregister = registerXterm(terminal)
    const first = terminal.options.theme
    setActiveTokens(light)
    const second = terminal.options.theme
    expect(second).not.toBe(first)
    expect(first?.background).not.toBe(second?.background)
    unregister()
  })

  it('subscribeXtermTheme 通知订阅者并支持退订', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeXtermTheme(listener)
    setActiveTokens(light)
    expect(listener).toHaveBeenCalledTimes(1)
    const theme = listener.mock.calls[0]![0]
    expect(theme.background).toBe(light['--ts-bg-app'])
    unsubscribe()
    setActiveTokens(dark)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('applyXtermTheme 支持显式传入主题（预览场景）', () => {
    const { terminal, refresh } = fakeTerminal(10)
    applyXtermTheme(terminal, buildXtermTheme(light))
    expect(terminal.options.theme?.background).toBe(light['--ts-bg-app'])
    expect(refresh).toHaveBeenCalledWith(0, 9)
  })

  it('terminal 没有 rows 时不炸（构造早期 refresh 参数用兜底值）', () => {
    const refresh = vi.fn()
    const terminal: XtermTerminalLike = { options: {}, refresh }
    applyXtermTheme(terminal, buildXtermTheme(dark))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
