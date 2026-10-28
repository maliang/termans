import { useTranslation } from 'react-i18next'
import { findTab, useTabStore } from '../tabs/tab-store'
import { useSessionStore } from './session-store'
import { useTerminalUi } from './runtime-context'

/**
 * 终端工具栏：搜索、清屏、复制全部、粘贴、字号缩放，以及当前会话的尺寸/渲染器。
 *
 * 「复制全部」和「清屏」都只作用于**激活页签**：终端里的这些动作天然是针对当前窗口的，
 * 提供「对第 3 个页签清屏」这种入口只会让用户误伤后台会话。
 */

export function TerminalToolbar() {
  const { t } = useTranslation()
  const ui = useTerminalUi()
  const activeTabId = useTabStore((state) => state.activeTabId)
  const activeTab = useTabStore((state) => findTab(state.tabs, state.activeTabId))
  const view = useSessionStore((state) => (activeTabId ? state.byTab[activeTabId] : undefined))
  const disabled = !activeTabId

  const statusText = activeTab
    ? [
        activeTab.hostLabel ?? t('terminal:tab.local', { defaultValue: '本地' }),
        view ? `${view.cols}×${view.rows}` : null,
        view ? view.renderer.toUpperCase() : null,
        view ? t(`terminal:tab.status.${view.phase}`, { defaultValue: view.phase }) : null
      ]
        .filter(Boolean)
        .join(' · ')
    : t('terminal:empty.title', { defaultValue: '没有打开的终端' })

  return (
    <div className="ts-term-toolbar" data-testid="term-toolbar">
      <div className="ts-term-toolbar__group">
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-search-toggle"
          title={t('terminal:toolbar.find', { defaultValue: '在终端中查找 (⌘F)' })}
          disabled={disabled}
          onClick={() => ui.openSearch()}
        >
          ⌕
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-clear"
          title={t('terminal:toolbar.clear', { defaultValue: '清屏 (⌘K)' })}
          disabled={disabled}
          onClick={() => ui.clearActive()}
        >
          ⌫
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-copy-all"
          title={t('terminal:toolbar.copyAll', { defaultValue: '复制全部输出 (⌘⇧C)' })}
          disabled={disabled}
          onClick={() => void ui.copyAllActive()}
        >
          ⧉
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-paste"
          title={t('terminal:toolbar.paste', { defaultValue: '粘贴 (⌘⇧V)' })}
          disabled={disabled}
          onClick={() => {
            if (activeTabId) void ui.requestPaste(activeTabId)
          }}
        >
          ⌘V
        </button>
      </div>

      <div className="ts-term-toolbar__status" data-testid="term-status" title={statusText}>
        {statusText}
      </div>

      <div className="ts-term-toolbar__group">
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-zoom-out"
          title={t('terminal:toolbar.zoomOut', { defaultValue: '缩小字号 (⌘-)' })}
          disabled={disabled}
          onClick={() => ui.zoom(-1)}
        >
          A−
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-zoom-reset"
          title={t('terminal:toolbar.zoomReset', { defaultValue: '恢复默认字号 (⌘0)' })}
          disabled={disabled}
          onClick={() => ui.zoom(0)}
        >
          A
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-zoom-in"
          title={t('terminal:toolbar.zoomIn', { defaultValue: '放大字号 (⌘+)' })}
          disabled={disabled}
          onClick={() => ui.zoom(1)}
        >
          A+
        </button>
      </div>
    </div>
  )
}
