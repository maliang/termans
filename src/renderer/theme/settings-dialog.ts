import { create } from 'zustand'

/**
 * 设置对话框的开关状态。
 *
 * 放在主题模块里（而不是 app/store）是为了让「谁拥有设置 UI」与「谁拥有开关」在同一处，
 * 集成成员替换 `placeholders/*` 时不会把这个开关弄丢。
 * `open-settings` 菜单命令由 `SettingsDialogHost` 自己订阅（`app:menu-command`），
 * 因此不需要 App 的菜单 switch 里再加一个 case。
 */

export type SettingsTab = 'appearance' | 'terminal' | 'general'

export interface SettingsDialogState {
  open: boolean
  tab: SettingsTab
  openDialog(tab?: SettingsTab): void
  closeDialog(): void
  setTab(tab: SettingsTab): void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  tab: 'appearance',
  openDialog(tab) {
    set({ open: true, ...(tab ? { tab } : {}) })
  },
  closeDialog() {
    set({ open: false })
  },
  setTab(tab) {
    set({ tab })
  }
}))

/** 非 React 代码（菜单命令、测试）打开设置 */
export function openSettingsDialog(tab?: SettingsTab): void {
  useSettingsDialog.getState().openDialog(tab)
}

export function closeSettingsDialog(): void {
  useSettingsDialog.getState().closeDialog()
}
