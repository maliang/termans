import { beforeEach, describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import type {
  SshClosedEvent,
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshStateEvent,
  TerminalSize
} from '@shared'
import { useTabStore } from '../tabs/tab-store'
import { createSessionController, mapSshPhase } from './session-controller'
import { useSessionStore } from './session-store'
import { createTerminalPool } from './terminal-pool'
import type { TerminalFactory, TerminalHandle, TerminalTransport } from './types'

/**
 * 会话控制器单测：连接、数据路由、状态映射、resize、关页签的清理。
 *
 * 全部依赖注入（假 transport + 假终端 + 真 zustand store），
 * 所以在 node 环境里就能验证「输出不会串台」「关页签一定 disconnect + dispose」。
 */

interface Harness {
  controller: ReturnType<typeof createSessionController>
  transport: TerminalTransport
  pool: ReturnType<typeof createTerminalPool>
  written: string[]
  connects: SshConnectRequest[]
  writes: Array<{ sessionId: string; data: string }>
  resizes: Array<{ sessionId: string; size: TerminalSize }>
  disconnects: string[]
  emitData: (sessionId: string, data: string) => void
  emitState: (sessionId: string, phase: SshStateEvent['phase']) => void
  emitClosed: (event: SshClosedEvent) => void
  handleDisposed: (tabId: string) => boolean
}

function createHarness(options: { connect: (request: SshConnectRequest) => Promise<SshConnectResult> }): Harness {
  const dataListeners = new Set<(event: SshDataEvent) => void>()
  const stateListeners = new Set<(event: SshStateEvent) => void>()
  const closedListeners = new Set<(event: SshClosedEvent) => void>()
  const written: string[] = []
  const connects: SshConnectRequest[] = []
  const writes: Array<{ sessionId: string; data: string }> = []
  const resizes: Array<{ sessionId: string; size: TerminalSize }> = []
  const disconnects: string[] = []
  const disposed = new Set<string>()

  const transport: TerminalTransport = {
    kind: 'mock',
    connect: (request) => {
      connects.push(request)
      return options.connect(request)
    },
    write: (sessionId, data) => {
      writes.push({ sessionId, data })
      return Promise.resolve()
    },
    resize: (sessionId, size) => {
      resizes.push({ sessionId, size })
      return Promise.resolve()
    },
    disconnect: (sessionId) => {
      disconnects.push(sessionId)
      return Promise.resolve()
    },
    onData: (listener) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onState: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onClosed: (listener) => {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    }
  }

  const factory: TerminalFactory = ({ tabId }) => {
    const handle: TerminalHandle = {
      tabId,
      terminal: {
        write: (data: string) => {
          written.push(data)
        }
      } as unknown as TerminalHandle['terminal'],
      fit: {} as TerminalHandle['fit'],
      search: {} as TerminalHandle['search'],
      renderer: 'dom',
      get disposed() {
        return disposed.has(tabId)
      },
      size: () => ({ cols: 100, rows: 30 }),
      propose: () => ({ cols: 100, rows: 30 }),
      dispose: () => {
        disposed.add(tabId)
      }
    }
    return handle
  }

  const pool = createTerminalPool({ factory })
  const controller = createSessionController({ transport, pool })

  return {
    controller,
    transport,
    pool,
    written,
    connects,
    writes,
    resizes,
    disconnects,
    emitData: (sessionId, data) => {
      for (const listener of dataListeners) listener({ sessionId, data })
    },
    emitState: (sessionId, phase) => {
      for (const listener of stateListeners) listener({ sessionId, phase, message: null })
    },
    emitClosed: (event) => {
      for (const listener of closedListeners) listener(event)
    },
    handleDisposed: (tabId) => disposed.has(tabId)
  }
}

const tabState = (): ReturnType<typeof useTabStore.getState> => useTabStore.getState()
const sessionState = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

function openTabWithHost(label = 'prod'): string {
  const tabId = tabState().openTab({ hostId: 'host-1', hostLabel: label })
  useSessionStore.getState().ensure(tabId, { hostLabel: label })
  return tabId
}

beforeEach(() => {
  tabState().reset()
  sessionState().reset()
})

describe('mapSshPhase', () => {
  it('把 SSH 阶段收敛成 6 种页签状态点', () => {
    expect(mapSshPhase('idle')).toBe('idle')
    expect(mapSshPhase('connecting')).toBe('connecting')
    expect(mapSshPhase('authenticating')).toBe('connecting')
    expect(mapSshPhase('host-key-verification')).toBe('connecting')
    expect(mapSshPhase('connected')).toBe('connected')
    expect(mapSshPhase('reconnecting')).toBe('reconnecting')
    expect(mapSshPhase('closed')).toBe('closed')
    expect(mapSshPhase('error')).toBe('error')
  })
})

describe('connectTab', () => {
  it('握手用页面实际尺寸，成功后写回 sessionId 与双向映射', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: 'SHA256:x', hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    harness.pool.create(tabId, null)
    const stop = harness.controller.start()

    await harness.controller.connectTab(tabId)

    expect(harness.connects).toHaveLength(1)
    expect(harness.connects[0]).toMatchObject({ hostId: 'host-1', size: { cols: 100, rows: 30 }, reuseExisting: false })
    expect(tabState().tabs[0]?.status).toBe('connected')
    expect(tabState().tabs[0]?.sessionId).toBe('ssh-1')
    expect(sessionState().byTab[tabId]?.sessionId).toBe('ssh-1')
    expect(sessionState().bySession['ssh-1']).toBe(tabId)
    stop()
  })

  it('同一个页签重复调用不会开第二条会话', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'not-verified' })
    })
    const tabId = openTabWithHost()
    await harness.controller.connectTab(tabId)
    await harness.controller.connectTab(tabId)
    expect(harness.connects).toHaveLength(1)
  })

  it('主进程还没接线（E_NOT_IMPLEMENTED）时降级成页签 error + 终端内提示，不抛异常', async () => {
    const harness = createHarness({
      connect: () => Promise.reject(new IpcCallError({ code: 'E_NOT_IMPLEMENTED', message: 'ssh:connect not implemented' }))
    })
    const tabId = openTabWithHost()
    harness.pool.create(tabId, null)

    await expect(harness.controller.connectTab(tabId)).resolves.toBeUndefined()

    expect(tabState().tabs[0]?.status).toBe('error')
    expect(harness.written.join('')).toContain('SSH 引擎尚未接线')
    expect(sessionState().byTab[tabId]?.error).toContain('尚未接线')
  })

  it('没有 hostId 的空页签不发起连接', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'not-verified' })
    })
    const tabId = tabState().openTab()
    await harness.controller.connectTab(tabId)
    expect(harness.connects).toHaveLength(0)
  })
})

describe('数据与状态路由', () => {
  it('ssh:data 只写进对应页签，并统计字节数', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    const other = openTabWithHost('staging')
    harness.pool.create(tabId, null)
    harness.pool.create(other, null)
    const stop = harness.controller.start()
    await harness.controller.connectTab(tabId)

    harness.emitData('ssh-1', 'hello')

    expect(harness.written).toEqual(['hello'])
    expect(sessionState().byTab[tabId]?.receivedBytes).toBe(5)
    stop()
  })

  it('非激活页签收到输出时累加未读数，激活页签不累加', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const background = openTabWithHost('prod')
    harness.pool.create(background, null)
    const stop = harness.controller.start()
    await harness.controller.connectTab(background)

    // 当前激活的是 background
    expect(tabState().activeTabId).toBe(background)
    harness.emitData('ssh-1', 'x')
    expect(tabState().tabs.find((tab) => tab.id === background)?.unreadCount).toBe(0)

    // 切到另一个页签后再来输出 → 记 1 条未读
    const foreground = openTabWithHost('staging')
    harness.pool.create(foreground, null)
    harness.emitData('ssh-1', 'more output')
    expect(tabState().tabs.find((tab) => tab.id === background)?.unreadCount).toBe(1)
    stop()
  })

  it('ssh:state-changed 映射到页签状态点', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    const stop = harness.controller.start()
    await harness.controller.connectTab(tabId)

    harness.emitState('ssh-1', 'authenticating')
    expect(tabState().tabs[0]?.status).toBe('connecting')
    harness.emitState('ssh-1', 'reconnecting')
    expect(tabState().tabs[0]?.status).toBe('reconnecting')
    stop()
  })

  it('ssh:closed 清空 sessionId（可重连）并写一行结束提示', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    harness.pool.create(tabId, null)
    const stop = harness.controller.start()
    await harness.controller.connectTab(tabId)

    harness.emitClosed({ sessionId: 'ssh-1', exitCode: 0, signal: null, reason: 'exit' })

    expect(tabState().tabs[0]?.status).toBe('closed')
    expect(tabState().tabs[0]?.sessionId).toBeNull()
    expect(sessionState().byTab[tabId]?.phase).toBe('closed')
    expect(harness.written.join('')).toContain('会话结束')
    stop()
  })
})

describe('握手前就到的事件（早期 banner）', () => {
  it('connect 还没 resolve 就推来的 banner/状态，会在 bindSession 之后补放，不丢字', async () => {
    const dataListeners = new Set<(event: SshDataEvent) => void>()
    const stateListeners = new Set<(event: SshStateEvent) => void>()
    const written: string[] = []
    const transport: TerminalTransport = {
      kind: 'mock',
      connect: () => {
        // 关键时序：先推 connected + banner，再 resolve —— 真实的 ssh2 也是这个顺序
        for (const listener of stateListeners) listener({ sessionId: 'ssh-early', phase: 'connected', message: null })
        for (const listener of dataListeners) listener({ sessionId: 'ssh-early', data: 'Welcome banner\r\n' })
        return Promise.resolve({ sessionId: 'ssh-early', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
      },
      write: () => Promise.resolve(),
      resize: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      onData: (listener) => {
        dataListeners.add(listener)
        return () => dataListeners.delete(listener)
      },
      onState: (listener) => {
        stateListeners.add(listener)
        return () => stateListeners.delete(listener)
      },
      onClosed: () => () => {}
    }
    const factory: TerminalFactory = ({ tabId }) => ({
      tabId,
      terminal: { write: (data: string) => written.push(data) } as unknown as TerminalHandle['terminal'],
      fit: {} as TerminalHandle['fit'],
      search: {} as TerminalHandle['search'],
      renderer: 'dom',
      disposed: false,
      size: () => ({ cols: 80, rows: 24 }),
      propose: () => ({ cols: 80, rows: 24 }),
      dispose: () => {}
    })
    const pool = createTerminalPool({ factory })
    const controller = createSessionController({ transport, pool })
    const tabId = openTabWithHost()
    pool.create(tabId, null)
    const stop = controller.start()

    await controller.connectTab(tabId)

    expect(written.join('')).toContain('Welcome banner')
    expect(sessionState().byTab[tabId]?.phase).toBe('connected')
    expect(sessionState().byTab[tabId]?.receivedBytes).toBe('Welcome banner\r\n'.length)
    stop()
  })
})

describe('输入 / resize', () => {
  it('sendInput 走 ssh:input，未连接时静默丢弃', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    harness.controller.sendInput(tabId, 'ls\r')
    expect(harness.writes).toHaveLength(0)

    await harness.controller.connectTab(tabId)
    harness.controller.sendInput(tabId, 'ls\r')
    expect(harness.writes).toEqual([{ sessionId: 'ssh-1', data: 'ls\r' }])
  })

  it('sendResize 写会话尺寸并下发 ssh:resize', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    await harness.controller.connectTab(tabId)

    harness.controller.sendResize(tabId, { cols: 132, rows: 43 })

    expect(sessionState().byTab[tabId]).toMatchObject({ cols: 132, rows: 43 })
    expect(harness.resizes).toEqual([{ sessionId: 'ssh-1', size: { cols: 132, rows: 43 } }])
  })
})

describe('关页签的清理（泄漏防线）', () => {
  it('关闭页签 → disconnect + 会话解绑 + 终端 dispose', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    harness.pool.create(tabId, null)
    const stop = harness.controller.start()
    await harness.controller.connectTab(tabId)

    tabState().closeTab(tabId)

    expect(harness.disconnects).toEqual(['ssh-1'])
    expect(harness.handleDisposed(tabId)).toBe(true)
    expect(sessionState().byTab[tabId]).toBeUndefined()
    expect(sessionState().bySession['ssh-1']).toBeUndefined()
    expect(harness.pool.stats()).toEqual({ created: 1, disposed: 1, live: 0 })
    stop()
  })

  it('disconnectTab(user) 后页签变成 closed，且不再把输出写进终端', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    harness.pool.create(tabId, null)
    const stop = harness.controller.start()
    await harness.controller.connectTab(tabId)

    await harness.controller.disconnectTab(tabId)

    expect(harness.disconnects).toEqual(['ssh-1'])
    expect(tabState().tabs[0]?.status).toBe('closed')
    const before = harness.written.length
    harness.emitData('ssh-1', '迟到的输出')
    expect(harness.written.length).toBe(before)
    stop()
  })

  it('reconnectTab 先断开旧会话再连新的', async () => {
    let counter = 0
    const harness = createHarness({
      connect: () => {
        counter += 1
        return Promise.resolve({ sessionId: `ssh-${counter}`, hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
      }
    })
    const tabId = openTabWithHost()
    await harness.controller.connectTab(tabId)
    expect(sessionState().byTab[tabId]?.sessionId).toBe('ssh-1')

    await harness.controller.reconnectTab(tabId)

    expect(harness.disconnects).toEqual(['ssh-1'])
    expect(sessionState().byTab[tabId]?.sessionId).toBe('ssh-2')
    expect(harness.connects).toHaveLength(2)
  })

  it('dispose 之后不再路由任何输出（窗口关闭时不留悬挂监听）', async () => {
    const harness = createHarness({
      connect: () => Promise.resolve({ sessionId: 'ssh-1', hostKeyFingerprint: null, hostKeyDecision: 'trusted' })
    })
    const tabId = openTabWithHost()
    harness.pool.create(tabId, null)
    harness.controller.start()
    await harness.controller.connectTab(tabId)
    harness.controller.dispose()

    harness.emitData('ssh-1', 'should be ignored')
    expect(harness.written).toHaveLength(0)
  })
})
