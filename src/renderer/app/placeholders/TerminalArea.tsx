import { useTranslation } from 'react-i18next'
import { Terminal } from 'lucide-react'
import { useShellStore } from '../store'

/**
 * 主终端区（占位骨架）。
 *
 * 归属：terminal-ui 用 @xterm/xterm + fit/search/web-links addon 实现真实终端。
 * 注意事项已经踩过一次，写在这里免得重复踩：
 * - 容器必须有确定高度（flex:1 + min-height:0），否则 fit addon 算出来的 rows 是 1；
 * - xterm 实例**不要放在 React 状态里**，放 ref，否则每次渲染都可能重建 buffer；
 * - 主题色从 CSS 变量读取（`--ts-ansi-*`），不能在 TS 里硬编码色值。
 */
export function TerminalArea(): JSX.Element {
  const { t } = useTranslation(['terminal', 'common'])
  const tabs = useShellStore((state) => state.tabs)
  const activeTabId = useShellStore((state) => state.activeTabId)
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null

  return (
    <main className="ts-terminal" data-testid="terminal-area">
      {activeTab ? (
        <div className="ts-terminal__mounted" data-tab-id={activeTab.id}>
          <div className="ts-terminal__placeholder">
            <Terminal size={22} aria-hidden="true" />
            <p className="ts-empty__title">{activeTab.title}</p>
            <p className="ts-empty__body">{t('terminal:view.placeholder')}</p>
          </div>
        </div>
      ) : (
        <div className="ts-empty">
          <Terminal size={26} aria-hidden="true" />
          <p className="ts-empty__title">{t('terminal:empty.title')}</p>
          <p className="ts-empty__body">{t('terminal:empty.body')}</p>
        </div>
      )}
    </main>
  )
}
