import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { VaultVariantNotice } from '@shared'
import { useVaultStore } from '../vault/store'

const VARIANT_KEYS: Record<VaultVariantNotice['variant'], string> = {
  nfkc: 'unlock.variant.name.nfkc',
  trim: 'unlock.variant.name.trim',
  'strip-zero-width': 'unlock.variant.name.stripZeroWidth'
}

/**
 * AC-7 的一次性告知条：口令命中了「受控输入变体」（全角/首尾空格/零宽字符），
 * 主进程已用规范形重封了口令槽。
 *
 * 位置：标题栏之下、主内容之上的**普通流式元素**（不是 toast / fixed）——
 * 命中那一刻已经解锁、解锁卡早已卸载，所以它挂在 `.ts-workspace` 里而不是解锁卡内。
 * 关闭是手动的（不自动消失）：用户要能回头看一眼「刚才是哪种变体命中了」。
 */
export function VaultNoticeBar(): JSX.Element | null {
  const { t } = useTranslation('vaultsync')
  const notice = useVaultStore((state) => state.variantNotice)
  const dismissedAt = useVaultStore((state) => state.variantNoticeDismissedAt)
  const dismiss = useVaultStore((state) => state.dismissVariantNotice)

  if (notice === null || notice.at === dismissedAt) return null

  const variantName = t(VARIANT_KEYS[notice.variant], { defaultValue: notice.variant })
  const text = t('unlock.variant.hit', { variant: variantName })

  return (
    <div className="ts-vault-notice" data-testid="variant-notice" role="status">
      <span className="ts-vault-notice__text" title={text}>
        {text}
      </span>
      <button
        type="button"
        className="ts-vault-notice__close"
        data-testid="variant-notice-dismiss"
        aria-label={t('unlock.variant.dismiss')}
        title={t('unlock.variant.dismiss')}
        onClick={dismiss}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}
