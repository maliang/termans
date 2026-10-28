import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Server } from 'lucide-react'
import type { GroupRecord } from '@shared'
import type { HostView, LibraryView } from './api'

interface HostTreeProps {
  library: LibraryView
  groups: GroupRecord[]
  selectedHostId: string | null
  onSelect: (hostId: string) => void
  onEdit: (hostId: string) => void
}

interface TreeGroup {
  group: GroupRecord | null
  hosts: HostView[]
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
 */
export function HostTree({ library, groups, selectedHostId, onSelect, onEdit }: HostTreeProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const tree = useMemo(() => buildGroups({ ...library, groups }), [library, groups])

  if (library.hosts.length === 0) {
    return (
      <div className="ts-empty ts-empty--compact" data-testid="vault-host-empty">
        <Server size={20} aria-hidden="true" />
        <p className="ts-empty__title">{t('hosts.empty')}</p>
        <p className="ts-empty__body">{t('hosts.emptyBody')}</p>
      </div>
    )
  }

  return (
    <div className="ts-vault__tree" data-testid="vault-host-tree">
      {tree.map((node) => {
        const key = node.group?.id ?? 'ungrouped'
        return (
          <div key={key} className="ts-vault__group">
            <div className="ts-vault__group-title">
              <Folder size={13} aria-hidden="true" />
              <span>{node.group?.name ?? t('hosts.groupUntitled')}</span>
              <span className="ts-vault__count">{node.hosts.length}</span>
            </div>
            <ul className="ts-vault__hosts" role="list">
              {node.hosts.map((host) => (
                <li key={host.id}>
                  <button
                    type="button"
                    className={`ts-vault__host${host.id === selectedHostId ? ' ts-vault__host--active' : ''}`}
                    onClick={() => onSelect(host.id)}
                    onDoubleClick={() => onEdit(host.id)}
                    data-testid="vault-host-item"
                    title={`${host.username}@${host.hostname}:${host.port}`}
                  >
                    <span className="ts-vault__host-dot" style={host.color === null ? undefined : { background: host.color }} />
                    <span className="ts-vault__host-label">{host.label}</span>
                    <span className="ts-vault__host-addr">
                      {host.hostname}:{host.port}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}
