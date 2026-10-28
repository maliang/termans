// side-effect：注册 `vaultsync` namespace 的文案（en + zh-CN）
import './i18n'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import type { SyncConflict, SyncStatus, VaultStatus } from '@shared'
import { useShellStore } from '../../app/store'
import { subscribe } from '../../platform/ipc'
import * as api from './api'
import type { LibraryView } from './api'

/**
 * 主机库 + 同步的前端状态。
 *
 * 划分：外壳状态（`app/store.ts`）只管布局与生命周期，这里管 vault 的业务数据。
 * 两个约束写死在这里，避免各处重复实现：
 * 1. **锁定态不缓存主机数据**：`vault:state-changed` 收到非 unlocked 就把 library 清空，
 *    否则锁屏之后旧数据还留在内存/React 树里，改个 CSS 就能看到 IP。
 * 2. 所有失败都收敛成 `error`（reason 字符串），由 UI 做 i18n，不把英文堆栈丢给用户。
 */
export interface VaultFeatureState {
  status: VaultStatus | null
  library: LibraryView | null
  syncStatus: SyncStatus | null
  conflicts: SyncConflict[]
  selectedHostId: string | null
  busy: boolean
  error: string | null
  notice: string | null

  applyStatus: (status: VaultStatus) => void
  applySyncStatus: (status: SyncStatus) => void
  setError: (reason: string | null) => void
  setNotice: (text: string | null) => void
  selectHost: (hostId: string | null) => void
  refresh: () => Promise<void>
  refreshSync: () => Promise<void>
  run: <T>(action: () => Promise<T>) => Promise<T | null>
}

let subscribed = false

export const useVaultStore = create<VaultFeatureState>((set, get) => ({
  status: null,
  library: null,
  syncStatus: null,
  conflicts: [],
  selectedHostId: null,
  busy: false,
  error: null,
  notice: null,

  applyStatus: (status) => {
    // 通知外壳（决定是否铺解锁屏）；锁定/未初始化时立刻丢掉本地缓存
    useShellStore.getState().setVault(status.state)
    set({
      status,
      library: status.state === 'unlocked' ? get().library : null,
      syncStatus: status.state === 'unlocked' ? get().syncStatus : null,
      conflicts: status.state === 'unlocked' ? get().conflicts : [],
      selectedHostId: status.state === 'unlocked' ? get().selectedHostId : null
    })
    if (status.state === 'unlocked') void get().refresh()
  },

  applySyncStatus: (syncStatus) => {
    set({ syncStatus })
    void get().refreshSync()
  },

  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  selectHost: (selectedHostId) => set({ selectedHostId }),

  refresh: async () => {
    if (get().status?.state !== 'unlocked') return
    await get().run(async () => {
      const [library, status, conflicts] = await Promise.all([
        api.fetchLibrary(),
        api.vaultStatus(),
        api.listConflicts()
      ])
      useShellStore.getState().setVault(status.state)
      set({ library, status, conflicts })
    })
  },

  refreshSync: async () => {
    const state = get().status?.state
    if (state !== undefined && state !== 'unlocked') return
    await get().run(async () => {
      const syncStatus = await api.syncStatus()
      const conflicts = await api.listConflicts()
      set({ syncStatus, conflicts })
    })
  },

  run: async (action) => {
    set({ busy: true, error: null })
    try {
      const result = await action()
      set({ busy: false })
      return result
    } catch (error) {
      set({ busy: false, error: api.errorReason(error) })
      return null
    }
  }
}))

/** 组件里拿不到 store 的普通函数时用这个（等价于 `useVaultStore()` 全量订阅） */
export function useVaultHelpers(): VaultFeatureState {
  return useVaultStore()
}

/** 把主进程的 reason 码翻成当前语言的文案（没有对应 key 时退回原始 reason，便于排查） */
export function useVaultErrorText(): string | null {
  const reason = useVaultStore((state) => state.error)
  const { t } = useTranslation('vaultsync')
  if (reason === null) return null
  return t(`error.${reason}`, { defaultValue: reason })
}

/** 启动握手（幂等）：订阅主进程事件 + 拉一次状态。t7 在 App 启动时调用一次即可。 */
export async function initializeVaultFeature(): Promise<void> {
  const store = useVaultStore.getState()
  if (!subscribed) {
    subscribed = true
    subscribe('vault:state-changed', (status) => useVaultStore.getState().applyStatus(status))
    subscribe('sync:status-changed', (status) => useVaultStore.getState().applySyncStatus(status))
  }
  await store.run(async () => {
    const status = await api.vaultStatus()
    useVaultStore.getState().applyStatus(status)
    if (status.state === 'unlocked') {
      const syncStatus = await api.syncStatus()
      useVaultStore.setState({ syncStatus })
    }
  })
}
