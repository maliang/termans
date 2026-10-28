/**
 * 国际化契约。
 *
 * 目录约定：`src/locales/<lang>/<feature>.json`
 * - 一个 feature 一个 namespace 文件（就是下面 I18N_NAMESPACES 里的名字），**不要挤在一个大文件里**。
 * - key 用扁平点号串（`hosts.empty.title`），**不做嵌套对象**；因此 i18next 初始化必须 `keySeparator: false`。
 * - en 与 zh-CN 的 key 集合必须**完全相等**——缺 key 时 i18next 会静默回退 en 或显示 key 本身，
 *   这种「少一句文案」在 UI 上极难被 QA 发现，所以由 `tests/contract/i18n.test.ts` 强制对齐。
 * - 新增 namespace 的流程：改这里 → 两个语言各加同名文件 → 跑 `pnpm test`。
 */
export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文'
}

/** 语言回退链：zh-CN → en */
export const LOCALE_FALLBACK: Record<Locale, Locale | null> = {
  en: null,
  'zh-CN': 'en'
}

export const I18N_NAMESPACES = ['common', 'hosts', 'terminal', 'settings', 'ai', 'sync', 'auth', 'errors'] as const
export type I18nNamespace = (typeof I18N_NAMESPACES)[number]

export const DEFAULT_NAMESPACE: I18nNamespace = 'common'

/** namespace → 文件相对仓库根的路径（测试与文档共用同一函数，避免两边各写一份字符串） */
export function localeResourcePath(lang: Locale, namespace: I18nNamespace): string {
  return `src/locales/${lang}/${namespace}.json`
}

/** 单语言单 namespace 的资源结构：扁平 key → 文案 */
export type LocaleResource = Record<string, string>

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

export function isI18nNamespace(value: string): value is I18nNamespace {
  return (I18N_NAMESPACES as readonly string[]).includes(value)
}
