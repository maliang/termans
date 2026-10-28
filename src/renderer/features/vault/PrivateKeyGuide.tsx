import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound, Upload } from 'lucide-react'
import * as api from './api'
import type { HostView } from './api'
import { useVaultErrorText, useVaultStore } from './store'

interface PrivateKeyGuideProps {
  host: HostView
  onImported: () => void
  onSwitchToPassword: () => void
}

/**
 * 私钥引导：B 机同步下来只有 IdentityFile 路径，本机没有对应私钥时必须**明确报错并给三个入口**
 * （导入文件 / 粘贴私钥 / 改用密码），而不是让连接以「Permission denied (publickey)」结束。
 *
 * 归位方式：`ssh:connect` 失败时（t2 抛 `E_SSH` + `details.reason==='private-key-missing'`）
 * 由 t7 打开本组件；主机编辑器里也直接可用来提前导入。
 */
export function PrivateKeyGuide({ host, onImported, onSwitchToPassword }: PrivateKeyGuideProps): JSX.Element {
  const { t } = useTranslation('vaultsync')
  const busy = useVaultStore((state) => state.busy)
  const notice = useVaultStore((state) => state.notice)
  const run = useVaultStore((state) => state.run)
  const error = useVaultErrorText()
  const [pasted, setPasted] = useState('')
  const [showPaste, setShowPaste] = useState(false)

  async function importText(content: string): Promise<void> {
    if (content.trim().length === 0) return
    await run(async () => {
      await api.importPrivateKey(host.id, content)
      onImported()
    })
  }

  async function onFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    await importText(await file.text())
  }

  return (
    <section className="ts-vault__guide" data-testid="private-key-guide">
      <header className="ts-vault__guide-head">
        <KeyRound size={15} aria-hidden="true" />
        <strong>{t('key.title')}</strong>
      </header>
      <p className="ts-vault__hint">{t('key.body', { label: host.label })}</p>
      {host.privateKeyPath !== null ? (
        <p className="ts-vault__mono">
          {t('key.path')}: {host.privateKeyPath}
        </p>
      ) : null}

      <div className="ts-vault__row">
        <label className="ts-btn ts-btn--ghost">
          <Upload size={14} aria-hidden="true" />
          {t('key.import')}
          <input type="file" accept=".pem,.key,.ppk,text/plain" hidden onChange={(event) => void onFile(event)} />
        </label>
        <button type="button" className="ts-btn ts-btn--ghost" onClick={() => setShowPaste((value) => !value)}>
          {t('key.paste')}
        </button>
        <button type="button" className="ts-btn ts-btn--ghost" onClick={onSwitchToPassword}>
          {t('key.usePassword')}
        </button>
      </div>

      {showPaste ? (
        <div className="ts-vault__paste">
          <textarea
            rows={5}
            value={pasted}
            placeholder={t('key.pastePlaceholder')}
            onChange={(event) => setPasted(event.target.value)}
            data-testid="private-key-paste"
          />
          <button
            type="button"
            className="ts-btn ts-btn--primary"
            disabled={busy || pasted.trim().length === 0}
            onClick={() => void importText(pasted)}
          >
            {t('key.usePaste')}
          </button>
        </div>
      ) : null}

      {notice !== null ? <p className="ts-vault__ok">{notice}</p> : null}
      {error !== null ? <p className="ts-vault__error">{error}</p> : null}
    </section>
  )
}
