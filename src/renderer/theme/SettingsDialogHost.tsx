import { useEffect } from 'react'
import './theme.css'
import { useTranslation } from 'react-i18next'
import { subscribe } from '../platform/ipc'
import { AiSettings } from './AiSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { ThemeEditor } from './ThemeEditor'
import { useSettingsDialog, type SettingsTab } from './settings-dialog'
import { useThemeStore } from './store'

/**
 * 设置对话框宿主。
 *
 * 为什么由主题模块自带宿主而非塞进 App：
 * - `open-settings` 菜单命令原先在 App 的 switch 里落到 default 分支（无人处理），
 *   这里自己订阅 `app:menu-command`，集成成员替换 `placeholders/*` 时不会被弄丢；
 * - 设置页分「外观」（语言 + 主题）与「AI」（总开关 / 默认供应商 / 上下文行数）两页，
 *   编辑器与主题列表也都在本模块内，放在一起可以避免跨成员改 App 的排版。
 *
 * 关闭方式：右上角 ×、Escape、点击遮罩。
 */

export function SettingsDialogHost(): JSX.Element | null {
  const { t } = useTranslation(['settings', 'common'])
  const open = useSettingsDialog((state) => state.open)
  const tab = useSettingsDialog((state) => state.tab)
  const closeDialog = useSettingsDialog((state) => state.closeDialog)
  const setTab = useSettingsDialog((state) => state.setTab)
  const draft = useThemeStore((state) => state.draft)
  const discardDraft = useThemeStore((state) => state.discardDraft)

  // 菜单「设置…」→ 打开对话框
  useEffect(() => {
    return subscribe('app:menu-command', ({ command }) => {
      if (command === 'open-settings') useSettingsDialog.getState().openDialog('appearance')
    })
  }, [])

  // Escape 关闭（编辑中先放弃草稿，避免把预览色留在界面上）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (useThemeStore.getState().draft) discardDraft()
      else closeDialog()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, closeDialog, discardDraft])

  if (!open) return null

  const tabs: SettingsTab[] = ['appearance', 'ai']

  return (
    <div
      className="ts-dialog"
      role="presentation"
      data-testid="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog()
      }}
    >
      <div
        className="ts-dialog__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings:title')}
        data-testid="settings-dialog"
      >
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title">{t('settings:title')}</h2>
          <button
            type="button"
            className="ts-dialog__close"
            data-testid="settings-close"
            aria-label={t('common:action.close')}
            onClick={() => {
              if (draft) discardDraft()
              closeDialog()
            }}
          >
            ×
          </button>
        </header>

        {tabs.length > 1 ? (
          <nav className="ts-dialog__tabs">
            {tabs.map((item) => (
              <button
                key={item}
                type="button"
                className={`ts-dialog__tab${item === tab ? ' ts-dialog__tab--active' : ''}`}
                data-testid={`settings-tab-${item}`}
                onClick={() => setTab(item)}
              >
                {t(`settings:tabs.${item}`)}
              </button>
            ))}
          </nav>
        ) : null}

        <div className="ts-dialog__body">
          {draft ? <ThemeEditor /> : tab === 'ai' ? <AiSettings /> : <AppearanceSettings />}
        </div>
      </div>
    </div>
  )
}

/** 状态条/菜单里的设置入口按钮（集成到 StatusBar 用；带稳定 testid 方便 QA） */
export function SettingsButton(): JSX.Element {
  const { t } = useTranslation(['settings'])
  return (
    <button
      type="button"
      className="ts-statusbar__button"
      data-testid="open-settings"
      title={t('settings:title')}
      aria-label={t('settings:title')}
      onClick={() => useSettingsDialog.getState().openDialog('appearance')}
    >
      ⚙
    </button>
  )
}
