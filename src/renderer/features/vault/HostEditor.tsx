import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, Trash2 } from 'lucide-react'
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
 * 两个细节值得留意：
 * 1. 密码走 `credentials:set`（主进程按引用分流：主机密码进**密文包**，Git token/私钥只在本机），
 *    所以 B 机同步下来也能直接连；私钥本体则永远不进仓库。
 * 2. 备注（notes）不在 `HostInput` 里，随 `hosts:update` 的扩展键一起提交，落在 payload.hostNotes。
 */
export function HostEditor({ host, groups, hosts, onClose, onSaved }: HostEditorProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const busy = useVaultStore((state) => state.busy)
  const run = useVaultStore((state) => state.run)
  const error = useVaultErrorText()

  const [draft, setDraft] = useState<HostInput>(() => (host === null ? blankHost() : toInput(host)))
  const [notes, setNotes] = useState(host?.notes ?? '')
  const [tagsText, setTagsText] = useState((host?.tags ?? []).join(', '))
  const [password, setPassword] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [keyGuide, setKeyGuide] = useState(false)

  const credentialRef = draft.credentialRef ?? `ref-${crypto.randomUUID()}`

  function patch(changes: Partial<HostInput>): void {
    setDraft((current) => ({ ...current, ...changes }))
  }

  async function save(): Promise<void> {
    const input: HostInput = {
      ...draft,
      credentialRef,
      label: draft.label.trim() === '' ? draft.hostname.trim() : draft.label.trim(),
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

  return (
    <div className="ts-vault__modal" role="dialog" aria-modal="true" aria-label={host === null ? t('editor.titleNew') : t('editor.titleEdit')}>
      <form
        className="ts-vault__card"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <h2 className="ts-vault__card-title">{host === null ? t('editor.titleNew') : t('editor.titleEdit')}</h2>

        <div className="ts-vault__grid">
          <label className="ts-field">
            <span className="ts-field__label">{t('editor.label')}</span>
            <input value={draft.label} onChange={(event) => patch({ label: event.target.value })} data-testid="host-label" />
          </label>
          <label className="ts-field">
            <span className="ts-field__label">{t('editor.hostname')}</span>
            <input
              required
              value={draft.hostname}
              onChange={(event) => patch({ hostname: event.target.value })}
              placeholder="10.0.0.1"
              data-testid="host-hostname"
            />
          </label>
          <label className="ts-field ts-field--narrow">
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
            <span className="ts-field__label">{t('editor.username')}</span>
            <input required value={draft.username} onChange={(event) => patch({ username: event.target.value })} />
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
          <label className="ts-field">
            <span className="ts-field__label">{t('editor.jumpHost')}</span>
            <select
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
          </label>
          <label className="ts-field">
            <span className="ts-field__label">{t('editor.tags')}</span>
            <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="prod, web" />
          </label>
          <label className="ts-field ts-field--narrow">
            <span className="ts-field__label">{t('editor.color')}</span>
            <input
              type="color"
              value={draft.color ?? '#4f8cff'}
              onChange={(event) => patch({ color: event.target.value })}
            />
          </label>
        </div>

        {draft.authMethod === 'password' ? (
          <label className="ts-field">
            <span className="ts-field__label">{t('editor.password')}</span>
            <input
              type="password"
              value={password}
              placeholder={t('editor.passwordKeep')}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="host-password"
            />
          </label>
        ) : null}

        {draft.authMethod === 'publickey' ? (
          <div className="ts-vault__row">
            <label className="ts-field ts-field--wide">
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
        </label>

        <label className="ts-vault__check">
          <input
            type="checkbox"
            checked={draft.forwardAgent}
            onChange={(event) => patch({ forwardAgent: event.target.checked })}
          />
          <span>{t('editor.forwardAgent')}</span>
        </label>

        {error !== null ? <p className="ts-vault__error">{error}</p> : null}

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
