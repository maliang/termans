import { useTranslation } from 'react-i18next'
import type { TerminalTab } from './tab-store'

/**
 * 关闭「还连着」的页签时的二次确认。
 *
 * 样式用风格底座的 `.ts-dialog*`（与设置页同一个弹窗语汇），不自己再写一套：
 * `base.css` 里的 `.ts-confirm` 是**行内**确认条（危险动作的小红框），不是模态框，
 * 早先我把它当模态框用过，两套同名规则叠在一起会在视口四周描出红边（已改掉）。
 *
 * 位置：页签条内部直接渲染，不依赖 app 的门户组件——页签条要能独立接进任何布局。
 */

export interface CloseTabDialogProps {
  tab: TerminalTab
  onConfirm: () => void
  onCancel: () => void
}

export function CloseTabDialog({ tab, onConfirm, onCancel }: CloseTabDialogProps): JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="ts-dialog ts-tab-modal" role="presentation" onMouseDown={onCancel}>
      <div
        className="ts-dialog__panel ts-dialog__panel--sm"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('terminal:tab.confirmClose.title', { defaultValue: 'Close this tab?' })}
        data-testid="close-tab-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title">
            {t('terminal:tab.confirmClose.title', { defaultValue: 'Close this tab?' })}
          </h2>
        </header>

        <div className="ts-dialog__body">
          {/*
            * 参数名必须和 locale 里的占位符一一对上（en/zh 都是 {{title}} + {{host}}）。
            * 传错名字不会抛错，界面上会直接显示 “{{title}}” 原文——截图里抓到过一次。
            */}
          <p className="ts-dialog__text">
            {t('terminal:tab.confirmClose.body', {
              title: tab.title,
              host: tab.hostLabel ?? tab.title,
              defaultValue:
                '“{{title}}” on {{host}} still has an active session. Closing the tab ends it.'
            })}
          </p>
        </div>

        <footer className="ts-dialog__footer">
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
        </footer>
      </div>
    </div>
  )
}
