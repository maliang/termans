import { create } from 'zustand'

/**
 * 设置对话框的开关状态。
 *
 * 放在主题模块里（而不是 app/store）是为了让「谁拥有设置 UI」与「谁拥有开关」在同一处，
 * 集成成员替换 `placeholders/*` 时不会把这个开关弄丢。
 * `open-settings` 菜单命令由 `SettingsDialogHost` 自己订阅（`app:menu-command`），
 * 因此不需要 App 的菜单 switch 里再加一个 case。
 */

/**
 * 设置页签。
 *
 * `appearance` / `ai` / `security` / `sync` 是四个**用户可见**的页签：
 * 外观与 AI 由本模块实现，安全与同步复用 vault-sync 已有的面板（同一个设置类入口，
 * 不该在侧栏再开三个独立弹窗）。
 * `terminal` / `general` 是预留的页签名（P0 契约里就留着了），不要删——
 * 删除会打破「页签 id 稳定」的约定，将来加页签又会有人重新发明名字。
 */
export type SettingsTab = 'appearance' | 'ai' | 'security' | 'sync' | 'terminal' | 'general'

/** 真正渲染出来的页签顺序（terminal/general 尚未接入，不进导航） */
export const VISIBLE_SETTINGS_TABS: readonly SettingsTab[] = ['appearance', 'ai', 'security', 'sync']

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
