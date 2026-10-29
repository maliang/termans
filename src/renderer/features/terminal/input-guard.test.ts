import { describe, expect, it } from 'vitest'
import { EMPTY_INPUT_GUARD, noteTerminalData, shouldSuppressInput } from './input-guard'

describe('输入重复发送守卫', () => {
  it('单字符 onData 记成待判回声的字符', () => {
    expect(noteTerminalData(EMPTY_INPUT_GUARD, 'a').pending).toBe('a')
    expect(noteTerminalData(EMPTY_INPUT_GUARD, ' ').pending).toBe(' ')
    expect(noteTerminalData(EMPTY_INPUT_GUARD, '\r').pending).toBe('\r')
  })

  it('多字符 onData（粘贴、输入法上屏）清空守卫', () => {
    expect(noteTerminalData({ pending: 'a' }, 'echo hello').pending).toBeNull()
  })

  it('空串不会把已有的 pending 抹掉（xterm 不会发空串，但别让它误伤）', () => {
    expect(noteTerminalData({ pending: 'a' }, '').pending).toBe('a')
  })

  it('同一个字符的 insertText 回声要拦（keydown 已经发过一次）', () => {
    const state = noteTerminalData(EMPTY_INPUT_GUARD, 'x')
    expect(shouldSuppressInput(state, 'x', 'insertText')).toBe(true)
  })

  it('回车/空格的回声同样要拦', () => {
    expect(shouldSuppressInput(noteTerminalData(EMPTY_INPUT_GUARD, ' '), ' ', 'insertText')).toBe(true)
    expect(shouldSuppressInput(noteTerminalData(EMPTY_INPUT_GUARD, '\r'), '\r', 'insertText')).toBe(true)
  })

  it('字符不同的 input 放行（那是真的新输入，例如 insertText 整段字符串）', () => {
    const state = noteTerminalData(EMPTY_INPUT_GUARD, 'e')
    expect(shouldSuppressInput(state, 'E2E-STILL-ALIVE', 'insertText')).toBe(false)
    expect(shouldSuppressInput(state, 'x', 'insertText')).toBe(false)
  })

  it('输入法事件不碰（insertCompositionText / insertFromPaste 都不是我们的回声）', () => {
    const state = noteTerminalData(EMPTY_INPUT_GUARD, 'a')
    expect(shouldSuppressInput(state, 'a', 'insertCompositionText')).toBe(false)
    expect(shouldSuppressInput(state, 'a', 'insertFromPaste')).toBe(false)
    expect(shouldSuppressInput(state, 'a', undefined)).toBe(false)
  })

  it('没有 pending（例如刚从粘贴过来）时一律放行', () => {
    expect(shouldSuppressInput(EMPTY_INPUT_GUARD, 'a', 'insertText')).toBe(false)
  })

  it('data 为 null 的 input 放行', () => {
    expect(shouldSuppressInput(noteTerminalData(EMPTY_INPUT_GUARD, 'a'), null, 'insertText')).toBe(false)
  })
})
