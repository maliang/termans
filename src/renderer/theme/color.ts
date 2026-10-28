/**
 * 颜色解析与对比度计算（**纯函数，无 DOM / 无第三方依赖**）。
 *
 * 为什么单独一层：主题编辑器的「可读性提示」必须在保存前给出数字，
 * 而浏览器只能告诉你 `getComputedStyle` 的字符串，不给对比度；所以自己算。
 *
 * 计算口径按 WCAG 2.1：
 * - 相对亮度用 sRGB 分段线性化（不是简单的 0.2126*R + ... 直接套在 0-255 上）；
 * - 半透明色先按 alpha 合成到背景上再算（`rgba(255,255,255,.08)` 这类边框色必须这样处理，
 *   否则算出来的对比度是「白色对白色」的假高分）。
 */

export interface Rgba {
  /** 0-255 */
  r: number
  /** 0-255 */
  g: number
  /** 0-255 */
  b: number
  /** 0-1 */
  a: number
}

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i
const RGB_FUNC = /^rgba?\(([^)]+)\)$/i

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 1
  const text = raw.trim()
  const value = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text)
  if (!Number.isFinite(value)) return Number.NaN
  return clamp(value, 0, 1)
}

function parseChannel(raw: string): number {
  const text = raw.trim()
  const value = text.endsWith('%') ? (Number.parseFloat(text) / 100) * 255 : Number.parseFloat(text)
  if (!Number.isFinite(value)) return Number.NaN
  return clamp(Math.round(value), 0, 255)
}

/**
 * 解析 CSS 颜色字符串；无法解析（含 `var(--ts-x)` 这类未解析引用）时返回 null。
 * 调用方必须把 null 当作「非法值」处理，而不是静默回退到黑色。
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null
  const text = input.trim()
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  const short = HEX_SHORT.exec(text)
  if (short) {
    const [, r, g, b, a] = short
    return {
      r: Number.parseInt(`${r}${r}`, 16),
      g: Number.parseInt(`${g}${g}`, 16),
      b: Number.parseInt(`${b}${b}`, 16),
      a: a ? Number.parseInt(`${a}${a}`, 16) / 255 : 1
    }
  }

  const long = HEX_LONG.exec(text)
  if (long) {
    const [, r, g, b, a] = long
    return {
      r: Number.parseInt(r, 16),
      g: Number.parseInt(g, 16),
      b: Number.parseInt(b, 16),
      a: a ? Number.parseInt(a, 16) / 255 : 1
    }
  }

  const func = RGB_FUNC.exec(text)
  if (func) {
    const parts = func[1].split(/[,/]/).flatMap((chunk) => chunk.trim().split(/\s+/))
    const [r, g, b, a] = parts
    if (!r || !g || !b) return null
    const parsed = {
      r: parseChannel(r),
      g: parseChannel(g),
      b: parseChannel(b),
      a: parseAlpha(a)
    }
    if ([parsed.r, parsed.g, parsed.b, parsed.a].some((value) => Number.isNaN(value))) return null
    return parsed
  }

  return null
}

export function isColorString(input: string | null | undefined): boolean {
  return parseColor(input) !== null
}

export function toHex(color: Rgba, withAlpha = false): string {
  const hex = (value: number): string => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
  const base = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
  return withAlpha && color.a < 1 ? `${base}${hex(color.a * 255)}` : base
}

/** 把半透明前景按 alpha 合成到（不透明）背景上，返回不透明颜色 */
export function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  if (foreground.a >= 1) return { ...foreground, a: 1 }
  const alpha = foreground.a + background.a * (1 - foreground.a)
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 1 }
  const blend = (fg: number, bg: number): number => (fg * foreground.a + bg * background.a * (1 - foreground.a)) / alpha
  return {
    r: blend(foreground.r, background.r),
    g: blend(foreground.g, background.g),
    b: blend(foreground.b, background.b),
    a: 1
  }
}

/** sRGB 分量线性化（WCAG 定义） */
function linearize(channel: number): number {
  const value = clamp(channel, 0, 255) / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b)
}

/**
 * 对比度（1..21）。
 * 输入允许带 alpha：前景先合成到背景上；背景带 alpha 时再合成到白色（相当于纸面），
 * 这样 `rgba(0,0,0,.5)` 这类值不会因为 alpha 被忽略而算出离谱的比值。
 */
export function contrastRatio(foreground: string | Rgba, background: string | Rgba): number {
  const fgColor = typeof foreground === 'string' ? parseColor(foreground) : foreground
  const bgColor = typeof background === 'string' ? parseColor(background) : background
  if (!fgColor || !bgColor) return Number.NaN
  const opaqueBg = bgColor.a < 1 ? compositeOver(bgColor, { r: 255, g: 255, b: 255, a: 1 }) : bgColor
  const opaqueFg = fgColor.a < 1 ? compositeOver(fgColor, opaqueBg) : fgColor
  const lighter = Math.max(relativeLuminance(opaqueFg), relativeLuminance(opaqueBg))
  const darker = Math.min(relativeLuminance(opaqueFg), relativeLuminance(opaqueBg))
  return (lighter + 0.05) / (darker + 0.05)
}

export type WcagLevel = 'AAA' | 'AA' | 'AA-large' | 'fail'

export function wcagLevel(ratio: number): WcagLevel {
  if (!Number.isFinite(ratio)) return 'fail'
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA-large'
  return 'fail'
}

/** 固定两位小数（避免 UI 上出现 4.500000000001 这种数字） */
export function roundRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0
  return Math.round(ratio * 100) / 100
}

/**
 * 判断一个 token 值是不是「安全」的 CSS 值：不含分号/大括号/换行。
 * 主题值会通过 `style.setProperty` 写进 `<html>`，虽然 setProperty 会拒绝非法值，
 * 但我们更希望在导入阶段就给出可读错误，而不是「保存成功、界面没变」。
 */
export function isCssSafeValue(value: string): boolean {
  return !/[;{}\n\r]/.test(value)
}
