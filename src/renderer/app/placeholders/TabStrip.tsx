import { useTranslation } from 'react-i18next'
import { Plus, Sparkles, X } from 'lucide-react'
import { useShellStore } from '../store'

/**
 * 顶部页签条（占位骨架）。
 *
 * 归属：terminal-ui 提供多页签 + 分屏 + 会话绑定，integration 负责替换。
 * 这里只固化两件事：① 页签条兼作 macOS 标题栏拖拽区（`-webkit-app-region: drag`），
 * ② 关闭按钮/加号必须 `no-drag`，否则点不动。
 */
export function TabStrip(): JSX.Element {
  const { t } = useTranslation(['terminal', 'common'])
  const tabs = useShellStore((state) => state.tabs)
  const activeTabId = useShellStore((state) => state.activeTabId)
  const activateTab = useShellStore((state) => state.activateTab)
  const closeTab = useShellStore((state) => state.closeTab)
  const openTab = useShellStore((state) => state.openTab)
  const toggleAiPanel = useShellStore((state) => state.toggleAiPanel)

  return (
    <header className="ts-tabstrip" data-testid="tab-strip">
      <div className="ts-tabstrip__tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            className={`ts-tab${tab.id === activeTabId ? ' ts-tab--active' : ''}`}
            onClick={() => activateTab(tab.id)}
          >
            <span className={`ts-tab__dot ts-tab__dot--${tab.status}`} aria-hidden="true" />
            <span className="ts-tab__title">{tab.title}</span>
            <button
              type="button"
              className="ts-tab__close"
              aria-label={t('common:action.closeTab')}
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>

      <div className="ts-tabstrip__tools">
        <button
          type="button"
          className="ts-icon-btn"
          onClick={() => openTab()}
          title={t('terminal:tab.new')}
          aria-label={t('terminal:tab.new')}
          data-testid="tab-new"
        >
          <Plus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="ts-icon-btn"
          onClick={toggleAiPanel}
          title={t('ai:panel.title')}
          aria-label={t('ai:panel.title')}
          data-testid="toggle-ai"
        >
          <Sparkles size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
