import type { ITheme } from '@xterm/xterm'
import { ANSI_TOKENS } from '@shared'
import { BUILTIN_THEMES, DEFAULT_THEME_ID, resolveThemeDefinition } from './builtin'
import type { ResolvedTokens } from './tokens'

/**
 * xterm.js 配色联动。
 *
 * 关键点（踩过的坑）：**只改 CSS 变量不会让已经打开的终端重绘**。
 * xterm 把主题缓存在实例内部，必须重新赋值 `terminal.options.theme`（必要时再 `refresh`），
 * 才能让背景/前景/16 色 palette 跟着变；而**不能**重建实例——重建会丢掉滚动缓冲、
 * 正在跑的会话绑定，用户看到的是「切主题后历史输出没了」。
 *
 * 对外契约（terminal 功能模块接这一个口子就够）：
 * - `registerXterm(term)`：挂载时注册，返回注销函数。注册即拿到当前主题，此后每次切主题都会自动重绘。
 * - `applyXtermTheme(term)`：不想用注册表时手动应用一次。
 * - `useXtermTheme()`（./hooks）：React 侧拿当前 ITheme，配合 `options.theme` 使用。
 * - `subscribeXtermTheme(fn)`：非 React 消费者订阅变化。
 */

export const XTERM_ANSI_KEYS = [
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

export type XtermAnsiKey = (typeof XTERM_ANSI_KEYS)[number]

/** 只依赖我们真正用到的 Terminal 成员，测试里可以传假对象 */
export interface XtermTerminalLike {
  options: { theme?: ITheme }
  rows?: number
  refresh?(start: number, end: number): void
}

/**
 * token → xterm ITheme。
 * 背景用 `--ts-bg-app`（与终端区容器同色，避免「终端比周围深一块」的接缝），
 * 光标/选区沿用语义 token，保证切主题时它们跟着品牌规则走（琥珀=可操作）。
 */
export function buildXtermTheme(tokens: ResolvedTokens): ITheme {
  const theme: ITheme = {
    foreground: tokens['--ts-text-primary'],
    background: tokens['--ts-bg-app'],
    cursor: tokens['--ts-accent'],
    cursorAccent: tokens['--ts-accent-contrast'],
    selectionBackground: tokens['--ts-selection'],
    selectionInactiveBackground: tokens['--ts-selection'],
    scrollbarSliderBackground: tokens['--ts-border-strong'],
    scrollbarSliderHoverBackground: tokens['--ts-text-muted'],
    scrollbarSliderActiveBackground: tokens['--ts-text-primary']
  }
  XTERM_ANSI_KEYS.forEach((key, index) => {
    const token = ANSI_TOKENS[index]
    if (token) theme[key] = tokens[token]
  })
  return theme
}

/** 默认深色主题的 xterm 配色（首帧兜底：设置还没读回来时终端也有正确颜色） */
const DEFAULT_XTERM_THEME = buildXtermTheme(
  resolveThemeDefinition(BUILTIN_THEMES.find((theme) => theme.id === DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]!)
)

let activeTheme: ITheme = DEFAULT_XTERM_THEME
let activeTokens: ResolvedTokens | null = null

type ThemeListener = (theme: ITheme) => void

const listeners = new Set<ThemeListener>()
const terminals = new Set<XtermTerminalLike>()

export function getXtermTheme(): ITheme {
  return activeTheme
}

export function getActiveTokens(): ResolvedTokens | null {
  return activeTokens
}

/**
 * 更新当前主题并让所有已注册终端立即重绘。
 * 由 `applyThemeToDocument()` 调用（主题 store 不直接碰 xterm）。
 */
export function setActiveTokens(tokens: ResolvedTokens): void {
  activeTokens = tokens
  activeTheme = buildXtermTheme(tokens)
  for (const terminal of terminals) applyXtermTheme(terminal, activeTheme)
  for (const listener of listeners) listener(activeTheme)
}

/**
 * 把主题写到实例上。
 * - 每次都赋一个**新对象**：xterm 依赖 options 变更来触发重绘/清缓存，
 *   复用同一个引用会被当成「没变」；
 * - `refresh(0, rows-1)` 兜一层：只改主题不刷新时，部分版本会残留旧背景的单元格。
 */
export function applyXtermTheme(terminal: XtermTerminalLike, theme: ITheme = activeTheme): void {
  terminal.options.theme = { ...theme }
  if (typeof terminal.refresh === 'function') {
    const rows = typeof terminal.rows === 'number' && terminal.rows > 0 ? terminal.rows : 24
    terminal.refresh(0, rows - 1)
  }
}

/** 注册终端实例：立即应用当前主题，返回注销函数（在组件 unmount 时调用） */
export function registerXterm(terminal: XtermTerminalLike): () => void {
  terminals.add(terminal)
  applyXtermTheme(terminal)
  return () => {
    terminals.delete(terminal)
  }
}

/** 非 React 消费者订阅主题变化；返回取消订阅函数 */
export function subscribeXtermTheme(listener: ThemeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 仅供测试/诊断：当前注册的终端数量 */
export function registeredTerminalCount(): number {
  return terminals.size
}
