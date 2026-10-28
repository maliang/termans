import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_SIZE, sessionForTab, tabIdForSession, useSessionStore } from './session-store'

/**
 * 会话映射单测：`tabId ↔ sessionId` 是数据路由的唯一依据，
 * 一旦错一个，输出就会写到别的页签（串台），所以这里逐条钉住。
 */

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

beforeEach(() => {
  store().reset()
})

describe('useSessionStore', () => {
  it('ensure 幂等，默认尺寸 80x24，phase 为 idle', () => {
    const view = store().ensure('tab-1')
    expect(view.cols).toBe(DEFAULT_TERMINAL_SIZE.cols)
    expect(view.rows).toBe(DEFAULT_TERMINAL_SIZE.rows)
    expect(view.phase).toBe('idle')
    expect(view.sessionId).toBeNull()
    const again = store().ensure('tab-1', { hostLabel: 'prod' })
    expect(again.hostLabel).toBe('prod')
    expect(store().byTab['tab-1']?.hostLabel).toBe('prod')
  })

  it('bindSession 双向映射，tabIdForSession 可反查', () => {
    store().bindSession('tab-1', 'ssh-1', 'prod')
    expect(store().bySession['ssh-1']).toBe('tab-1')
    expect(store().byTab['tab-1']?.sessionId).toBe('ssh-1')
    expect(tabIdForSession('ssh-1')).toBe('tab-1')
    expect(tabIdForSession('ssh-x')).toBeNull()
    expect(tabIdForSession(null)).toBeNull()
    expect(sessionForTab('tab-1')?.hostLabel).toBe('prod')
    expect(sessionForTab('nope')).toBeNull()
  })

  it('setPhase / setSize / setRenderer 只在真变化时改（避免无意义重渲染）', () => {
    store().ensure('tab-1')
    const before = store().byTab['tab-1']
    store().setPhase('tab-1', 'idle')
    expect(store().byTab['tab-1']).toBe(before)
    store().setPhase('tab-1', 'connected')
    expect(store().byTab['tab-1']?.phase).toBe('connected')
    store().setSize('tab-1', { cols: 120, rows: 40 })
    expect(store().byTab['tab-1']).toMatchObject({ cols: 120, rows: 40 })
    store().setRenderer('tab-1', 'webgl')
    expect(store().byTab['tab-1']?.renderer).toBe('webgl')
  })

  it('recordOutput 累计字节数并刷新 lastActivityAt', () => {
    store().ensure('tab-1')
    expect(store().byTab['tab-1']?.receivedBytes).toBe(0)
    store().recordOutput('tab-1', 12)
    store().recordOutput('tab-1', 8)
    expect(store().byTab['tab-1']?.receivedBytes).toBe(20)
    expect(store().byTab['tab-1']?.lastActivityAt).toBeGreaterThan(0)
  })

  it('recordClose 记退出码；带 error 时 phase 变 error', () => {
    store().ensure('tab-1')
    store().recordClose('tab-1', 0)
    expect(store().byTab['tab-1']).toMatchObject({ phase: 'closed', exitCode: 0 })
    store().ensure('tab-2')
    store().recordClose('tab-2', null, '连接异常中断')
    expect(store().byTab['tab-2']).toMatchObject({ phase: 'error', error: '连接异常中断' })
  })

  it('detach 只清 sessionId 与反向映射，保留视图统计（重连要用）', () => {
    store().ensure('tab-1')
    store().bindSession('tab-1', 'ssh-1')
    store().recordOutput('tab-1', 100)
    store().detach('tab-1')
    expect(store().byTab['tab-1']?.sessionId).toBeNull()
    expect(store().byTab['tab-1']?.receivedBytes).toBe(100)
    expect(store().bySession['ssh-1']).toBeUndefined()
  })

  it('unbind 彻底移除页签视图与它的所有会话映射', () => {
    store().ensure('tab-1')
    store().ensure('tab-2')
    store().bindSession('tab-1', 'ssh-1')
    store().bindSession('tab-2', 'ssh-2')
    store().unbind('tab-1')
    expect(store().byTab['tab-1']).toBeUndefined()
    expect(store().bySession['ssh-1']).toBeUndefined()
    expect(store().bySession['ssh-2']).toBe('tab-2')
  })

  it('setFontSize 支持页签级覆盖与清除（null = 回落到全局设置）', () => {
    store().ensure('tab-1')
    store().setFontSize('tab-1', 16)
    expect(store().byTab['tab-1']?.fontSize).toBe(16)
    store().setFontSize('tab-1', null)
    expect(store().byTab['tab-1']?.fontSize).toBeNull()
  })
})
