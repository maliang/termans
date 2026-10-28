import type { SshClosedEvent, SshPhase, TerminalSize } from '@shared'
import { describeError, isNotImplemented } from '@renderer/platform/ipc'
import type { TerminalHandle, TerminalTransport } from './types'
import type { TabStatus, TabStoreState, TerminalTab } from '../tabs/tab-store'
import { findTab, subscribeTabEvents, useTabStore, type TabEvent } from '../tabs/tab-store'
import { DEFAULT_TERMINAL_SIZE, useSessionStore, type SessionStoreState } from './session-store'
import type { TerminalPool } from './terminal-pool'
import { sizesEqual } from './resize'

/**
 * 会话控制器：把「页签生命周期 / 传输层事件 / 终端实例」缝在一起。
 *
 * 这里是整个终端功能里唯一有副作用编排的地方，所以它**不直接碰 React**、也不直接碰 @xterm：
 * 依赖（transport、pool、两个 store 的 getState）都可注入，单测用假 transport + 假 pool
 * 就能验证「连接、数据路由、resize 只发一次、关页签必 disconnect + dispose」。
 */

export type TransportReason = 'user' | 'error' | 'window'

/** SSH 阶段 → 页签状态点。host-key-verification 也算 connecting（用户看到的是「在连」） */
export function mapSshPhase(phase: SshPhase): TabStatus {
  switch (phase) {
    case 'idle':
      return 'idle'
    case 'connecting':
    case 'authenticating':
    case 'host-key-verification':
      return 'connecting'
    case 'connected':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting'
    case 'closed':
      return 'closed'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

export interface SessionControllerDeps {
  transport: TerminalTransport
  pool: TerminalPool
  tabs?: () => TabStoreState
  sessions?: () => SessionStoreState
}

export interface SessionController {
  /** 订阅传输层与页签事件；返回取消订阅函数 */
  start: () => () => void
  connectTab: (tabId: string) => Promise<void>
  reconnectTab: (tabId: string) => Promise<void>
  disconnectTab: (tabId: string, reason?: TransportReason) => Promise<void>
  sendInput: (tabId: string, data: string) => void
  sendResize: (tabId: string, size: TerminalSize) => void
  /** 直接往终端写本地文本（提示、错误回显），不经过 SSH */
  write: (tabId: string, text: string) => void
  handle: (tabId: string) => TerminalHandle | null
  sessionIdOf: (tabId: string) => string | null
  dispose: () => void
}

const DIM = '\x1b[90m'
const BAD = '\x1b[31m'
const RESET = '\x1b[0m'

export function createSessionController(deps: SessionControllerDeps): SessionController {
  const { transport, pool } = deps
  const tabState = deps.tabs ?? (() => useTabStore.getState())
  const sessionState = deps.sessions ?? (() => useSessionStore.getState())

  const sessionToTab = new Map<string, string>()
  const reportedFailures = new Set<string>()
  let offTransport: (() => void) | null = null
  let offTabs: (() => void) | null = null

  const write = (tabId: string, text: string): void => {
    const handle = pool.get(tabId)
    if (!handle || handle.disposed) return
    handle.terminal.write(text)
  }

  const tabOf = (tabId: string): TerminalTab | null => findTab(tabState().tabs, tabId)

  const resolveTabId = (sessionId: string): string | null =>
    sessionToTab.get(sessionId) ?? sessionState().bySession[sessionId] ?? null

  /**
   * 早到事件缓冲。
   *
   * 真实 ssh2 和假后端都会在 `ssh:connect` 的 invoke 还没 resolve 前就把 banner/MOTD 推过来
   * （契约里 sessionId 是 connect 的**返回值**，所以这一刻前端还不知道它属于哪个页签）。
   * 直接丢掉 → 用户看到「连上了但一片空白」，这是最难查的一类故障。
   * 所以按 sessionId 暂存，等 bindSession 时按顺序回放。
   */
  type PendingEvent =
    | { kind: 'data'; data: string }
    | { kind: 'state'; phase: SshPhase }
    | { kind: 'closed'; event: SshClosedEvent }

  const PENDING_LIMIT = 64
  const pendingEvents = new Map<string, PendingEvent[]>()

  const stash = (sessionId: string, event: PendingEvent): void => {
    const queue = pendingEvents.get(sessionId) ?? []
    // 上限只为防泄漏：真连上之前能积 64 条已经非常极端了
    if (queue.length >= PENDING_LIMIT) return
    queue.push(event)
    pendingEvents.set(sessionId, queue)
  }

  const reportOnce = (tabId: string, key: string, text: string): void => {
    if (reportedFailures.has(key)) return
    reportedFailures.add(key)
    write(tabId, `\r\n${BAD}${text}${RESET}\r\n`)
  }

  const sendResize = (tabId: string, size: TerminalSize): void => {
    sessionState().setSize(tabId, size)
    const sessionId = sessionState().byTab[tabId]?.sessionId ?? tabOf(tabId)?.sessionId ?? null
    if (!sessionId) return
    // resize 失败不该弹窗：窗口拖动时会连续触发，报错刷屏比不报更糟
    void transport.resize(sessionId, size).catch(() => {})
  }

  const sendInput = (tabId: string, data: string): void => {
    const sessionId = sessionState().byTab[tabId]?.sessionId ?? tabOf(tabId)?.sessionId ?? null
    if (!sessionId) return
    void transport.write(sessionId, data).catch((error: unknown) => {
      if (isNotImplemented(error)) return
      reportOnce(tabId, `input:${sessionId}`, `[输入发送失败] ${describeError(error)}`)
    })
  }

  const applyData = (tabId: string, data: string): void => {
    write(tabId, data)
    sessionState().recordOutput(tabId, data.length)
    // 后台页签只记未读，不抢焦点
    if (tabState().activeTabId !== tabId) tabState().markOutput(tabId)
  }

  const applyState = (tabId: string, phase: SshPhase): void => {
    sessionState().setPhase(tabId, phase)
    tabState().setStatus(tabId, mapSshPhase(phase))
    if (phase === 'connected') {
      const proposed = pool.get(tabId)?.propose() ?? null
      if (proposed) sendResize(tabId, proposed)
    }
  }

  const applyClosed = (tabId: string, sessionId: string, event: SshClosedEvent): void => {
    sessionToTab.delete(sessionId)
    pendingEvents.delete(sessionId)
    reportedFailures.delete(`input:${sessionId}`)
    sessionState().detach(tabId)
    sessionState().recordClose(tabId, event.exitCode ?? null, event.reason === 'error' ? '连接异常中断' : null)
    tabState().setSessionId(tabId, null)
    tabState().setStatus(tabId, event.reason === 'error' ? 'error' : 'closed')
    write(tabId, `\r\n${DIM}[${describeClose(event)}]${RESET}\r\n`)
  }

  /** 把 bindSession 之前攒下的事件按到达顺序补放 */
  const replayPending = (tabId: string, sessionId: string): void => {
    const queue = pendingEvents.get(sessionId)
    if (!queue) return
    pendingEvents.delete(sessionId)
    for (const event of queue) {
      if (event.kind === 'data') applyData(tabId, event.data)
      else if (event.kind === 'state') applyState(tabId, event.phase)
      else applyClosed(tabId, sessionId, event.event)
    }
  }

  const connectTab = async (tabId: string): Promise<void> => {
    const tab = tabOf(tabId)
    if (!tab) return
    // 已连上/正在连：重复点击「重连」不该开第二条会话
    if (tab.sessionId) return
    if (!tab.hostId) return

    const handle = pool.get(tabId)
    const size = handle?.propose() ?? handle?.size() ?? DEFAULT_TERMINAL_SIZE
    sessionState().ensure(tabId, {
      hostLabel: tab.hostLabel ?? '',
      cols: size.cols,
      rows: size.rows,
      renderer: handle?.renderer ?? 'dom'
    })
    sessionState().setPhase(tabId, 'connecting')
    tabState().setStatus(tabId, 'connecting')

    try {
      const result = await transport.connect({
        hostId: tab.hostId,
        size,
        startupCommand: null,
        reuseExisting: false
      })
      sessionToTab.set(result.sessionId, tabId)
      reportedFailures.delete(`input:${result.sessionId}`)
      sessionState().bindSession(tabId, result.sessionId, tab.hostLabel ?? '')
      sessionState().setPhase(tabId, 'connected')
      tabState().setStatus(tabId, 'connected', result.sessionId)
      // 握手期间就先到的 banner/提示（见 pendingEvents）在这里补放
      replayPending(tabId, result.sessionId)
      // 首次 fit 之后真实尺寸可能和握手时不同，补发一次（主进程按最后一次为准）
      const proposed = pool.get(tabId)?.propose() ?? null
      if (proposed && !sizesEqual(proposed, size)) sendResize(tabId, proposed)
    } catch (error) {
      const message = isNotImplemented(error) ? 'SSH 引擎尚未接线（占位实现）' : describeError(error)
      reportOnce(tabId, `connect:${tabId}`, `[连接失败] ${message}`)
      sessionState().recordError(tabId, message)
      tabState().setStatus(tabId, 'error')
    }
  }

  const detach = (tabId: string): void => {
    const view = sessionState().byTab[tabId]
    if (view?.sessionId) sessionToTab.delete(view.sessionId)
    sessionState().detach(tabId)
    tabState().setSessionId(tabId, null)
  }

  const disconnectTab = async (tabId: string, reason: TransportReason = 'user'): Promise<void> => {
    const sessionId = sessionState().byTab[tabId]?.sessionId ?? tabOf(tabId)?.sessionId ?? null
    if (!sessionId) {
      detach(tabId)
      return
    }
    sessionToTab.delete(sessionId)
    try {
      await transport.disconnect(sessionId)
    } catch (error) {
      // 主进程那边可能已经没了；用户主动关页签时不该因此卡住
      if (!isNotImplemented(error)) {
        reportOnce(tabId, `disconnect:${sessionId}`, `[断开失败] ${describeError(error)}`)
      }
    }
    sessionState().detach(tabId)
    sessionState().recordClose(tabId, null, reason === 'error' ? '连接异常中断' : null)
    tabState().setSessionId(tabId, null)
    tabState().setStatus(tabId, reason === 'error' ? 'error' : 'closed')
  }

  const reconnectTab = async (tabId: string): Promise<void> => {
    const hadSession = Boolean(sessionState().byTab[tabId]?.sessionId ?? tabOf(tabId)?.sessionId)
    if (hadSession) {
      tabState().setStatus(tabId, 'reconnecting')
      const sessionId = sessionState().byTab[tabId]?.sessionId ?? tabOf(tabId)?.sessionId ?? null
      if (sessionId) {
        sessionToTab.delete(sessionId)
        await transport.disconnect(sessionId).catch(() => {})
      }
      detach(tabId)
    }
    await connectTab(tabId)
  }

  const onTabClosed = (tab: TerminalTab): void => {
    const sessionId = sessionState().byTab[tab.id]?.sessionId ?? tab.sessionId ?? null
    if (sessionId) {
      sessionToTab.delete(sessionId)
      reportedFailures.delete(`input:${sessionId}`)
      void transport.disconnect(sessionId).catch(() => {})
    }
    sessionState().unbind(tab.id)
    // xterm 实例必须在这里释放：晚一步就是 canvas/addon 泄漏
    pool.dispose(tab.id)
  }

  const handleTabEvent = (event: TabEvent): void => {
    if (event.type === 'closed') onTabClosed(event.tab)
  }

  const start = (): (() => void) => {
    offTransport?.()
    offTabs?.()
    offTabs = subscribeTabEvents(handleTabEvent)
    const offData = transport.onData((event) => {
      const tabId = resolveTabId(event.sessionId)
      if (!tabId) {
        stash(event.sessionId, { kind: 'data', data: event.data })
        return
      }
      applyData(tabId, event.data)
    })
    const offState = transport.onState((event) => {
      const tabId = resolveTabId(event.sessionId)
      if (!tabId) {
        stash(event.sessionId, { kind: 'state', phase: event.phase })
        return
      }
      applyState(tabId, event.phase)
    })
    const offClosed = transport.onClosed((event) => {
      const tabId = resolveTabId(event.sessionId)
      if (!tabId) {
        stash(event.sessionId, { kind: 'closed', event })
        return
      }
      applyClosed(tabId, event.sessionId, event)
    })
    offTransport = () => {
      offData()
      offState()
      offClosed()
    }
    return () => {
      offTransport?.()
      offTransport = null
      offTabs?.()
      offTabs = null
    }
  }

  return {
    start,
    connectTab,
    reconnectTab,
    disconnectTab,
    sendInput,
    sendResize,
    write,
    handle: (tabId) => pool.get(tabId),
    sessionIdOf: (tabId) => sessionState().byTab[tabId]?.sessionId ?? tabOf(tabId)?.sessionId ?? null,
    dispose: () => {
      offTransport?.()
      offTransport = null
      offTabs?.()
      offTabs = null
      sessionToTab.clear()
      reportedFailures.clear()
      pendingEvents.clear()
    }
  }
}

function describeClose(event: { reason: string; exitCode: number | null; signal: string | null }): string {
  switch (event.reason) {
    case 'exit':
      return `会话结束（退出码 ${event.exitCode ?? '?'}）`
    case 'disconnected':
      return '连接已断开'
    case 'user':
      return '会话已关闭'
    default:
      return event.signal ? `连接异常中断（${event.signal}）` : '连接异常中断'
  }
}
