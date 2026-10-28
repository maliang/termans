import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANSI_TOKENS, THEME_TOKENS, ansiTokenAtIndex } from '@shared'

/**
 * 主题 token 的结构测试。
 *
 * 为什么必须有：CSS 变量名写错**不会报错**（`color: var(--ts-text-1)` 是无效声明，元素静默继承），
 * 主题编辑器少一个变量也不会有任何提示。只有结构比对能挡住这两类事故。
 */
const repoRoot = resolve(__dirname, '../..')
const css = readFileSync(resolve(repoRoot, 'src/renderer/styles/tokens.css'), 'utf8')

/** 从 CSS 里抽出某个选择器块内声明的 --ts-* 变量名 */
function declaredTokens(cssText: string, selector: string): string[] {
  const start = cssText.indexOf(selector)
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1)
  const blockStart = cssText.indexOf('{', start)
  const blockEnd = cssText.indexOf('}', blockStart)
  const block = cssText.slice(blockStart + 1, blockEnd)
  return [...block.matchAll(/(--ts-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string)
}

describe('theme token 清单', () => {
  it('清单本身不重复', () => {
    expect(new Set(THEME_TOKENS).size).toBe(THEME_TOKENS.length)
  })

  it('dark（:root）定义了全部契约 token，且没有清单外的 --ts-*', () => {
    const declared = new Set(declaredTokens(css, ':root'))
    const layoutOnly = new Set(['--ts-sidebar-width', '--ts-ai-panel-width'])
    for (const token of THEME_TOKENS) {
      expect(declared.has(token), `missing in :root -> ${token}`).toBe(true)
    }
    for (const token of declared) {
      expect(THEME_TOKENS.includes(token as never) || layoutOnly.has(token), `unknown token -> ${token}`).toBe(true)
    }
  })

  it('light 主题覆盖同样完整的 token 集（换主题不能少颜色）', () => {
    const light = new Set(declaredTokens(css, "[data-theme='light']"))
    for (const token of THEME_TOKENS) {
      expect(light.has(token), `missing in light -> ${token}`).toBe(true)
    }
  })

  it('ANSI 16 色顺序固定，越界抛 RangeError', () => {
    expect(ANSI_TOKENS.length).toBe(16)
    expect(ansiTokenAtIndex(0)).toBe('--ts-ansi-black')
    expect(ansiTokenAtIndex(15)).toBe('--ts-ansi-bright-white')
    expect(() => ansiTokenAtIndex(16)).toThrow(RangeError)
  })

  it('样式表里不存在裸色值（颜色必须走变量）', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // 只允许在变量声明行出现 hex / rgb；其余行出现视为绕过主题
    const offenders = withoutComments
      .split('\n')
      .filter((line) => !line.trim().startsWith('--ts-'))
      .filter((line) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line))
    expect(offenders).toEqual([])
  })
})
