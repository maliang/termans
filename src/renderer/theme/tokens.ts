import {
  ANSI_TOKENS,
  BRAND_TOKENS,
  METRIC_TOKENS,
  SEMANTIC_TOKENS,
  THEME_TOKENS,
  TYPOGRAPHY_TOKENS,
  type ThemeToken,
  type ThemeTokenPatch,
  type ThemeTokenSet
} from '@shared'

/**
 * token 的**语义分组**与解析（纯函数）。
 *
 * 主题 = 「token 覆盖集」：内置主题给全量，用户主题只给子集（缺的继承 `extends` 的内置主题）。
 * 但浏览器里 `var(--ts-bg-app)` 引用的是 `var(--ts-ink-900)`，落到 xterm / 对比度计算时需要**字面值**，
 * 所以这里做一次 `var()` 链解析，把「覆盖集」变成「包含 52 个字面值的完整集合」。
 *
 * 别在组件里做这件事：`getComputedStyle` 拿到的值依赖当前 DOM 与样式表加载顺序，
 * 首帧/离屏/测试环境下都不可靠。
 */

/** 解析后的完整 token 集合（每个都是可直接使用的字面值，不含 `var()`） */
export type ResolvedTokens = Record<ThemeToken, string>

/** 颜色类 token：编辑器里给取色器、导入时按颜色校验 */
export const COLOR_TOKENS: readonly ThemeToken[] = [...BRAND_TOKENS, ...SEMANTIC_TOKENS, ...ANSI_TOKENS]

/** 长度类 token：只接受 px/rem/em（写死成色值等于把排版弄坏） */
export const LENGTH_TOKENS: readonly ThemeToken[] = [
  '--ts-font-size-sm',
  '--ts-font-size-base',
  '--ts-font-size-lg',
  '--ts-radius-sm',
  '--ts-radius-md',
  '--ts-radius-lg',
  '--ts-titlebar-height'
]

/** 字体族 token：值是一串字体名，不做颜色/长度校验 */
export const FONT_TOKENS: readonly ThemeToken[] = ['--ts-font-ui', '--ts-font-mono']

export interface TokenGroup {
  id: 'brand' | 'semantic' | 'ansi' | 'typography' | 'metric'
  tokens: readonly ThemeToken[]
}

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  { id: 'brand', tokens: BRAND_TOKENS },
  { id: 'semantic', tokens: SEMANTIC_TOKENS },
  { id: 'ansi', tokens: ANSI_TOKENS },
  { id: 'typography', tokens: TYPOGRAPHY_TOKENS },
  { id: 'metric', tokens: METRIC_TOKENS }
]

const THEME_TOKEN_SET = new Set<string>(THEME_TOKENS)
const COLOR_TOKEN_SET = new Set<string>(COLOR_TOKENS)
const LENGTH_TOKEN_SET = new Set<string>(LENGTH_TOKENS)
const FONT_TOKEN_SET = new Set<string>(FONT_TOKENS)

export function isThemeToken(value: string): value is ThemeToken {
  return THEME_TOKEN_SET.has(value)
}

export function isColorToken(token: ThemeToken): boolean {
  return COLOR_TOKEN_SET.has(token)
}

export function isLengthToken(token: ThemeToken): boolean {
  return LENGTH_TOKEN_SET.has(token)
}

export function isFontToken(token: ThemeToken): boolean {
  return FONT_TOKEN_SET.has(token)
}

/** 主题编辑器/导入错误里展示的分组名（i18n key 后缀，UI 侧拼 `settings:themeEditor.group.<id>`） */
export function tokenGroupOf(token: ThemeToken): TokenGroup['id'] {
  const group = TOKEN_GROUPS.find((entry) => entry.tokens.includes(token))
  return group ? group.id : 'semantic'
}

const MAX_VAR_DEPTH = 16

const VAR_REFERENCE = /var\(\s*(--ts-[a-z0-9-]+)\s*(?:,\s*([^()]*))?\)/gi

/**
 * 把值里的 `var(--ts-x[, fallback])` 替换成 `lookup` 给出的字面值。
 * 支持多层链（`--ts-bg-app → --ts-ink-900`），最多下钻 `MAX_VAR_DEPTH` 层，防止自引用死循环。
 */
export function resolveVarReferences(
  value: string,
  lookup: (token: ThemeToken) => string | undefined,
  depth = 0
): string {
  if (!value.includes('var(')) return value
  if (depth > MAX_VAR_DEPTH) return value
  return value.replace(VAR_REFERENCE, (match, rawToken: string, fallback: string | undefined) => {
    const token = rawToken as ThemeToken
    const resolved = isThemeToken(token) ? lookup(token) : undefined
    if (resolved === undefined) {
      if (fallback !== undefined) return resolveVarReferences(fallback.trim(), lookup, depth + 1)
      return match
    }
    return resolveVarReferences(resolved, lookup, depth + 1)
  })
}

/**
 * 内置主题（全量）解析：把自身 `var()` 引用展开成字面值。
 * 自引用的 token 原样保留（而不是抛错），这样「值写错」会在对比度/预览上暴露，而不是白屏。
 */
export function resolveTokenSet(tokens: ThemeTokenSet | ResolvedTokens): ResolvedTokens {
  const resolved = {} as ResolvedTokens
  const lookup = (token: ThemeToken): string | undefined => {
    const raw = (tokens as Partial<Record<ThemeToken, string>>)[token]
    if (raw === undefined) return undefined
    return resolveVarReferences(raw, lookup, 0)
  }
  for (const token of THEME_TOKENS) {
    const raw = (tokens as Partial<Record<ThemeToken, string>>)[token]
    resolved[token] = raw === undefined ? '' : resolveVarReferences(raw, lookup, 0)
  }
  return resolved
}

/**
 * 主题覆盖集 → 完整字面值集合。
 * `base` 必须是已解析的内置主题；`patch` 里缺的字段继承 base，值里的 `var(--ts-x)` 也按 base 解析。
 */
export function resolveThemeTokens(base: ResolvedTokens, patch: ThemeTokenPatch): ResolvedTokens {
  const merged = {} as ResolvedTokens
  for (const token of THEME_TOKENS) {
    const override = patch[token]
    merged[token] = override ?? base[token]
  }
  const lookup = (token: ThemeToken): string | undefined => merged[token]
  const resolved = {} as ResolvedTokens
  for (const token of THEME_TOKENS) {
    resolved[token] = resolveVarReferences(merged[token], lookup, 0)
  }
  return resolved
}

/** 覆盖率：内置主题必须 52/52，用户主题可以只覆盖子集（用于 UI 上的「覆盖 3/52」提示） */
export function coverageOf(patch: ThemeTokenPatch): { covered: number; total: number } {
  const covered = THEME_TOKENS.filter((token) => patch[token] !== undefined).length
  return { covered, total: THEME_TOKENS.length }
}

/** 两个 token 集合里值不同的 token（导出/预览提示用） */
export function diffTokens(a: Partial<Record<ThemeToken, string>>, b: Partial<Record<ThemeToken, string>>): ThemeToken[] {
  return THEME_TOKENS.filter((token) => a[token] !== b[token])
}

/** 把完整集合转成「全量 patch」（内置主题 → 主题定义时需要，用户导出则只写自己覆盖的 token） */
export function patchFromTokens(tokens: ResolvedTokens): ThemeTokenPatch {
  const patch: ThemeTokenPatch = {}
  for (const token of THEME_TOKENS) patch[token] = tokens[token]
  return patch
}
