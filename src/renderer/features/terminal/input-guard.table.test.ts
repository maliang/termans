import { describe, expect, it } from 'vitest'
import { EMPTY_INPUT_GUARD, noteTerminalData, shouldSuppressInput, type InputGuardState } from './input-guard'

/**
 * 用状态机复刻真实事件顺序，断言「最终发给 IPC 的字节序列」。
 *
 * 这里刻意不 mock 被验证的那一层：`noteTerminalData` 就是 onData 出口干的事，
 * `shouldSuppressInput` 就是 input 入口干的事，两者之间的状态传递与 XtermSurface 完全一致。
 * 真实浏览器里的端到端证据（服务端 PTY 收到的字节）在 t41 的报告里，脚本见 `dev/`。
 */

interface Harness {
  state: InputGuardState
  /** 按事件顺序喂进去，返回真正发给终端（ssh:input）的字节 */
  run(events: Array<{ kind: 'keydown' | 'keyup' | 'input'; data: string; inputType?: string }>): string
}

function createHarness(): Harness {
  let state = EMPTY_INPUT_GUARD
  return {
    get state() {
      return state
    },
    run(events) {
      let sent = ''
      for (const event of events) {
        if (event.kind === 'input') {
          if (shouldSuppressInput(state, event.data, event.inputType ?? 'insertText')) {
            state = EMPTY_INPUT_GUARD
            continue
          }
          sent += event.data
          state = noteTerminalData(state, event.data)
          continue
        }
        if (event.kind === 'keydown') {
          // xterm 的 _keyDown 直接把 key 派发出去
          sent += event.data
          state = noteTerminalData(state, event.data)
        }
      }
      return sent
    }
  }
}

describe('输入事件顺序与最终字节', () => {
  it('正常顺序（keydown → input → keyup）：一个字符只发一次', () => {
    const harness = createHarness()
    const sent = harness.run([
      { kind: 'keydown', data: 'x' },
      { kind: 'input', data: 'x' },
      { kind: 'keyup', data: 'x' }
    ])
    expect(sent).toBe('x')
  })

  it('高危顺序（keydown → keyup → input）：仍然只发一次', () => {
    const harness = createHarness()
    const sent = harness.run([
      { kind: 'keydown', data: 'x' },
      { kind: 'keyup', data: 'x' },
      { kind: 'input', data: 'x' }
    ])
    expect(sent).toBe('x')
  })

  it('空格与回车在这个顺序下也不会变成两个', () => {
    const harness = createHarness()
    const sent = harness.run([
      { kind: 'keydown', data: ' ' },
      { kind: 'keyup', data: ' ' },
      { kind: 'input', data: ' ' },
      { kind: 'keydown', data: '\r' },
      { kind: 'keyup', data: '\r' },
      { kind: 'input', data: '\r' }
    ])
    expect(sent).toBe(' \r')
  })

  it('用户快速连按同一个键两拍：两拍都保留（守卫只吃回声，不吃真按键）', () => {
    const harness = createHarness()
    const sent = harness.run([
      { kind: 'keydown', data: 'a' },
      { kind: 'input', data: 'a' },
      { kind: 'keyup', data: 'a' },
      { kind: 'keydown', data: 'a' },
      { kind: 'keyup', data: 'a' },
      { kind: 'input', data: 'a' }
    ])
    expect(sent).toBe('aa')
  })

  it('没有 keydown 的整段 insertText（自动化/听写）照常送出', () => {
    const harness = createHarness()
    const sent = harness.run([{ kind: 'input', data: 'echo E2E-STILL-ALIVE' }])
    expect(sent).toBe('echo E2E-STILL-ALIVE')
  })

  it('输入法上屏（insertCompositionText）不被当成回声', () => {
    const harness = createHarness()
    const sent = harness.run([
      { kind: 'keydown', data: 'a' },
      { kind: 'input', data: 'a', inputType: 'insertCompositionText' }
    ])
    expect(sent).toBe('aa')
  })
})
