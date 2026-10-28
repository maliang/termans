import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ANSI_TOKENS, BUILTIN_THEME_IDS, THEME_TOKENS, ansiTokenAtIndex } from '@shared'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  baseThemeFor,
  findBuiltinTheme,
  isBuiltinTheme,
  resolveBuiltinTheme
} from '@renderer/theme/builtin'
import {
  COLOR_TOKENS,
  FONT_TOKENS,
  LENGTH_TOKENS,
  TOKEN_GROUPS,
  isColorToken,
  isLengthToken,
  resolveTokenSet
} from '@renderer/theme/tokens'
import { isColorString } from '@renderer/theme/color'

/**
 * 内置主题的结构测试（SPEC M-02 / M-03 / M-08 的基础）。
 *
 * 为什么必须有：主题少一个 token 不会报错——那个变量就是空值，落到浏览器默认值，
 * 表现为「某个角落颜色不对」，几乎不可能靠肉眼系统性发现。所以：
 * ① 每套内置主题必须覆盖全部 52 个 token；
 * ② 值必须是真的颜色/长度/字体（不是空串、不是拼错的 token 名）；
 * ③ termans-dark / termans-light 必须与 tokens.css 的两个块逐 token 一致（防首屏与运行期漂移）。
 */
const repoRoot = resolve(__dirname, '../..')
const cssText = readFileSync(resolve(repoRoot, 'src/renderer/styles/tokens.css'), 'utf8')

/** 取从 index 处开始的那个 `{ … }` 块（CSS 里这两个块内部没有嵌套花括号） */
function blockAfter(index: number): string {
  const open = cssText.indexOf('{', index)
  expect(open, 'CSS 块缺少左花括号').toBeGreaterThan(-1)
  const close = cssText.indexOf('}', open)
  expect(close, 'CSS 块缺少右花括号').toBeGreaterThan(open)
  return cssText.slice(open + 1, close)
}

/** 折叠任意空白：CSS 里长值（字体栈）会换行续写，直接逐行正则会把它们整条漏掉 */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function declarations(block: string): Record<string, string> {
  const result: Record<string, string> = {}
  // 先去掉注释（注释里也会出现 `--ts-xxx:` 的讲解示例），再按 `;` 切声明——
  // 逐行匹配会漏掉跨行续写的 `--ts-font-ui`，那正是「CSS 与 TS 漂移」测试最该盯的项。
  for (const chunk of block.replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const colon = chunk.indexOf(':')
    if (colon === -1) continue
    const name = chunk.slice(0, colon).trim()
    if (!/^--ts-[a-z0-9-]+$/.test(name)) continue
    result[name] = normalize(chunk.slice(colon + 1))
  }
  return result
}

const darkSelectorIndex = cssText.indexOf("data-theme='dark'")
const lightSelectorIndex = cssText.indexOf("data-theme='light'")
const cssDark = declarations(blockAfter(darkSelectorIndex))
const cssLight = declarations(blockAfter(lightSelectorIndex))

const LENGTH_PATTERN = /^-?\d+(\.\d+)?(px|rem|em|%)$/

describe('内置主题', () => {
  it('至少 4 套，id 唯一，且包含契约冻结的 dark/light', () => {
    expect(BUILTIN_THEMES.length).toBeGreaterThanOrEqual(4)
    const ids = BUILTIN_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of BUILTIN_THEME_IDS) expect(ids).toContain(id)
    expect(ids).toContain('termans-midnight')
    expect(ids).toContain('termans-contrast')
  })

  it('默认主题是 termans-dark', () => {
    expect(DEFAULT_THEME_ID).toBe('termans-dark')
    expect(findBuiltinTheme(DEFAULT_THEME_ID)).toBeDefined()
  })

  for (const theme of BUILTIN_THEMES) {
    it(`${theme.id}: 覆盖全部 ${THEME_TOKENS.length} 个 token`, () => {
      const missing = THEME_TOKENS.filter((token) => theme.tokens[token] === undefined)
      expect(missing, `${theme.id} 缺少 token: ${missing.join(', ')}`).toEqual([])

      const extra = Object.keys(theme.tokens).filter((token) => !THEME_TOKENS.includes(token as never))
      expect(extra, `${theme.id} 出现契约外的 token: ${extra.join(', ')}`).toEqual([])
    })

    it(`${theme.id}: 每个 token 值类型合法`, () => {
      for (const token of THEME_TOKENS) {
        const value = theme.tokens[token]
        expect(typeof value, `${token} 必须是字符串`).toBe('string')
        expect(value!.trim(), `${token} 不能为空`).not.toBe('')

        if (isColorToken(token)) {
          const isAlias = /^var\(\s*--ts-[a-z0-9-]+\s*\)$/.test(value!.trim())
          expect(isColorString(value!) || isAlias, `${token} 不是合法颜色: ${value}`).toBe(true)
        } else if (isLengthToken(token)) {
          expect(LENGTH_PATTERN.test(value!.trim()), `${token} 不是合法长度: ${value}`).toBe(true)
        } else {
          // 字体栈：颜色/长度都不该混进来
          expect(value!.trim().length).toBeGreaterThan(0)
        }
      }
    })

    it(`${theme.id}: 解析后 52 个 token 全部是字面值（无 var 残留）`, () => {
      const resolved = resolveBuiltinTheme(theme)
      expect(Object.keys(resolved).sort()).toEqual([...THEME_TOKENS].sort())
      for (const token of THEME_TOKENS) {
        expect(resolved[token], `${token} 解析后为空`).toBeTruthy()
        expect(resolved[token], `${token} 仍有未展开的 var()`).not.toContain('var(')
      }
      // 颜色类解析后必须真的能被解析（xterm palette / 对比度计算都依赖它）
      for (const token of COLOR_TOKENS) {
        expect(isColorString(resolved[token]), `${token} 解析后不是颜色: ${resolved[token]}`).toBe(true)
      }
    })

    it(`${theme.id}: builtin 标记、外观与基座自洽`, () => {
      expect(theme.builtin).toBe(true)
      expect(theme.extends).toBeNull()
      expect(['dark', 'light']).toContain(theme.appearance)
      expect(isBuiltinTheme(theme)).toBe(true)
      expect(theme.name.trim()).not.toBe('')
    })
  }

  it('TOKEN_GROUPS 不重不漏地覆盖 52 个 token', () => {
    const grouped = TOKEN_GROUPS.flatMap((group) => group.tokens)
    expect(grouped.length).toBe(THEME_TOKENS.length)
    expect(new Set(grouped).size).toBe(grouped.length)
    expect([...grouped].sort()).toEqual([...THEME_TOKENS].sort())
    expect(ANSI_TOKENS.length).toBe(16)
    expect([...LENGTH_TOKENS, ...FONT_TOKENS].length).toBe(9)
  })

  it('ANSI 顺序与 xterm 的 0…15 一致', () => {
    ANSI_TOKENS.forEach((token, index) => {
      expect(ansiTokenAtIndex(index)).toBe(token)
    })
    expect(() => ansiTokenAtIndex(16)).toThrow(RangeError)
  })

  it('termans-dark 与 tokens.css 的 :root/[data-theme=dark] 块逐 token 一致', () => {
    const dark = findBuiltinTheme('termans-dark')!
    for (const token of THEME_TOKENS) {
      expect(normalize(dark.tokens[token] ?? ''), `CSS 与 TS drift：${token}`).toBe(cssDark[token])
    }
  })

  it('termans-light 与 tokens.css 的 [data-theme=light] 块逐 token 一致', () => {
    const light = findBuiltinTheme('termans-light')!
    for (const token of THEME_TOKENS) {
      expect(normalize(light.tokens[token] ?? ''), `CSS 与 TS drift：${token}`).toBe(cssLight[token])
    }
  })

  it('CSS 两个块覆盖的 token 集合与契约一致（除已知布局变量）', () => {
    const layoutOnly = new Set(['--ts-sidebar-width', '--ts-ai-panel-width'])
    for (const [name, block] of [
      ['dark', cssDark],
      ['light', cssLight]
    ] as const) {
      const declared = Object.keys(block)
      const unknown = declared.filter((token) => !THEME_TOKENS.includes(token as never) && !layoutOnly.has(token))
      expect(unknown, `${name} 块出现未知变量: ${unknown.join(', ')}`).toEqual([])
      const missing = THEME_TOKENS.filter((token) => block[token] === undefined)
      expect(missing, `${name} 块缺少: ${missing.join(', ')}`).toEqual([])
    }
  })

  it('自定义主题基座解析：extends 命中内置主题，缺省回退默认', () => {
    expect(baseThemeFor({ extends: 'termans-midnight' }).id).toBe('termans-midnight')
    expect(baseThemeFor({ extends: null }).id).toBe(DEFAULT_THEME_ID)
    expect(baseThemeFor({ extends: 'does-not-exist' }).id).toBe(DEFAULT_THEME_ID)
  })

  it('isBuiltinTheme 不受 @shared 只有两个 id 的限制（现有 4 套）', () => {
    expect(isBuiltinTheme({ builtin: true, id: 'termans-contrast' })).toBe(true)
    expect(isBuiltinTheme({ builtin: false, id: 'termans-contrast' })).toBe(true)
    expect(isBuiltinTheme({ builtin: false, id: 'my-own-theme' })).toBe(false)
  })

  it('resolveTokenSet 会展平别名链（含后备值语法）', () => {
    const resolved = resolveTokenSet({
      ...resolveBuiltinTheme(findBuiltinTheme('termans-dark')!)
    })
    expect(resolved['--ts-bg-app']).toBe('#05080e')
    expect(resolved['--ts-accent']).toBe('#f8ab24')
  })
})
