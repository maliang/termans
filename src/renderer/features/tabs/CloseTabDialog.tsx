import { useTranslation } from 'react-i18next'
import type { TerminalTab } from './tab-store'

/**
 * 关闭「还连着」的页签时的二次确认。
 *
 * 位置：页签条内部（`position: absolute` 的遮罩），而不是 app 级 dialog 容器——
 * 页签条自己要能独立接进任何布局，不该反向依赖 app 的门户组件。
 */

export interface CloseTabDialogProps {
  tab: TerminalTab
  onConfirm: () => void
  onCancel: () => void
}

export function CloseTabDialog({ tab, onConfirm, onCancel }: CloseTabDialogProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="ts-confirm" role="presentation" onMouseDown={onCancel}>
      <div
        className="ts-confirm__panel"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('terminal:tab.confirmClose.title', { defaultValue: 'Close this tab?' })}
        data-testid="close-tab-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 className="ts-confirm__title">
          {t('terminal:tab.confirmClose.title', { defaultValue: 'Close this tab?' })}
        </h2>
        <p className="ts-confirm__body">
          {/*
            * 参数名必须和 locale 里的占位符一一对上（en/zh 都是 {{title}} + {{host}}）。
            * 传错名字不会抛错，界面上会直接显示 “{{title}}” 原文——截图里抓到过一次。
            */}
          {t('terminal:tab.confirmClose.body', {
            title: tab.title,
            host: tab.hostLabel ?? tab.title,
            defaultValue:
              '“{{title}}” on {{host}} still has an active session. Closing the tab ends it.'
          })}
        </p>
        <div className="ts-confirm__actions">
          <button type="button" className="ts-btn" data-testid="close-tab-cancel" onClick={onCancel}>
            {t('common:action.cancel', { defaultValue: 'Cancel' })}
          </button>
          <button
            type="button"
            className="ts-btn ts-btn--danger"
            data-testid="close-tab-confirm"
            autoFocus
            onClick={onConfirm}
          >
            {t('terminal:tab.confirmClose.confirm', { defaultValue: 'Disconnect & close' })}
          </button>
        </div>
      </div>
    </div>
  )
}
