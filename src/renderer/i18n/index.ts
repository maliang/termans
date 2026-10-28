import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { DEFAULT_NAMESPACE, I18N_NAMESPACES, LOCALES, type Locale, type LocaleResource } from '@shared'
import { buildI18nOptions, getMissingKeys, type LocaleResources, type MissingKeyInfo } from './options'
import { detectSystemLocale } from './locale'

/**
 * i18n 引导。
 *
 * 资源打包方式：Vite 的 `import.meta.glob` 把 `src/locales/<lang>/<feature>.json` 一次性静态收进来。
 * 好处是离线/打包后零 IO，路径写错会在**构建期**报错（而不是运行时静默缺文案）。
 *
 * 选项的构造在 `./options.ts`（纯函数、node 可测），这里只负责：
 * 收资源 → init → 切语言 → 把缺 key 的告警统一出口。
 *
 * 两个不能动的配置（改动前先读 docs/i18n.md）：
 * - `keySeparator: false`：资源是扁平点号 key；
 * - `nsSeparator: ':'` 保持默认：关掉会让 `t('hosts:empty.title')` 整串当 key 显示在界面上，
 *   而构建、类型检查、单测全绿（这个坑真实踩过）。
 */

type LocaleModules = Record<string, { default: LocaleResource }>

const modules = import.meta.glob<{ default: LocaleResource }>('../../locales/*/*.json', { eager: true }) as LocaleModules

/** 把 glob 结果整理成 i18next 需要的 { lang: { ns: resource } } */
export function buildResources(): LocaleResources {
  const resources: LocaleResources = {}
  for (const [path, mod] of Object.entries(modules)) {
    const match = /locales\/([^/]+)\/([^/]+)\.json$/.exec(path)
    if (!match) continue
    const [, lang, ns] = match
    if (!lang || !ns) continue
    resources[lang] ??= {}
    resources[lang][ns] = mod.default
  }
  return resources
}

/** 打包期自检：每个语言 × namespace 都必须有资源，缺了在 dev 下吼一声（prod 由测试兜底） */
function assertResourcesComplete(resources: LocaleResources): void {
  const problems: string[] = []
  for (const locale of LOCALES) {
    for (const ns of I18N_NAMESPACES) {
      const table = resources[locale]?.[ns]
      if (!table || Object.keys(table).length === 0) problems.push(`${locale}/${ns}.json`)
    }
  }
  if (problems.length > 0 && import.meta.env?.DEV) {
    console.error(`[i18n] 缺少语言资源：${problems.join(', ')}`)
  }
}

let initialized = false

/** 首屏语言：有用户偏好用偏好，否则跟随系统 —— 详情见 ./locale.ts */
export function resolveBootLocale(): Locale {
  return detectSystemLocale()
}

export async function initI18n(locale: Locale = resolveBootLocale()): Promise<void> {
  if (initialized) {
    await changeLocale(locale)
    return
  }
  const resources = buildResources()
  assertResourcesComplete(resources)
  await i18next.use(initReactI18next).init(buildI18nOptions({ resources, locale }))
  initialized = true
}

export async function changeLocale(locale: Locale): Promise<void> {
  await i18next.changeLanguage(locale)
}

/** 缺 key 记录（e2e/单测断言「没有静默显示裸 key」） */
export function missingKeyReport(): readonly MissingKeyInfo[] {
  return getMissingKeys()
}

export { i18next }
export { DEFAULT_NAMESPACE }
export type { MissingKeyInfo }
