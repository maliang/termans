import { SettingsEntry } from './SettingsDialogHost'

/**
 * 侧栏底部工具区（外壳层，t45）。
 *
 * 为什么由主题模块提供、挂在 `.ts-sidebar-host` 的第二行而不是塞进主机库：
 * 主机库（`features/vault/HostSidebar`）的页脚是**数据相关动作**（刷新 / 导入 ssh_config /
 * 导入私钥 / 同步 / 安全 / 锁定），而归属于外壳的**全局工具**（设置入口）不该混进去——
 * 那会让「主机库」这个功能域承担跨域职责，也让 vault 的地盘里出现主题/语言的入口。
 * 这里只做摆放，动作仍走 `settings-dialog` 的 store（谁都能调）。
 *
 * 参考：VS Code 把设置入口固定在左下角（齿轮），Termius 的三段式外壳也在侧栏底部放
 * 全局入口。位置见 `docs/UI-KIT.md §10 布局骨架`。
 *
 * `data-testid`：
 * - `open-settings`：齿轮按钮本身——e2e（`e2e/fixtures/ui.ts:291`）依赖这个名字，不许改；
 * - `sidebar-tools`：这条工具带；
 * - `sidebar-lock-slot`：锁定动作的**预留位**（本轮只留空间与分隔线，不新接功能；
 *   真正的锁定动作仍在主机库页脚的 `lock-vault` 上）。
 */
export function SidebarTools(): JSX.Element {
  return (
    <div className="ts-sidebar__tools" data-testid="sidebar-tools">
      <SettingsEntry testId="open-settings" className="ts-icon-btn" />
      <span className="ts-sidebar__tools-slot" data-testid="sidebar-lock-slot" aria-hidden="true" />
    </div>
  )
}
