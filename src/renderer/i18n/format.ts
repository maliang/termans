import type { Locale } from '@shared'
import { DEFAULT_LOCALE } from '@shared'

/**
 * Intl 格式化封装。
 *
 * 纪律：**界面上的日期/数字/相对时间一律走这里**，不要在组件里手拼
 * `toLocaleString()` 或 `'3 分钟前'` 这类硬编码 —— 换语言时那些硬编码不会变。
 * 每个函数都只接收 locale 参数、不读全局状态，因此可以在 node 里直接测。
 */

export type DateInput = Date | number | string

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>()

function cached<T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.ListFormat>(
  key: string,
  factory: () => T
): T {
  const hit = cache.get(key)
  if (hit) return hit as T
  const created = factory()
  cache.set(key, created)
  return created
}

export interface DateFormatOptions {
  locale?: Locale
  dateStyle?: 'full' | 'long' | 'medium' | 'short'
  timeStyle?: 'full' | 'long' | 'medium' | 'short'
  timeZone?: string
}

function dateFormatter(options: DateFormatOptions): Intl.DateTimeFormat {
  const locale = options.locale ?? DEFAULT_LOCALE
  const key = `dt:${locale}:${options.dateStyle ?? ''}:${options.timeStyle ?? ''}:${options.timeZone ?? ''}`
  return cached(key, () =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: options.dateStyle ?? 'medium',
      ...(options.timeStyle ? { timeStyle: options.timeStyle } : {}),
      ...(options.timeZone ? { timeZone: options.timeZone } : {})
    })
  )
}

export function formatDate(value: DateInput, options: DateFormatOptions = {}): string {
  return dateFormatter({ ...options, dateStyle: options.dateStyle ?? 'medium', timeStyle: undefined }).format(toDate(value))
}

export function formatTime(value: DateInput, options: DateFormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE
  const key = `tm:${locale}:${options.timeZone ?? ''}`
  const formatter = cached(key, () =>
    new Intl.DateTimeFormat(locale, {
      timeStyle: 'medium',
      ...(options.timeZone ? { timeZone: options.timeZone } : {})
    })
  )
  return formatter.format(toDate(value))
}

export function formatDateTime(value: DateInput, options: DateFormatOptions = {}): string {
  return dateFormatter({ ...options, dateStyle: options.dateStyle ?? 'medium', timeStyle: options.timeStyle ?? 'short' }).format(
    toDate(value)
  )
}

export interface NumberFormatOptions {
  locale?: Locale
  minimumFractionDigits?: number
  maximumFractionDigits?: number
  notation?: 'standard' | 'compact'
  signDisplay?: 'auto' | 'always' | 'never' | 'exceptZero'
}

function numberFormatter(options: NumberFormatOptions): Intl.NumberFormat {
  const locale = options.locale ?? DEFAULT_LOCALE
  const key = `num:${JSON.stringify([locale, options])}`
  return cached(key, () =>
    new Intl.NumberFormat(locale, {
      ...(options.minimumFractionDigits === undefined ? {} : { minimumFractionDigits: options.minimumFractionDigits }),
      ...(options.maximumFractionDigits === undefined ? {} : { maximumFractionDigits: options.maximumFractionDigits }),
      ...(options.notation ? { notation: options.notation } : {}),
      ...(options.signDisplay ? { signDisplay: options.signDisplay } : {})
    })
  )
}

export function formatNumber(value: number, options: NumberFormatOptions = {}): string {
  return numberFormatter(options).format(value)
}

/** 0.1234 + fractionDigits=1 → en `12.3%` / zh-CN `12.3%` */
export function formatPercent(value: number, options: NumberFormatOptions = {}): string {
  const locale = options.locale ?? DEFAULT_LOCALE
  const key = `pct:${JSON.stringify([locale, options])}`
  const formatter = cached(key, () =>
    new Intl.NumberFormat(locale, {
      style: 'percent',
      ...(options.minimumFractionDigits === undefined ? {} : { minimumFractionDigits: options.minimumFractionDigits }),
      ...(options.maximumFractionDigits === undefined ? {} : { maximumFractionDigits: options.maximumFractionDigits })
    })
  )
  return formatter.format(value)
}

/** 字节数 → `1.4 MB`（单位是 SI，千进制） */
export function formatBytes(bytes: number, locale: Locale = DEFAULT_LOCALE): string {
  if (!Number.isFinite(bytes) || bytes < 0) return formatNumber(0, { locale })
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const digits = unitIndex === 0 ? 0 : value >= 100 ? 0 : 1
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: units[unitIndex]!,
    unitDisplay: 'short',
    maximumFractionDigits: digits
  }).format(value)
}

/** 毫秒 → `1:23`；超过 1 小时 `1:02:03`（终端会话时长这类不需要本地化） */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** 相对时间，如「3 分钟前」/「in 2 hours」 */
export function formatRelativeTime(value: DateInput, locale: Locale = DEFAULT_LOCALE, now: number = Date.now()): string {
  const target = toDate(value).getTime()
  const diffSeconds = Math.round((target - now) / 1000)
  const formatter = cached(`rel:${locale}`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }))
  const divisions: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year']
  ]
  let duration = diffSeconds
  for (const [amount, unit] of divisions) {
    if (Math.abs(duration) < amount) {
      return formatter.format(Math.round(duration), unit)
    }
    duration /= amount
  }
  return formatter.format(Math.round(duration), 'year')
}

/** 把字符串列表格式化成语言相关的连接（en: `a, b, and c` / zh: `a、b 和 c`） */
export function formatList(items: readonly string[], locale: Locale = DEFAULT_LOCALE): string {
  const formatter = cached(`list:${locale}`, () => new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }))
  return formatter.format([...items])
}

/** 大小写/首字母这类语言敏感操作（土耳其语 i 问题）不要手写 toUpperCase */
export function toLocaleUpper(value: string, locale: Locale = DEFAULT_LOCALE): string {
  return value.toLocaleUpperCase(locale)
}
