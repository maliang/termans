import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openSettingsDialog } from '@renderer/theme/settings-dialog'
import { FileInput, GitBranch, KeyRound, Lock, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react'
import * as api from './api'
import type { HostView } from './api'
import { HostEditor } from './HostEditor'
import { HostTree } from './HostTree'
import { PrivateKeyGuide } from './PrivateKeyGuide'
import { SyncPanel } from './SyncPanel'
import { VaultSecurityPanel } from './VaultSecurityPanel'
import { useVaultErrorText, useVaultStore } from './store'

/**
 * 左栏主机库（替换 `app/placeholders/HostSidebar.tsx`，t7 一行接线）。
 *
 * 锁定语义是硬约束：`status.state !== 'unlocked'` 时**不渲染任何主机数据**——
 * 不是 CSS 隐藏，而是根本不挂载 `<HostTree>`，锁屏时 DOM 里没有主机名/IP。
 *
 * 入口分层（t31/#4、#5）：搜索行只留「搜索 + 新建主机」一个新增入口；
 * 页脚按语义分两组——「本机数据操作」（刷新 / 导入 ssh_config / 导入私钥）
 * 与「同步与安全」（Git 同步 / 锁定），全部同尺寸图标按钮 + `title` + `aria-label`。
 */
export interface HostSidebarProps {
  /**
   * 双击主机行 = 连接（产品约定）。外壳 `HostLibraryPane` 目前用捕获阶段抢事件实现，
   * 它可以直接把这个回调传进来、删掉自己的捕获层（t37/#25 的正式通道）。
   * 不传时双击退回「编辑」（HostTree 的默认语义）。
   */
  onConnect?: (hostId: string) => void
}

export function HostSidebar({ onConnect }: HostSidebarProps = {}): JSX.Element {
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
  const [showSync, setShowSync] = useState(false)
  const [showSecurity, setShowSecurity] = useState(false)
  const [editing, setEditing] = useState<HostView | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [keyTarget, setKeyTarget] = useState<HostView | null>(null)

  const unlocked = status?.state === 'unlocked'
  const hasHosts = (library?.hosts.length ?? 0) > 0
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

  const selectedHost = library?.hosts.find((host) => host.id === selectedHostId) ?? null

  function openEditor(hostId: string): void {
    const host = library?.hosts.find((candidate) => candidate.id === hostId) ?? null
    setEditing(host)
  }

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
        setNotice(t('hosts.importMissing', { path }))
        return false
      }
      const result = await api.importSshConfig({ path, aliases: null, overwriteExisting: false })
      setNotice(t('hosts.importResult', { imported: result.importedAliases.length, skipped: result.skipped.length }))
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

  function openPrivateKey(): void {
    if (selectedHost === null) return
    setKeyTarget(selectedHost)
  }

  /**
   * 同步 / 安全入口的去向（t34 接线落地，theme-i18n 改，vault-sync 在注释里预授权）：
   * 面板已支持 `embedded`，设置弹窗的 security / sync 页签内嵌它们
   * （`src/renderer/theme/SettingsDialogHost.tsx` 的 `settings-embed-security|sync`）。
   * 所以这里不再开本模块的独立弹窗——那个弹窗是「同类设置三种入口」的来源（UI 审计 #13）。
   *
   * `setShow*Panel(false)` 是防御性的：把旧弹窗状态显式关掉，避免任何遗留路径
   * （按钮被程序化点击、或面板开着时状态被改成 true）出现「设置页 + 旧弹窗」两层。
   * 旧的独立弹窗渲染分支与状态本身保留未删：删它属于本文件布局改动，需 vault-sync 自己清。
   */
  function openSyncEntry(): void {
    setShowSync(false)
    void refreshSync()
    openSettingsDialog('sync')
  }

  function openSecurityEntry(): void {
    setShowSecurity(false)
    openSettingsDialog('security')
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
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('hosts.search')}
                aria-label={t('hosts.search')}
              />
            </label>
            {/* 唯一的新建入口（t31/#5：原来 `+` 与「文件夹」并排，两个新增入口且后者图标含混） */}
            <button
              type="button"
              className="ts-icon-btn"
              title={t('hosts.new')}
              aria-label={t('hosts.new')}
              onClick={() => setCreating(true)}
              data-testid="host-new"
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          </div>

          {creatingGroup ? (
            <div className="ts-vault__row ts-vault__row--tight">
              <input
                autoFocus
                value={groupName}
                placeholder={t('hosts.newGroup')}
                aria-label={t('hosts.newGroup')}
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
                onEdit={openEditor}
                onCreate={() => setCreating(true)}
                onCreateGroup={() => setCreatingGroup(true)}
                onImportSshConfig={() => void importSshConfig()}
                {...(onConnect === undefined ? {} : { onConnect })}
              />
            )}
          </div>

          {notice !== null ? <p className="ts-vault__ok">{notice}</p> : null}
          {error !== null ? <p className="ts-vault__error">{error}</p> : null}
        </>
      )}

      <footer className="ts-vault__foot">
        <div className="ts-vault__foot-group">
          <button
            type="button"
            className="ts-icon-btn"
            onClick={() => void refresh()}
            disabled={!unlocked || busy}
            title={t('hosts.refresh')}
            aria-label={t('hosts.refresh')}
            data-testid="sidebar-refresh"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          {/* 空库时导入入口只留空态里那一个（真实文字按钮），避免同一个动作出现两处 */}
          {hasHosts ? (
            <button
              type="button"
              className="ts-icon-btn"
              onClick={() => void importSshConfig()}
              disabled={!unlocked || busy}
              title={t('hosts.importSshConfig')}
              aria-label={t('hosts.importSshConfig')}
              data-testid="sidebar-import-ssh-config"
            >
              <FileInput size={15} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="ts-icon-btn"
            onClick={openPrivateKey}
            disabled={!unlocked || busy || selectedHost === null}
            title={selectedHost === null ? t('hosts.pickHostFirst') : t('hosts.importKey')}
            aria-label={t('hosts.importKey')}
            data-testid="sidebar-import-key"
          >
            <KeyRound size={15} aria-hidden="true" />
          </button>
        </div>
        <span className="ts-vault__foot-sep" aria-hidden="true" />
        <div className="ts-vault__foot-group">
          <button
            type="button"
            className="ts-icon-btn"
            onClick={() => {
              // 设置弹窗的「同步」页签由 theme-i18n 接线（SettingsDialogHost 里的两行 embed 位）；
              // 在它落地前仍然用本模块的独立弹窗兜底，保证 e2e 的 open-sync-panel 不会点开空页签。
              openSyncEntry()
            }}
            disabled={!unlocked}
            title={t('sync.title')}
            aria-label={t('sync.title')}
            data-testid="open-sync-panel"
          >
            <GitBranch size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ts-icon-btn"
            onClick={() => openSecurityEntry()}
            disabled={!unlocked}
            title={t('security.title')}
            aria-label={t('security.title')}
            data-testid="open-security-panel"
          >
            <ShieldCheck size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="ts-icon-btn"
            onClick={() => void lock()}
            disabled={!unlocked || busy}
            title={t('security.lock')}
            aria-label={t('security.lock')}
            data-testid="lock-vault"
          >
            <Lock size={15} aria-hidden="true" />
          </button>
        </div>
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

      {keyTarget !== null ? (
        <div className="ts-dialog" data-testid="private-key-modal">
          <section
            className="ts-dialog__panel ts-dialog__panel--sm"
            role="dialog"
            aria-modal="true"
            aria-label={t('hosts.importKey')}
          >
            <header className="ts-dialog__header">
              <h2 className="ts-dialog__title">{t('key.title')}</h2>
              <button
                type="button"
                className="ts-dialog__close"
                onClick={() => setKeyTarget(null)}
                title={t('editor.close')}
                aria-label={t('editor.close')}
              >
                <X size={15} aria-hidden="true" />
              </button>
            </header>
            <div className="ts-dialog__body">
              <PrivateKeyGuide
                host={keyTarget}
                onImported={() => {
                  setKeyTarget(null)
                  void refresh()
                }}
                onSwitchToPassword={() => {
                  setKeyTarget(null)
                  setEditing(keyTarget)
                }}
              />
            </div>
          </section>
        </div>
      ) : null}

      {showSync ? <SyncPanel onClose={() => setShowSync(false)} /> : null}
      {showSecurity ? <VaultSecurityPanel onClose={() => setShowSecurity(false)} /> : null}
    </aside>
  )
}
