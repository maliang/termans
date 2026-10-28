import type { Locale } from '@shared'
import { DEFAULT_LOCALE, LOCALES } from '@shared'

/**
 * 语言探测与首启决策。
 *
 * 规则（与 docs/i18n.md「首启与持久化」一致）：
 * 1. 用户显式切换过语言 → 永久记住（localStorage 打标 + `settings.locale` 落盘），不再跟随系统。
 * 2. 从未切换过 → 用系统语言匹配支持的 locale；匹配不到用 `DEFAULT_LOCALE`（en）。
 * 3. 只有 [[`LOCALES`]] 里的语言会被采用，其它系统语言一律回落到 en。
 */

export const LOCALE_PREFERENCE_KEY = 'termans:locale:v1'

/** 系统语言 → 支持的 locale；`zh`/`zh-Hans`/`zh-TW` 一律归到 `zh-CN`（当前唯一中文变体） */
export function matchLocale(candidate: string | undefined | null): Locale | null {
  if (!candidate) return null
  const normalized = candidate.trim()
  if (normalized === '') return null
  if ((LOCALES as readonly string[]).includes(normalized)) return normalized as Locale
  const base = normalized.toLowerCase().split(/[-_]/)[0] ?? ''
  if (base === 'zh') return 'zh-CN'
  if (base === 'en') return 'en'
  return null
}

/** 结构式读取 navigator：避免本模块在 node/vitest 里依赖 DOM lib */
function systemCandidates(): string[] {
  try {
    const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator
    if (!nav) return []
    if (nav.languages && nav.languages.length > 0) return [...nav.languages]
    return nav.language ? [nav.language] : []
  } catch {
    return []
  }
}

/** 按 navigator.languages 顺序匹配，第一个命中的胜出 */
export function detectSystemLocale(candidates: readonly string[] = systemCandidates()): Locale {
  for (const candidate of candidates) {
    const matched = matchLocale(candidate)
    if (matched) return matched
  }
  return DEFAULT_LOCALE
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function safeStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage
    return storage ?? null
  } catch {
    return null
  }
}

export function readLocalePreference(): Locale | null {
  try {
    const stored = safeStorage()?.getItem(LOCALE_PREFERENCE_KEY)
    return stored ? matchLocale(stored) : null
  } catch {
    return null
  }
}

export function rememberLocalePreference(locale: Locale): void {
  try {
    safeStorage()?.setItem(LOCALE_PREFERENCE_KEY, locale)
  } catch {
    // localStorage 不可用（隐私模式）：只是下次启动重新探测，不影响本次切换
  }
}

export interface InitialLocaleDecision {
  locale: Locale
  /** true 表示这次是「首启按系统语言」猜的，调用方应把它写回 settings 固化下来 */
  adoptSystem: boolean
}

/** 首启决策：有偏好 → 用 `settings.locale`；无偏好 → 用系统语言 */
export function resolveInitialLocale(
  storedLocale: Locale,
  options: { preference?: Locale | null; candidates?: readonly string[] } = {}
): InitialLocaleDecision {
  const preference = options.preference === undefined ? readLocalePreference() : options.preference
  if (preference) {
    return { locale: preference, adoptSystem: false }
  }
  const detected = detectSystemLocale(options.candidates ?? systemCandidates())
  return { locale: detected, adoptSystem: detected !== storedLocale }
}

/** 把语言写到 <html lang>（含 dir），供 CSS/无障碍/拼写检查使用 */
export function applyLocaleToDocument(locale: Locale): void {
  const doc = (globalThis as { document?: { documentElement: { lang: string; dir: string; dataset: Record<string, string> } } }).document
  if (!doc) return
  const root = doc.documentElement
  root.lang = locale
  root.dir = isRtlLocale(locale) ? 'rtl' : 'ltr'
  root.dataset.locale = locale
}

const RTL_LANGUAGES = ['ar', 'fa', 'he', 'ur']

export function isRtlLocale(locale: string): boolean {
  const base = locale.toLowerCase().split(/[-_]/)[0] ?? ''
  return RTL_LANGUAGES.includes(base)
}
