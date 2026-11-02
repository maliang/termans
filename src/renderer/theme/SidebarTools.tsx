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
 * 参考：VS Code 把设置入口固定在左下角（齿轮）。位置见 `docs/UI-KIT.md §10 布局骨架`。
 *
 * 折叠侧栏的入口**不在这里**（t54 起）：主人要求「关闭显示按钮固定在顶部新建标签按钮前面，
 * 底部的去掉」→ 折叠/展开统一由页签条左端的 `SidebarToggle`（`features/tabs/TabStrip.tsx`）承担，
 * 一处开关、两种状态都在同一个位置，不需要先记住「折叠后把手跑到外面去了」。
 *
 * `data-testid`：
 * - `open-settings`：齿轮按钮本身——e2e（`e2e/fixtures/ui.ts:291`）依赖这个名字，不许改；
 * - `sidebar-tools`：这条工具带；
 * 历史：这里原本还有一个 28px 的「锁定动作预留位」（`sidebar-lock-slot`）。锁定动作始终
 * 留在主机库页脚（`lock-vault`），那个空位只是在齿轮左边多出一段 28px 空白，看着像漏了
 * 一个图标——已删除（2026-11-02）。
 *
 * 位置（主人 2026-11-02 定）：**设置入口在最右边**，与左侧那排主机库动作之间有一条分隔线，
 * 并且和它们垂直对齐。旧实现把齿轮放在 `left:10px; bottom:10px`，比页脚按钮高 10px，
 * 看起来「没对齐」——现在 `bottom:0` 让它的底边与页脚按钮同线。
 */
export function SidebarTools(): JSX.Element {
  return (
    <div className="ts-sidebar__tools" data-testid="sidebar-tools">
      <SettingsEntry testId="open-settings" className="ts-icon-btn" />
    </div>
  )
}
