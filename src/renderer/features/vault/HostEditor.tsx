import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, Trash2, X } from 'lucide-react'
import type { GroupRecord, HostInput } from '@shared'
import * as api from './api'
import type { HostView } from './api'
import { PrivateKeyGuide } from './PrivateKeyGuide'
import { useVaultErrorText, useVaultStore } from './store'

interface HostEditorProps {
  host: HostView | null
  groups: GroupRecord[]
  hosts: HostView[]
  onClose: () => void
  onSaved: () => void
}

/** 6 个预设标记色。这是**数据**（写进 host.color），不是主题 token，所以用字面量。 */
const COLOR_PRESETS = ['#4f8cff', '#38d39f', '#f5b942', '#ff6b6b', '#c792ea', '#8b95a5']

interface FieldErrors {
  label?: string
  hostname?: string
  username?: string
}

function blankHost(): HostInput {
  return {
    label: '',
    groupId: null,
    hostname: '',
    port: 22,
    username: '',
    authMethod: 'password',
    privateKeyPath: null,
    credentialRef: null,
    jumpHostId: null,
    forwardAgent: false,
    keepaliveSeconds: 30,
    terminalProfileId: null,
    startupCommand: null,
    env: {},
    tags: [],
    color: null,
    portForwards: [],
    sshConfigOrigin: null
  }
}

function toInput(host: HostView): HostInput {
  const { id: _id, sortIndex: _sortIndex, createdAt: _createdAt, updatedAt: _updatedAt, notes: _notes, ...input } = host
  return input
}

/**
 * 主机编辑表单。
 *
 * 三个细节值得留意：
 * 1. 密码走 `credentials:set`（主进程按引用分流：主机密码进**密文包**，Git token/私钥只在本机），
 *    所以 B 机同步下来也能直接连；私钥本体则永远不进仓库。
 * 2. 备注（notes）不在 `HostInput` 里，随 `hosts:update` 的扩展键一起提交，落在 payload.hostNotes。
 * 3. 「是否已保存密码」只能由 `credentialRef !== null` 推断 —— IPC 契约里**没有读取密码的通道**
 *    （只有 set / clear），所以这里不做任何回显，只给一个状态提示 + 清除动作（t31/#8）。
 */
export function HostEditor({ host, groups, hosts, onClose, onSaved }: HostEditorProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const busy = useVaultStore((state) => state.busy)
  const run = useVaultStore((state) => state.run)
  const setNotice = useVaultStore((state) => state.setNotice)
  const error = useVaultErrorText()

  const [draft, setDraft] = useState<HostInput>(() => (host === null ? blankHost() : toInput(host)))
  const [notes, setNotes] = useState(host?.notes ?? '')
  const [tagsText, setTagsText] = useState((host?.tags ?? []).join(', '))
  const [password, setPassword] = useState('')
  const [savedPassword, setSavedPassword] = useState(host !== null && host.credentialRef !== null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [keyGuide, setKeyGuide] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})

  const labelRef = useRef<HTMLInputElement>(null)
  const hostnameRef = useRef<HTMLInputElement>(null)
  const usernameRef = useRef<HTMLInputElement>(null)

  const credentialRef = draft.credentialRef ?? `ref-${crypto.randomUUID()}`
  const title = host === null ? t('editor.titleNew') : t('editor.titleEdit')

  // 打开即把焦点放到第一个字段；Esc 关弹窗（审计 #9：原来只有「取消」一条退路）
  useEffect(() => {
    labelRef.current?.focus()
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      const busyNow = useVaultStore.getState().busy
      if (busyNow) return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function patch(changes: Partial<HostInput>): void {
    setDraft((current) => ({ ...current, ...changes }))
  }

  function validate(): boolean {
    const next: FieldErrors = {}
    if (draft.label.trim() === '') next.label = t('editor.requiredHint')
    if (draft.hostname.trim() === '') next.hostname = t('editor.requiredHint')
    if (draft.username.trim() === '') next.username = t('editor.requiredHint')
    setErrors(next)
    if (next.label !== undefined) labelRef.current?.focus()
    else if (next.hostname !== undefined) hostnameRef.current?.focus()
    else if (next.username !== undefined) usernameRef.current?.focus()
    return Object.keys(next).length === 0
  }

  async function save(): Promise<void> {
    if (!validate()) return
    const input: HostInput = {
      ...draft,
      credentialRef,
      label: draft.label.trim(),
      hostname: draft.hostname.trim(),
      username: draft.username.trim(),
      tags: tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    }
    const saved = await run(async () => {
      const record = host === null ? await api.createHost(input) : await api.updateHost(host.id, input, notes)
      if (host === null && notes.trim().length > 0) await api.updateHost(record.id, input, notes)
      if (password.length > 0) await api.setHostPassword(credentialRef, password)
      return record
    })
    if (saved !== null) {
      setPassword('')
      onSaved()
      onClose()
    }
  }

  async function clearPassword(): Promise<void> {
    if (host === null || host.credentialRef === null) return
    const done = await run(async () => {
      await api.clearHostSecret(host.credentialRef as string)
      return true
    })
    if (done === true) {
      setPassword('')
      setSavedPassword(false)
      setNotice(t('editor.passwordCleared'))
    }
  }

  async function remove(): Promise<void> {
    if (host === null) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    const done = await run(async () => {
      await api.deleteHost(host.id)
      return true
    })
    if (done === true) {
      onSaved()
      onClose()
    }
  }

  function requiredLabel(text: string): JSX.Element {
    return (
      <span className="ts-field__label">
        {text}
        <span className="ts-vault__req" aria-hidden="true">
          *
        </span>
      </span>
    )
  }

  return (
    <div
      className="ts-vault__modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ts-host-editor-title"
      data-testid="host-editor"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      {/* noValidate：交给 validate() 做字段级错误，否则原生校验气泡会先拦住提交 */}
      <form
        className="ts-vault__card ts-vault__card--dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <header className="ts-vault__card-head">
          <h2 className="ts-vault__card-title" id="ts-host-editor-title">
            {title}
          </h2>
          <button
            type="button"
            className="ts-vault__card-close"
            onClick={onClose}
            disabled={busy}
            title={t('editor.close')}
            aria-label={t('editor.close')}
            data-testid="host-editor-close"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <div className="ts-vault__card-body">
          <div className="ts-vault__grid">
            <label className="ts-field">
              {requiredLabel(t('editor.label'))}
              <input
                ref={labelRef}
                value={draft.label}
                aria-required="true"
                aria-invalid={errors.label !== undefined}
                aria-describedby={errors.label === undefined ? undefined : 'ts-host-label-error'}
                onChange={(event) => patch({ label: event.target.value })}
                data-testid="host-label"
              />
              {errors.label !== undefined ? (
                <span className="ts-vault__field-error" id="ts-host-label-error" role="alert">
                  {errors.label}
                </span>
              ) : null}
            </label>
            <label className="ts-field">
              {requiredLabel(t('editor.hostname'))}
              <input
                ref={hostnameRef}
                value={draft.hostname}
                aria-required="true"
                aria-invalid={errors.hostname !== undefined}
                aria-describedby={errors.hostname === undefined ? undefined : 'ts-host-hostname-error'}
                placeholder="10.0.0.1"
                onChange={(event) => patch({ hostname: event.target.value })}
                data-testid="host-hostname"
              />
              {errors.hostname !== undefined ? (
                <span className="ts-vault__field-error" id="ts-host-hostname-error" role="alert">
                  {errors.hostname}
                </span>
              ) : null}
            </label>
            <label className="ts-field">
              <span className="ts-field__label">{t('editor.port')}</span>
              <input
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) => patch({ port: Number(event.target.value) || 22 })}
              />
            </label>
            <label className="ts-field">
              {requiredLabel(t('editor.username'))}
              <input
                ref={usernameRef}
                value={draft.username}
                aria-required="true"
                aria-invalid={errors.username !== undefined}
                aria-describedby={errors.username === undefined ? undefined : 'ts-host-username-error'}
                onChange={(event) => patch({ username: event.target.value })}
              />
              {errors.username !== undefined ? (
                <span className="ts-vault__field-error" id="ts-host-username-error" role="alert">
                  {errors.username}
                </span>
              ) : null}
            </label>
            <label className="ts-field">
              <span className="ts-field__label">{t('editor.authMethod')}</span>
              <select
                value={draft.authMethod}
                onChange={(event) => patch({ authMethod: event.target.value as HostInput['authMethod'] })}
              >
                <option value="password">{t('editor.auth.password')}</option>
                <option value="publickey">{t('editor.auth.publickey')}</option>
                <option value="agent">{t('editor.auth.agent')}</option>
                <option value="keyboard-interactive">{t('editor.auth.keyboard-interactive')}</option>
              </select>
            </label>
            <label className="ts-field">
              <span className="ts-field__label">{t('editor.group')}</span>
              <select
                value={draft.groupId ?? ''}
                onChange={(event) => patch({ groupId: event.target.value === '' ? null : event.target.value })}
              >
                <option value="">{t('editor.noGroup')}</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* 认证区块：与认证相关的字段、开关、密码规则都收敛在这里（t31/#10） */}
          <section className="ts-vault__section">
            <h3 className="ts-vault__section-title">{t('editor.sectionAuth')}</h3>

            {draft.authMethod === 'publickey' ? (
              <div className="ts-vault__row ts-vault__row--end">
                <label className="ts-field ts-field--grow">
                  {/* 标签文本保持 IdentityFile 字面量：e2e 用 getByLabel(/IdentityFile/) 定位 */}
                  <span className="ts-field__label">IdentityFile</span>
                  <input
                    value={draft.privateKeyPath ?? ''}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(event) => patch({ privateKeyPath: event.target.value === '' ? null : event.target.value })}
                  />
                </label>
                <button type="button" className="ts-btn ts-btn--ghost" onClick={() => setKeyGuide((value) => !value)}>
                  {t('key.import')}
                </button>
              </div>
            ) : null}

            {draft.authMethod === 'password' ? (
              <div className="ts-field">
                <label className="ts-field__label" htmlFor="ts-host-password">
                  {t('editor.password')}
                </label>
                <input
                  id="ts-host-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  placeholder={t('editor.passwordPlaceholder')}
                  onChange={(event) => setPassword(event.target.value)}
                  data-testid="host-password"
                />
                <p className="ts-vault__hint">
                  {savedPassword ? (
                    <span className="ts-vault__hint-ok" data-testid="password-saved">
                      {t('editor.passwordSaved')}
                      <button
                        type="button"
                        className="ts-link"
                        onClick={() => void clearPassword()}
                        disabled={busy}
                        data-testid="password-clear"
                      >
                        {t('editor.passwordClear')}
                      </button>
                    </span>
                  ) : null}
                  <span>{t('editor.passwordHint')}</span>
                </p>
              </div>
            ) : null}

            {keyGuide && host !== null ? (
              <PrivateKeyGuide
                host={host}
                onImported={() => {
                  setKeyGuide(false)
                  onSaved()
                }}
                onSwitchToPassword={() => {
                  setKeyGuide(false)
                  patch({ authMethod: 'password' })
                }}
              />
            ) : null}

            <label className="ts-vault__check">
              <input
                type="checkbox"
                checked={draft.forwardAgent}
                onChange={(event) => patch({ forwardAgent: event.target.checked })}
              />
              <span>{t('editor.forwardAgent')}</span>
            </label>
          </section>

          {/* 跳板机：整行 + 一句短说明，完整说明放 title，不再挤压下方字段（t31/#11） */}
          <div className="ts-field">
            <label className="ts-field__label" htmlFor="ts-host-jump">
              {t('editor.jumpHost')}
            </label>
            <select
              id="ts-host-jump"
              value={draft.jumpHostId ?? ''}
              onChange={(event) => patch({ jumpHostId: event.target.value === '' ? null : event.target.value })}
            >
              <option value="">{t('editor.noJumpHost')}</option>
              {hosts
                .filter((candidate) => candidate.id !== host?.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
            </select>
            <p className="ts-vault__hint" data-testid="jump-host-hint" title={t('hosts:editor.jumpHostHint')}>
              {t('editor.jumpHostHintShort')}
            </p>
          </div>

          <div className="ts-vault__grid">
            <label className="ts-field">
              <span className="ts-field__label">{t('editor.tags')}</span>
              <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="prod, web" />
            </label>
            <div className="ts-field">
              <span className="ts-field__label">{t('editor.colorLabel')}</span>
              <div className="ts-vault__swatches" role="group" aria-label={t('editor.colorLabel')}>
                {COLOR_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`ts-vault__swatch${draft.color === color ? ' ts-vault__swatch--on' : ''}`}
                    style={{ background: color }}
                    title={color}
                    aria-label={color}
                    aria-pressed={draft.color === color}
                    onClick={() => patch({ color })}
                  />
                ))}
                <label className="ts-vault__swatch ts-vault__swatch--custom" title={t('editor.colorCustom')}>
                  <input
                    type="color"
                    value={draft.color ?? '#4f8cff'}
                    aria-label={t('editor.colorCustom')}
                    onChange={(event) => patch({ color: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="ts-btn ts-btn--ghost ts-btn--sm"
                  onClick={() => patch({ color: null })}
                  disabled={draft.color === null}
                >
                  {t('editor.colorNone')}
                </button>
              </div>
              <span className="ts-vault__mono-inline">{draft.color ?? '—'}</span>
            </div>
          </div>

          <label className="ts-field">
            <span className="ts-field__label">{t('editor.startupCommand')}</span>
            <input
              value={draft.startupCommand ?? ''}
              onChange={(event) => patch({ startupCommand: event.target.value === '' ? null : event.target.value })}
            />
          </label>

          <label className="ts-field">
            <span className="ts-field__label">{t('editor.notes')}</span>
            <textarea
              rows={3}
              value={notes}
              placeholder={t('editor.notesPlaceholder')}
              onChange={(event) => setNotes(event.target.value)}
              data-testid="host-notes"
            />
            <span className="ts-vault__hint">{t('editor.notesHint')}</span>
          </label>

          {error !== null ? <p className="ts-vault__error">{error}</p> : null}
        </div>

        <footer className="ts-vault__actions">
          {host !== null ? (
            <button type="button" className="ts-btn ts-btn--ghost ts-vault__danger" onClick={() => void remove()} disabled={busy}>
              <Trash2 size={14} aria-hidden="true" />
              {confirmDelete ? t('editor.deleteConfirm') : t('editor.delete')}
            </button>
          ) : null}
          <span className="ts-vault__spacer" />
          <button type="button" className="ts-btn ts-btn--ghost" onClick={onClose} disabled={busy}>
            {t('editor.cancel')}
          </button>
          <button type="submit" className="ts-btn ts-btn--primary" disabled={busy} data-testid="host-save">
            <Save size={14} aria-hidden="true" />
            {busy ? t('editor.saving') : t('editor.save')}
          </button>
        </footer>
      </form>
    </div>
  )
}
