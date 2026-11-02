import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, FileText, GitBranch, RefreshCw, ShieldCheck, Star, Trash2, Upload, X } from 'lucide-react'
import type { ConflictStrategy, GitTokenCandidate, GitTokenState, SyncRepo } from '@shared'
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

  /* ---- Git 令牌（t57）：多条令牌 / 默认令牌 / 令牌文件 / 系统令牌自动载入 ---- */
  const [tokenState, setTokenState] = useState<GitTokenState | null>(null)
  const [tokenPath, setTokenPath] = useState('')
  const [candidates, setCandidates] = useState<GitTokenCandidate[]>([])
  const [detecting, setDetecting] = useState(false)
  /** 哪一枚按钮刚刚复制成功（'input' 表示上方输入框）—— 只影响那一枚的文案与配色 */
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [tokenNotice, setTokenNotice] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashCopied = useCallback((key: string) => {
    setCopiedKey(key)
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopiedKey(null), 2_000)
  }, [])

  useEffect(() => {
    return () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    }
  }, [])

  /**
   * 首次渲染就去看系统里有没有令牌（主人要求「软件会查看系统令牌并默认加载」）。
   *
   * 只在**一条令牌都没有**时才自动载入：已经有令牌的用户不该因为打开一次设置
   * 就被悄悄换掉默认令牌（那会让同步换成另一个账号的权限）。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const state = await api.gitTokenState()
        if (!alive) return
        setTokenState(state)
        setTokenPath(state.tokenFilePath ?? '')
        if (state.tokens.length > 0) return
        const found = await api.detectGitTokens()
        if (!alive || found.length === 0) return
        setCandidates(found)
        const adopted = await api.adoptGitToken(found[0]!.id)
        if (!alive) return
        setTokenState(adopted)
        setTokenNotice(t('sync.token.detected', { label: found[0]!.label }))
      } catch {
        // 未解锁 / 锁定态下这两个通道会抛 E_VAULT_LOCKED：令牌区本来就只在已解锁时渲染
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function copyText(key: string, text: string): Promise<void> {
    const copied = await api.writeClipboard(text)
    if (copied) flashCopied(key)
    else setTokenNotice(t('sync.token.copyFailed'))
  }

  async function copySavedToken(id: string): Promise<void> {
    const token = await api.revealGitToken(id)
    await copyText(id, token)
  }

  async function saveTypedToken(): Promise<void> {
    const value = token.trim()
    if (value === '') return
    const next = await api.addGitToken({ token: value })
    setTokenState(next)
    setTokenNotice(t('sync.token.saved'))
  }

  async function makeDefault(id: string): Promise<void> {
    setTokenState(await api.setDefaultGitToken(id))
    setTokenNotice(null)
  }

  async function removeToken(id: string): Promise<void> {
    setTokenState(await api.removeGitToken(id))
    setTokenNotice(null)
  }

  async function saveTokenPath(path: string | null): Promise<void> {
    const next = await api.setGitTokenPath(path)
    setTokenState(next)
    setTokenPath(next.tokenFilePath ?? '')
    setTokenNotice(path === null ? t('sync.token.pathCleared') : t('sync.token.pathSaved'))
  }

  async function detectNow(): Promise<void> {
    setDetecting(true)
    try {
      const found = await api.detectGitTokens()
      setCandidates(found)
      setTokenNotice(found.length === 0 ? t('sync.token.detectEmpty') : null)
    } finally {
      setDetecting(false)
    }
  }

  async function adoptCandidate(candidateId: string): Promise<void> {
    const next = await api.adoptGitToken(candidateId)
    setTokenState(next)
    setTokenNotice(t('sync.token.saved'))
  }

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
              <div className="ts-field ts-field--wide ts-vault__token-section" data-testid="sync-token-section">
                <span className="ts-field__label">{t('sync.token')}</span>
                <div className="ts-vault__token-row">
                  <input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="ghp_…"
                    aria-label={t('sync.token')}
                    autoComplete="off"
                    data-testid="sync-token"
                  />
                  <button
                    type="button"
                    className={copiedKey === 'input' ? 'ts-btn ts-btn--sm ts-btn--copied' : 'ts-btn ts-btn--sm'}
                    onClick={() => void copyText('input', token.trim())}
                    disabled={token.trim() === ''}
                    data-testid="sync-token-copy"
                  >
                    {copiedKey === 'input' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                    {copiedKey === 'input' ? t('sync.token.copied') : t('sync.token.copy')}
                  </button>
                  <button
                    type="button"
                    className="ts-btn ts-btn--sm"
                    onClick={() => void saveTypedToken()}
                    disabled={token.trim() === ''}
                    data-testid="sync-token-save"
                  >
                    {t('sync.token.save')}
                  </button>
                </div>

                {/* 说明放在「连接」这些字段下面（主人要求）：讲清三种令牌获取方式与「谁跟着同步」 */}
                <p className="ts-vault__hint" data-testid="sync-token-hint">
                  {t('sync.token.hint')}
                </p>
                {tokenState !== null ? (
                  <p className="ts-vault__hint" data-testid="sync-token-active">
                    {t(`sync.token.active.${tokenState.activeSource}`)}
                  </p>
                ) : null}

                {tokenState !== null && tokenState.tokens.length > 0 ? (
                  <ul className="ts-vault__token-list" data-testid="sync-token-list">
                    {tokenState.tokens.map((item) => (
                      <li
                        key={item.id}
                        className={
                          item.id === tokenState.defaultTokenId ? 'ts-vault__token is-default' : 'ts-vault__token'
                        }
                        data-testid={`sync-token-item-${item.id}`}
                      >
                        <span className="ts-vault__token-name">
                          {item.label.trim() !== '' ? item.label : t('sync.token.untitled')}
                        </span>
                        <span className="ts-vault__token-mask" data-testid={`sync-token-mask-${item.id}`}>
                          {item.masked}
                        </span>
                        <span className="ts-vault__token-source">{t(`sync.token.source.${item.source}`)}</span>
                        {item.id === tokenState.defaultTokenId ? (
                          <span className="ts-vault__token-badge">
                            <Star size={11} aria-hidden="true" /> {t('sync.token.default')}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="ts-btn ts-btn--sm ts-btn--ghost"
                            onClick={() => void makeDefault(item.id)}
                            data-testid={`sync-token-default-${item.id}`}
                          >
                            {t('sync.token.makeDefault')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={copiedKey === item.id ? 'ts-icon-btn ts-icon-btn--copied' : 'ts-icon-btn'}
                          onClick={() => void copySavedToken(item.id)}
                          title={copiedKey === item.id ? t('sync.token.copied') : t('sync.token.copy')}
                          aria-label={copiedKey === item.id ? t('sync.token.copied') : t('sync.token.copy')}
                          data-testid={`sync-token-copy-${item.id}`}
                        >
                          {copiedKey === item.id ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className="ts-icon-btn"
                          onClick={() => void removeToken(item.id)}
                          title={t('sync.token.remove')}
                          aria-label={t('sync.token.remove')}
                          data-testid={`sync-token-remove-${item.id}`}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* 令牌文件路径：设了就以文件为准，每次同步前重新读 */}
                <div className="ts-vault__token-row">
                  <input
                    value={tokenPath}
                    onChange={(event) => setTokenPath(event.target.value)}
                    placeholder="/run/secrets/git-token"
                    aria-label={t('sync.token.path')}
                    data-testid="sync-token-path"
                  />
                  <button
                    type="button"
                    className="ts-btn ts-btn--sm"
                    onClick={() => void saveTokenPath(tokenPath.trim() === '' ? null : tokenPath.trim())}
                    data-testid="sync-token-path-save"
                  >
                    {t('sync.token.pathSave')}
                  </button>
                  {tokenState?.tokenFilePath !== null && tokenState?.tokenFilePath !== undefined ? (
                    <button
                      type="button"
                      className="ts-btn ts-btn--sm ts-btn--ghost"
                      onClick={() => void saveTokenPath(null)}
                      data-testid="sync-token-path-clear"
                    >
                      {t('sync.token.pathClear')}
                    </button>
                  ) : null}
                </div>
                <p className="ts-vault__hint">{t('sync.token.pathHint')}</p>

                <div className="ts-vault__token-row">
                  <button
                    type="button"
                    className="ts-btn ts-btn--sm ts-btn--ghost"
                    onClick={() => void detectNow()}
                    disabled={detecting}
                    data-testid="sync-token-detect"
                  >
                    <FileText size={13} aria-hidden="true" />
                    {detecting ? t('sync.token.detecting') : t('sync.token.detect')}
                  </button>
                </div>

                {candidates.length > 0 ? (
                  <ul className="ts-vault__token-list" data-testid="sync-token-candidates">
                    {candidates.map((candidate) => (
                      <li key={candidate.id} className="ts-vault__token" data-testid={`sync-token-candidate-${candidate.id}`}>
                        <span className="ts-vault__token-name">{candidate.label}</span>
                        <span className="ts-vault__token-mask">{candidate.masked}</span>
                        <button
                          type="button"
                          className="ts-btn ts-btn--sm ts-btn--ghost"
                          onClick={() => void adoptCandidate(candidate.id)}
                          data-testid={`sync-token-adopt-${candidate.id}`}
                        >
                          {t('sync.token.adopt')}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {tokenNotice !== null ? (
                  <p className="ts-vault__ok" data-testid="sync-token-notice">
                    {tokenNotice}
                  </p>
                ) : null}
              </div>
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
