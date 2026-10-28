import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Lock } from 'lucide-react'
import { call, describeError, isNotImplemented } from '../../platform/ipc'
import { useShellStore } from '../store'
import { BrandMark } from './BrandMark'

/**
 * 解锁屏（加密包为锁定态时覆盖整个窗口）。
 *
 * 归属：vault-sync 实现 vault:unlock / vault:recover / vault:create；integration 替换本组件。
 *
 * 骨架期行为：真实通道还是 `E_NOT_IMPLEMENTED` 桩，所以点「解锁」会拿到该错误，
 * 这里据此显示「模块尚未接线」并提供**预览模式**入口（否则骨架期完全看不到主界面）。
 * 真实实现接入后，这个分支自然不再触发——不要把它当成产品逻辑保留。
 */
export function LockScreen(): JSX.Element {
  const { t } = useTranslation(['auth', 'common'])
  const setVault = useShellStore((state) => state.setVault)
  const setPreviewLocked = useShellStore((state) => state.setPreviewLocked)

  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [moduleMissing, setModuleMissing] = useState(false)

  async function unlock(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const status = await call('vault:unlock', { passphrase, rememberWithKeychain: false })
      setVault(status.state)
      if (status.state === 'unlocked') setPreviewLocked(false)
    } catch (err) {
      if (isNotImplemented(err)) setModuleMissing(true)
      else setError(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ts-lock" data-testid="lock-screen" role="dialog" aria-modal="true" aria-label={t('auth:lock.title')}>
      <form
        className="ts-lock__card"
        onSubmit={(event) => {
          event.preventDefault()
          void unlock()
        }}
      >
        <BrandMark size={44} />
        <h1 className="ts-lock__title">{t('auth:lock.title')}</h1>
        <p className="ts-lock__subtitle">{t('auth:lock.subtitle')}</p>

        <label className="ts-field">
          <span className="ts-field__label">{t('auth:lock.passphrase')}</span>
          <input
            type="password"
            autoFocus
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            placeholder={t('auth:lock.passphrasePlaceholder')}
            data-testid="unlock-passphrase"
          />
        </label>

        <button type="submit" className="ts-btn ts-btn--primary ts-btn--block" disabled={busy || passphrase.length === 0}>
          <KeyRound size={14} aria-hidden="true" />
          {busy ? t('auth:lock.unlocking') : t('common:action.unlock')}
        </button>

        {error ? (
          <p className="ts-lock__error" role="alert">
            {error}
          </p>
        ) : null}

        {moduleMissing ? (
          <div className="ts-lock__notice" role="status">
            <p>{t('errors:notImplemented')}</p>
            <button type="button" className="ts-btn ts-btn--ghost ts-btn--block" onClick={() => setPreviewLocked(false)}>
              <Lock size={14} aria-hidden="true" />
              {t('auth:lock.previewMode')}
            </button>
          </div>
        ) : null}

        <button type="button" className="ts-link" onClick={() => setError(t('auth:lock.recoveryHint'))}>
          {t('auth:lock.forgot')}
        </button>
      </form>
    </div>
  )
}
