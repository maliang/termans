import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, KeyRound, Lock, ShieldCheck } from 'lucide-react'
import { useShellStore } from '../../app/store'
import * as api from '../vault/api'
import { downloadTextFile } from '../vault/download'
import { useVaultErrorText, useVaultStore } from '../vault/store'
import '../vault/vault.css'

type Mode = 'unlock' | 'create' | 'recover' | 'recovery-saved'

/**
 * 解锁屏（替换 `app/placeholders/LockScreen.tsx`，t7 一行接线）。
 *
 * 三种入口都在这里：解锁、首次创建（含弱口令二次确认）、用恢复码重置口令。
 * 弱口令的「二次确认」是协议级的：主进程第一次抛 `weak-passphrase`，**同口令再提交一次**才接受
 * （`vault:create` 的请求体只有一个 passphrase，冻结契约里没有 confirm 字段）。
 */
export function UnlockScreen(): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const status = useVaultStore((state) => state.status)
  const run = useVaultStore((state) => state.run)
  const applyStatus = useVaultStore((state) => state.applyStatus)
  const busy = useVaultStore((state) => state.busy)
  const error = useVaultErrorText()
  const setPreviewLocked = useShellStore((state) => state.setPreviewLocked)

  const [mode, setMode] = useState<Mode>('unlock')
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [remember, setRemember] = useState(true)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [issuedRecoveryCode, setIssuedRecoveryCode] = useState<string | null>(null)
  const [weakConfirmed, setWeakConfirmed] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  useEffect(() => {
    if (status?.state === 'uninitialized') setMode('create')
  }, [status?.state])

  function resetInputs(): void {
    setPassphrase('')
    setRepeat('')
    setRecoveryCode('')
    setWeakConfirmed(false)
    setLocalError(null)
  }

  async function unlock(): Promise<void> {
    const next = await run(() => api.unlockVault(passphrase, remember))
    if (next !== null) {
      resetInputs()
      applyStatus(next)
    }
  }

  async function create(): Promise<void> {
    if (passphrase !== repeat) {
      setLocalError(t('unlock.mismatch'))
      return
    }
    const result = await run(() => api.createVault(passphrase))
    if (result !== null) {
      setIssuedRecoveryCode(result.recoveryCode)
      applyStatus(result.status)
      setMode('recovery-saved')
      return
    }
    if (useVaultStore.getState().error === 'weak-passphrase') setWeakConfirmed(true)
  }

  async function recover(): Promise<void> {
    if (passphrase !== repeat) {
      setLocalError(t('unlock.mismatch'))
      return
    }
    const next = await run(() => api.recoverVault(recoveryCode, passphrase))
    if (next !== null) {
      resetInputs()
      applyStatus(next)
      setMode('unlock')
    }
  }

  const recovering = mode === 'recover'

  return (
    <div className="ts-unlock" data-testid="unlock-screen">
      <div className="ts-unlock__card">
        <header className="ts-unlock__head">
          <span className="ts-unlock__icon">
            {mode === 'create' ? <KeyRound size={18} aria-hidden="true" /> : <Lock size={18} aria-hidden="true" />}
          </span>
          <div>
            <h2 className="ts-unlock__title">
              {mode === 'create' ? t('unlock.createTitle') : recovering ? t('unlock.recoverTitle') : t('unlock.title')}
            </h2>
            <p className="ts-unlock__subtitle">
              {mode === 'create' ? t('unlock.createSubtitle') : t('unlock.subtitle')}
            </p>
          </div>
        </header>

        {mode === 'recovery-saved' ? (
          <div className="ts-unlock__recovery" data-testid="unlock-recovery-code">
            <p className="ts-unlock__warn">
              <ShieldCheck size={14} aria-hidden="true" /> {t('unlock.recoveryTitle')}
            </p>
            <p className="ts-unlock__subtitle">{t('unlock.recoveryBody')}</p>
            <code className="ts-unlock__code">{issuedRecoveryCode}</code>
            <div className="ts-unlock__row">
              <button
                type="button"
                className="ts-btn ts-btn--ghost"
                onClick={() => downloadTextFile('termans-recovery-code.txt', issuedRecoveryCode ?? '')}
              >
                <Download size={14} aria-hidden="true" /> {t('unlock.recoveryDownload')}
              </button>
              <span className="ts-vault__spacer" />
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                onClick={() => {
                  setIssuedRecoveryCode(null)
                  resetInputs()
                  setMode('unlock')
                }}
              >
                {t('unlock.recoveryDone')}
              </button>
            </div>
          </div>
        ) : (
          <form
            className="ts-unlock__form"
            onSubmit={(event) => {
              event.preventDefault()
              if (mode === 'create') void create()
              else if (recovering) void recover()
              else void unlock()
            }}
          >
            {recovering ? (
              <label className="ts-field">
                <span className="ts-field__label">{t('unlock.recoveryCode')}</span>
                <input
                  required
                  value={recoveryCode}
                  placeholder={t('unlock.recoveryPlaceholder')}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  data-testid="recovery-code-input"
                />
              </label>
            ) : null}

            <label className="ts-field">
              <span className="ts-field__label">
                {mode === 'create' || recovering ? t('unlock.newPassphrase') : t('unlock.passphrase')}
              </span>
              <input
                required
                type="password"
                autoFocus
                value={passphrase}
                placeholder={t('unlock.passphrasePlaceholder')}
                onChange={(event) => setPassphrase(event.target.value)}
                data-testid="passphrase-input"
              />
            </label>

            {mode === 'create' || recovering ? (
              <label className="ts-field">
                <span className="ts-field__label">{t('unlock.repeatPassphrase')}</span>
                <input
                  required
                  type="password"
                  value={repeat}
                  onChange={(event) => setRepeat(event.target.value)}
                  data-testid="passphrase-repeat"
                />
              </label>
            ) : null}

            {mode === 'unlock' ? (
              <label className="ts-vault__check">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                <span>{t('unlock.remember')}</span>
              </label>
            ) : null}

            {weakConfirmed ? (
              <p className="ts-unlock__warn" data-testid="weak-passphrase-warning">
                {t('unlock.weakTitle')} — {t('unlock.weakBody')}
              </p>
            ) : null}

            {localError !== null ? <p className="ts-unlock__error">{localError}</p> : null}
            {error !== null ? <p className="ts-unlock__error">{error}</p> : null}

            <div className="ts-unlock__row">
              {mode === 'unlock' ? (
                <button
                  type="button"
                  className="ts-link"
                  onClick={() => {
                    resetInputs()
                    setMode('recover')
                  }}
                >
                  {t('unlock.forgot')}
                </button>
              ) : (
                <button
                  type="button"
                  className="ts-link"
                  onClick={() => {
                    resetInputs()
                    setMode(status?.state === 'uninitialized' ? 'create' : 'unlock')
                  }}
                >
                  {t('unlock.backToUnlock')}
                </button>
              )}
              <span className="ts-vault__spacer" />
              <button
                type="submit"
                className="ts-btn ts-btn--primary"
                disabled={busy}
                data-testid={mode === 'create' ? 'create-vault' : recovering ? 'recover-vault' : 'unlock-vault'}
              >
                {busy
                  ? t('unlock.unlocking')
                  : mode === 'create'
                    ? t('unlock.createSubmit')
                    : recovering
                      ? t('unlock.recoverSubmit')
                      : t('unlock.submit')}
              </button>
            </div>
          </form>
        )}

        <footer className="ts-unlock__foot">
          <button type="button" className="ts-link" onClick={() => setPreviewLocked(true)} data-testid="preview-mode">
            {t('unlock.previewMode')}
          </button>
        </footer>
      </div>
    </div>
  )
}
