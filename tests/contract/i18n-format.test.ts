import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatList,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatTime
} from '@renderer/i18n/format'
import { detectSystemLocale, isRtlLocale, matchLocale, resolveInitialLocale } from '@renderer/i18n/locale'

/**
 * Intl 格式化与语言匹配（SPEC L-01 的「日期/数字跟随语言」）。
 *
 * 这里断言的是**语言间有差异**而不是固定字符串：ICU 数据会随 Node/系统升级变化，
 * 写死 `Oct 29, 2026` 会让测试变成「Node 版本探测器」。
 */
const instant = new Date('2026-10-29T09:41:07Z')

describe('日期与时间', () => {
  it('同一时刻在 en 与 zh-CN 下产出不同写法', () => {
    const en = formatDate(instant, { locale: 'en', timeZone: 'UTC' })
    const zh = formatDate(instant, { locale: 'zh-CN', timeZone: 'UTC' })
    expect(en).not.toBe(zh)
    expect(en).toMatch(/2026/)
    expect(zh).toContain('2026')
    expect(zh).toMatch(/年/)
  })

  it('时间格式跟随语言（12 小时制 vs 24 小时制）', () => {
    const en = formatTime(instant, { locale: 'en', timeStyle: 'medium', timeZone: 'UTC' })
    const zh = formatTime(instant, { locale: 'zh-CN', timeStyle: 'medium', timeZone: 'UTC' })
    expect(en).toMatch(/AM|PM/)
    expect(zh).toMatch(/09:41:07/)
  })

  it('formatDateTime 一次成型，包含日期与时间信息', () => {
    const value = formatDateTime(instant, { locale: 'zh-CN', dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    expect(value).toContain('2026')
    expect(value).toMatch(/9:41|09:41/)
  })

  it('接受 Date / 毫秒数 / ISO 字符串三种输入', () => {
    const fromDate = formatDate(instant, { locale: 'en', timeZone: 'UTC' })
    const fromNumber = formatDate(instant.getTime(), { locale: 'en', timeZone: 'UTC' })
    const fromString = formatDate('2026-10-29T09:41:07Z', { locale: 'en', timeZone: 'UTC' })
    expect(fromNumber).toBe(fromDate)
    expect(fromString).toBe(fromDate)
  })
})

describe('数字、百分比、字节', () => {
  it('千分位与小数位跟随语言', () => {
    expect(formatNumber(1234567.891, { locale: 'en' })).toBe('1,234,567.891')
    const zh = formatNumber(1234567.891, { locale: 'zh-CN' })
    expect(zh.replace(/\u00a0/g, ' ')).toBe('1,234,567.891')
    expect(formatNumber(3.14159, { locale: 'en', maximumFractionDigits: 2 })).toBe('3.14')
  })

  it('百分比按 locale 输出', () => {
    expect(formatPercent(0.256, { locale: 'en' })).toBe('26%')
    expect(formatPercent(0.256, { locale: 'zh-CN' })).toContain('26')
  })

  it('字节用 unit 风格（SI 进制），带单位', () => {
    expect(formatBytes(1536, 'en')).toMatch(/1\.5/)
    expect(formatBytes(1536, 'en')).toMatch(/kB/)
    expect(formatBytes(0, 'en')).toMatch(/0/)
  })
})

describe('相对时间、列表、时长', () => {
  const now = instant.getTime()

  it('相对时间跟随语言（英文用 ago，中文用「前」）', () => {
    const en = formatRelativeTime(now - 3600_000, 'en', now)
    const zh = formatRelativeTime(now - 3600_000, 'zh-CN', now)
    expect(en).toContain('hour')
    expect(en).toContain('ago')
    expect(zh).toContain('小时')
    expect(zh).toContain('前')
    expect(zh).not.toContain('ago')
  })

  it('未来时间用「后」/ in', () => {
    expect(formatRelativeTime(now + 86_400_000 * 2, 'en', now)).toContain('in')
    expect(formatRelativeTime(now + 86_400_000 * 2, 'zh-CN', now)).toContain('后')
  })

  it('列表连接词按语言变化', () => {
    expect(formatList(['alpha', 'beta'], 'en')).toBe('alpha and beta')
    expect(formatList(['甲', '乙'], 'zh-CN')).toContain('和')
    expect(formatList(['alpha'], 'en')).toBe('alpha')
  })

  it('时长刻意不本地化，固定 h:mm:ss / m:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_725_000)).toBe('1:02:05')
    expect(formatDuration(-5_000)).toBe('0:00')
  })
})

describe('语言匹配与首启决策', () => {
  it('精确匹配与主语言前缀匹配', () => {
    expect(matchLocale('zh-CN')).toBe('zh-CN')
    expect(matchLocale('en')).toBe('en')
    expect(matchLocale('zh')).toBe('zh-CN')
    expect(matchLocale('zh-TW')).toBe('zh-CN')
    expect(matchLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(matchLocale('en-GB')).toBe('en')
    expect(matchLocale('ja-JP')).toBeNull()
    expect(matchLocale('')).toBeNull()
    expect(matchLocale(null)).toBeNull()
  })

  it('按 candidates 顺序取第一个命中的语言', () => {
    expect(detectSystemLocale(['ja-JP', 'zh-Hans', 'en-US'])).toBe('zh-CN')
    expect(detectSystemLocale(['ja-JP', 'de-DE'])).toBe('en')
    expect(detectSystemLocale([])).toBe('en')
  })

  it('有本机偏好时用户选择优先，且不 adoptSystem', () => {
    const decision = resolveInitialLocale('en', { preference: 'zh-CN', candidates: ['en-US'] })
    expect(decision).toEqual({ locale: 'zh-CN', adoptSystem: false })
  })

  it('无偏好时按系统语言，并在与已存设置不同时 adoptSystem', () => {
    expect(resolveInitialLocale('en', { preference: null, candidates: ['zh-CN'] })).toEqual({
      locale: 'zh-CN',
      adoptSystem: true
    })
    expect(resolveInitialLocale('zh-CN', { preference: null, candidates: ['zh-CN'] })).toEqual({
      locale: 'zh-CN',
      adoptSystem: false
    })
    // 系统语言不认识 → 回退 en；此时若已存 zh-CN，只切到 en 一次
    expect(resolveInitialLocale('zh-CN', { preference: null, candidates: ['ja-JP'] })).toEqual({
      locale: 'en',
      adoptSystem: true
    })
  })

  it('RTL 语言白名单', () => {
    expect(isRtlLocale('ar')).toBe(true)
    expect(isRtlLocale('he-IL')).toBe(true)
    expect(isRtlLocale('zh-CN')).toBe(false)
    expect(isRtlLocale('en')).toBe(false)
  })
})
