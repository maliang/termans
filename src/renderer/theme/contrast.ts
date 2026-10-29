import { contrastRatio, roundRatio, wcagLevel, type WcagLevel } from './color'
import type { ResolvedTokens } from './tokens'
import type { ThemeToken } from '@shared'

/**
 * 主题可读性审计（纯函数）。
 *
 * 规则来自 `docs/SPEC.md` M-06 与 `design/BRAND.md`：
 * - 正文（`--ts-text-primary`）与任一背景层的对比度 **≥ 4.5:1**（WCAG AA 正文）；
 * - 次要文案（`--ts-text-secondary`）≥ 4.5:1，弱化文案（`--ts-text-muted`）**同样 ≥ 4.5:1**
 *   ——弱化不等于「可以看不清」：它承载的是空态说明、状态栏、表单提示这些真句子，
 *   2026-10-30 实测旧值只有 2.99–4.08:1（深色 elevated 最低 2.99），用户反馈「提示看不清」；
 * - 主按钮文字（`--ts-accent-contrast` 落在 `--ts-accent` 上）目标 4.5:1，**最低 3:1**；
 *   3:1 是「不刺眼也不糊」的底线，低于它按钮文字会明显吃力；
 * - 状态色（成功/错误）与背景 ≥ 3:1，保证色点/图标可辨。
 *
 * 编辑器只「警告」不「阻止保存」：用户可能故意做低对比度的复古配色，
 * 但必须让他在保存前看到具体是哪一对、比值多少。
 */

export type ContrastPairId =
  | 'body-app'
  | 'body-surface'
  | 'body-elevated'
  | 'secondary-surface'
  | 'muted-app'
  | 'muted-surface'
  | 'muted-elevated'
  | 'button'
  | 'button-hover'
  | 'accent-app'
  | 'status-ok-surface'
  | 'status-error-surface'

export interface ContrastPair {
  id: ContrastPairId
  foreground: ThemeToken
  background: ThemeToken
  /** 硬底线（测试会按这个断言） */
  min: number
  /** 建议值（编辑器低于它给黄色警告） */
  recommended: number
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { id: 'body-app', foreground: '--ts-text-primary', background: '--ts-bg-app', min: 4.5, recommended: 4.5 },
  { id: 'body-surface', foreground: '--ts-text-primary', background: '--ts-bg-surface', min: 4.5, recommended: 4.5 },
  {
    id: 'body-elevated',
    foreground: '--ts-text-primary',
    background: '--ts-bg-elevated',
    min: 4.5,
    recommended: 4.5
  },
  {
    id: 'secondary-surface',
    foreground: '--ts-text-secondary',
    background: '--ts-bg-surface',
    min: 4.5,
    recommended: 4.5
  },
  {
    id: 'muted-app',
    foreground: '--ts-text-muted',
    background: '--ts-bg-app',
    min: 4.5,
    recommended: 4.5
  },
  {
    id: 'muted-surface',
    foreground: '--ts-text-muted',
    background: '--ts-bg-surface',
    // 弱化文案承载真句子（空态、状态栏、表单提示），按正文口径 4.5:1 判，不按大字号口径
    min: 4.5,
    recommended: 4.5
  },
  {
    id: 'muted-elevated',
    foreground: '--ts-text-muted',
    background: '--ts-bg-elevated',
    min: 4.5,
    recommended: 4.5
  },
  { id: 'button', foreground: '--ts-accent-contrast', background: '--ts-accent', min: 3, recommended: 4.5 },
  // hover 态用的是 --ts-accent-strong：浅色主题曾取 #a85505，黑字压上去只有 3.97:1（2026-10-30 实测）
  {
    id: 'button-hover',
    foreground: '--ts-accent-contrast',
    background: '--ts-accent-strong',
    min: 4.5,
    recommended: 4.5
  },
  { id: 'accent-app', foreground: '--ts-accent', background: '--ts-bg-app', min: 3, recommended: 4.5 },
  {
    id: 'status-ok-surface',
    foreground: '--ts-status-ok',
    background: '--ts-bg-surface',
    min: 3,
    recommended: 4.5
  },
  {
    id: 'status-error-surface',
    foreground: '--ts-status-error',
    background: '--ts-bg-surface',
    min: 3,
    recommended: 4.5
  }
]

export interface ContrastResult {
  pair: ContrastPair
  ratio: number
  level: WcagLevel
  /** 低于硬底线 */
  failsMin: boolean
  /** 低于建议值（编辑器黄色警告，不阻止保存） */
  warns: boolean
  foreground: string
  background: string
}

export function auditContrast(tokens: ResolvedTokens): ContrastResult[] {
  return CONTRAST_PAIRS.map((pair) => {
    const foreground = tokens[pair.foreground]
    const background = tokens[pair.background]
    const ratio = roundRatio(contrastRatio(foreground, background))
    return {
      pair,
      ratio,
      level: wcagLevel(ratio),
      failsMin: !(ratio >= pair.min),
      warns: !(ratio >= pair.recommended),
      foreground,
      background
    }
  })
}

/** 只返回需要注意的行（编辑器与测试共用） */
export function contrastProblems(tokens: ResolvedTokens): ContrastResult[] {
  return auditContrast(tokens).filter((result) => result.failsMin || result.warns)
}

/** 正文对比度（SPEC M-06 的「正文与背景」；多处展示会用这个单值） */
export function bodyContrastRatio(tokens: ResolvedTokens): number {
  return roundRatio(contrastRatio(tokens['--ts-text-primary'], tokens['--ts-bg-app']))
}
