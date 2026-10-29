import { useEffect } from 'react'
import './theme.css'
import { useTranslation } from 'react-i18next'
import { Bot, GitBranch, Palette, Settings, ShieldCheck, TerminalSquare } from 'lucide-react'
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

        {/*
          竖向导航（t45）：分类在左、内容在右（VS Code 的设置界面同构）。
          `data-testid` / `role` / `aria-selected` 与改造前的横向 tab **完全一致** ——
          e2e（`e2e/fixtures/ui.ts` 的 `enableAi()`）与导出脚本靠 testid 点击，改名等于
          把它们全弄红。本轮新增的只有 `aria-orientation="vertical"` 与 `data-testid="settings-nav"`。
        */}
        <div className="ts-dialog__main">
          <nav
            className="ts-settings__nav"
            role="tablist"
            aria-orientation="vertical"
            aria-label={t('settings:title')}
            data-testid="settings-nav"
          >
            {VISIBLE_SETTINGS_TABS.map((item) => {
              const Icon = TAB_ICONS[item]
              return (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={item === tab}
                  className={`ts-settings__nav-item${item === tab ? ' ts-settings__nav-item--active' : ''}`}
                  data-testid={`settings-tab-${item}`}
                  onClick={() => setTab(item)}
                >
                  <Icon size={14} aria-hidden="true" />
                  {t(`settings:tabs.${item}`)}
                </button>
              )
            })}
          </nav>

          <div className="ts-dialog__body">
            <SettingsTabContent tab={tab} />
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * 页签内容。
 *
 * 安全 / 同步面板归 vault-sync：`embedded` 为真时它们不渲染弹窗外壳、
 * 不渲染自己的 `<h2>` 与「取消」按钮，只出内容（`SyncPanel.tsx` / `VaultSecurityPanel.tsx`
 * 里各自有 `if (embedded) return <section className="ts-vault__card ts-vault__card--embedded">`）。
 * 这里只负责摆放，**不再**外包一层「把旧外壳抹平」的样式：面板自己就有 `embedded` 形态，
 * 那层兜底样式连同它「等 embedded 做好」的过时注释一起删掉了（t40）
 * （理由与时序见 `theme.css` 文件末尾的说明）。
 * 侧栏原来那两个独立弹窗入口已改成 `openSettingsDialog('security' | 'sync')`，
 * 于是「同类设置三种入口」收敛成一处（UI 审计 #13）。
 */
function SettingsTabContent({ tab }: { tab: SettingsTab }): JSX.Element {
  const draft = useThemeStore((state) => state.draft)
  if (draft) return <ThemeEditor />
  if (tab === 'ai') return <AiSettings />
  if (tab === 'security') {
    return (
      <div data-testid="settings-embed-security">
        <VaultSecurityPanel embedded onClose={closeSettingsDialog} />
      </div>
    )
  }
  if (tab === 'sync') {
    return (
      <div data-testid="settings-embed-sync">
        <SyncPanel embedded onClose={closeSettingsDialog} />
      </div>
    )
  }
  return <AppearanceSettings />
}

/** 状态条/菜单/侧栏工具区里的设置入口按钮（带稳定 testid 方便 QA） */
export interface SettingsEntryProps {
  /**
   * 传入不同 testid 是为了**避免同一个 testid 在 DOM 里出现两次**：侧栏工具区（解锁态）
   * 与锁定态兜底入口可能同时挂载，两处都用 `open-settings` 会让 Playwright 的
   * `getByTestId('open-settings')` 命中两个元素直接报 strict mode violation。
   */
  testId?: string
  className?: string
  size?: number
}

export function SettingsEntry({
  testId = 'open-settings',
  className = 'ts-icon-btn',
  size = 15
}: SettingsEntryProps = {}): JSX.Element {
  const { t } = useTranslation(['settings'])
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      title={t('settings:title')}
      aria-label={t('settings:title')}
      onClick={() => useSettingsDialog.getState().openDialog('appearance')}
    >
      <Settings size={size} aria-hidden="true" />
    </button>
  )
}

/**
 * 旧名字（m0001 期就在用，`theme/index.ts` 的 barrel 与 `docs/theming.md` 都还引用）。
 * 现在只是 `SettingsEntry` 的别名 —— t45 把入口从状态栏右下角搬到了侧栏左下角，
 * 但保留这个导出是为了不让第三方入口（菜单命令、文档片段、未来的托盘菜单）失效。
 */
export const SettingsButton = SettingsEntry

/** 四个页签的图标（形状只表达分类，不含状态；颜色一律继承文字色） */
const TAB_ICONS: Record<SettingsTab, typeof Settings> = {
  appearance: Palette,
  ai: Bot,
  security: ShieldCheck,
  sync: GitBranch,
  // 预留页签（P0 契约里的 terminal/general）本轮不进导航，但类型上要齐全
  terminal: TerminalSquare,
  general: Settings
}
