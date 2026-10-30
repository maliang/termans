import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/reasoning'

/**
 * A1：全局默认思考强度（三档分段控件）。
 *
 * 这是**全页唯一可编辑**的思考强度入口（AC-8）。供应商卡片里只放一行只读的
 * 「跟随全局 · 高 [去顶部修改]」，卡片内不再摆第二个可编辑控件 —— 两处都能改，
 * 用户永远说不清「我改的是哪一层」。
 *
 * `support` 由调用方用 `resolveReasoningMode()` 算好传进来（本组件**不做**协议判断）：
 * 映射表只有 `src/shared/reasoning.ts` 一份，UI 再写一次 `kind === 'ollama'` 就会出现
 * 两套判定漂移（AC-9 的单点性）。
 *
 * 不支持的时候控件**仍然可见、仍然可切**（AC-11）：档位是全局设置，换个供应商就生效了，
 * 置灰会让人误以为这个设置坏了。只在下方追加一行「已忽略」的说明。
 */

export interface ReasoningEffortControlProps {
  value: ReasoningEffort
  disabled?: boolean
  onChange: (level: ReasoningEffort) => void
  /** null = 还没有默认供应商；providerName 用于「已忽略」文案 */
  support: { providerName: string; supported: boolean } | null
}

export function ReasoningEffortControl({
  value,
  disabled = false,
  onChange,
  support
}: ReasoningEffortControlProps): JSX.Element {
  const { t } = useTranslation(['settings'])

  return (
    <div className="ts-ai-effort" data-testid="ai-reasoning-effort-global">
      <div className="ts-ai-effort__head">
        <span className="ts-ai-effort__label">{t('settings:ai.reasoningEffort.label')}</span>
        <div className="ts-ai-effort__seg" role="radiogroup" aria-label={t('settings:ai.reasoningEffort.label')}>
          {REASONING_EFFORTS.map((level) => {
            const checked = value === level
            return (
              <label
                key={level}
                className={checked ? 'ts-ai-effort__item is-checked' : 'ts-ai-effort__item'}
              >
                <input
                  type="radio"
                  name="ts-ai-reasoning-effort"
                  value={level}
                  data-testid={`ai-reasoning-effort-${level}`}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onChange(level)}
                />
                <span>{t(`settings:ai.reasoningEffort.${level}`)}</span>
              </label>
            )
          })}
        </div>
      </div>

      <p className="ts-ai-effort__caption">{t(`settings:ai.reasoningEffort.caption.${value}`)}</p>

      {support === null ? (
        <p className="ts-ai-effort__caption is-muted" data-testid="ai-reasoning-effort-no-default">
          {t('settings:ai.reasoningEffort.noDefault')}
        </p>
      ) : support.supported ? null : (
        <p className="ts-ai-effort__warning" data-testid="ai-reasoning-effort-unsupported">
          <AlertTriangle size={12} aria-hidden="true" />
          {t('settings:ai.reasoningEffort.unsupported', { provider: support.providerName })}
        </p>
      )}
    </div>
  )
}
