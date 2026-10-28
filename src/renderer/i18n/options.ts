import type { Locale, LocaleResource } from '@shared'
import { DEFAULT_LOCALE, DEFAULT_NAMESPACE, I18N_NAMESPACES, LOCALES, LOCALE_FALLBACK } from '@shared'

/**
 * i18next 初始化选项的**纯函数**构造器。
 *
 * 单独成文件（不 import react / import.meta.glob）是为了让 vitest（node 环境）
 * 能直接构造一个真实 i18n 实例做断言：缺 key 时要告警、要给出可读兜底，
 * 而不是「界面静默显示 key 或空白」。
 */

export type LocaleResources = Record<string, Record<string, LocaleResource>>

export interface MissingKeyInfo {
  /** i18next 解析过的语言列表（第一个是当前语言） */
  languages: string[]
  namespace: string
  key: string
  /** 调用方通过 `defaultValue` 传入的兜底文案（没有则为空串） */
  fallbackValue: string
}

const missingKeys: MissingKeyInfo[] = []

/** 已收集的缺 key 记录（供测试 / e2e 断言；prod 下也收集，成本可忽略） */
export function getMissingKeys(): readonly MissingKeyInfo[] {
  return missingKeys
}

export function resetMissingKeys(): void {
  missingKeys.length = 0
}

/** 把 `tab.confirmClose.body` 变成 `Confirm Close Body`：可读、且不是裸 key */
export function humanizeKey(rawKey: string): string {
  let key = rawKey
  const colon = key.indexOf(':')
  if (colon > 0 && (I18N_NAMESPACES as readonly string[]).includes(key.slice(0, colon))) {
    key = key.slice(colon + 1)
  }
  const segments = key.split('.').filter(Boolean)
  const tail = segments.slice(-2)
  const words = tail
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (words === '') return rawKey
  return words.replace(/\b\w/g, (char) => char.toUpperCase())
}

function isDevEnvironment(): boolean {
  try {
    // 结构式读取：`import.meta.env` 只在 Vite 的 renderer 类型里存在，
    // 用 cast 读可以让这个模块在 node（vitest）里也能被 typecheck 与单测。
    const meta = import.meta as ImportMeta & { env?: { DEV?: boolean } }
    return Boolean(meta.env?.DEV)
  } catch {
    return false
  }
}

/** 语言回退链：zh-CN → en；en 无回退 */
export function buildFallbackLng(locale: Locale = DEFAULT_LOCALE): string[] {
  const chain: string[] = []
  let current: Locale | null = locale
  while (current) {
    chain.push(current)
    current = LOCALE_FALLBACK[current]
  }
  if (!chain.includes(DEFAULT_LOCALE)) chain.push(DEFAULT_LOCALE)
  return chain
}

export interface BuildI18nOptionsInput {
  resources: LocaleResources
  locale?: Locale
  /** 覆盖 dev 判定（测试用） */
  dev?: boolean
  /** 缺 key 时的额外回调（默认只在 dev 下 console.warn） */
  onMissingKey?: (info: MissingKeyInfo) => void
}

export interface I18nRuntimeOptions {
  resources: LocaleResources
  lng: string
  fallbackLng: string[]
  supportedLngs: string[]
  ns: string[]
  defaultNS: string
  keySeparator: false
  nsSeparator: ':'
  saveMissing: true
  interpolation: { escapeValue: false }
  returnNull: false
  returnEmptyString: false
  missingKeyHandler: (
    lngs: readonly string[],
    ns: string,
    key: string,
    fallbackValue: string
  ) => void
  parseMissingKeyHandler: (key: string, defaultValue?: string) => string
}

/**
 * 构造 i18next init 选项。
 *
 * 两个刻意的设置（改动前先读 docs/i18n.md）：
 * - `keySeparator: false`：资源是扁平点号 key，关掉嵌套分隔符才不会把 `tab.new` 当层级。
 * - `nsSeparator: ':'` 保持默认：关掉它会让 `t('hosts:empty.title')` 整串当 key，
 *   界面直接显示 `hosts:empty.title`，而构建与单测都还是绿的。
 */
export function buildI18nOptions(input: BuildI18nOptionsInput): I18nRuntimeOptions {
  const locale = input.locale ?? DEFAULT_LOCALE
  const dev = input.dev ?? isDevEnvironment()

  return {
    resources: input.resources,
    lng: locale,
    fallbackLng: buildFallbackLng(locale),
    supportedLngs: [...LOCALES],
    ns: [...I18N_NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    keySeparator: false,
    nsSeparator: ':',
    saveMissing: true,
    interpolation: { escapeValue: false },
    returnNull: false,
    returnEmptyString: false,
    missingKeyHandler: (lngs, ns, key, fallbackValue) => {
      const info: MissingKeyInfo = {
        languages: [...lngs],
        namespace: ns,
        key,
        fallbackValue: fallbackValue ?? ''
      }
      const isNew = !missingKeys.some((item) => item.namespace === info.namespace && item.key === info.key)
      if (isNew) missingKeys.push(info)
      if (input.onMissingKey) input.onMissingKey(info)
      else if (dev && isNew) {
        console.warn(`[i18n] missing key: ${ns}:${key} (lng=${lngs.join(', ')})`)
      }
    },
    parseMissingKeyHandler: (key, defaultValue) => {
      // 调用方用 defaultValue 兜底时尊重它；否则给人读得懂的词，绝不回显裸 key
      if (defaultValue && defaultValue !== key) return defaultValue
      return humanizeKey(key)
    }
  }
}
