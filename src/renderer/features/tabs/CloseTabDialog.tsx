import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TerminalTab } from './tab-store'

/**
 * 关闭「还连着」的页签时的二次确认。
 *
 * 样式用风格底座的 `.ts-dialog*`（与设置页同一个弹窗语汇），不自己再写一套：
 * `base.css` 里的 `.ts-confirm` 是**行内**确认条（危险动作的小红框），不是模态框，
 * 早先我把它当模态框用过，两套同名规则叠在一起会在视口四周描出红边（已改掉）。
 *
 * 位置：**portal 到 document.body**，而不是留在页签条内部。页签条整块是
 * `-webkit-app-region: drag`（标题栏可拖动），留在里面的弹窗会落进拖拽区：真机上按钮
 * 点了没反应（事件被窗口服务器当拖窗口吃掉），而 Playwright 的合成点击绕过 app-region，
 * e2e 一直绿。portal 出去 + `.ts-dialog` 自带 `no-drag`，双层兜住这类「只在真机上坏」的问题。
 * 页签条依旧不依赖 app 的门户组件：portal 的目标就是 document.body。
 */

export interface CloseTabDialogProps {
  tab: TerminalTab
  onConfirm: () => void
  onCancel: () => void
}

export function CloseTabDialog({ tab, onConfirm, onCancel }: CloseTabDialogProps): JSX.Element {
  const { t } = useTranslation()
  /*
   * 页签标题正好等于主机名时（单主机一个页签是最常见的情形），
   * 通用正文会渲染成「「web-prod-01」在 web-prod-01 上仍有活动会话」——自己重复自己。
   * t36 起用另一条 key（只有一个 {{title}} 占位）说同一件事。
   */
  const sameHost = tab.hostLabel !== null && tab.hostLabel === tab.title
  const dialog = (
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
            * 参数名必须和 locale 里的占位符一一对上。传错名字不会抛错，界面上会直接显示
            * “{{title}}” 原文——截图里抓到过一次。所以两条 key 都写成**字面量调用**
            * （契约测试只扫字面量），各自的占位符也各自传：
            *   body           {{title}} + {{host}}
            *   bodySameHost   只有 {{title}}
            */}
          <p className="ts-dialog__text">
            {sameHost
              ? t('terminal:tab.confirmClose.bodySameHost', {
                  title: tab.title,
                  defaultValue: '“{{title}}” still has an active session. Closing the tab ends it.'
                })
              : t('terminal:tab.confirmClose.body', {
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
  // 单测里可能没有 document（node 环境），退回直接渲染，避免为了一个 portal 让组件不可测。
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}
