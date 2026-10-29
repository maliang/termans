import { HostSidebar, useVaultStore } from '@renderer/features/vault'
import { useTabStore } from '@renderer/features/tabs/tab-store'
import { SidebarTools } from '@renderer/theme/SidebarTools'

/**
 * 左侧主机库（真正的 vault feature + 产品语义接线）。
 *
 * 历史（t37/#25 之前为什么这里有一段捕获阶段代码，留一行原因给后来的人）：
 * `HostTree` 早期的双击语义是「编辑」，而产品约定是「双击主机 = 连上去」，
 * 当时 `features/vault` 不在接线任务的可改范围内，所以外壳改用**捕获阶段**的双击处理器
 * （`onDoubleClick` 的 capture 变体）抢在目标处理器之前 `preventDefault() + stopPropagation()` 后直连主机
 * —— 副作用是 HostTree 自己的双击处理器永远拿不到事件，t37 的「双击打不开编辑器」
 * 就是这么来的。
 *
 * 现在由 feature 的正式通道接管：`HostSidebar` 透传 `onConnect`，`HostTree` 收到后
 * 双击即连接；**不传时它退回「编辑」**，所以外壳必须一直传，否则双击会变成编辑器。
 * 编辑的显式入口是行内铅笔按钮（`data-testid="host-edit"`）与行按钮上的 F2。
 *
 * 第二行 `SidebarTools` 是外壳的**全局工具带**（t45：设置入口固定在左下角）。
 * 它刻意放在 `.ts-sidebar-host` 里而不是主机库内部——设置入口属于外壳，不属于主机库；
 * `.ts-sidebar-host` 是 flex column，aside 占 `flex:1`，这条工具带自然被顶到底部。
 */
export function HostLibraryPane(): JSX.Element {
  return (
    <div className="ts-sidebar-host">
      <HostSidebar onConnect={connectSelectedHost} />
      <SidebarTools />
    </div>
  )
}

/**
 * 打开（或聚焦）主机的页签；返回页签 id（调试与测试用）。
 *
 * `hostId` 由 `HostTree` 在双击时给出。取它而不是只读 `selectedHostId`，是因为
 * 「click 先于 dblclick」只是浏览器当前的行为，不该让连接对象取决于点击时序；
 * 不传时仍回退到选中行，保持旧的调用语义不变。
 */
export function connectSelectedHost(hostId?: string): string | null {
  const vault = useVaultStore.getState()
  if (vault.status?.state !== 'unlocked') return null
  const targetId = hostId ?? vault.selectedHostId
  if (!targetId) return null
  const host = vault.library?.hosts.find((candidate) => candidate.id === targetId)
  if (!host) return null
  // status 由 tab store 依据 hostId 自动置为 'connecting'；真正的连接在 XtermSurface 首帧发起
  return useTabStore.getState().openTab({ hostId: host.id, hostLabel: host.label, origin: 'host' })
}
