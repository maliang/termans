import { z } from 'zod'

/**
 * 主题 token 契约（唯一的 token 清单）。
 *
 * 约定：
 * - 变量名一律 `--ts-` 前缀；**清单就是契约**，改清单要同时改 `src/renderer/styles/tokens.css`
 *   与 `docs/ARCHITECTURE.md`，并由 `tests/contract/theme-tokens.test.ts` 挡回归。
 * - 内置主题必须给全量 token；用户自定义主题只允许覆盖子集（缺的继承内置默认）。
 * - 主题只换「值」，不改「结构」：新增语义不要靠新增变量，先用现有语义。
 * - 变量写错名字不会有任何报错（`color: var(--ts-typo)` 是静默无效声明），所以必须有结构测试。
 */
export const BRAND_TOKENS = [
  '--ts-ink-900',
  '--ts-ink-800',
  '--ts-ink-700',
  '--ts-ink-600',
  '--ts-amber',
  '--ts-amber-soft',
  '--ts-amber-deep',
  '--ts-mint',
  '--ts-danger'
] as const

export const SEMANTIC_TOKENS = [
  '--ts-bg-app',
  '--ts-bg-surface',
  '--ts-bg-elevated',
  '--ts-bg-overlay',
  '--ts-border',
  '--ts-border-strong',
  '--ts-text-primary',
  '--ts-text-secondary',
  '--ts-text-muted',
  '--ts-text-inverse',
  '--ts-accent',
  '--ts-accent-strong',
  '--ts-accent-contrast',
  '--ts-focus-ring',
  '--ts-selection',
  '--ts-status-ok',
  '--ts-status-warn',
  '--ts-status-error'
] as const

/** xterm.js 需要的 ANSI 16 色，顺序即 xterm 的 ansi 索引顺序 */
export const ANSI_TOKENS = [
  '--ts-ansi-black',
  '--ts-ansi-red',
  '--ts-ansi-green',
  '--ts-ansi-yellow',
  '--ts-ansi-blue',
  '--ts-ansi-magenta',
  '--ts-ansi-cyan',
  '--ts-ansi-white',
  '--ts-ansi-bright-black',
  '--ts-ansi-bright-red',
  '--ts-ansi-bright-green',
  '--ts-ansi-bright-yellow',
  '--ts-ansi-bright-blue',
  '--ts-ansi-bright-magenta',
  '--ts-ansi-bright-cyan',
  '--ts-ansi-bright-white'
] as const

export const TYPOGRAPHY_TOKENS = [
  '--ts-font-ui',
  '--ts-font-mono',
  '--ts-font-size-sm',
  '--ts-font-size-base',
  '--ts-font-size-lg'
] as const

export const METRIC_TOKENS = ['--ts-radius-sm', '--ts-radius-md', '--ts-radius-lg', '--ts-titlebar-height'] as const

export const THEME_TOKENS = [
  ...BRAND_TOKENS,
  ...SEMANTIC_TOKENS,
  ...ANSI_TOKENS,
  ...TYPOGRAPHY_TOKENS,
  ...METRIC_TOKENS
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]
export type ThemeTokenName = ThemeToken
export type ThemeTokenColor = ThemeToken

const themeTokenShape = Object.fromEntries(THEME_TOKENS.map((token) => [token, z.string().min(1)])) as Record<
  ThemeToken,
  z.ZodString
>

/** 内置主题：必须给全量 token */
export const themeTokenSetSchema = z.object(themeTokenShape).strict()

/** 用户主题：允许部分覆盖（缺省继承内置 base） */
export const themeTokenPatchSchema = z.object(themeTokenShape).partial().strict()

export type ThemeTokenSet = z.infer<typeof themeTokenSetSchema>
export type ThemeTokenPatch = z.infer<typeof themeTokenPatchSchema>

export const themeAppearanceSchema = z.enum(['dark', 'light'])
export type ThemeAppearance = z.infer<typeof themeAppearanceSchema>

export const themeDefinitionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  appearance: themeAppearanceSchema,
  /** 内置主题不可删除、不可覆盖 */
  builtin: z.boolean(),
  /** 自定义主题基于哪个内置主题扩展 */
  extends: z.string().min(1).nullable(),
  tokens: themeTokenPatchSchema,
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable()
})
export type ThemeDefinition = z.infer<typeof themeDefinitionSchema>

/** 内置主题 id 常量：settings.theme.themeId 与 theme:list 共用 */
export const BUILTIN_THEME_IDS = ['termans-dark', 'termans-light'] as const
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number]

export type AnsiTokenName = (typeof ANSI_TOKENS)[number]

/** 渲染层把 token set 转成 xterm ITheme 时的映射顺序（索引即 ANSI 0..15） */
export function ansiTokenAtIndex(index: number): AnsiTokenName {
  const token = ANSI_TOKENS[index]
  if (!token) throw new RangeError(`ANSI index out of range: ${index}`)
  return token
}
