/**
 * vault-sync 功能入口（t7 集成时用）：
 *
 * ```tsx
 * // src/renderer/app/App.tsx
 * import { HostSidebar } from '../features/vault'
 * import { UnlockScreen } from '../features/unlock'
 * import { initializeVaultFeature } from '../features/vault'
 * ```
 *
 * 组件导出与占位组件同名同职责，替换即完成接线；`initializeVaultFeature()` 幂等，
 * 在 App 启动时调用一次即可（订阅 vault/sync 事件 + 拉一次初始状态）。
 */
export { HostSidebar } from './HostSidebar'
export { HostTree } from './HostTree'
export { HostEditor } from './HostEditor'
export { PrivateKeyGuide } from './PrivateKeyGuide'
export { SyncPanel } from './SyncPanel'
export { VaultSecurityPanel } from './VaultSecurityPanel'
export { VAULTSYNC_NS } from './i18n'
export {
  initializeVaultFeature,
  useVaultErrorText,
  useVaultHelpers,
  useVaultStore,
  type VaultFeatureState
} from './store'
export * as vaultApi from './api'
