import type { MouseEvent } from 'react'
import { HostSidebar, useVaultStore } from '@renderer/features/vault'
import { useTabStore } from '@renderer/features/tabs/tab-store'

/**
 * 左侧主机库（真正的 vault feature + 一处接线妥协）。
 *
 * 妥协点，必须写清楚：`HostTree` 目前的**双击语义是「编辑」**
 * （`features/vault/HostTree.tsx` 的 `onDoubleClick={() => onEdit(host.id)}`），
 * 而产品约定是「双击主机 = 连上去」。`features/vault` 不在 t7 的可改范围内，
 * 所以这里用**捕获阶段**的 `onDoubleClickCapture` 抢在目标处理器之前拦下：
 * React 的合成事件在捕获阶段调用 `stopPropagation()` 后，目标元素上的 bubble 处理器不会被调用。
 *
 * 命中判定用 `closest('[data-testid="vault-host-item"]')` 而不是读 props：主机库里
 * 每一行的 id 只在 feature 内部，外壳不该知道 DOM 结构以外的细节。
 * 主机 id 取 `useVaultStore.selectedHostId`：**click 先于 dblclick 发生**，双击时它已经指向该行。
 *
 * 待办（已上报 captain）：请 vault-sync 给 `HostTree` 增加正式的 `onConnect` 回调，
 * 之后这里可以直接删掉捕获层。
 */
export function HostLibraryPane(): JSX.Element {
  const handleDoubleClickCapture = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (!target?.closest('[data-testid="vault-host-item"]')) return
    // 拦下「双击 = 编辑」；同时避免触发文本选择
    event.preventDefault()
    event.stopPropagation()
    connectSelectedHost()
  }

  return (
    <div className="ts-sidebar-host" onDoubleClickCapture={handleDoubleClickCapture}>
      <HostSidebar />
    </div>
  )
}

/** 打开（或聚焦）选中主机的页签；返回页签 id（调试与测试用） */
export function connectSelectedHost(): string | null {
  const vault = useVaultStore.getState()
  if (vault.status?.state !== 'unlocked') return null
  const hostId = vault.selectedHostId
  if (!hostId) return null
  const host = vault.library?.hosts.find((candidate) => candidate.id === hostId)
  if (!host) return null
  // status 由 tab store 依据 hostId 自动置为 'connecting'；真正的连接在 XtermSurface 首帧发起
  return useTabStore.getState().openTab({ hostId: host.id, hostLabel: host.label, origin: 'host' })
}
