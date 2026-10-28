import { THEME_TOKENS, themeDefinitionSchema, type ThemeDefinition, type ThemeTokenPatch } from '@shared'
import { isColorString, isCssSafeValue, parseColor } from './color'
import { COLOR_TOKENS, isColorToken, isFontToken, isLengthToken, isThemeToken } from './tokens'

/**
 * 主题 JSON 的导出 / 导入校验（纯函数）。
 *
 * 导入是**不可信输入**：主题值会通过 `style.setProperty` 落到 `<html>` 上，
 * 所以逐条校验（名字、未知 token、颜色、长度、注入字符）之后才交给 zod。
 * 报错必须是「哪个 token、错在哪」这种可读信息 —— SPEC M-08 要求导入失败有可读错误，
 * 而不是 `ZodError: [...]` 糊在界面上。
 *
 * 文件格式（导出）：
 * ```json
 * { "format": "termans-theme", "version": 1, "theme": { …ThemeDefinition } }
 * ```
 * 导入同时兼容裸 ThemeDefinition（别人手写的主题、早期导出）。
 */

export const THEME_FILE_FORMAT = 'termans-theme'
export const THEME_FILE_VERSION = 1

export type ThemeIssueCode =
  | 'invalidJson'
  | 'notObject'
  | 'invalidId'
  | 'invalidName'
  | 'builtinLocked'
  | 'unknownToken'
  | 'invalidColor'
  | 'invalidLength'
  | 'unsafeValue'
  | 'invalidSchema'
  | 'unknownBase'

export interface ThemeIssue {
  code: ThemeIssueCode
  /** 出问题的 token（unknownToken / invalidColor / invalidLength / unsafeValue 有值） */
  token?: string
  /** 原始细节（zod message、非法值等），给「高级信息」用，不直接当标题 */
  detail?: string
}

export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT
  version: number
  theme: ThemeDefinition
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const LENGTH_PATTERN = /^-?\d+(\.\d+)?(px|rem|em|%)$/
const VAR_REFERENCE = /var\(\s*(--ts-[a-z0-9-]+)\s*\)/

/** 导出：包一层文件头，方便以后加版本迁移；用户主题恒为 builtin:false */
export function exportThemeFile(theme: ThemeDefinition): ThemeFile {
  return {
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    theme: { ...theme, builtin: false }
  }
}

export function serializeThemeFile(theme: ThemeDefinition): string {
  return JSON.stringify(exportThemeFile(theme), null, 2)
}

/** token 值校验：颜色类允许 `var(--ts-x)` 引用，长度类必须带单位，字体类只做安全校验 */
export function validateTokenValue(token: string, value: string): ThemeIssue | null {
  if (!isThemeToken(token)) return { code: 'unknownToken', token }
  if (value.trim() === '') return { code: 'unsafeValue', token, detail: 'empty' }
  if (!isCssSafeValue(value)) return { code: 'unsafeValue', token, detail: value }

  if (isColorToken(token)) {
    const reference = VAR_REFERENCE.exec(value)
    if (reference) {
      const referenced = reference[1]
      if (!isThemeToken(referenced)) return { code: 'unknownToken', token, detail: value }
      return null
    }
    if (!isColorString(value)) return { code: 'invalidColor', token, detail: value }
    return null
  }

  if (isLengthToken(token)) {
    if (!LENGTH_PATTERN.test(value.trim())) return { code: 'invalidLength', token, detail: value }
    return null
  }

  if (isFontToken(token)) return null

  return null
}

/** 覆盖集整体校验（内置主题保存前也走这里，保证「值写错」不会静默生效） */
export function validateTokenPatch(patch: ThemeTokenPatch): ThemeIssue[] {
  const issues: ThemeIssue[] = []
  for (const [token, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const issue = validateTokenValue(token, value)
    if (issue) issues.push(issue)
  }
  return issues
}

export interface ParseThemeOptions {
  /** 允许的 extends 基座（内置主题 id）；不传则不校验 */
  knownBaseIds?: readonly string[]
}

export interface ParseThemeSuccess {
  ok: true
  theme: ThemeDefinition
}
export interface ParseThemeFailure {
  ok: false
  issues: ThemeIssue[]
}

export type ParseThemeResult = ParseThemeSuccess | ParseThemeFailure

/**
 * 解析导入的主题 JSON。
 * 永远返回 `{ok:false, issues}` 而不是抛异常：调用方（store/UI）要在同一条链路上
 * 既处理「JSON 语法错」也处理「token 非法」，抛异常会让 UI 不得不写两层 try/catch。
 */
export function parseThemeFile(text: string, options: ParseThemeOptions = {}): ParseThemeResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, issues: [{ code: 'invalidJson', detail: error instanceof Error ? error.message : String(error) }] }
  }
  return parseThemeObject(raw, options)
}

export function parseThemeObject(raw: unknown, options: ParseThemeOptions = {}): ParseThemeResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ code: 'notObject' }] }
  }
  const container = raw as Record<string, unknown>
  const candidate = (container['theme'] ?? container) as Record<string, unknown>

  const issues: ThemeIssue[] = []

  const id = candidate['id']
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    issues.push({ code: 'invalidId', detail: typeof id === 'string' ? id : String(id) })
  }

  const name = candidate['name']
  if (typeof name !== 'string' || name.trim() === '' || name.length > 80) {
    issues.push({ code: 'invalidName' })
  }

  if (candidate['builtin'] === true) {
    // 内置主题由代码提供，导入一份「内置」定义会让人以为可以覆盖它（SPEC M-05）
    issues.push({ code: 'builtinLocked' })
  }

  const extendsId = candidate['extends']
  if (extendsId !== null && extendsId !== undefined && typeof extendsId !== 'string') {
    issues.push({ code: 'invalidSchema', detail: 'extends must be string|null' })
  } else if (typeof extendsId === 'string' && options.knownBaseIds && !options.knownBaseIds.includes(extendsId)) {
    issues.push({ code: 'unknownBase', detail: extendsId })
  }

  const tokens = candidate['tokens']
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    issues.push({ code: 'invalidSchema', detail: 'tokens must be an object' })
  } else {
    for (const [token, value] of Object.entries(tokens as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        issues.push({ code: 'invalidSchema', token, detail: 'value must be a string' })
        continue
      }
      const issue = validateTokenValue(token, value)
      if (issue) issues.push(issue)
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  // 结构层交给契约 schema（多一个未知 token 会因为 tokens 是 strict 而失败）
  const parsed = themeDefinitionSchema.safeParse({
    id,
    name: typeof name === 'string' ? name.trim() : name,
    appearance: candidate['appearance'] === 'light' ? 'light' : 'dark',
    builtin: false,
    extends: typeof extendsId === 'string' ? extendsId : null,
    tokens: tokens as ThemeTokenPatch,
    createdAt: typeof candidate['createdAt'] === 'string' ? candidate['createdAt'] : null,
    updatedAt: typeof candidate['updatedAt'] === 'string' ? candidate['updatedAt'] : null
  })

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: 'invalidSchema' as const,
        token: issue.path.length > 1 ? String(issue.path[1]) : undefined,
        detail: issue.message
      }))
    }
  }

  return { ok: true, theme: parsed.data }
}

/** 主题名 → 候选 id（`My Theme!` → `my-theme`），并避开已存在的 id */
export function slugifyThemeId(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'custom'
  if (!taken.includes(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

/** 从当前主题派生一份可编辑副本（应用外观、基座、名次都跟着走） */
export function cloneThemeForEditing(
  source: ThemeDefinition,
  overrides: Partial<ThemeDefinition> = {}
): ThemeDefinition {
  return {
    ...source,
    tokens: { ...source.tokens },
    ...overrides
  }
}

/** 供 UI 展示「覆盖了 N/52」用；不做校验 */
export function coveredTokens(patch: ThemeTokenPatch): string[] {
  return THEME_TOKENS.filter((token) => patch[token] !== undefined)
}

/** 颜色类 token 的当前值（取色器需要 `#rrggbb`；rgba/var 值取色器显示不了，返回 null） */
export function colorInputValue(value: string | undefined): string | null {
  if (!value) return null
  const parsed = parseColor(value)
  if (!parsed) return null
  if (parsed.a < 1) return null
  const hex = (channel: number): string => channel.toString(16).padStart(2, '0')
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`
}

export const COLOR_TOKEN_LIST: readonly string[] = COLOR_TOKENS
