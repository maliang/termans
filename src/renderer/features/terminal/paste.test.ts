import { describe, expect, it } from 'vitest'
import { inspectPaste, normalizeNewlines } from './paste'

/**
 * 粘贴安全检查单测。
 *
 * 判据必须站在「会不会误执行」上：单行带结尾换行同样危险（粘一条 `rm -rf ~/tmp` 再加个回车就执行了），
 * 所以 hasTrailingNewline 单独触发确认，而不是只看行数。
 */

describe('normalizeNewlines', () => {
  it('CRLF 与孤立 CR 都归一成 LF', () => {
    expect(normalizeNewlines('a\r\nb')).toBe('a\nb')
    expect(normalizeNewlines('a\rb')).toBe('a\nb')
    expect(normalizeNewlines('a\nb')).toBe('a\nb')
  })
})

describe('inspectPaste', () => {
  it('单行无换行：直接粘贴，不弹确认', () => {
    const result = inspectPaste('ls -la')
    expect(result.lineCount).toBe(1)
    expect(result.needsConfirm).toBe(false)
    expect(result.hasTrailingNewline).toBe(false)
    expect(result.charCount).toBe(6)
  })

  it('单行但以换行结尾：要确认（等于自动回车执行）', () => {
    const result = inspectPaste('rm -rf ./tmp\n')
    expect(result.lineCount).toBe(1)
    expect(result.hasTrailingNewline).toBe(true)
    expect(result.needsConfirm).toBe(true)
  })

  it('多行内容：要确认，行数按非空行算', () => {
    const result = inspectPaste('cd /srv\nnpm run build\n')
    expect(result.lineCount).toBe(2)
    expect(result.needsConfirm).toBe(true)
  })

  it('全是空行也至少算 1 行，不能算出 0', () => {
    expect(inspectPaste('\n\n').lineCount).toBe(1)
    expect(inspectPaste('\n\n').needsConfirm).toBe(true)
  })

  it('CRLF 的多行文本照样识别（Windows 剪贴板）', () => {
    const result = inspectPaste('line1\r\nline2\r\nline3')
    expect(result.hasCarriageReturns).toBe(true)
    expect(result.lineCount).toBe(3)
    expect(result.needsConfirm).toBe(true)
  })

  it('空字符串不提示', () => {
    const result = inspectPaste('')
    expect(result.lineCount).toBe(0)
    expect(result.needsConfirm).toBe(false)
  })
})
