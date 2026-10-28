import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import {
  DEFAULT_LOCALE,
  DEFAULT_NAMESPACE,
  I18N_NAMESPACES,
  LOCALE_FALLBACK,
  LOCALES,
  type Locale,
  type LocaleResource
} from '@shared'

/**
 * i18n 引导（骨架版；theme-i18n 成员在此之上扩展语言切换 UI 与 namespace 内容是允许的）。
 *
 * 资源打包方式：Vite 的 `import.meta.glob` 把 `src/locales/<lang>/<feature>.json` 一次性静态收进来。
 * 好处是离线/打包后零 IO、路径写错会在**构建期**报错（而不是运行时静默缺文案）。
 *
 * 两个必须保持的配置：
 * - `keySeparator: false` —— 我们的 key 是扁平点号串（`hosts.empty.title`），
 *   默认的 `.` 分隔会把它拆成嵌套查找，永远命中不到；
 * - `nsSeparator` 保持默认 ':' —— 组件里统一用 `t('hosts:empty.title')` 这种带 namespace 的写法；
  把它设成 false 会让 ':' 变成字面量，所有带前缀的 key 都命不中，界面上直接显示 `hosts:empty.title`
  （这个坑真实踩过：截图里全是原始 key，但构建、类型检查、测试全绿）。
- `fallbackLng` 走 LOCALE_FALLBACK（zh-CN → en），避免中文漏 key 时显示原始 key。
 */

type LocaleModules = Record<string, { default: LocaleResource }>

/**
 * LOCALE_FALLBACK 的值是单个语言名，而 i18next 的 `fallbackLng` 对象形态要求 `string[]`。
 * 这里显式转换，避免把契约里的形状直接塞给库（TS 会报 not assignable）。
 */
function buildFallbackLng(): Record<string, readonly string[]> {
  return Object.fromEntries(Object.values(LOCALES).map((locale) => {
    const fallback = LOCALE_FALLBACK[locale]
    return [locale, fallback ? [fallback] : []]
  }))
}

const modules = import.meta.glob<{ default: LocaleResource }>('../../locales/*/*.json', { eager: true }) as LocaleModules

/** 把 glob 结果整理成 i18next 需要的 { lang: { ns: resource } } */
export function buildResources(): Record<string, Record<string, LocaleResource>> {
  const resources: Record<string, Record<string, LocaleResource>> = {}
  for (const [path, mod] of Object.entries(modules)) {
    const match = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path)
    if (!match) continue
    const [, lang, ns] = match
    if (!match || !lang || !ns) continue
    resources[lang] ??= {}
    resources[lang][ns] = mod.default
  }
  return resources
}

let initialized = false

export async function initI18n(locale: Locale = DEFAULT_LOCALE): Promise<void> {
  if (initialized) {
    await changeLocale(locale)
    return
  }
  await i18next.use(initReactI18next).init({
    resources: buildResources(),
    lng: locale,
    fallbackLng: buildFallbackLng(),
    supportedLngs: [...LOCALES],
    ns: [...I18N_NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    keySeparator: false,
    interpolation: { escapeValue: false },
    returnNull: false
  })
  initialized = true
}

export async function changeLocale(locale: Locale): Promise<void> {
  // 单语言：回退链由 i18next 的 fallbackLng 配置决定，这里不重复传数组
  await i18next.changeLanguage(locale)
}

export { i18next }
