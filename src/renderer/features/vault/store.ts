// side-effect：注册 `vaultsync` namespace 的文案（en + zh-CN）
import './i18n'
import { create } from 'zustand'
import { useTranslation } from 'react-i18next'
import type {
  SyncConflict,
  SyncStatus,
  VaultCreateResult,
  VaultLibraryCreateRequest,
  VaultLibraryMeta,
  VaultStatus,
  VaultUnlockFailure,
  VaultVariantNotice
} from '@shared'
import { useShellStore } from '../../app/store'
import { subscribe } from '../../platform/ipc'
import * as api from './api'
import type { LibraryView } from './api'

/**
 * 主机库 + 同步的前端状态。
 *
 * 划分：外壳状态（`app/store.ts`）只管布局与生命周期，这里管 vault 的业务数据。
 * 三个约束写死在这里，避免各处重复实现：
 * 1. **锁定态不缓存主机数据**：`vault:state-changed` 收到非 unlocked 就把 library 清空，
 *    否则锁屏之后旧数据还留在内存/React 树里，改个 CSS 就能看到 IP。
 * 2. 所有失败都收敛成 `error`（reason 字符串），由 UI 做 i18n，不把英文堆栈丢给用户。
 * 3. **解锁失败的归因只认主进程推来的 `status.unlockFailure`**（r3 AC-1）：渲染层不许拿
 *    `error` 里的 reason 反推四分类，否则四分类会出现第二个实现（DESIGN §7 第 2 条）。
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
  /** `status` 里三个 r3 字段的窄订阅副本（唯一写入点仍是 `applyStatus`，不另存真相） */
  libraries: VaultLibraryMeta[]
  unlockFailure: VaultUnlockFailure | null
  variantNotice: VaultVariantNotice | null
  /** 已关闭的那条变体告知条的 `at`（会话内生效：DESIGN §2.9「关闭即销毁，本会话不再出现」） */
  variantNoticeDismissedAt: string | null
  /**
   * 恢复码还没确认（AC-16）。建库/新建库成功后主进程已是 `unlocked`，
   * 但恢复码只显示这一次 —— 确认之前外壳不许接管屏幕（见 `App.tsx` 的 `locked`）。
   */
  recoveryPending: boolean

  applyStatus: (status: VaultStatus) => void
  applySyncStatus: (status: SyncStatus) => void
  setError: (reason: string | null) => void
  setNotice: (text: string | null) => void
  selectHost: (hostId: string | null) => void
  setRecoveryPending: (pending: boolean) => void
  dismissVariantNotice: () => void
  switchLibrary: (id: string) => Promise<void>
  createLibrary: (input: VaultLibraryCreateRequest) => Promise<VaultCreateResult | null>
  /** 从主进程重读一次权威状态（失败后取归因用；失败不覆盖当前屏） */
  reloadStatus: () => Promise<void>
  refresh: () => Promise<void>
  refreshSync: () => Promise<void>
  run: <T>(action: () => Promise<T>) => Promise<T | null>
}

/** `status` → 三个窄订阅字段；`at` 变化说明是新的一条告知条，重新可见 */
function statusSlice(status: VaultStatus): Pick<
  VaultFeatureState,
  'libraries' | 'unlockFailure' | 'variantNotice'
> {
  return {
    libraries: status.libraries,
    unlockFailure: status.unlockFailure,
    variantNotice: status.variantNotice
  }
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
  libraries: [],
  unlockFailure: null,
  variantNotice: null,
  variantNoticeDismissedAt: null,
  recoveryPending: false,

  applyStatus: (status) => {
    // 通知外壳（决定是否铺解锁屏）；锁定/未初始化时立刻丢掉本地缓存
    useShellStore.getState().setVault(status.state)
    const slice = statusSlice(status)
    set((state) => ({
      status,
      ...slice,
      // 新的一条告知条（`at` 变了）必须重新可见，否则「关掉一条」会把后续那条一起吞掉
      variantNoticeDismissedAt:
        slice.variantNotice !== null && slice.variantNotice.at === state.variantNotice?.at
          ? state.variantNoticeDismissedAt
          : null,
      library: status.state === 'unlocked' ? state.library : null,
      syncStatus: status.state === 'unlocked' ? state.syncStatus : null,
      conflicts: status.state === 'unlocked' ? state.conflicts : [],
      selectedHostId: status.state === 'unlocked' ? state.selectedHostId : null
    }))
    if (status.state === 'unlocked') void get().refresh()
  },

  applySyncStatus: (syncStatus) => {
    set({ syncStatus })
    void get().refreshSync()
  },

  setError: (error) => set({ error }),
  setNotice: (notice) => set({ notice }),
  selectHost: (selectedHostId) => set({ selectedHostId }),
  setRecoveryPending: (recoveryPending) => set({ recoveryPending }),

  dismissVariantNotice: () => {
    const notice = get().variantNotice
    if (notice === null) return
    // 只在前端隐藏：冻结契约里没有「告知条已读」的通道，而 DESIGN §2.9 的语义本就是
    // 「本会话不再出现」——下次启动主进程重算，那时它已经不该再出现。
    set({ variantNoticeDismissedAt: notice.at })
  },

  switchLibrary: async (id) => {
    if (get().busy) return
    const status = await get().run(() => api.switchVaultLibrary(id))
    if (status === null) return
    // 切换后屏上的一切输入都属于上一只库：口令/恢复码/归因/诊断全部丢弃（AC-12 的 UI 侧隔离）
    set({ unlockFailure: null, error: null })
    get().applyStatus(status)
  },

  createLibrary: async (input) => {
    if (get().busy) return null
    const result = await get().run(() => api.createVaultLibrary(input))
    if (result === null) return null
    get().applyStatus(result.status)
    return result
  },

  reloadStatus: async () => {
    try {
      const status = await api.vaultStatus()
      get().applyStatus(status)
    } catch {
      // 状态拉取失败时保留屏上现有的归因块，不要把错误盖成第二层文案
    }
  },

  refresh: async () => {
    if (get().status?.state !== 'unlocked') return
    await get().run(async () => {
      const [library, status, conflicts] = await Promise.all([
        api.fetchLibrary(),
        api.vaultStatus(),
        api.listConflicts()
      ])
      useShellStore.getState().setVault(status.state)
      set({ library, status, conflicts, ...statusSlice(status) })
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
