import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Lock, KeyRound, X } from 'lucide-react'
import * as api from './api'
import { downloadTextFile } from './download'
import { useVaultErrorText, useVaultStore } from './store'

interface VaultSecurityPanelProps {
  /** 弹窗模式下关闭；内嵌到设置页签时不需要 */
  onClose?: () => void
  /** true = 只出内容（不渲染遮罩层/标题/取消按钮），供设置弹窗内嵌 */
  embedded?: boolean
}

/**
 * 安全面板：轮换口令 / 重新生成恢复码（需重新验证当前口令）/ 立即锁定。
 *
 * 为什么「重新生成恢复码」用 `vault:rotate`：IPC 通道在 P0 已冻结（不能新增通道），
 * 而 `vault:rotate({currentPassphrase, newPassphrase: currentPassphrase})` 的语义是
 * 「重验证当前口令 → 换新盐 → 生成新恢复码 → revision+1 的一次提交」。
 * 注意它的副作用（不是纯读操作）：**仓库会前进一次 revision，远端需要重新 push**，
 * 因此按钮文案写「重新生成」而不是「查看/导出」，并加一步显式确认。
 */
export function VaultSecurityPanel({ onClose, embedded = false }: VaultSecurityPanelProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const busy = useVaultStore((state) => state.busy)
  const run = useVaultStore((state) => state.run)
  const applyStatus = useVaultStore((state) => state.applyStatus)
  const error = useVaultErrorText()

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null)
  const [confirmExport, setConfirmExport] = useState(false)

  async function rotate(keepSame: boolean): Promise<void> {
    const result = await run(() => api.rotateVault(current, keepSame ? current : next))
    if (result !== null) {
      setRecoveryCode(result.recoveryCode)
      applyStatus(result.status)
      setCurrent('')
      setNext('')
      setConfirmExport(false)
    }
  }

  async function lock(): Promise<void> {
    const status = await run(() => api.lockVault())
    if (status !== null) {
      applyStatus(status)
      onClose?.()
    }
  }

  const content = (
    <>

        <label className="ts-field">
          <span className="ts-field__label">{t('security.current')}</span>
          <input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} data-testid="rotate-current" />
        </label>
        <label className="ts-field">
          <span className="ts-field__label">{t('security.new')}</span>
          <input type="password" value={next} onChange={(event) => setNext(event.target.value)} data-testid="rotate-new" />
        </label>

        <div className="ts-vault__row">
          <button
            type="button"
            className="ts-btn ts-btn--primary"
            disabled={busy || current.length === 0 || next.length === 0}
            onClick={() => void rotate(false)}
            data-testid="rotate-submit"
          >
            {t('security.rotateSubmit')}
          </button>
          <button
            type="button"
            className="ts-btn"
            disabled={busy || current.length === 0}
            onClick={() => setConfirmExport(true)}
            data-testid="export-recovery-code"
          >
            <Download size={14} aria-hidden="true" /> {t('security.exportCode')}
          </button>
        </div>

        <p className="ts-vault__hint">{t('security.note')}</p>

        {confirmExport ? (
          <div className="ts-vault__warn" data-testid="export-recovery-confirm">
            <p>{t('security.exportConfirm')}</p>
            <div className="ts-vault__row">
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                disabled={busy || current.length === 0}
                onClick={() => void rotate(true)}
                data-testid="export-recovery-confirm-yes"
              >
                {t('security.exportConfirmYes')}
              </button>
              <button
                type="button"
                className="ts-btn ts-btn--ghost"
                onClick={() => setConfirmExport(false)}
                data-testid="export-recovery-confirm-no"
              >
                {t('security.exportConfirmNo')}
              </button>
            </div>
          </div>
        ) : null}

        {recoveryCode !== null ? (
          <div className="ts-vault__recovery" data-testid="recovery-code">
            <p className="ts-vault__ok">{t('security.rotated')}</p>
            <code className="ts-vault__code">{recoveryCode}</code>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              onClick={() => downloadTextFile('termans-recovery-code.txt', recoveryCode)}
            >
              <Download size={14} aria-hidden="true" /> {t('unlock.recoveryDownload')}
            </button>
          </div>
        ) : null}

        <div className="ts-vault__actions">
          <button type="button" className="ts-btn ts-btn--ghost" onClick={() => void lock()} disabled={busy}>
            <Lock size={14} aria-hidden="true" /> {t('security.lock')}
          </button>
          <span className="ts-vault__spacer" />
          {embedded ? null : (
            <button type="button" className="ts-btn ts-btn--ghost" onClick={() => onClose?.()}>
              {t('editor.cancel')}
            </button>
          )}
        </div>

        {error !== null ? <p className="ts-vault__error">{error}</p> : null}

    </>
  )

  // 内嵌模式：设置弹窗自己有标题与关闭按钮，这里只出内容（避免两层遮罩 + 两个「取消」）
  if (embedded) {
    return (
      <section className="ts-vault__card ts-vault__card--embedded" data-testid="vault-security-panel">
        {content}
      </section>
    )
  }

  // 独立弹窗形态：走 kit 的 .ts-dialog 外壳（与设置 / 主机编辑器同一套底座）
  return (
    <div className="ts-dialog" data-testid="security-dialog">
      <section
        className="ts-dialog__panel ts-dialog__panel--sm"
        role="dialog"
        aria-modal="true"
        aria-label={t('security.title')}
        data-testid="vault-security-panel"
      >
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title">
            <KeyRound size={15} aria-hidden="true" /> {t('security.title')}
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
