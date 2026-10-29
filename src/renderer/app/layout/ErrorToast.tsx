import { useTranslation } from 'react-i18next'

/**
 * 外壳级错误条（替换骨架期那个只显示原始字符串的 toast）。
 *
 * 为什么要翻译一层：`IpcCallError` 的 message 形如 `[E_VAULT_LOCKED] 加密包未解锁`，
 * 直接把英文堆栈丢给用户既看不懂也不好截图报 bug。这里按 **错误码** 选词条，
 * 认不出来的码保留原文（排障时原文比「出错了」有用得多）。
 */
const CODE_PATTERN = /\[([A-Z][A-Z_]+)\]/

export function ErrorToast({ message }: { message: string }): JSX.Element {
  const { t } = useTranslation(['errors'])
  const code = CODE_PATTERN.exec(message)?.[1]

  if (code === 'E_NOT_IMPLEMENTED') {
    return (
      <div className="ts-toast" role="alert" data-testid="error-toast">
        {t('errors:notImplemented')}
      </div>
    )
  }
  if (code === 'E_VAULT_LOCKED') {
    return (
      <div className="ts-toast" role="alert" data-testid="error-toast">
        {t('errors:vaultLocked')}
      </div>
    )
  }

  return (
    <div className="ts-toast" role="alert" data-testid="error-toast">
      <span>{t('errors:generic')}</span>
      <span className="ts-toast__detail">{message}</span>
    </div>
  )
}
