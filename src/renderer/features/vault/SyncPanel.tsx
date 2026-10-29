import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, RefreshCw, ShieldCheck, Upload, X } from 'lucide-react'
import type { ConflictStrategy, SyncRepo } from '@shared'
import * as api from './api'
import { useVaultErrorText, useVaultStore } from './store'

interface SyncPanelProps {
  /** 弹窗模式下关闭；内嵌到设置页签时不需要 */
  onClose?: () => void
  /** true = 只出内容（不渲染遮罩层/标题/取消按钮），供设置弹窗内嵌 */
  embedded?: boolean
}

/**
 * Git 同步面板。
 *
 * 三件必须看得见的事：
 * 1. **仓库里只有密文**（notice 常驻，不是一次性的提示）；
 * 2. 上次提交 / 上次同步时间 / 当前状态（ahead/behind/diverged 各有不同文案）；
 * 3. 冲突快照可以逐条选边（保留本地 / 保留远端 / 两边都留），**没有静默覆盖的按钮**。
 */
export function SyncPanel({ onClose, embedded = false }: SyncPanelProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const syncStatus = useVaultStore((state) => state.syncStatus)
  const conflicts = useVaultStore((state) => state.conflicts)
  const busy = useVaultStore((state) => state.busy)
  const notice = useVaultStore((state) => state.notice)
  const setNotice = useVaultStore((state) => state.setNotice)
  const refreshSync = useVaultStore((state) => state.refreshSync)
  const refresh = useVaultStore((state) => state.refresh)
  const run = useVaultStore((state) => state.run)
  const error = useVaultErrorText()

  const [remoteUrl, setRemoteUrl] = useState(syncStatus?.repo?.remoteUrl ?? '')
  const [branch, setBranch] = useState(syncStatus?.repo?.branch ?? 'main')
  const [auth, setAuth] = useState<SyncRepo['auth']>(syncStatus?.repo?.auth ?? 'token')
  const [token, setToken] = useState('')

  const repo = syncStatus?.repo ?? null

  async function connect(): Promise<void> {
    const status = await run(async () => {
      if (auth === 'token' && token.trim().length > 0) await api.setLocalCredential(api.GIT_TOKEN_REFERENCE, token.trim())
      return api.bootstrapSync(remoteUrl.trim(), branch.trim() === '' ? 'main' : branch.trim(), auth)
    })
    if (status !== null) {
      setToken('')
      await refreshSync()
      await refresh()
    }
  }

  async function push(): Promise<void> {
    const status = await run(() => api.pushSync())
    if (status !== null) {
      await refreshSync()
      await refresh()
    }
  }

  async function pull(): Promise<void> {
    const status = await run(() => api.pullSync())
    if (status !== null) {
      await refreshSync()
      await refresh()
    }
  }

  async function resolve(conflictId: string, strategy: ConflictStrategy): Promise<void> {
    const status = await run(() => api.resolveConflict(conflictId, strategy))
    if (status !== null) {
      await refreshSync()
      await refresh()
    }
  }

  async function eraseCredentials(): Promise<void> {
    const done = await run(async () => {
      await api.clearLocalCredential(api.GIT_TOKEN_REFERENCE)
      await api.clearLocalCredential(api.SESSION_REFERENCE)
      return true
    })
    if (done === true) setNotice(t('sync.eraseDone'))
  }

  const content = (
    <>
        <p className="ts-vault__notice">
          <ShieldCheck size={14} aria-hidden="true" /> {t('sync.notice')}
        </p>

        {repo === null ? (
          <form
            className="ts-vault__grid"
            onSubmit={(event) => {
              event.preventDefault()
              void connect()
            }}
          >
            <label className="ts-field ts-field--wide">
              <span className="ts-field__label">{t('sync.remoteUrl')}</span>
              <input
                required
                value={remoteUrl}
                placeholder="https://github.com/you/termans-vault.git"
                onChange={(event) => setRemoteUrl(event.target.value)}
                data-testid="sync-remote-url"
              />
            </label>
            <label className="ts-field ts-field--narrow">
              <span className="ts-field__label">{t('sync.branch')}</span>
              <input value={branch} onChange={(event) => setBranch(event.target.value)} />
            </label>
            <label className="ts-field ts-field--narrow">
              <span className="ts-field__label">{t('sync.auth')}</span>
              <select value={auth} onChange={(event) => setAuth(event.target.value as SyncRepo['auth'])}>
                <option value="token">{t('sync.auth.token')}</option>
                <option value="none">{t('sync.auth.none')}</option>
              </select>
            </label>
            {auth === 'token' ? (
              <label className="ts-field ts-field--wide">
                <span className="ts-field__label">{t('sync.token')}</span>
                <input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="ghp_…"
                  data-testid="sync-token"
                />
              </label>
            ) : null}
            <div className="ts-vault__actions">
              <span className="ts-vault__spacer" />
              {embedded ? null : (
                <button type="button" className="ts-btn ts-btn--ghost" onClick={() => onClose?.()}>
                  {t('editor.cancel')}
                </button>
              )}
              <button type="submit" className="ts-btn ts-btn--primary" disabled={busy} data-testid="sync-connect">
                {busy ? t('sync.connecting') : t('sync.connect')}
              </button>
            </div>
          </form>
        ) : (
          <>
            <dl className="ts-vault__meta">
              <dt>{t('sync.remoteUrl')}</dt>
              <dd className="ts-vault__mono">{repo.remoteUrl}</dd>
              <dt>{t('sync.branch')}</dt>
              <dd className="ts-vault__mono">{repo.branch}</dd>
              <dt>State</dt>
              <dd data-testid="sync-state">{t(`sync.state.${syncStatus?.state ?? 'off'}`)}</dd>
              <dt>{t('sync.localCommit')}</dt>
              <dd className="ts-vault__mono">{syncStatus?.localCommit?.slice(0, 8) ?? '—'}</dd>
              <dt>{t('sync.remoteCommit')}</dt>
              <dd className="ts-vault__mono">{syncStatus?.remoteCommit?.slice(0, 8) ?? '—'}</dd>
              <dt>{t('sync.lastSynced')}</dt>
              <dd className="ts-vault__mono">{syncStatus?.lastSyncedAt ?? '—'}</dd>
            </dl>

            <div className="ts-vault__row">
              <button type="button" className="ts-btn ts-btn--primary" disabled={busy} onClick={() => void push()} data-testid="sync-push">
                <Upload size={14} aria-hidden="true" /> {t('sync.push')}
              </button>
              <button type="button" className="ts-btn" disabled={busy} onClick={() => void pull()} data-testid="sync-pull">
                <RefreshCw size={14} aria-hidden="true" /> {t('sync.pull')}
              </button>
              <button type="button" className="ts-btn ts-btn--ghost" onClick={() => void refreshSync()} disabled={busy}>
                <RefreshCw size={14} aria-hidden="true" /> {t('sync.refresh')}
              </button>
            </div>

            {conflicts.length > 0 ? (
              <div className="ts-vault__conflicts" data-testid="sync-conflicts">
                <h3 className="ts-vault__subtitle">{t('sync.conflictTitle', { count: conflicts.length })}</h3>
                {conflicts.map((conflict) => (
                  <div key={conflict.id} className="ts-vault__conflict">
                    <div className="ts-vault__conflict-head">
                      <strong>{conflict.label}</strong>
                      <span className="ts-vault__mono">{conflict.path}</span>
                    </div>
                    <div className="ts-vault__conflict-values">
                      <span>
                        <em>{t('sync.keepLocal')}</em> {conflict.localSummary}
                      </span>
                      <span>
                        <em>{t('sync.keepRemote')}</em> {conflict.remoteSummary}
                      </span>
                    </div>
                    <div className="ts-vault__row">
                      <button type="button" className="ts-btn" onClick={() => void resolve(conflict.id, 'local')}>
                        {t('sync.keepLocal')}
                      </button>
                      <button type="button" className="ts-btn" onClick={() => void resolve(conflict.id, 'remote')}>
                        {t('sync.keepRemote')}
                      </button>
                      <button type="button" className="ts-btn ts-btn--ghost" onClick={() => void resolve(conflict.id, 'duplicate')}>
                        {t('sync.keepBoth')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="ts-vault__actions">
              <button type="button" className="ts-btn ts-btn--ghost ts-vault__danger" onClick={() => void eraseCredentials()}>
                {t('sync.eraseCredentials')}
              </button>
              <span className="ts-vault__spacer" />
              {embedded ? null : (
                <button type="button" className="ts-btn ts-btn--ghost" onClick={() => onClose?.()}>
                  {t('editor.cancel')}
                </button>
              )}
            </div>
          </>
        )}

        {notice !== null ? <p className="ts-vault__ok">{notice}</p> : null}
        {error !== null ? <p className="ts-vault__error">{error}</p> : null}

    </>
  )

  // 内嵌模式：设置弹窗自己有标题与关闭按钮，这里只出内容
  if (embedded) {
    return (
      <section className="ts-vault__card ts-vault__card--embedded" data-testid="sync-panel">
        {content}
      </section>
    )
  }

  // 独立弹窗形态：走 kit 的 .ts-dialog 外壳（遮罩 / 边框 / 阴影 / 焦点环都由底座给，见 docs/UI-KIT.md §4）
  return (
    <div className="ts-dialog" data-testid="sync-dialog">
      <section
        className="ts-dialog__panel ts-dialog__panel--md"
        role="dialog"
        aria-modal="true"
        aria-label={t('sync.title')}
        data-testid="sync-panel"
      >
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title">
            <GitBranch size={15} aria-hidden="true" /> {t('sync.title')}
          </h2>
          <button
            type="button"
            className="ts-dialog__close"
            onClick={() => onClose?.()}
            title={t('editor.close')}
            aria-label={t('editor.close')}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>
        <div className="ts-dialog__body">{content}</div>
      </section>
    </div>
  )
}
