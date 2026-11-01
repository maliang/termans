import { create } from 'zustand'
import { DEFAULT_SETTINGS, type AppInfo, type AppPlatform, type Settings, type VaultState } from '@shared'

/**
 * 应用外壳状态（**只管布局与生命周期，不管业务数据**）。
 *
 * 划界很重要：
 * - 这里：窗口/平台信息、设置副本、当前加密包状态、页签列表、面板开关；
 * - 别人的 store：主机库（vault-sync）、终端实例与 xterm buffer（terminal-ui）、
 *   AI 会话（ai）、主题对象（theme-i18n）。
 * 混在一起之后，任何一侧改动都会触发全树重渲染，xterm 尤其怕这个（会掉输入法/滚动位置）。
 */

export type TabStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

export interface ShellTab {
  id: string
  title: string
  hostId: string | null
  sessionId: string | null
  status: TabStatus
}

export interface ShellState {
  booted: boolean
  platform: AppPlatform
  appInfo: AppInfo | null
  settings: Settings
  /** 加密包状态；unknown = 还没问到主进程（骨架期模块未接线时也停在这里） */
  vault: VaultState | 'unknown'
  /** 骨架期的本地锁定预览：真实模块接线后由 vault:state-changed 驱动，这一位会被删掉 */
  tabs: ShellTab[]
  activeTabId: string | null
  aiPanelVisible: boolean
  lastError: string | null

  setBooted: (booted: boolean) => void
  setPlatform: (platform: AppPlatform) => void
  setAppInfo: (info: AppInfo) => void
  setSettings: (settings: Settings) => void
  setVault: (vault: VaultState | 'unknown') => void
  setLastError: (message: string | null) => void
  toggleAiPanel: () => void
  openTab: (tab?: Partial<ShellTab>) => void
  closeTab: (tabId: string) => void
  activateTab: (tabId: string) => void
  setTabStatus: (tabId: string, status: TabStatus, sessionId?: string | null) => void
}

let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `tab-${tabSeq}`
}

export const useShellStore = create<ShellState>((set, get) => ({
  booted: false,
  platform: 'linux',
  appInfo: null,
  settings: DEFAULT_SETTINGS,
  vault: 'unknown',
  tabs: [],
  activeTabId: null,
  aiPanelVisible: DEFAULT_SETTINGS.ui.aiPanelVisible,
  lastError: null,

  setBooted: (booted) => set({ booted }),
  setPlatform: (platform) => set({ platform }),
  setAppInfo: (appInfo) => set({ appInfo }),
  setSettings: (settings) => set({ settings, aiPanelVisible: settings.ui.aiPanelVisible }),
  setVault: (vault) => set({ vault }),
  setLastError: (lastError) => set({ lastError }),
  toggleAiPanel: () => set((state) => ({ aiPanelVisible: !state.aiPanelVisible })),

  openTab: (tab) => {
    const id = tab?.id ?? nextTabId()
    const next: ShellTab = {
      id,
      title: tab?.title ?? `Terminal ${get().tabs.length + 1}`,
      hostId: tab?.hostId ?? null,
      sessionId: tab?.sessionId ?? null,
      status: tab?.status ?? 'idle'
    }
    set((state) => ({ tabs: [...state.tabs, next], activeTabId: id }))
  },

  closeTab: (tabId) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === tabId)
      if (index === -1) return state
      const tabs = state.tabs.filter((tab) => tab.id !== tabId)
      // 关掉当前页签后，焦点落到右侧邻居，没有则左侧——和浏览器一致的手感
      const fallback = tabs[index] ?? tabs[index - 1] ?? null
      return {
        tabs,
        activeTabId: state.activeTabId === tabId ? (fallback?.id ?? null) : state.activeTabId
      }
    }),

  activateTab: (tabId) => set({ activeTabId: tabId }),

  setTabStatus: (tabId, status, sessionId) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, status, sessionId: sessionId === undefined ? tab.sessionId : sessionId } : tab
      )
    }))
}))
