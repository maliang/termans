import { useTranslation } from 'react-i18next'
import { SettingsButton } from '@renderer/theme/SettingsDialogHost'
import { useTabStore } from '@renderer/features/tabs/tab-store'
import { useVaultStore } from '@renderer/features/vault'
import { useShellStore } from '../store'

/**
 * 底部状态条（真实现，替换骨架期的同名占位组件）。
 *
 * 保留它的理由没变：骨架期它是「主进程到底通没通」的窗口；集成后它仍然是唯一一处
 * 把版本、加密包状态、同步状态、页签数、最近错误摆在一行的地方——**错误可见性比好看重要**。
 *
 * 数据来源按模块归属分开取，不在外壳里复制业务状态：
 * - 版本/平台/加密包状态/最近错误：`useShellStore`（`vault:state-changed` → vault store → shell store）
 * - 页签数：`useTabStore`（页签的真相在 tabs feature）
 * - 同步状态：`useVaultStore.syncStatus`（sync:status-changed 已由 initializeVaultFeature 订阅）
 */
export function StatusBar(): JSX.Element {
  const { t } = useTranslation(['common', 'sync', 'ai'])
  const appInfo = useShellStore((state) => state.appInfo)
  const vault = useShellStore((state) => state.vault)
  const lastError = useShellStore((state) => state.lastError)
  const aiPanelVisible = useShellStore((state) => state.aiPanelVisible)
  const toggleAiPanel = useShellStore((state) => state.toggleAiPanel)
  const tabCount = useTabStore((state) => state.tabs.length)
  const syncState = useVaultStore((state) => state.syncStatus?.state ?? null)

  return (
    <footer className="ts-statusbar" data-testid="status-bar">
      <span className="ts-statusbar__item">
        {appInfo ? `Termans ${appInfo.version}` : t('common:state.loading')}
      </span>
      <span className="ts-statusbar__item">{appInfo ? `${appInfo.platform}/${appInfo.arch}` : '—'}</span>
      <span className="ts-statusbar__item" data-testid="status-vault">
        {t('common:state.vault', { state: vault })}
      </span>
      <span className="ts-statusbar__item" data-testid="status-sync">
        {t(`sync:status.${syncState ?? 'off'}`, { defaultValue: syncState ?? 'off' })}
      </span>
      <span className="ts-statusbar__item">{t('common:state.tabs', { count: tabCount })}</span>
      <span className="ts-statusbar__spacer" />
      <button
        type="button"
        className="ts-icon-btn"
        data-testid="status-toggle-ai"
        aria-pressed={aiPanelVisible}
        title={t('ai:panel.title')}
        onClick={toggleAiPanel}
      >
        AI
      </button>
      <SettingsButton />
      {lastError ? (
        <span className="ts-statusbar__item ts-statusbar__item--error" role="alert">
          {lastError}
        </span>
      ) : null}
    </footer>
  )
}
