// 必须在 features/vault 之前求值：它给 i18next v26 补回 addResourceBundle（原因见该文件头）
import './layout/i18next-compat'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { MenuCommand } from '@shared'
import { AiPanel } from '@renderer/features/ai'
import { runMenuCommand, useTabStore } from '@renderer/features/tabs/tab-store'
import { TerminalTabStrip } from '@renderer/features/tabs/TabStrip'
import { TerminalWorkspace } from '@renderer/features/terminal/TerminalWorkspace'
import { UnlockScreen } from '@renderer/features/unlock'
import { initializeVaultFeature } from '@renderer/features/vault'
import { call, describeError, subscribe } from '../platform/ipc'
import { useLocaleBootstrap } from '../i18n/useLocale'
import { SettingsDialogHost, SettingsEntry } from '../theme/SettingsDialogHost'
import { useThemeBootstrap } from '../theme/hooks'
import { useShellStore } from './store'
import { ErrorToast } from './layout/ErrorToast'
import { HostKeyPrompt } from './layout/HostKeyPrompt'
import { HostLibraryPane } from './layout/HostLibraryPane'
import { StatusBar } from './layout/StatusBar'
import {
  activeTerminalSnapshot,
  getCaptureTransport,
  terminalSnapshot,
  writeCommand
} from './layout/terminal-bridge'

/**
 * 应用外壳（**唯一的渲染层接线点**）。
 *
 *   ┌──────────┬──────────────────────────────┬──────────┐
 *   │ 主机库    │ 页签条                        │ AI 面板  │
 *   │ (aside)  ├──────────────────────────────┤ (aside)  │
 *   │          │ 终端区 (main)                 │          │
 *   ├──────────┴──────────────────────────────┴──────────┤
 *   │ 状态条                                              │
 *   └────────────────────────────────────────────────────┘
 *
 * 数据流向（谁是谁的真相）：
 * - 主机库 / 同步：`features/vault`（`initializeVaultFeature()` 订阅 vault/sync 事件）
 * - 页签 / 会话：`features/tabs/tab-store` + `features/terminal/session-store`
 * - 终端实例：`features/terminal`（xterm 不进 React state）
 * - AI：`features/ai`（上下文「拉取式」取自 `layout/terminal-bridge.ts` 的缓冲）
 * - 主题 / 语言：`features/theme` + `features/i18n` 的 bootstrap hook（外壳只调一次）
 *
 * 锁定态（加密包 locked/uninitialized / 预览锁）→ 解锁屏覆盖整个窗口，其余 UI **不卸载**，
 * 否则已连接的终端会被一起扔掉（重连代价大，且 scrollback 丢失）。
 */
export function App(): JSX.Element {
  // 只是让 i18n 的 react 绑定随语言变化重渲染；具体文案由各子组件取
  useTranslation()
  const booted = useShellStore((state) => state.booted)
  const vault = useShellStore((state) => state.vault)
  const previewLocked = useShellStore((state) => state.previewLocked)
  const aiPanelVisible = useShellStore((state) => state.aiPanelVisible)
  const platform = useShellStore((state) => state.platform)
  const lastError = useShellStore((state) => state.lastError)
  const terminalSettings = useShellStore((state) => state.settings.terminal)
  // AI 面板要据此决定「能不能带上下文发送」：必须随页签/会话变化重渲染
  const hasSession = useTabStore((state) =>
    state.tabs.some(
      (tab) => tab.id === state.activeTabId && Boolean(tab.sessionId) && tab.status !== 'closed' && tab.status !== 'error'
    )
  )

  // ① 启动握手：app:info / settings:get → 外壳状态；vault 交给 vault feature 自己拉
  useEffect(() => {
    const store = useShellStore.getState()
    void (async () => {
      store.setPlatform(window.termans?.platform ?? 'linux')
      try {
        const info = await call('app:info')
        store.setAppInfo(info)
        const loaded = await call('settings:get')
        store.setSettings(loaded)
      } catch (error) {
        store.setLastError(describeError(error))
      }
      // 订阅 vault:state-changed / sync:status-changed 并拉一次状态（幂等）
      await initializeVaultFeature()
      store.setBooted(true)
    })()
  }, [])

  // ② 主进程事件订阅：设置变更、菜单命令
  useEffect(() => {
    const offSettings = subscribe('settings:changed', (next) => {
      useShellStore.getState().setSettings(next)
    })
    const offMenu = subscribe('app:menu-command', ({ command }) => {
      handleMenuCommand(command)
    })
    return () => {
      offSettings()
      offMenu()
    }
  }, [])

  // ③ 语言与主题：首启跟随系统语言、切换即时生效；主题由 theme 模块把 52 个 token
  //    内联到 <html> 并通知已注册的 xterm 重绘（含已打开的终端，不重建实例）
  useLocaleBootstrap()
  useThemeBootstrap()

  // 「未初始化」= 首启还没建库：同样要铺解锁屏（那里提供「创建加密包」流程），
  // 否则用户会看到一个空壳界面却无从下手。
  const locked = previewLocked || vault === 'locked' || vault === 'uninitialized'

  return (
    <div
      className="ts-app"
      data-platform={platform}
      data-booted={booted}
      data-locked={locked ? 'true' : undefined}
      data-testid="app-shell"
    >
      {/*
        锁定态：外壳保持挂载（终端会话、页签、AI 草稿都不销毁），但**不可见也不可聚焦** ——
        否则解锁屏只是「盖在上面」，主机名、IP、终端回显仍然能被截图、被读屏、被 DOM 抓走。
        规则只作用于 `.ts-unlock` 之外的一级子节点，所以解锁屏自己照常显示。
      */}
      <style>{LOCKED_SHELL_CSS}</style>
      <HostLibraryPane />
      <div className="ts-workspace">
        <TerminalTabStrip />
        <TerminalWorkspace transport={getCaptureTransport()} settings={terminalSettings} platform={platform} />
      </div>
      {aiPanelVisible ? (
        <AiPanel
          hasSession={hasSession}
          getContext={() => activeTerminalSnapshot()}
          runCommand={writeCommand}
        />
      ) : null}
      <StatusBar />
      {lastError ? <ErrorToast message={lastError} /> : null}
      <SettingsDialogHost />
      {/* 首次连接/指纹变化时必须有人回答 ssh:host-key-challenge，否则连接会静默卡住 */}
      <HostKeyPrompt />
      {/*
        锁定态兜底设置入口（t45）：锁定后侧栏整块不渲染（`.ts-sidebar-host` 仍是 DOM，
        但被上面那条 `visibility: hidden` 关掉），如果设置入口只放在侧栏底部，用户锁上之后
        就再也进不去设置（改语言/换主题都被锁在门外）。所以锁屏时补一个固定在下行右侧的齿轮。
        testid 用 `open-settings-locked` 而不是 `open-settings`：两个入口会同时存在于 DOM，
        同名会让 Playwright 的 `getByTestId('open-settings')` 命中两个元素直接报错。
      */}
      {locked ? (
        <div className="ts-lock-tools" data-testid="lock-tools">
          <SettingsEntry testId="open-settings-locked" />
        </div>
      ) : null}
      {locked ? <UnlockScreen /> : null}
    </div>
  )
}

/**
 * 锁定态把外壳（侧栏/工作区/AI/状态条）整体隐藏，只留解锁屏。
 *
 * 用 `visibility` 而不是 `display:none`：布局尺寸不变，解锁后 xterm 不需要重新 fit；
 * `visibility:hidden` 同时让内容退出可访问性树与 `innerText`，读屏与截图都拿不到主机信息。
 *
 * 两个例外（t45）：
 * - `.ts-lock-tools`：锁定态唯一的设置入口，必须看得见、点得到；
 * - `.ts-dialog`：设置对话框本身（锁着也能改语言/主题）。它在解锁屏（z-index 60）
 *   之上弹出来，否则点开等于没反应。
 */
const LOCKED_SHELL_CSS = `
.ts-app[data-locked='true'] > :not(.ts-unlock):not(.ts-lock-tools):not(.ts-dialog) { visibility: hidden; }
.ts-app[data-locked='true'] > .ts-dialog { z-index: 70; }
`

/**
 * 菜单 / 快捷键统一入口。
 *
 * 页签类命令交给 `features/tabs` 的 `runMenuCommand()`（它返回 false 表示「不是我管的」），
 * 剩下的外壳自己处理。`open-settings` 由 `SettingsDialogHost` 自己订阅同一条事件处理，
 * 这里刻意不重复处理（两处都弹一次就成了弹两个对话框）。
 */
function handleMenuCommand(command: MenuCommand): void {
  const store = useShellStore.getState()
  switch (command) {
    case 'toggle-ai-panel':
      store.toggleAiPanel()
      return
    case 'lock-vault':
      void lockVault()
      return
    default:
      // new-tab / close-tab / next-tab / previous-tab / find-in-terminal
      runMenuCommand(command)
  }
}

async function lockVault(): Promise<void> {
  const store = useShellStore.getState()
  try {
    const status = await call('vault:lock')
    store.setVault(status.state)
  } catch (error) {
    store.setLastError(describeError(error))
  }
}

/** 调试/测试钩子：拿到「当前页签最近输出」的快照（AI 上下文同源） */
export function debugSnapshot(): ReturnType<typeof terminalSnapshot> {
  return activeTerminalSnapshot()
}
