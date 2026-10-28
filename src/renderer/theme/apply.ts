import { THEME_TOKENS, type ThemeAppearance, type ThemeToken } from '@shared'
import type { ResolvedTokens } from './tokens'
import { setActiveTokens } from './xterm'

/**
 * 把主题落到 DOM。
 *
 * 做法：**整组 52 个 `--ts-*` 直接内联到 `<html>`**。
 * - 不依赖 tokens.css 里预先写好每个主题块：新增主题不用改 CSS；
 * - 切换是同步的（一个 style.setProperty 循环），没有网络/异步等待，天然满足「<100ms 无白屏」；
 * - 内联优先级高于样式表，`[data-theme='light']` 那套兜底不会覆盖真实主题。
 *
 * `data-theme` 只放外观（dark/light，给 `color-scheme` 与 CSS 兜底用），
 * `data-theme-id` 放真实主题 id（给 e2e / QA 断言「当前是哪个主题」）。
 */

export interface AppliedThemeMeta {
  id: string
  appearance: ThemeAppearance
}

export function applyThemeToDocument(tokens: ResolvedTokens, meta: AppliedThemeMeta): void {
  const root = document.documentElement
  for (const token of THEME_TOKENS) {
    const value = tokens[token]
    if (value === undefined || value === '') continue
    root.style.setProperty(token, value)
  }
  root.dataset['theme'] = meta.appearance
  root.dataset['themeId'] = meta.id
  // 原生控件（滚动条、表单）跟随主题明暗，否则浅色主题里会冒出深色滚动条
  root.style.colorScheme = meta.appearance
  setActiveTokens(tokens)
}

/** 清掉内联覆盖，回到 tokens.css 的兜底（恢复默认时用，避免残留自定义主题的变量） */
export function clearThemeOverrides(): void {
  const root = document.documentElement
  for (const token of THEME_TOKENS) root.style.removeProperty(token)
  delete root.dataset['themeId']
  root.style.removeProperty('color-scheme')
}

/** 从 DOM 读当前计算值（e2e/诊断用；渲染逻辑不要依赖它，见 tokens.ts 的注释） */
export function readAppliedToken(token: ThemeToken): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim()
}

/** 当前主题 id（未应用过则为空串） */
export function currentThemeId(): string {
  return document.documentElement.dataset['themeId'] ?? ''
}
