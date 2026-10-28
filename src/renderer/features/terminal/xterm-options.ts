import type { ITheme, ITerminalOptions } from '@xterm/xterm'
import { ANSI_TOKENS, type TerminalSettings } from '@shared'

/**
 * 设置 → xterm 选项的转换。
 *
 * 两个容易踩的点：
 * 1. `settings.terminal.fontFamily` 的默认值是 CSS 变量写法 `var(--ts-font-mono)`。
 *    xterm 要的是真正的 font-family 字符串，把它原样塞进 canvas/DOM 会静默退回浏览器默认字体
 *    （字宽算错 → 列数错 → 远端 vim/top 折行），所以必须在这里解析成计算值。
 * 2. 主题色全部来自 `--ts-*` token（16 个 ANSI + 前景/背景/光标/选区），
 *    顺序即 xterm 的 ANSI 索引；漏映射一个，`tput setaf` 的颜色就不对。
 */

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 40
export const FONT_SIZE_STEP = 1

export const FALLBACK_MONO_STACK =
  "'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace"

const CSS_VAR_PATTERN = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return FONT_SIZE_MIN
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)))
}

export function nextFontSize(current: number, delta: number): number {
  return clampFontSize(current + delta)
}

/** `var(--ts-font-mono)` → 计算后的字体栈；解析不到就用兜底 mono 字体栈 */
export function resolveFontFamily(raw: string, readVariable: (name: string) => string): string {
  const trimmed = raw.trim()
  const match = CSS_VAR_PATTERN.exec(trimmed)
  if (!match) return trimmed.length > 0 ? trimmed : FALLBACK_MONO_STACK
  const resolved = readVariable(match[1]).trim()
  return resolved.length > 0 ? resolved : FALLBACK_MONO_STACK
}

/**
 * 取一个 `#RRGGBB` 色值；不是六位十六进制就用兜底色。
 *
 * addon-search 的装饰色只接受 `#RRGGBB`（见 `ISearchDecorationOptions` 注释），
 * 而主题 token 里有 rgba()/hsl() 之类的复合写法，直接塞进去会被 addon 静默忽略，
 * 表现为「搜索有命中但没有高亮」。
 */
export function hexOr(value: string | null | undefined, fallback: string): string {
  const trimmed = (value ?? '').trim()
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed : fallback
}

/** 从 CSS 变量建 xterm 主题；readVariable 返回空串时该键不写（让 xterm 用默认色） */
export function readTerminalTheme(readVariable: (name: string) => string): ITheme {
  const theme: ITheme = {}
  const set = (key: keyof ITheme, token: string): void => {
    const value = readVariable(token).trim()
    if (value.length > 0) {
      // ITheme 的键都是 string|undefined，这里按索引赋值需要断言
      ;(theme as Record<string, string | undefined>)[key as string] = value
    }
  }
  set('foreground', '--ts-text-primary')
  set('background', '--ts-bg-app')
  set('cursor', '--ts-accent')
  set('cursorAccent', '--ts-bg-app')
  set('selectionBackground', '--ts-selection')
  const ansiKeys = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite'
  ] as const
  ansiKeys.forEach((key, index) => {
    const token = ANSI_TOKENS[index]
    if (token) set(key, token)
  })
  return theme
}

export interface BuildOptionsDeps {
  /** 已解析的字体栈（见 resolveFontFamily） */
  fontFamily: string
  theme: ITheme
  /** 单测/非 DOM 环境下可关掉 proposed API（search 的 decorations 需要它） */
  allowProposedApi?: boolean
}

export function buildTerminalOptions(settings: TerminalSettings, deps: BuildOptionsDeps): ITerminalOptions {
  return {
    fontFamily: deps.fontFamily,
    fontSize: clampFontSize(settings.fontSize),
    lineHeight: settings.lineHeight,
    letterSpacing: 0,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: settings.scrollback,
    theme: deps.theme,
    // addon-search 的高亮装饰走 proposed API；不开的话搜索能命中但没有高亮
    allowProposedApi: deps.allowProposedApi ?? true,
    allowTransparency: false,
    convertEol: false,
    // mac 上 Option 作为 Meta（否则 Alt+B 之类的前缀键无法送进 shell）
    macOptionIsMeta: true,
    // 右键由我们自己接管（有选区复制、否则粘贴），不让 xterm 抢成 "选择单词"
    rightClickSelectsWord: false,
    smoothScrollDuration: 0,
    // 终端里换行分隔符放宽，避免粘贴路径/URL 被当成单词选择
    drawBoldTextInBrightColors: false
  }
}

/** DOM 侧读取 CSS 变量；target 默认 documentElement（主题挂在 :root 上） */
export function createCssVariableReader(target?: HTMLElement | null): (name: string) => string {
  return (name: string) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return ''
    const element = target ?? document.documentElement
    const value = window.getComputedStyle(element).getPropertyValue(name)
    return value.trim()
  }
}
