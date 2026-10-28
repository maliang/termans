import { useTranslation } from 'react-i18next'
import { SettingsButton } from '../../theme/SettingsDialogHost'
import { useShellStore } from '../store'

/**
 * 底部状态条（占位骨架）：版本、平台、页签数与最近一次错误。
 * 骨架期它是「一屏之内能看到主进程到底通没通」的窗口，集成后保留即可（错误可见性比好看重要）。
 */
export function StatusBar(): JSX.Element {
  const { t } = useTranslation(['common'])
  const appInfo = useShellStore((state) => state.appInfo)
  const tabs = useShellStore((state) => state.tabs)
  const vault = useShellStore((state) => state.vault)
  const lastError = useShellStore((state) => state.lastError)

  return (
    <footer className="ts-statusbar" data-testid="status-bar">
      <span className="ts-statusbar__item">
        {appInfo ? `Termans ${appInfo.version}` : t('common:state.loading')}
      </span>
      <span className="ts-statusbar__item">{appInfo ? `${appInfo.platform}/${appInfo.arch}` : '—'}</span>
      <span className="ts-statusbar__item">{t('common:state.vault', { state: vault })}</span>
      <span className="ts-statusbar__item">{t('common:state.tabs', { count: tabs.length })}</span>
      <span className="ts-statusbar__spacer" />
      <SettingsButton />
      {lastError ? (
        <span className="ts-statusbar__item ts-statusbar__item--error" role="alert">
          {lastError}
        </span>
      ) : null}
    </footer>
  )
}
