import { create } from 'zustand'
import type { MenuCommand } from '@shared'

/**
 * 页签状态（terminal-ui 自己的 store，不进 IPC）。
 *
 * 职责边界（重要）：
 * - 这里只存**页签的可序列化元数据**：标题、主机、状态、未读计数、顺序；
 * - xterm 实例 / DOM 节点 / scrollback 一律不进 React state（每次 set 都会重渲染整条页签条，
 *   xterm 尤其怕父级重渲染：会掉输入法组合、丢滚动位置）。实例放在 `features/terminal/terminal-pool`。
 * - 页签 id ↔ 会话 id 的映射由看到连接的一侧（session-store）维护，这里只挂 `sessionId` 便于展示。
 *
 * 为什么事件要单独发一份（`subscribeTabEvents`）：
 * 关闭页签必须 dispose xterm 实例、断开 SSH，但 store 保持纯函数（不 import 终端/DOM，才能单测）。
 * 所以 store 只广播 opened/closed/activated 三类事件，由 session-controller 订阅后做副作用。
 */

export type TabStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'

/** 「还连着」的状态集合：关闭这些页签要先二次确认 */
const ACTIVE_STATUSES: readonly TabStatus[] = ['connecting', 'connected', 'reconnecting']

/** 页签从哪来：主机库 / 快速连接（临时主机） */
export type TabOrigin = 'host' | 'quick'

export interface TerminalTab {
  id: string
  title: string
  hostId: string | null
  hostLabel: string | null
  /** 主进程分配的 SSH 会话 id；未连接为 null */
  sessionId: string | null
  status: TabStatus
  /** 非激活页签收到输出时累加，切过去即清零 */
  unreadCount: number
  /** 单调递增序号，用于默认标题「Terminal N」与稳定排序 */
  seq: number
  origin: TabOrigin
  createdAt: number
}

export interface OpenTabInput {
  hostId?: string | null
  hostLabel?: string | null
  title?: string
  origin?: TabOrigin
  status?: TabStatus
}

/** 关闭请求的裁决结果：需要确认时不关，交给 UI 弹确认框 */
export type CloseRequest =
  | { closed: true; tab: TerminalTab }
  | { closed: false; reason: 'active-session'; tab: TerminalTab }
  | { closed: false; reason: 'not-found'; tab: null }

export interface TabEvent {
  type: 'opened' | 'closed' | 'activated'
  tab: TerminalTab
}

type TabListener = (event: TabEvent) => void

const listeners = new Set<TabListener>()

export function subscribeTabEvents(listener: TabListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(event: TabEvent): void {
  for (const listener of [...listeners]) listener(event)
}

let tabSeq = 0
let tabCounter = 0

function nextTabId(): string {
  tabCounter += 1
  return `tab-${tabCounter}`
}

export interface TabStoreState {
  tabs: TerminalTab[]
  activeTabId: string | null

  openTab: (input?: OpenTabInput) => string
  closeTab: (tabId: string) => TerminalTab | null
  activateTab: (tabId: string) => void
  activateRelative: (delta: number) => void
  /** 1 基序号；9 表示最后一个页签（Termius 同款语义） */
  activateIndex: (index: number) => void
  moveTab: (tabId: string, toIndex: number) => void
  setStatus: (tabId: string, status: TabStatus, sessionId?: string | null) => void
  setSessionId: (tabId: string, sessionId: string | null) => void
  markOutput: (tabId: string, count?: number) => void
  clearUnread: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  reset: () => void
}

function patchTab(
  tabs: TerminalTab[],
  tabId: string,
  patch: Partial<TerminalTab>
): TerminalTab[] {
  let changed = false
  const next = tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    changed = true
    return { ...tab, ...patch }
  })
  return changed ? next : tabs
}

export const useTabStore = create<TabStoreState>()((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (input = {}) => {
    tabSeq += 1
    const seq = tabSeq
    const id = nextTabId()
    const hostLabel = input.hostLabel ?? null
    const tab: TerminalTab = {
      id,
      title: input.title ?? hostLabel ?? `Terminal ${seq}`,
      hostId: input.hostId ?? null,
      hostLabel,
      sessionId: null,
      status: input.status ?? (input.hostId ? 'connecting' : 'idle'),
      unreadCount: 0,
      seq,
      origin: input.origin ?? 'host',
      createdAt: Date.now()
    }
    set((state) => ({ tabs: [...state.tabs, tab], activeTabId: id }))
    emit({ type: 'opened', tab })
    return id
  },

  closeTab: (tabId) => {
    const state = get()
    const index = state.tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) return null
    const tab = state.tabs[index]
    const tabs = state.tabs.filter((candidate) => candidate.id !== tabId)

    // 关掉当前页签后落到哪里：优先右侧邻居（原 index 位置），否则左侧，最后 null
    let activeTabId = state.activeTabId
    if (state.activeTabId === tabId) {
      const nextActive = tabs[index] ?? tabs[index - 1] ?? null
      activeTabId = nextActive ? nextActive.id : null
    }

    set({ tabs, activeTabId })
    emit({ type: 'closed', tab })
    if (activeTabId && activeTabId !== state.activeTabId) {
      const nextActive = tabs.find((candidate) => candidate.id === activeTabId)
      if (nextActive) emit({ type: 'activated', tab: nextActive })
    }
    return tab
  },

  activateTab: (tabId) => {
    const state = get()
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    const alreadyActive = state.activeTabId === tabId && tab.unreadCount === 0
    set({
      activeTabId: tabId,
      tabs: patchTab(state.tabs, tabId, { unreadCount: 0 })
    })
    if (!alreadyActive) emit({ type: 'activated', tab: { ...tab, unreadCount: 0 } })
  },

  activateRelative: (delta) => {
    const { tabs, activeTabId } = get()
    if (tabs.length === 0) return
    const current = tabs.findIndex((tab) => tab.id === activeTabId)
    const from = current === -1 ? 0 : current
    const next = (from + delta + tabs.length * Math.max(1, Math.abs(delta))) % tabs.length
    get().activateTab(tabs[next].id)
  },

  activateIndex: (index) => {
    const { tabs } = get()
    if (tabs.length === 0) return
    // Cmd/Ctrl+9 = 最后一个页签（与终端浏览器的习惯一致）
    if (index === 9) {
      get().activateTab(tabs[tabs.length - 1].id)
      return
    }
    const target = tabs[index - 1]
    if (target) get().activateTab(target.id)
  },

  moveTab: (tabId, toIndex) => {
    const state = get()
    const from = state.tabs.findIndex((tab) => tab.id === tabId)
    if (from === -1) return
    const bounded = Math.max(0, Math.min(state.tabs.length - 1, toIndex))
    if (bounded === from) return
    const tabs = [...state.tabs]
    const [moved] = tabs.splice(from, 1)
    tabs.splice(bounded, 0, moved)
    set({ tabs })
  },

  setStatus: (tabId, status, sessionId) => {
    const patch: Partial<TerminalTab> = { status }
    if (sessionId !== undefined) patch.sessionId = sessionId
    set((state) => ({ tabs: patchTab(state.tabs, tabId, patch) }))
  },

  setSessionId: (tabId, sessionId) => {
    set((state) => ({ tabs: patchTab(state.tabs, tabId, { sessionId }) }))
  },

  markOutput: (tabId, count = 1) => {
    const state = get()
    if (state.activeTabId === tabId) return
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) return
    set({ tabs: patchTab(state.tabs, tabId, { unreadCount: tab.unreadCount + count }) })
  },

  clearUnread: (tabId) => {
    const state = get()
    const tab = state.tabs.find((candidate) => candidate.id === tabId)
    if (!tab || tab.unreadCount === 0) return
    set({ tabs: patchTab(state.tabs, tabId, { unreadCount: 0 }) })
  },

  renameTab: (tabId, title) => {
    set((state) => ({ tabs: patchTab(state.tabs, tabId, { title }) }))
  },

  reset: () => {
    tabSeq = 0
    tabCounter = 0
    set({ tabs: [], activeTabId: null })
  }
}))

/** 页签是否还有活着的会话（决定关闭时要不要二次确认） */
export function hasActiveSession(tab: TerminalTab): boolean {
  return ACTIVE_STATUSES.includes(tab.status)
}

export interface CloseTabOptions {
  /** 来自 settings.ui.confirmOnCloseTab；false = 一律直接关 */
  confirmOnClose?: boolean
}

/**
 * 关闭页签前的判定（不产生副作用）：
 * - 有活跃会话且开启确认 → 返回 needs-confirm，由 UI 弹 CloseTabDialog；
 * - 否则调用方直接 `closeTab`。把这个判定抽成纯函数，单测才能覆盖「什么时候会拦」。
 */
export function requestCloseTab(tabId: string, options: CloseTabOptions = {}): CloseRequest {
  const state = useTabStore.getState()
  const tab = state.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) return { closed: false, reason: 'not-found', tab: null }
  const confirmOnClose = options.confirmOnClose ?? true
  if (confirmOnClose && hasActiveSession(tab)) {
    return { closed: false, reason: 'active-session', tab }
  }
  return { closed: true, tab }
}

/** 当前页签在列表里的 0 基位置（-1 = 没有激活页签） */
export function activeTabIndex(tabs: readonly TerminalTab[], activeTabId: string | null): number {
  return tabs.findIndex((tab) => tab.id === activeTabId)
}

export function findTab(tabs: readonly TerminalTab[], tabId: string | null): TerminalTab | null {
  if (!tabId) return null
  return tabs.find((tab) => tab.id === tabId) ?? null
}

/* -------------------------------------------------------------------------- */
/* 菜单命令 → 页签动作                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 菜单命令里与页签相关的那部分，需要一点 UI 侧能力（打开「新建页签」选择器、
 * 弹关闭确认、打开终端搜索条）。store 保持纯净（不 import React/终端），
 * 因此这些能力由工作区在挂载时注册进来——和 TabBackend 是同一套思路。
 */
export type NewTabPickerMode = 'hosts' | 'quick'

export interface TabCommandHooks {
  /** `mode` 让外部入口（例如空会话态的「快速连接」）直接落到对应分页 */
  openNewTabPicker?: (mode?: NewTabPickerMode) => void
  /** 走 requestCloseTab 的判定后再关（有活跃会话时弹确认） */
  requestCloseTab?: (tabId: string) => void
  openSearch?: () => void
}

let commandHooks: TabCommandHooks = {}

/**
 * 多个组件各注册自己那几项（页签条注册「新建选择器」，工作区注册「关闭确认 / 搜索」），
 * 所以是**合并式**注册而不是覆盖式：后注册的只覆盖同名 key，卸载时只清掉自己还占着的 key。
 */
export function registerTabCommandHooks(hooks: TabCommandHooks): () => void {
  Object.assign(commandHooks, hooks)
  return () => {
    for (const key of Object.keys(hooks) as Array<keyof TabCommandHooks>) {
      if (commandHooks[key] === hooks[key]) delete commandHooks[key]
    }
  }
}

/**
 * 打开「新建页签」选择器（可指定分页）。
 *
 * 空会话态的主/次按钮也走这里：入口只有一个面板（页签条上的 `+`），
 * 复制一份面板就会出现两个浮层互相抢焦点。
 * 没有注册 hook（页签条没挂载）时退化成直接开一个空页签，至少不让按钮变哑巴。
 */
export function openNewTabPicker(mode: NewTabPickerMode = 'hosts'): void {
  if (commandHooks.openNewTabPicker) {
    commandHooks.openNewTabPicker(mode)
    return
  }
  useTabStore.getState().openTab()
}

/**
 * 菜单 / 快捷键统一入口（t7 integration 在 App.tsx 的 handleMenuCommand 里调用）。
 * 返回 true = 本模块消化了这条命令；false = 交给 App 处理（设置、锁库、AI 面板…）。
 */
export function runMenuCommand(command: MenuCommand): boolean {
  const state = useTabStore.getState()
  switch (command) {
    case 'new-tab':
      openNewTabPicker('hosts')
      return true
    case 'close-tab': {
      const tabId = state.activeTabId
      if (!tabId) return true
      if (commandHooks.requestCloseTab) commandHooks.requestCloseTab(tabId)
      else state.closeTab(tabId)
      return true
    }
    case 'next-tab':
      state.activateRelative(1)
      return true
    case 'previous-tab':
      state.activateRelative(-1)
      return true
    case 'find-in-terminal':
      commandHooks.openSearch?.()
      return true
    default:
      return false
  }
}
