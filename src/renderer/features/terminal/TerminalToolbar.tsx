import { useTranslation } from 'react-i18next'
import { ClipboardPaste, Copy, Eraser, Search } from 'lucide-react'
import { useTabStore } from '../tabs/tab-store'
import { useTerminalUi } from './runtime-context'

/**
 * 终端工具条：**只放动作**（查找 / 清屏 / 复制全部 / 粘贴，右侧字号缩放）。
 *
 * 审计 #2 的两条整改：
 * 1. 原来四个纯字形按钮（⌕ ⌫ ⧉ ⌘V）没有任何线索，用户只能一个个点开试——
 *    现在换成 lucide 图标 + `title` + `aria-label`（title 给鼠标，aria-label 给读屏和 e2e）；
 * 2. 中间那串「host · 131×40 · DOM · 已连接」挪去了状态栏（`SessionStatus`）：
 *    它是**状态**不是动作，放在工具条里既挤占页签空间，又让人以为能点。
 *
 * 「复制全部」和「清屏」都只作用于**激活页签**：终端里的这些动作天然针对当前窗口，
 * 提供「对第 3 个页签清屏」这种入口只会让用户误伤后台会话。
 */

export function TerminalToolbar() {
  const { t } = useTranslation()
  const ui = useTerminalUi()
  const activeTabId = useTabStore((state) => state.activeTabId)
  const disabled = !activeTabId

  const actions = [
    {
      testId: 'term-search-toggle',
      label: t('terminal:toolbar.search', { defaultValue: 'Find in terminal' }),
      hint: t('terminal:toolbar.find', { defaultValue: 'Find in terminal (⌘F)' }),
      icon: <Search size={14} aria-hidden="true" />,
      run: () => ui.openSearch()
    },
    {
      testId: 'term-clear',
      label: t('terminal:toolbar.clear', { defaultValue: 'Clear screen' }),
      hint: t('terminal:toolbar.clear', { defaultValue: 'Clear screen' }) + ' (⌘K)',
      icon: <Eraser size={14} aria-hidden="true" />,
      run: () => ui.clearActive()
    },
    {
      testId: 'term-copy-all',
      label: t('terminal:toolbar.copyAll', { defaultValue: 'Copy all output' }),
      hint: t('terminal:toolbar.copyAll', { defaultValue: 'Copy all output' }) + ' (⌘⇧C)',
      icon: <Copy size={14} aria-hidden="true" />,
      run: () => void ui.copyAllActive()
    },
    {
      testId: 'term-paste',
      label: t('terminal:toolbar.paste', { defaultValue: 'Paste' }),
      hint: t('terminal:toolbar.paste', { defaultValue: 'Paste' }) + ' (⌘⇧V)',
      icon: <ClipboardPaste size={14} aria-hidden="true" />,
      run: () => {
        if (activeTabId) void ui.requestPaste(activeTabId)
      }
    }
  ]

  return (
    <div className="ts-term-toolbar" data-testid="term-toolbar">
      <div className="ts-term-toolbar__group">
        {actions.map((action) => (
          <button
            key={action.testId}
            type="button"
            className="ts-icon-btn"
            data-testid={action.testId}
            title={action.hint}
            aria-label={action.label}
            disabled={disabled}
            onClick={action.run}
          >
            {action.icon}
          </button>
        ))}
      </div>

      {/* 动作与「缩放」不是一类操作，用 1px 分隔线隔开（审计 #2 要求的层次） */}
      <span className="ts-term-toolbar__divider" role="presentation" aria-hidden="true" />

      <div className="ts-term-toolbar__group">
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-zoom-out"
          title={t('terminal:toolbar.zoomOut', { defaultValue: 'Zoom out' })}
          aria-label={t('terminal:toolbar.zoomOut', { defaultValue: 'Zoom out' })}
          disabled={disabled}
          onClick={() => ui.zoom(-1)}
        >
          A−
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-zoom-reset"
          title={t('terminal:toolbar.zoomReset', { defaultValue: 'Reset zoom' })}
          aria-label={t('terminal:toolbar.zoomReset', { defaultValue: 'Reset zoom' })}
          disabled={disabled}
          onClick={() => ui.zoom(0)}
        >
          A
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          data-testid="term-zoom-in"
          title={t('terminal:toolbar.zoomIn', { defaultValue: 'Zoom in' })}
          aria-label={t('terminal:toolbar.zoomIn', { defaultValue: 'Zoom in' })}
          disabled={disabled}
          onClick={() => ui.zoom(1)}
        >
          A+
        </button>
      </div>
    </div>
  )
}
