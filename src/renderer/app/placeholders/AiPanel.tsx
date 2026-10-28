import { useTranslation } from 'react-i18next'
import { Send, Sparkles } from 'lucide-react'

/**
 * 右侧 AI 面板（占位骨架）。
 *
 * 归属：ai 成员实现供应商配置、流式对话与命令建议；integration 替换本组件。
 * 不可协商的交互：AI 给出的命令**必须**先以「待确认」卡片呈现，用户点执行后才写入终端
 * （对应 shared 里 `AiCommandSuggestion.requiresConfirmation: true` 字面量类型）。
 */
export function AiPanel(): JSX.Element {
  const { t } = useTranslation(['ai', 'common'])

  return (
    <aside className="ts-ai-panel" data-testid="ai-panel" aria-label={t('ai:panel.title')}>
      <div className="ts-ai-panel__head">
        <Sparkles size={15} aria-hidden="true" />
        <span>{t('ai:panel.title')}</span>
      </div>

      <div className="ts-ai-panel__body">
        <div className="ts-empty ts-empty--compact">
          <Sparkles size={20} aria-hidden="true" />
          <p className="ts-empty__title">{t('ai:empty.title')}</p>
          <p className="ts-empty__body">{t('ai:empty.body')}</p>
        </div>
      </div>

      <div className="ts-ai-panel__composer">
        <textarea
          rows={2}
          placeholder={t('ai:input.placeholder')}
          aria-label={t('ai:input.placeholder')}
          disabled
        />
        <button type="button" className="ts-btn ts-btn--primary" disabled>
          <Send size={14} aria-hidden="true" />
          {t('ai:action.send')}
        </button>
      </div>
    </aside>
  )
}
