import { useEffect } from 'react'
import './theme.css'
import { useTranslation } from 'react-i18next'
import { subscribe } from '../platform/ipc'
import { AiSettings } from './AiSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { ThemeEditor } from './ThemeEditor'
import { VISIBLE_SETTINGS_TABS, useSettingsDialog, type SettingsTab } from './settings-dialog'
import { useThemeStore } from './store'

/**
 * 设置对话框宿主。
 *
 * 为什么由主题模块自带宿主而非塞进 App：
 * - `open-settings` 菜单命令原先在 App 的 switch 里落到 default 分支（无人处理），
 *   这里自己订阅 `app:menu-command`，集成成员替换 `placeholders/*` 时不会被弄丢；
 * - 设置页分「外观 / AI / 安全 / 同步」四页（UI 审计 #13：此前安全与同步是另外两个
 *   独立弹窗，同类设置三种入口），编辑器与主题列表也都在本模块内，放在一起可以
 *   避免跨成员改 App 的排版。
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
        data-tab={tab}
      >
        <header className="ts-dialog__header">
          <h2 className="ts-dialog__title">{t('settings:title')}</h2>
          <button
            type="button"
            className="ts-dialog__close"
            data-testid="settings-close"
            title={t('common:action.close')}
            aria-label={t('common:action.close')}
            onClick={() => {
              if (draft) discardDraft()
              closeDialog()
            }}
          >
            ×
          </button>
        </header>

        <nav className="ts-dialog__tabs" role="tablist" aria-label={t('settings:title')}>
          {VISIBLE_SETTINGS_TABS.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={item === tab}
              className={`ts-dialog__tab${item === tab ? ' ts-dialog__tab--active' : ''}`}
              data-testid={`settings-tab-${item}`}
              onClick={() => setTab(item)}
            >
              {t(`settings:tabs.${item}`)}
            </button>
          ))}
        </nav>

        <div className="ts-dialog__body">
          <SettingsTabContent tab={tab} />
        </div>
      </div>
    </div>
  )
}

/**
 * 页签内容。
 *
 * 安全 / 同步两页的接线位：面板本体（`VaultSecurityPanel` / `SyncPanel`）归 vault-sync，
 * 正在由 t31 加 `embedded` 模式（为真时不渲染 `.ts-vault__modal` 遮罩、不渲染自己的 `<h2>`
 * 与「取消」按钮）。落地后这里换成：
 *
 * ```tsx
 * {tab === 'security' ? <div className="ts-settings__embed"><VaultSecurityPanel embedded onClose={closeSettingsDialog} /></div> : null}
 * {tab === 'sync' ? <div className="ts-settings__embed"><SyncPanel embedded onClose={closeSettingsDialog} /></div> : null}
 * ```
 *
 * 在那之前渲染占位并明确告诉用户「暂时从哪里打开」，而不是给一个点开是空白的页签
 * （`.ts-settings__embed` 的抹平外壳样式已在 theme.css 里备好，接线时无需再改样式）。
 */
function SettingsTabContent({ tab }: { tab: SettingsTab }): JSX.Element {
  const draft = useThemeStore((state) => state.draft)
  if (draft) return <ThemeEditor />
  if (tab === 'ai') return <AiSettings />
  if (tab === 'security' || tab === 'sync') return <PendingSettingsTab tab={tab} />
  return <AppearanceSettings />
}

function PendingSettingsTab({ tab }: { tab: 'security' | 'sync' }): JSX.Element {
  const { t } = useTranslation(['settings'])
  return (
    <div className="ts-settings__placeholder" data-testid="settings-tab-placeholder" data-tab={tab}>
      <p>{t(`settings:tab.pending.${tab}`)}</p>
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
