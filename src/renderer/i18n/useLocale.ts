import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCALE_MODE_LABELS, LOCALE_MODES, type Locale, type LocaleMode } from '@shared'
import { useShellStore } from '../app/store'
import { call, describeError } from '../platform/ipc'
import { changeLocale, i18next } from './index'
import { applyLocaleToDocument, detectSystemLocale, resolveLocaleMode } from './locale'
import * as fmt from './format'

/**
 * 语言切换（设置页用）。
 *
 * 生效链路：`changeLanguage` → `<html lang>`/`dir` → `settings:update({locale})` 落盘。
 * 先切界面再落盘：即使主进程写盘失败，用户也已经看到切换结果，只在控制台告警、不弹错。
 *
 * 偏好取值的唯一真源是 `settings.locale`（可以是 `'system'`）：不再另存一份 localStorage，
 * 否则「设置里选了跟随系统」和「上次手动切过英文」会在下次启动时打架。
 */

export interface LocaleOption {
  value: LocaleMode
  label: string
}

export interface LocaleController {
  /** 当前生效的语言（已解析，永远不是 `'system'`） */
  locale: Locale
  /** 用户偏好，可能是 `'system'` */
  mode: LocaleMode
  /** 系统语言此刻解析出的语言，用于把「跟随系统」标注成「跟随系统（简体中文）」 */
  detected: Locale
  locales: LocaleOption[]
  setLocale(mode: LocaleMode): Promise<void>
  format: {
    date: (value: fmt.DateInput, options?: fmt.DateFormatOptions) => string
    time: (value: fmt.DateInput) => string
    dateTime: (value: fmt.DateInput) => string
    number: (value: number, options?: fmt.NumberFormatOptions) => string
    percent: (value: number, options?: fmt.NumberFormatOptions) => string
    bytes: (value: number) => string
    relativeTime: (value: fmt.DateInput) => string
    list: (items: readonly string[]) => string
  }
}

export function localeOptions(): LocaleOption[] {
  return LOCALE_MODES.map((mode) => ({ value: mode, label: LOCALE_MODE_LABELS[mode] }))
}

export function useLocale(): LocaleController {
  const { i18n } = useTranslation()
  const mode = useShellStore((state) => state.settings.locale)
  const locale = (i18n.resolvedLanguage ?? i18n.language) as Locale

  return {
    locale,
    mode,
    detected: detectSystemLocale(),
    locales: localeOptions(),
    async setLocale(next) {
      const resolved = resolveLocaleMode(next)
      if (resolved !== locale) {
        await changeLocale(resolved)
      }
      applyLocaleToDocument(resolved)
      try {
        await call('settings:update', { locale: next })
      } catch (error) {
        console.warn(`[i18n] 语言偏好未能落盘：${describeError(error)}`)
      }
    },
    format: {
      date: (value, options) => fmt.formatDate(value, { ...options, locale }),
      time: (value) => fmt.formatTime(value, { locale }),
      dateTime: (value) => fmt.formatDateTime(value, { locale }),
      number: (value, options) => fmt.formatNumber(value, { ...options, locale }),
      percent: (value, options) => fmt.formatPercent(value, { ...options, locale }),
      bytes: (value) => fmt.formatBytes(value, locale),
      relativeTime: (value) => fmt.formatRelativeTime(value, locale),
      list: (items) => fmt.formatList(items, locale)
    }
  }
}

/**
 * 首启与外部变更的收敛（App 里调用一次）。
 *
 * - `settings.locale === 'system'`（缺省）→ 每次启动按系统语言解析（解析不到回落简体中文）；
 * - 用户选了具体语言 → 用那个语言（设置页/其他窗口的改动经 `settings:changed` 传回）。
 * 这里只解析、不回写：偏好已经是 `'system'` 本身，不需要固化成具体语言。
 */
export function useLocaleBootstrap(): void {
  const booted = useShellStore((state) => state.booted)
  const settingsLocale = useShellStore((state) => state.settings.locale)

  useEffect(() => {
    if (!booted) return
    const resolved = resolveLocaleMode(settingsLocale)
    applyLocaleToDocument(resolved)
    const active = i18next.resolvedLanguage ?? i18next.language
    if (active !== resolved) void changeLocale(resolved)
  }, [booted, settingsLocale])
}
