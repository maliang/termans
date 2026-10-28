import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { LOCALE_LABELS, LOCALES, type Locale } from '@shared'
import { useShellStore } from '../app/store'
import { call, describeError } from '../platform/ipc'
import { changeLocale, i18next } from './index'
import { applyLocaleToDocument, readLocalePreference, rememberLocalePreference, resolveInitialLocale } from './locale'
import * as fmt from './format'

/**
 * 语言切换（设置页用）。
 *
 * 生效链路：`changeLanguage` → `<html lang>`/`dir` → 记忆偏好 → `settings:update({locale})` 落盘。
 * 先切界面再落盘：即使主进程写盘失败，用户也已经看到切换结果，只在控制台告警、不弹错。
 */

export interface LocaleOption {
  value: Locale
  label: string
}

export interface LocaleController {
  locale: Locale
  locales: LocaleOption[]
  setLocale(locale: Locale): Promise<void>
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
  return LOCALES.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale] }))
}

export function useLocale(): LocaleController {
  const { i18n } = useTranslation()
  const locale = (i18n.resolvedLanguage ?? i18n.language) as Locale

  return {
    locale,
    locales: localeOptions(),
    async setLocale(next) {
      if (next === locale) return
      await changeLocale(next)
      applyLocaleToDocument(next)
      rememberLocalePreference(next)
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
 * - 用户从未切换过语言 → 采用系统语言，并写回 `settings.locale` 固化；
 * - 已经切换过 → 尊重 `settings.locale`（设置页/其他窗口的改动经 `settings:changed` 传回）。
 */
export function useLocaleBootstrap(): void {
  const booted = useShellStore((state) => state.booted)
  const settingsLocale = useShellStore((state) => state.settings.locale)

  useEffect(() => {
    if (!booted) return
    const preference = readLocalePreference()
    const decision = resolveInitialLocale(settingsLocale, { preference })
    if (!preference) rememberLocalePreference(decision.locale)
    applyLocaleToDocument(decision.locale)
    const active = i18next.resolvedLanguage ?? i18next.language
    if (active !== decision.locale) void changeLocale(decision.locale)
    if (decision.adoptSystem && decision.locale !== settingsLocale) {
      void call('settings:update', { locale: decision.locale }).catch((error: unknown) => {
        console.warn(`[i18n] 首启语言未能落盘：${describeError(error)}`)
      })
    }
  }, [booted, settingsLocale])
}
