import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileInput, Folder, FolderPlus, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import type { GroupRecord } from '@shared'
import type { HostView, LibraryView } from './api'

interface HostTreeProps {
  library: LibraryView
  groups: GroupRecord[]
  selectedHostId: string | null
  onSelect: (hostId: string) => void
  onEdit: (hostId: string) => void
  /**
   * 双击主机行 = 连接（产品约定，e2e `connectHost()` 也是双击）。传了它，双击就连接，
   * 编辑只走行内铅笔按钮 / F2；不传则双击退回「编辑」，旧调用方行为不变。
   */
  onConnect?: (hostId: string) => void
  onCreate: () => void
  onCreateGroup: () => void
  onImportSshConfig: () => void
  /**
   * 分组改名。`groupId === null` 表示给「未分组」这一栏改显示名（它是虚拟分组，
   * 没有自己的记录，只影响显示）。返回 false 表示失败，编辑态保留让用户改。
   */
  onRenameGroup?: (groupId: string | null, name: string) => Promise<boolean>
  /** 删除分组（真实分组才给按钮；主机不会跟着删，会回到「未分组」） */
  onDeleteGroup?: (groupId: string) => void
  /** 删除主机（t53）：只在传了它时渲染垃圾桶；确认与真正的删除由侧栏负责 */
  onDeleteHost?: (hostId: string) => void
  /** 「未分组」的显示名；null/未传用 i18n 默认文案 */
  ungroupedLabel?: string | null
}

interface TreeGroup {
  group: GroupRecord | null
  hosts: HostView[]
}

/** IPv6 用 [addr]:port 的写法，`2001:db8::42:22` 会被读成端口 22 还是地址的一部分分不清 */
function formatAddress(host: { hostname: string; port: number }): string {
  const isIpv6 = host.hostname.includes(':') && !host.hostname.startsWith('[')
  return isIpv6 ? `[${host.hostname}]:${host.port}` : `${host.hostname}:${host.port}`
}

function buildGroups(library: LibraryView): TreeGroup[] {
  const roots: TreeGroup[] = [{ group: null, hosts: library.hosts.filter((host) => host.groupId === null) }]
  const byGroup = new Map<string, HostView[]>()
  for (const host of library.hosts) {
    if (host.groupId === null) continue
    const list = byGroup.get(host.groupId) ?? []
    list.push(host)
    byGroup.set(host.groupId, list)
  }
  for (const group of [...library.groups].sort((a, b) => a.sortIndex - b.sortIndex)) {
    roots.push({ group, hosts: byGroup.get(group.id) ?? [] })
  }
  return roots
}

/**
 * 主机树：分组在上、未分组在首。**只在解锁态渲染**（锁定态的父组件不会挂载本组件，
 * 所以锁屏时 DOM 里根本不存在主机名/IP）。
 *
 * 行布局（t31/#6）：
 * - 每一行是 `dot + (label / host:port)` 的两段结构，两段都 `min-width:0` + 省略号，
 *   窄侧栏时地址折到第二行（容器查询见 vault.css），**任何宽度下都不出现横向滚动条**；
 * - label 用 UI 字体 + 中等字重、`host:port` 用等宽字体 + 次级色，扫一眼就知道「是哪台 + 连哪里」。
 */
export function HostTree({
  library,
  groups,
  selectedHostId,
  onSelect,
  onEdit,
  onConnect,
  onCreate,
  onCreateGroup,
  onImportSshConfig,
  onRenameGroup,
  onDeleteGroup,
  onDeleteHost,
  ungroupedLabel
}: HostTreeProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const tree = useMemo(() => buildGroups({ ...library, groups }), [library, groups])
  /**
   * 正在改名的分组：`null` = 没在改名；`'ungrouped'` = 未分组那一栏；其余是 groupId。
   * 用字符串而不是 GroupRecord，因为「未分组」没有记录。
   */
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  function startRename(key: string, current: string): void {
    if (!onRenameGroup) return
    setRenaming(key)
    setDraft(current)
  }

  async function commitRename(groupId: string | null): Promise<void> {
    if (renaming === null || !onRenameGroup) return
    const name = draft.trim()
    if (name.length === 0) {
      setRenaming(null)
      return
    }
    const ok = await onRenameGroup(groupId, name)
    if (ok) setRenaming(null)
  }

  if (library.hosts.length === 0) {
    return (
      <div className="ts-empty ts-empty--compact" data-testid="vault-host-empty">
        <Server size={20} aria-hidden="true" />
        <p className="ts-empty__title">{t('hosts.empty')}</p>
        <p className="ts-empty__body">{t('hosts.emptyBody')}</p>
        {/* 空态是「导入」最有说服力的位置：这里用真实文字，不是猜不透的图标 */}
        <div className="ts-vault__empty-actions">
          <button type="button" className="ts-btn ts-btn--primary ts-btn--block" onClick={onCreate} data-testid="host-empty-new">
            <Plus size={14} aria-hidden="true" />
            {t('hosts.new')}
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--ghost ts-btn--block"
            onClick={onImportSshConfig}
            data-testid="host-empty-import"
            title={t('hosts.importSshConfig')}
          >
            <FileInput size={14} aria-hidden="true" />
            {t('hosts.importSshConfig')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="ts-vault__tree" data-testid="vault-host-tree">
      {tree.map((node) => {
        const key = node.group?.id ?? 'ungrouped'
        return (
          <div key={key} className="ts-vault__group">
            <div className={`ts-vault__group-title${renaming === key ? ' ts-vault__group-title--editing' : ''}`}>
              <Folder size={13} aria-hidden="true" />
              {renaming === key ? (
                <input
                  autoFocus
                  className="ts-input ts-vault__group-input"
                  value={draft}
                  aria-label={t('hosts.renameGroup')}
                  data-testid={`group-rename-input-${key}`}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => void commitRename(node.group?.id ?? null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void commitRename(node.group?.id ?? null)
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setRenaming(null)
                    }
                  }}
                />
              ) : (
                <span className="ts-vault__group-name">{node.group?.name ?? ungroupedLabel ?? t('hosts.groupUntitled')}</span>
              )}
              <span className="ts-vault__count">{node.hosts.length}</span>
              {/* 分组操作（t52）：改名对「未分组」也开放（只改显示名）；删除只给真实分组，
                  主机不会跟着删，回到未分组。默认隐藏，hover/键盘聚焦才出现，不抢主机的视觉。 */}
              {onRenameGroup ? (
                <span className="ts-vault__group-actions">
                  <button
                    type="button"
                    className="ts-icon-btn ts-vault__group-action"
                    title={`${t('hosts.renameGroup')}：${node.group?.name ?? ungroupedLabel ?? t('hosts.groupUntitled')}`}
                    aria-label={`${t('hosts.renameGroup')}：${node.group?.name ?? ungroupedLabel ?? t('hosts.groupUntitled')}`}
                    data-testid={`group-rename-${key}`}
                    onClick={() => startRename(key, node.group?.name ?? ungroupedLabel ?? t('hosts.groupUntitled'))}
                  >
                    <Pencil size={12} aria-hidden="true" />
                  </button>
                  {node.group !== null && onDeleteGroup ? (
                    <button
                      type="button"
                      className="ts-icon-btn ts-vault__group-action ts-vault__group-action--danger"
                      title={`${t('hosts.deleteGroup')}：${node.group.name}`}
                      aria-label={`${t('hosts.deleteGroup')}：${node.group.name}`}
                      data-testid={`group-delete-${key}`}
                      onClick={() => onDeleteGroup(node.group!.id)}
                    >
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
            <ul className="ts-vault__hosts" role="list">
              {node.hosts.map((host) => (
                <li key={host.id} className="ts-vault__host-row">
                  <button
                    type="button"
                    className={`ts-vault__host${host.id === selectedHostId ? ' ts-vault__host--active' : ''}`}
                    onClick={() => onSelect(host.id)}
                    onDoubleClick={() => (onConnect ? onConnect(host.id) : onEdit(host.id))}
                    onKeyDown={(event) => {
                      // F2 = 重命名/编辑（Windows/资源管理器惯例），不占用 Enter（Enter 是选中/连接）
                      if (event.key === 'F2') {
                        event.preventDefault()
                        onEdit(host.id)
                      }
                    }}
                    data-testid="vault-host-item"
                    title={`${host.label}\n${host.username}@${formatAddress(host)}`}
                  >
                    <span
                      className={`ts-vault__host-dot${host.color === null ? '' : ' ts-vault__host-dot--custom'}`}
                      style={host.color === null ? undefined : { background: host.color }}
                      aria-hidden="true"
                    />
                    <span className="ts-vault__host-main">
                      <span className="ts-vault__host-label">{host.label}</span>
                      <span className="ts-vault__host-addr">{formatAddress(host)}</span>
                    </span>
                  </button>
                  {/* 编辑的显式入口：双击被「连接」占用后，这里是唯一不靠隐式手势的编辑入口（t37/#25） */}
                  <button
                    type="button"
                    className="ts-vault__host-edit"
                    onClick={() => onEdit(host.id)}
                    data-testid="host-edit"
                    title={`${t('hosts.edit')}：${host.label}`}
                    aria-label={`${t('hosts.edit')}：${host.label}`}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                  {/* 删除（t53）：主人反馈「ssh 项没有快捷删除图标」。确认放在侧栏，
                      这里只负责触发；不传 onDeleteHost 时不渲染，避免只读场景出现假入口。 */}
                  {onDeleteHost ? (
                    <button
                      type="button"
                      className="ts-vault__host-edit ts-vault__host-delete"
                      onClick={() => onDeleteHost(host.id)}
                      data-testid="host-delete"
                      title={`${t('hosts.deleteHost')}：${host.label}`}
                      aria-label={`${t('hosts.deleteHost')}：${host.label}`}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )
      })}

      {/* 建分组是低频动作：放在列表末尾做一行弱化文字入口，不再和「新建主机」抢按钮位（t31/#5） */}
      <button
        type="button"
        className="ts-vault__tree-action"
        onClick={onCreateGroup}
        data-testid="host-new-group"
        title={t('hosts.newGroup')}
      >
        <FolderPlus size={13} aria-hidden="true" />
        {t('hosts.newGroupRow')}
      </button>
    </div>
  )
}
