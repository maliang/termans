import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '@shared'

/**
 * token 分层锁：**非主题 token 不许混进 `:root`**。
 *
 * 背景（为什么要专门写一条测试）：`src/renderer/styles/tokens.css` 里有两层变量——
 * 1. **52 个契约 token**（`src/shared/theme.ts` 的 THEME_TOKENS）：主题可覆盖，
 *    用户自定义主题就是它的子集，导出/导入的 `termans-theme` JSON 也只认这些；
 * 2. **非主题 token**（间距 / 控件尺寸 / 焦点环 / 弹窗外壳 / 动效）：不随主题变，
 *    写在文件末尾的 `html { … }` 块里。
 *
 * 两者混在一起会出真事故：把新加的一批尺寸 token 挪进 `:root`，`themeTokenSetSchema`
 * （strict、52 个必填）就会认为「主题缺 token」，用户早先导出的主题 JSON 导入直接失败
 * （SPEC M-08 回归）——而界面看起来一切正常、`theme-tokens.test.ts` 也只会红在
 * 「unknown token」这种看不出因果的断言上。这条测试把「两层不许合并」写成机器可读的约定。
 */

const repoRoot = resolve(__dirname, '../..')
const css = readFileSync(resolve(repoRoot, 'src/renderer/styles/tokens.css'), 'utf8')

/** 抽某个选择器块内声明的 `--ts-*` 变量名（与 theme-tokens.test.ts 的做法保持一致） */
function declaredTokens(cssText: string, selector: string): string[] {
  const start = cssText.indexOf(selector)
  expect(start, `selector not found: ${selector}`).toBeGreaterThan(-1)
  const blockStart = cssText.indexOf('{', start)
  const blockEnd = cssText.indexOf('}', blockStart)
  const block = cssText.slice(blockStart + 1, blockEnd)
  return [...block.matchAll(/(--ts-[a-z0-9-]+)\s*:/g)].map((match) => match[1] as string)
}

/** 非主题 token 的允许前缀：名字一眼能看出「这不是主题能覆盖的东西」 */
const FOUNDATION_TOKEN_PREFIXES = [
  '--ts-space-',
  '--ts-control-',
  '--ts-icon-',
  '--ts-font-size-xs',
  '--ts-line-height',
  '--ts-font-weight-',
  '--ts-focus-ring-',
  '--ts-dialog-',
  '--ts-motion-'
] as const

const LAYOUT_ONLY = ['--ts-sidebar-width', '--ts-ai-panel-width']

describe('token 分层：契约层（主题可覆盖）与非主题层（底座）', () => {
  it(':root 的 token 集合 = 52 个契约 token + 2 个布局尺寸，一个不多一个不少', () => {
    const declared = declaredTokens(css, ':root')

    // 数量先钉死：以后有人往 :root 里「顺手」加东西，这里会先红
    expect(declared.length).toBe(THEME_TOKENS.length + LAYOUT_ONLY.length)

    const expected = new Set<string>([...THEME_TOKENS, ...LAYOUT_ONLY])
    expect(new Set(declared)).toEqual(expected)

    // 反过来也断言一遍，让失败信息直接指出「谁被搬走了」
    for (const token of THEME_TOKENS) {
      expect(declared, `契约 token 被从 :root 移除：${token}`).toContain(token)
    }
  })

  it('非主题 token 全部在 html 块里，且名字不属于契约 token', () => {
    const foundation = declaredTokens(css, '\nhtml {')
    expect(foundation.length).toBeGreaterThan(0)

    const themeTokens = new Set<string>(THEME_TOKENS)
    for (const token of foundation) {
      expect(themeTokens.has(token), `契约 token 不许写进底座块：${token}`).toBe(false)
      const allowed = FOUNDATION_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix))
      expect(allowed, `底座 token 名字不在允许前缀内（会被误认为主题 token）：${token}`).toBe(true)
    }
  })

  it('两层不相交：底座块里的 token 不出现在 :root，反之亦然', () => {
    const root = new Set(declaredTokens(css, ':root'))
    const foundation = new Set(declaredTokens(css, '\nhtml {'))
    const intersection = [...foundation].filter((token) => root.has(token))
    expect(intersection).toEqual([])
  })

  it('底座 token 不引用不存在的变量（拼错的 var() 是无效声明，静默失效）', () => {
    const foundationBlock = (() => {
      const start = css.indexOf('\nhtml {')
      const blockStart = css.indexOf('{', start)
      const blockEnd = css.indexOf('}', blockStart)
      return css.slice(blockStart + 1, blockEnd)
    })()

    const known = new Set<string>([...THEME_TOKENS, ...LAYOUT_ONLY, ...declaredTokens(css, '\nhtml {')])
    const referenced = [...foundationBlock.matchAll(/var\((--ts-[a-z0-9-]+)\)/g)].map((match) => match[1] as string)
    expect(referenced.length).toBeGreaterThan(0)
    for (const token of referenced) {
      expect(known.has(token), `底座 token 引用了不存在的变量：var(${token})`).toBe(true)
    }
  })
})
