import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from '@shared'
import { BUILTIN_THEMES, findBuiltinTheme } from '@renderer/theme/builtin'
import {
  THEME_FILE_FORMAT,
  THEME_FILE_VERSION,
  cloneThemeForEditing,
  colorInputValue,
  coveredTokens,
  exportThemeFile,
  parseThemeFile,
  parseThemeObject,
  serializeThemeFile,
  slugifyThemeId,
  validateTokenPatch,
  validateTokenValue
} from '@renderer/theme/validate'

/**
 * 主题导入/导出（SPEC M-04 / M-08）。
 *
 * 这两条最容易「看起来没问题」：导出再导入丢一个 token、非法值静默写入 localStorage，
 * 都要等用户换机器或重启才发现。所以这里断言：往返 token 全等、每类非法输入都有明确 code。
 */
const knownBaseIds = BUILTIN_THEMES.map((theme) => theme.id)

function sampleTheme() {
  return cloneThemeForEditing(findBuiltinTheme('termans-midnight')!, {
    id: 'midnight-amber',
    name: 'Midnight Amber',
    builtin: false,
    extends: 'termans-midnight',
    tokens: { '--ts-accent': '#ffb648', '--ts-accent-strong': '#d98b1f' }
  })
}

describe('主题导出格式', () => {
  it('顶层带 format/version，且 builtin 强制为 false', () => {
    const file = exportThemeFile(findBuiltinTheme('termans-dark')!)
    expect(file.format).toBe(THEME_FILE_FORMAT)
    expect(file.version).toBe(THEME_FILE_VERSION)
    expect(file.theme.builtin).toBe(false)
    expect(file.theme.id).toBe('termans-dark')
  })

  it('序列化是 2 空格缩进的 JSON，可被 JSON.parse 读回', () => {
    const text = serializeThemeFile(sampleTheme())
    expect(text.startsWith('{\n  "format"')).toBe(true)
    expect(() => JSON.parse(text)).not.toThrow()
  })
})

describe('主题导入', () => {
  it('导出 → 导入 token 完全一致（M-08 往返）', () => {
    const source = sampleTheme()
    const result = parseThemeFile(serializeThemeFile(source), { knownBaseIds })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.theme.id).toBe(source.id)
    expect(result.theme.name).toBe(source.name)
    expect(result.theme.appearance).toBe(source.appearance)
    expect(result.theme.extends).toBe('termans-midnight')
    expect(result.theme.tokens).toEqual(source.tokens)
    expect(result.theme.builtin).toBe(false)
  })

  it('接受只有 theme 字段的对象（手写 JSON 场景）', () => {
    const result = parseThemeObject({ id: 'hand-written', name: 'Hand Written', tokens: { '--ts-accent': '#123456' } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.theme.appearance).toBe('dark')
    expect(result.theme.extends).toBeNull()
  })

  it('非法 JSON → invalidJson（不抛异常）', () => {
    const result = parseThemeFile('{ nope', { knownBaseIds })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map((issue) => issue.code)).toContain('invalidJson')
  })

  it('顶层是数组/字符串 → notObject', () => {
    for (const raw of [[], 'text', 42, null]) {
      const result = parseThemeObject(raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.issues[0]!.code).toBe('notObject')
    }
  })

  it('id 非法 → invalidId', () => {
    const result = parseThemeObject({ id: 'Bad Id!', name: 'x', tokens: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('invalidId')
  })

  it('name 空或过长 → invalidName', () => {
    for (const name of ['', '   ', 'x'.repeat(81)]) {
      const result = parseThemeObject({ id: 'ok-id', name, tokens: {} })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('invalidName')
    }
  })

  it('导入声明 builtin:true 的主题 → builtinLocked（M-05）', () => {
    const result = parseThemeObject({ id: 'fake-builtin', name: 'Fake', builtin: true, tokens: {} })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('builtinLocked')
  })

  it('extends 指向不存在的内置主题 → unknownBase', () => {
    const result = parseThemeObject({ id: 'x-y', name: 'X Y', extends: 'nope', tokens: {} }, { knownBaseIds })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('unknownBase')
  })

  it('未知 token 名 → unknownToken（M-04）', () => {
    const result = parseThemeObject({ id: 'x-y', name: 'X Y', tokens: { '--ts-text-1': '#fff' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('unknownToken')
  })

  it('颜色值非法 → invalidColor', () => {
    const result = parseThemeObject({ id: 'x-y', name: 'X Y', tokens: { '--ts-accent': 'not-a-color' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('invalidColor')
  })

  it('长度值缺单位 → invalidLength', () => {
    const result = parseThemeObject({ id: 'x-y', name: 'X Y', tokens: { '--ts-radius-md': '10' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('invalidLength')
  })

  it('CSS 注入值 → unsafeValue（值会被写进内联样式）', () => {
    for (const value of ['#fff; color: red', 'red }', 'x{x}', 'line1\nline2']) {
      const issue = validateTokenValue('--ts-accent', value)
      expect(issue, `应当拒绝: ${JSON.stringify(value)}`).not.toBeNull()
      expect(['invalidColor', 'unsafeValue']).toContain(issue!.code)
    }
    const brace = validateTokenValue('--ts-font-ui', 'Inter; }')
    expect(brace?.code).toBe('unsafeValue')
  })

  it('允许 var(--ts-*) 别名，且引用不存在的变量 → unknownToken', () => {
    expect(validateTokenValue('--ts-accent', 'var(--ts-amber)')).toBeNull()
    expect(validateTokenValue('--ts-accent', 'var(--ts-nope)')?.code).toBe('unknownToken')
  })

  it('token 值不是字符串 → invalidSchema', () => {
    const result = parseThemeObject({ id: 'x-y', name: 'X Y', tokens: { '--ts-accent': 123 } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('invalidSchema')
  })
})

describe('编辑辅助', () => {
  it('slugifyThemeId 生成合法 id 并避开占用', () => {
    expect(slugifyThemeId('My Theme!')).toBe('my-theme')
    expect(slugifyThemeId('   ')).toBe('custom')
    expect(slugifyThemeId('My Theme', ['my-theme'])).toBe('my-theme-2')
    expect(slugifyThemeId('My Theme', ['my-theme', 'my-theme-2'])).toBe('my-theme-3')
    expect(slugifyThemeId('x'.repeat(80)).length).toBeLessThanOrEqual(48)
  })

  it('cloneThemeForEditing 是深拷贝（改副本不影响内置主题）', () => {
    const source = findBuiltinTheme('termans-dark')!
    const copy = cloneThemeForEditing(source, { id: 'copy', name: 'Copy', builtin: false })
    copy.tokens['--ts-accent'] = '#ff0000'
    expect(source.tokens['--ts-accent']).not.toBe('#ff0000')
  })

  it('coveredTokens 统计覆盖数并与 52 对齐', () => {
    expect(coveredTokens({})).toEqual([])
    const patch = sampleTheme().tokens
    expect(coveredTokens(patch).sort()).toEqual(['--ts-accent', '--ts-accent-strong'])
    expect(coveredTokens(Object.fromEntries(THEME_TOKENS.map((token) => [token, 'x']))).length).toBe(
      THEME_TOKENS.length
    )
  })

  it('validateTokenPatch 收集全部问题而不是遇到第一个就停', () => {
    const issues = validateTokenPatch({ '--ts-accent': 'nope', '--ts-radius-md': '10' })
    expect(issues.map((issue) => issue.code).sort()).toEqual(['invalidColor', 'invalidLength'])
  })

  it('colorInputValue 只给取色器能表达的纯色', () => {
    expect(colorInputValue('#FF0000')).toBe('#ff0000')
    expect(colorInputValue('rgba(255, 0, 0, 0.5)')).toBeNull()
    expect(colorInputValue('var(--ts-amber)')).toBeNull()
    expect(colorInputValue(undefined)).toBeNull()
    expect(colorInputValue('not-a-color')).toBeNull()
  })
})
