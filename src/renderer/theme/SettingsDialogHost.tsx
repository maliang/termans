import { useEffect } from 'react'
import './theme.css'
import { useTranslation } from 'react-i18next'
import { subscribe } from '../platform/ipc'
import { AiSettings } from './AiSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { ThemeEditor } from './ThemeEditor'
import { VISIBLE_SETTINGS_TABS, closeSettingsDialog, useSettingsDialog, type SettingsTab } from './settings-dialog'
import { useThemeStore } from './store'
// 安全 / 同步面板归 vault-sync，本模块只负责摆放。按文件路径引入而不是 `features/vault`
// 的 barrel：barrel 连 HostSidebar 一起拉进来，而 HostSidebar 又 import 了
// `openSettingsDialog`，形成 theme ↔ features 的循环引用（能跑，但 HMR 边界上容易拿到
// 半初始化的命名空间，也让人看不出这条依赖）。
import { SyncPanel } from '../features/vault/SyncPanel'
import { VaultSecurityPanel } from '../features/vault/VaultSecurityPanel'

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
 * 安全 / 同步面板归 vault-sync：`embedded` 为真时它们不渲染 `.ts-vault__modal` 遮罩、
 * 不渲染自己的 `<h2>` 与「取消」按钮，只出内容（`SyncPanel.tsx` / `VaultSecurityPanel.tsx`
 * 里各自有 `if (embedded) return <section className="ts-vault__card ts-vault__card--embedded">`）。
 * 这里只负责摆放；外层 `.ts-settings__embed` 再兜一层「把旧外壳抹平」的样式，
 * 面板哪天换壳，视觉也不会跳。
 * 侧栏原来那两个独立弹窗入口已改成 `openSettingsDialog('security' | 'sync')`，
 * 于是「同类设置三种入口」收敛成一处（UI 审计 #13）。
 */
function SettingsTabContent({ tab }: { tab: SettingsTab }): JSX.Element {
  const draft = useThemeStore((state) => state.draft)
  if (draft) return <ThemeEditor />
  if (tab === 'ai') return <AiSettings />
  if (tab === 'security') {
    return (
      <div className="ts-settings__embed" data-testid="settings-embed-security">
        <VaultSecurityPanel embedded onClose={closeSettingsDialog} />
      </div>
    )
  }
  if (tab === 'sync') {
    return (
      <div className="ts-settings__embed" data-testid="settings-embed-sync">
        <SyncPanel embedded onClose={closeSettingsDialog} />
      </div>
    )
  }
  return <AppearanceSettings />
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
