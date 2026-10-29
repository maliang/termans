import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HostKeyChallenge } from '@shared'
import { call, describeError, subscribe } from '../../platform/ipc'
import { useShellStore } from '../store'

/**
 * 首次连接时的主机密钥确认（t7 接线）。
 *
 * 为什么必须由接线层提供：主进程的引擎在 `host-key-verification` 阶段会推
 * `ssh:host-key-challenge` 并**阻塞等待** `ssh:answer-host-key`（默认 120s 超时），
 * 而 `features/terminal` 只把该阶段映射成「connecting」状态点，没有任何 UI 去回答它
 * ——没有这个弹窗，连一台新主机会静默卡住两分钟，然后连接失败。
 *
 * 安全语义（与 SPEC 的 known_hosts 判据一致）：
 * - `reason: 'unknown'`：首次见这台主机，让你核对指纹；
 * - `reason: 'mismatch'`：指纹**变了**，用红色告警展示新旧指纹，默认**不记住**；
 * - 「记住」写入的是**加密包里的** known_hosts（`src/main/ipc/bridges.ts` 把网关接到 vault），
 *   不是明文 JSON。
 */
export function HostKeyPrompt(): JSX.Element | null {
  const { t } = useTranslation(['terminal', 'common'])
  const setLastError = useShellStore((state) => state.setLastError)
  const [challenge, setChallenge] = useState<HostKeyChallenge | null>(null)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    return subscribe('ssh:host-key-challenge', (payload: HostKeyChallenge) => {
      setChallenge(payload)
      // 指纹变化时默认**不**自动记住：用户得显式勾选才覆盖旧指纹
      setRemember(payload.reason !== 'mismatch')
      setBusy(false)
    })
  }, [])

  if (!challenge) return null

  const mismatch = challenge.reason === 'mismatch'

  async function answer(decision: 'accept' | 'reject'): Promise<void> {
    if (!challenge) return
    setBusy(true)
    try {
      await call('ssh:answer-host-key', { sessionId: challenge.sessionId, decision, remember })
      setChallenge(null)
    } catch (error) {
      setLastError(describeError(error))
      setBusy(false)
    }
  }

  return (
    <div className="ts-dialog" role="presentation" data-testid="host-key-dialog">
      <div className="ts-dialog__panel" role="dialog" aria-modal="true" aria-label={t('terminal:hostKey.title')}>
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title">{t('terminal:hostKey.title')}</h2>
        </header>
        <div className="ts-dialog__body">
          <p className={mismatch ? 'ts-statusbar__item--error' : undefined}>
            {mismatch ? t('terminal:hostKey.reason.mismatch') : t('terminal:hostKey.reason.unknown')}
          </p>
          <dl className="ts-field">
            <dt>{t('terminal:hostKey.host')}</dt>
            <dd>
              {challenge.host}:{challenge.port}
            </dd>
            <dt>{t('terminal:hostKey.keyType')}</dt>
            <dd>{challenge.keyType}</dd>
            <dt>{t('terminal:hostKey.fingerprint')}</dt>
            <dd data-testid="host-key-fingerprint">{challenge.fingerprintSha256}</dd>
            {challenge.previousFingerprintSha256 ? (
              <>
                <dt>{t('terminal:hostKey.previous')}</dt>
                <dd>{challenge.previousFingerprintSha256}</dd>
              </>
            ) : null}
          </dl>
          <label className="ts-vault__check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              data-testid="host-key-remember"
            />
            <span>{t('terminal:hostKey.remember')}</span>
          </label>
        </div>
        <footer className="ts-dialog__footer">
          <button
            type="button"
            className="ts-btn ts-btn--ghost"
            onClick={() => void answer('reject')}
            disabled={busy}
            data-testid="host-key-reject"
          >
            {t('terminal:hostKey.reject')}
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--primary"
            onClick={() => void answer('accept')}
            disabled={busy}
            data-testid="host-key-accept"
          >
            {busy ? t('terminal:hostKey.busy') : t('terminal:hostKey.accept')}
          </button>
        </footer>
      </div>
    </div>
  )
}
