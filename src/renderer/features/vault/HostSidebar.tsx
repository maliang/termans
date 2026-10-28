import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderPlus, Import, Lock, Plus, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import * as api from './api'
import type { HostView } from './api'
import { HostEditor } from './HostEditor'
import { HostTree } from './HostTree'
import { SyncPanel } from './SyncPanel'
import { VaultSecurityPanel } from './VaultSecurityPanel'
import { useVaultErrorText, useVaultStore } from './store'

/**
 * 左栏主机库（替换 `app/placeholders/HostSidebar.tsx`，t7 一行接线）。
 *
 * 锁定语义是硬约束：`status.state !== 'unlocked'` 时**不渲染任何主机数据**——
 * 不是 CSS 隐藏，而是根本不挂载 `<HostTree>`，锁屏时 DOM 里没有主机名/IP。
 */
export function HostSidebar(): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const status = useVaultStore((state) => state.status)
  const library = useVaultStore((state) => state.library)
  const selectedHostId = useVaultStore((state) => state.selectedHostId)
  const busy = useVaultStore((state) => state.busy)
  const notice = useVaultStore((state) => state.notice)
  const run = useVaultStore((state) => state.run)
  const refresh = useVaultStore((state) => state.refresh)
  const refreshSync = useVaultStore((state) => state.refreshSync)
  const selectHost = useVaultStore((state) => state.selectHost)
  const setNotice = useVaultStore((state) => state.setNotice)
  const setError = useVaultStore((state) => state.setError)
  const error = useVaultErrorText()

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<HostView | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [showSync, setShowSync] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)

  const unlocked = status?.state === 'unlocked'
  const filtered = useMemo(() => {
    if (library === null) return null
    const needle = query.trim().toLowerCase()
    if (needle === '') return library
    return {
      ...library,
      hosts: library.hosts.filter(
        (host) =>
          host.label.toLowerCase().includes(needle) ||
          host.hostname.toLowerCase().includes(needle) ||
          host.username.toLowerCase().includes(needle) ||
          host.tags.some((tag) => tag.toLowerCase().includes(needle))
      )
    }
  }, [library, query])

  async function createGroup(): Promise<void> {
    const name = groupName.trim()
    if (name.length === 0) return
    const created = await run(async () => api.createGroup({ name, parentId: null, color: null }))
    if (created !== null) {
      setGroupName('')
      setCreatingGroup(false)
      await refresh()
    }
  }

  async function importSshConfig(): Promise<void> {
    const done = await run(async () => {
      const paths = await api.defaultSshConfigPaths()
      const path = paths[0]
      if (path === undefined) throw new Error('no default ssh config path')
      const parsed = await api.parseSshConfig(path)
      if (!parsed.exists) {
        setNotice(`${path} does not exist`)
        return false
      }
      const result = await api.importSshConfig({ path, aliases: null, overwriteExisting: false })
      setNotice(
        `${result.importedAliases.length} imported` +
          (result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : '')
      )
      return true
    })
    if (done === true) await refresh()
  }

  async function lock(): Promise<void> {
    await run(async () => {
      const lockedStatus = await api.lockVault()
      useVaultStore.getState().applyStatus(lockedStatus)
      return true
    })
  }

  return (
    <aside className="ts-sidebar ts-vault" data-testid="host-sidebar">
      <header className="ts-vault__head">
        <h1 className="ts-vault__title">{t('hosts.title')}</h1>
        {unlocked ? (
          <span className="ts-vault__count" title={t('hosts.count', { count: library?.hosts.length ?? 0 })}>
            {library?.hosts.length ?? 0}
          </span>
        ) : null}
      </header>

      {!unlocked ? (
        <div className="ts-vault__locked" data-testid="vault-locked-notice">
          <Lock size={18} aria-hidden="true" />
          <p>{t('hosts.locked')}</p>
        </div>
      ) : (
        <>
          <div className="ts-vault__toolbar">
            <label className="ts-vault__search">
              <Search size={13} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('hosts.search')} />
            </label>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              title={t('hosts.new')}
              onClick={() => setCreating(true)}
              data-testid="host-new"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              title={t('hosts.newGroup')}
              onClick={() => setCreatingGroup((value) => !value)}
            >
              <FolderPlus size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              title={t('hosts.import')}
              onClick={() => void importSshConfig()}
              disabled={busy}
            >
              <Import size={14} aria-hidden="true" />
            </button>
          </div>

          {creatingGroup ? (
            <div className="ts-vault__row ts-vault__row--tight">
              <input
                autoFocus
                value={groupName}
                placeholder={t('hosts.newGroup')}
                onChange={(event) => setGroupName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createGroup()
                  if (event.key === 'Escape') setCreatingGroup(false)
                }}
              />
              <button type="button" className="ts-btn ts-btn--primary" onClick={() => void createGroup()} disabled={busy}>
                {t('editor.save')}
              </button>
            </div>
          ) : null}

          <div className="ts-vault__scroll">
            {filtered === null ? (
              <p className="ts-vault__hint">{busy ? t('editor.saving') : ''}</p>
            ) : (
              <HostTree
                library={filtered}
                groups={filtered.groups}
                selectedHostId={selectedHostId}
                onSelect={selectHost}
                onEdit={(hostId) => {
                  const host = library?.hosts.find((candidate) => candidate.id === hostId) ?? null
                  setEditing(host)
                }}
              />
            )}
          </div>

          {notice !== null ? <p className="ts-vault__ok">{notice}</p> : null}
          {error !== null ? <p className="ts-vault__error">{error}</p> : null}
        </>
      )}

      <footer className="ts-vault__foot">
        <button type="button" className="ts-btn ts-btn--ghost" onClick={() => void refresh()} disabled={!unlocked || busy}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ts-btn ts-btn--ghost"
          onClick={() => {
            setShowSync(true)
            void refreshSync()
          }}
          disabled={!unlocked}
          title={t('sync.title')}
          data-testid="open-sync-panel"
        >
          Git
        </button>
        <button
          type="button"
          className="ts-btn ts-btn--ghost"
          onClick={() => setShowSecurity(true)}
          disabled={!unlocked}
          title={t('security.title')}
          data-testid="open-security-panel"
        >
          <ShieldCheck size={14} aria-hidden="true" />
        </button>
        <span className="ts-vault__spacer" />
        <button
          type="button"
          className="ts-btn ts-btn--ghost"
          onClick={() => void lock()}
          disabled={!unlocked || busy}
          title={t('security.lock')}
          data-testid="lock-vault"
        >
          <Lock size={14} aria-hidden="true" />
        </button>
      </footer>

      {creating ? (
        <HostEditor
          host={null}
          groups={library?.groups ?? []}
          hosts={library?.hosts ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setError(null)
            void refresh()
          }}
        />
      ) : null}

      {editing !== null ? (
        <HostEditor
          host={editing}
          groups={library?.groups ?? []}
          hosts={library?.hosts ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setError(null)
            void refresh()
          }}
        />
      ) : null}

      {showSync ? <SyncPanel onClose={() => setShowSync(false)} /> : null}
      {showSecurity ? <VaultSecurityPanel onClose={() => setShowSecurity(false)} /> : null}
    </aside>
  )
}
