import { BUILTIN_THEME_IDS, type ThemeDefinition, type ThemeTokenPatch, type ThemeTokenSet } from '@shared'
import { resolveThemeTokens, resolveTokenSet, type ResolvedTokens } from './tokens'

/**
 * 内置主题（**唯一数据源**）。
 *
 * 与 `src/renderer/styles/tokens.css` 的关系：
 * - `termans-dark` / `termans-light` 的 token 值与 tokens.css 的 `:root` / `[data-theme='light']`
 *   必须**逐字一致**（`tests/contract/theme-builtin.test.ts` 会解析 CSS 后比对，防止两处漂移）。
 *   tokens.css 只承担「首帧兜底」：设置还没读回来之前，CSS 先给出深色外观，避免白闪。
 * - `termans-midnight` / `termans-contrast` 只在 TS 里存在，由渲染层切换时整组覆盖 CSS 变量。
 *
 * 为什么值里还保留 `var(--ts-ink-900)` 这种别名而不是全部写字面值：
 * 都是为了跟 tokens.css 保持同构（语义层引用品牌层），解析成字面值的工作由
 * `resolveThemeTokens()` 在切换主题时统一做，xterm 与对比度计算拿到的一定是字面值。
 */

const FONTS: ThemeTokenPatch = {
  '--ts-font-ui':
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif",
  '--ts-font-mono': "'SF Mono', 'JetBrains Mono', 'Cascadia Mono', Menlo, Consolas, 'Liberation Mono', monospace"
}

const SIZES: ThemeTokenPatch = {
  '--ts-font-size-sm': '12px',
  '--ts-font-size-base': '13px',
  '--ts-font-size-lg': '15px',
  '--ts-radius-sm': '6px',
  '--ts-radius-md': '10px',
  '--ts-radius-lg': '14px',
  '--ts-titlebar-height': '38px'
}

/** 深色默认主题（= tokens.css `:root` 的一套值，改这里要同步改 CSS） */
const DARK_TOKENS: ThemeTokenPatch = {
  '--ts-ink-900': '#05080e',
  '--ts-ink-800': '#0d1424',
  '--ts-ink-700': '#1c2746',
  '--ts-ink-600': '#253257',
  '--ts-amber': '#f8ab24',
  '--ts-amber-soft': '#ffe2a8',
  '--ts-amber-deep': '#c86a08',
  '--ts-mint': '#1d9663',
  '--ts-danger': '#e0553b',

  '--ts-bg-app': 'var(--ts-ink-900)',
  '--ts-bg-surface': 'var(--ts-ink-800)',
  '--ts-bg-elevated': 'var(--ts-ink-700)',
  '--ts-bg-overlay': 'rgba(5, 8, 14, 0.72)',
  '--ts-border': 'rgba(255, 255, 255, 0.08)',
  '--ts-border-strong': 'rgba(255, 255, 255, 0.16)',
  '--ts-text-primary': '#e8edf7',
  '--ts-text-secondary': '#9aa8c0',
  '--ts-text-muted': '#8593ad',
  '--ts-text-inverse': '#05080e',
  '--ts-accent': 'var(--ts-amber)',
  '--ts-accent-strong': 'var(--ts-amber-deep)',
  '--ts-accent-contrast': '#0b0f18',
  '--ts-focus-ring': 'rgba(248, 171, 36, 0.55)',
  '--ts-selection': 'rgba(248, 171, 36, 0.24)',
  '--ts-status-ok': 'var(--ts-mint)',
  '--ts-status-warn': 'var(--ts-amber-soft)',
  '--ts-status-error': 'var(--ts-danger)',

  '--ts-ansi-black': '#0d1424',
  '--ts-ansi-red': '#e0553b',
  '--ts-ansi-green': '#1d9663',
  '--ts-ansi-yellow': '#f8ab24',
  '--ts-ansi-blue': '#4c7df0',
  '--ts-ansi-magenta': '#a574e8',
  '--ts-ansi-cyan': '#3fb6c8',
  '--ts-ansi-white': '#c7d2e4',
  '--ts-ansi-bright-black': '#3a4866',
  '--ts-ansi-bright-red': '#ff7a63',
  '--ts-ansi-bright-green': '#35c68a',
  '--ts-ansi-bright-yellow': '#ffcb63',
  '--ts-ansi-bright-blue': '#7ba0ff',
  '--ts-ansi-bright-magenta': '#c79bf5',
  '--ts-ansi-bright-cyan': '#6bd8e8',
  '--ts-ansi-bright-white': '#f2f6ff',

  ...FONTS,
  ...SIZES
}

/** 浅色主题（= tokens.css `[data-theme='light']` 的一套值，改这里要同步改 CSS） */
const LIGHT_TOKENS: ThemeTokenPatch = {
  '--ts-ink-900': '#f7f8fb',
  '--ts-ink-800': '#ffffff',
  '--ts-ink-700': '#edf0f7',
  '--ts-ink-600': '#dde3ee',
  '--ts-amber': '#f8ab24',
  '--ts-amber-soft': '#7a4a08',
  '--ts-amber-deep': '#c86a08',
  '--ts-mint': '#16794f',
  '--ts-danger': '#c23b22',

  '--ts-bg-app': 'var(--ts-ink-900)',
  '--ts-bg-surface': 'var(--ts-ink-800)',
  '--ts-bg-elevated': 'var(--ts-ink-700)',
  '--ts-bg-overlay': 'rgba(247, 248, 251, 0.82)',
  '--ts-border': 'rgba(16, 24, 40, 0.1)',
  '--ts-border-strong': 'rgba(16, 24, 40, 0.2)',
  '--ts-text-primary': '#0d1424',
  '--ts-text-secondary': '#4a5a78',
  '--ts-text-muted': '#5f6b80',
  '--ts-text-inverse': '#ffffff',
  '--ts-accent': 'var(--ts-amber-deep)',
  '--ts-accent-strong': '#bc5f07',
  '--ts-accent-contrast': '#000000',
  '--ts-focus-ring': 'rgba(200, 106, 8, 0.45)',
  '--ts-selection': 'rgba(248, 171, 36, 0.35)',
  '--ts-status-ok': 'var(--ts-mint)',
  '--ts-status-warn': '#a86a00',
  '--ts-status-error': 'var(--ts-danger)',

  '--ts-ansi-black': '#1c2746',
  '--ts-ansi-red': '#b83b23',
  '--ts-ansi-green': '#14724e',
  '--ts-ansi-yellow': '#8a5a00',
  '--ts-ansi-blue': '#2c56c8',
  '--ts-ansi-magenta': '#7a3fc0',
  '--ts-ansi-cyan': '#0f7280',
  '--ts-ansi-white': '#58657e',
  '--ts-ansi-bright-black': '#6b7891',
  '--ts-ansi-bright-red': '#d1482c',
  '--ts-ansi-bright-green': '#1a8c5f',
  '--ts-ansi-bright-yellow': '#a86a00',
  '--ts-ansi-bright-blue': '#3a6bd8',
  '--ts-ansi-bright-magenta': '#8f52d8',
  '--ts-ansi-bright-cyan': '#138a99',
  '--ts-ansi-bright-white': '#2a3550',

  ...FONTS,
  ...SIZES
}

/**
 * 深蓝主题：终端长时间盯屏时比纯黑更不刺眼，同时保持琥珀 accent 不动（品牌规则）。
 * 只改中性色阶与 ANSI 色，不改语义结构。
 */
const MIDNIGHT_TOKENS: ThemeTokenPatch = {
  '--ts-ink-900': '#040a1c',
  '--ts-ink-800': '#081228',
  '--ts-ink-700': '#0f1f42',
  '--ts-ink-600': '#16305c',
  '--ts-amber': '#f8ab24',
  '--ts-amber-soft': '#ffe2a8',
  '--ts-amber-deep': '#c86a08',
  '--ts-mint': '#17a06a',
  '--ts-danger': '#ef5b41',

  '--ts-bg-app': 'var(--ts-ink-900)',
  '--ts-bg-surface': 'var(--ts-ink-800)',
  '--ts-bg-elevated': 'var(--ts-ink-700)',
  '--ts-bg-overlay': 'rgba(4, 10, 28, 0.78)',
  '--ts-border': 'rgba(122, 168, 255, 0.14)',
  '--ts-border-strong': 'rgba(122, 168, 255, 0.28)',
  '--ts-text-primary': '#e7efff',
  '--ts-text-secondary': '#a3b8dc',
  '--ts-text-muted': '#7b90b8',
  '--ts-text-inverse': '#040a1c',
  '--ts-accent': 'var(--ts-amber)',
  '--ts-accent-strong': 'var(--ts-amber-deep)',
  '--ts-accent-contrast': '#061021',
  '--ts-focus-ring': 'rgba(248, 171, 36, 0.6)',
  '--ts-selection': 'rgba(96, 150, 255, 0.3)',
  '--ts-status-ok': 'var(--ts-mint)',
  '--ts-status-warn': 'var(--ts-amber-soft)',
  '--ts-status-error': 'var(--ts-danger)',

  '--ts-ansi-black': '#081228',
  '--ts-ansi-red': '#ef5b41',
  '--ts-ansi-green': '#2fbf82',
  '--ts-ansi-yellow': '#f8ab24',
  '--ts-ansi-blue': '#5a8dff',
  '--ts-ansi-magenta': '#a97cf0',
  '--ts-ansi-cyan': '#45c6d8',
  '--ts-ansi-white': '#cbd8ee',
  '--ts-ansi-bright-black': '#3d5480',
  '--ts-ansi-bright-red': '#ff8070',
  '--ts-ansi-bright-green': '#42d99a',
  '--ts-ansi-bright-yellow': '#ffcb63',
  '--ts-ansi-bright-blue': '#86afff',
  '--ts-ansi-bright-magenta': '#c4a0ff',
  '--ts-ansi-bright-cyan': '#6fe0ee',
  '--ts-ansi-bright-white': '#f0f6ff',

  ...FONTS,
  ...SIZES
}

/**
 * 高对比主题：给弱视/强光环境用。正文与背景拉到 21:1 附近，边框加粗可见，
 * accent 换成更亮的琥珀（`#ffcc33`）以拉开与黑底的距离；同时保证 accent 上的黑字 ≥ 4.5:1。
 */
const CONTRAST_TOKENS: ThemeTokenPatch = {
  '--ts-ink-900': '#000000',
  '--ts-ink-800': '#0a0a0a',
  '--ts-ink-700': '#161616',
  '--ts-ink-600': '#242424',
  '--ts-amber': '#ffcc33',
  '--ts-amber-soft': '#fff3cc',
  '--ts-amber-deep': '#ffb300',
  '--ts-mint': '#00e08c',
  '--ts-danger': '#ff5c4d',

  '--ts-bg-app': 'var(--ts-ink-900)',
  '--ts-bg-surface': 'var(--ts-ink-800)',
  '--ts-bg-elevated': 'var(--ts-ink-700)',
  '--ts-bg-overlay': 'rgba(0, 0, 0, 0.86)',
  '--ts-border': 'rgba(255, 255, 255, 0.42)',
  '--ts-border-strong': 'rgba(255, 255, 255, 0.72)',
  '--ts-text-primary': '#ffffff',
  '--ts-text-secondary': '#ececec',
  '--ts-text-muted': '#c8c8c8',
  '--ts-text-inverse': '#000000',
  '--ts-accent': 'var(--ts-amber)',
  '--ts-accent-strong': 'var(--ts-amber-deep)',
  '--ts-accent-contrast': '#000000',
  '--ts-focus-ring': 'rgba(255, 204, 51, 0.9)',
  '--ts-selection': 'rgba(255, 204, 51, 0.42)',
  '--ts-status-ok': 'var(--ts-mint)',
  '--ts-status-warn': 'var(--ts-amber-soft)',
  '--ts-status-error': 'var(--ts-danger)',

  '--ts-ansi-black': '#1a1a1a',
  '--ts-ansi-red': '#ff5c4d',
  '--ts-ansi-green': '#00e08c',
  '--ts-ansi-yellow': '#ffcc33',
  '--ts-ansi-blue': '#6ea8ff',
  '--ts-ansi-magenta': '#d79bff',
  '--ts-ansi-cyan': '#56e0f0',
  '--ts-ansi-white': '#f0f0f0',
  '--ts-ansi-bright-black': '#8a8a8a',
  '--ts-ansi-bright-red': '#ff8f82',
  '--ts-ansi-bright-green': '#4dffb8',
  '--ts-ansi-bright-yellow': '#ffe680',
  '--ts-ansi-bright-blue': '#a5c8ff',
  '--ts-ansi-bright-magenta': '#e8c2ff',
  '--ts-ansi-bright-cyan': '#99f0ff',
  '--ts-ansi-bright-white': '#ffffff',

  ...FONTS,
  ...SIZES
}

const BUILTIN_TIMESTAMP = '2026-10-29T00:00:00.000Z'

function builtinTheme(
  id: string,
  name: string,
  appearance: 'dark' | 'light',
  tokens: ThemeTokenPatch
): ThemeDefinition {
  return {
    id,
    name,
    appearance,
    builtin: true,
    extends: null,
    tokens,
    createdAt: BUILTIN_TIMESTAMP,
    updatedAt: BUILTIN_TIMESTAMP
  }
}

/**
 * 四套内置主题。
 * 顺序即 UI 里的展示顺序（默认主题在前）。
 *
 * 注意：`BUILTIN_THEME_IDS`（shared 契约）只固定了 `termans-dark` / `termans-light` 两个核心 id
 * （settings 默认值与首帧兜底用）。新增的 `termans-midnight` / `termans-contrast` 同样是内置主题，
 * 判定「是否内置」统一用 `ThemeDefinition.builtin === true`，不要用 id 白名单。
 */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  builtinTheme('termans-dark', 'Termans Dark', 'dark', DARK_TOKENS),
  builtinTheme('termans-midnight', 'Termans Midnight', 'dark', MIDNIGHT_TOKENS),
  builtinTheme('termans-light', 'Termans Light', 'light', LIGHT_TOKENS),
  builtinTheme('termans-contrast', 'Termans High Contrast', 'dark', CONTRAST_TOKENS)
]

/** 默认主题 id（settings 的默认值；必须是 BUILTIN_THEME_IDS 之一） */
export const DEFAULT_THEME_ID = BUILTIN_THEME_IDS[0]

export function findBuiltinTheme(id: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((theme) => theme.id === id)
}

/** 是否内置主题（以 `builtin` 标记为准，兼容未来 shared 增加 id 常量） */
export function isBuiltinTheme(theme: Pick<ThemeDefinition, 'builtin' | 'id'>): boolean {
  return theme.builtin || findBuiltinTheme(theme.id) !== undefined
}

/** 主题的「基座」：自定义主题继承 `extends` 指向的内置主题，否则回退默认深色 */
export function baseThemeFor(theme: Pick<ThemeDefinition, 'extends'>): ThemeDefinition {
  return (theme.extends ? findBuiltinTheme(theme.extends) : undefined) ?? findBuiltinTheme(DEFAULT_THEME_ID)!
}

/** 内置主题 → 完整字面值集合（`var()` 别名展开） */
export function resolveBuiltinTheme(theme: ThemeDefinition): ResolvedTokens {
  return resolveTokenSet(theme.tokens as ThemeTokenSet)
}

/**
 * 任意主题（内置或自定义）→ 完整字面值集合。
 * 自定义主题：先取 `extends` 指向的内置主题做基座，再叠加自己的覆盖集。
 */
export function resolveThemeDefinition(theme: ThemeDefinition): ResolvedTokens {
  if (isBuiltinTheme(theme)) return resolveBuiltinTheme(theme)
  return resolveThemeTokens(resolveBuiltinTheme(baseThemeFor(theme)), theme.tokens)
}
