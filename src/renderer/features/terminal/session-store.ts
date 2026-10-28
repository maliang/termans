import { create } from 'zustand'
import type { SshPhase, TerminalSize } from '@shared'
import type { RendererKind } from './types'

/**
 * 会话状态（zustand）：`tabId ↔ sessionId ↔ 终端实例` 三者的**可序列化那一半**。
 *
 * 为什么要单独一个 store，而不是塞进 tab store：
 * - 页签条只需要 6 个字段（标题/状态/未读…），会话的 cols/rows/字节数每收一段输出都会变，
 *   放进 tab store 会让**整条页签条**跟着每秒重渲染几十次；
 * - xterm 实例本身仍然不进 React state（见 `terminal-pool.ts`）：React 一重渲染父级，
 *   xterm 的输入法组合状态和滚动位置就可能丢。这里只存映射与统计。
 */

export const DEFAULT_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 }

export interface SessionView {
  tabId: string
  sessionId: string | null
  hostLabel: string
  cols: number
  rows: number
  phase: SshPhase
  renderer: RendererKind
  /** 用户为这个页签单独调过的字号；null = 跟随 settings.terminal.fontSize */
  fontSize: number | null
  receivedBytes: number
  lastActivityAt: number
  exitCode: number | null
  error: string | null
}

export interface EnsureSessionInput {
  hostLabel?: string
  cols?: number
  rows?: number
  renderer?: RendererKind
}

export interface SessionStoreState {
  byTab: Record<string, SessionView>
  /** sessionId → tabId；收到 ssh:data 时它决定往哪个终端写 */
  bySession: Record<string, string>

  ensure: (tabId: string, input?: EnsureSessionInput) => SessionView
  bindSession: (tabId: string, sessionId: string, hostLabel?: string) => void
  setPhase: (tabId: string, phase: SshPhase) => void
  setSize: (tabId: string, size: TerminalSize) => void
  setRenderer: (tabId: string, renderer: RendererKind) => void
  setFontSize: (tabId: string, fontSize: number | null) => void
  recordOutput: (tabId: string, bytes: number) => void
  recordClose: (tabId: string, exitCode: number | null, error?: string | null) => void
  recordError: (tabId: string, message: string) => void
  /** 只断开映射（保留视图与统计），用于重连 / 会话结束；关页签请用 unbind */
  detach: (tabId: string) => void
  unbind: (tabId: string) => void
  reset: () => void
}

function createView(tabId: string, input: EnsureSessionInput = {}): SessionView {
  return {
    tabId,
    sessionId: null,
    hostLabel: input.hostLabel ?? '',
    cols: input.cols ?? DEFAULT_TERMINAL_SIZE.cols,
    rows: input.rows ?? DEFAULT_TERMINAL_SIZE.rows,
    phase: 'idle',
    renderer: input.renderer ?? 'dom',
    fontSize: null,
    receivedBytes: 0,
    lastActivityAt: 0,
    exitCode: null,
    error: null
  }
}

export const useSessionStore = create<SessionStoreState>()((set, get) => ({
  byTab: {},
  bySession: {},

  ensure: (tabId, input = {}) => {
    const existing = get().byTab[tabId]
    if (existing) {
      const merged: SessionView = {
        ...existing,
        hostLabel: input.hostLabel ?? existing.hostLabel,
        cols: input.cols ?? existing.cols,
        rows: input.rows ?? existing.rows,
        renderer: input.renderer ?? existing.renderer
      }
      set((state) => ({ byTab: { ...state.byTab, [tabId]: merged } }))
      return merged
    }
    const view = createView(tabId, input)
    set((state) => ({ byTab: { ...state.byTab, [tabId]: view } }))
    return view
  },

  bindSession: (tabId, sessionId, hostLabel) => {
    set((state) => {
      const view = state.byTab[tabId] ?? createView(tabId)
      return {
        byTab: {
          ...state.byTab,
          [tabId]: {
            ...view,
            sessionId,
            hostLabel: hostLabel ?? view.hostLabel,
            error: null
          }
        },
        bySession: { ...state.bySession, [sessionId]: tabId }
      }
    })
  },

  setPhase: (tabId, phase) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view || view.phase === phase) return state
      return { byTab: { ...state.byTab, [tabId]: { ...view, phase } } }
    })
  },

  setSize: (tabId, size) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view || (view.cols === size.cols && view.rows === size.rows)) return state
      return { byTab: { ...state.byTab, [tabId]: { ...view, cols: size.cols, rows: size.rows } } }
    })
  },

  setRenderer: (tabId, renderer) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view || view.renderer === renderer) return state
      return { byTab: { ...state.byTab, [tabId]: { ...view, renderer } } }
    })
  },

  setFontSize: (tabId, fontSize) => {
    set((state) => {
      const view = state.byTab[tabId] ?? createView(tabId)
      return { byTab: { ...state.byTab, [tabId]: { ...view, fontSize } } }
    })
  },

  recordOutput: (tabId, bytes) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view) return state
      return {
        byTab: {
          ...state.byTab,
          [tabId]: {
            ...view,
            receivedBytes: view.receivedBytes + bytes,
            lastActivityAt: Date.now()
          }
        }
      }
    })
  },

  recordClose: (tabId, exitCode, error = null) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view) return state
      return {
        byTab: {
          ...state.byTab,
          [tabId]: { ...view, phase: error ? 'error' : 'closed', exitCode, error: error ?? view.error }
        }
      }
    })
  },

  recordError: (tabId, message) => {
    set((state) => {
      const view = state.byTab[tabId] ?? createView(tabId)
      return { byTab: { ...state.byTab, [tabId]: { ...view, phase: 'error', error: message } } }
    })
  },

  detach: (tabId) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view) return state
      const bySession = { ...state.bySession }
      for (const [sessionId, mappedTab] of Object.entries(bySession)) {
        if (mappedTab === tabId) delete bySession[sessionId]
      }
      return { byTab: { ...state.byTab, [tabId]: { ...view, sessionId: null } }, bySession }
    })
  },

  unbind: (tabId) => {
    set((state) => {
      const view = state.byTab[tabId]
      if (!view) return state
      const bySession = { ...state.bySession }
      for (const [sessionId, mappedTab] of Object.entries(bySession)) {
        if (mappedTab === tabId) delete bySession[sessionId]
      }
      const byTab = { ...state.byTab }
      delete byTab[tabId]
      return { byTab, bySession }
    })
  },

  reset: () => set({ byTab: {}, bySession: {} })
}))

export function tabIdForSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  return useSessionStore.getState().bySession[sessionId] ?? null
}

export function sessionForTab(tabId: string | null | undefined): SessionView | null {
  if (!tabId) return null
  return useSessionStore.getState().byTab[tabId] ?? null
}
