import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { MenuCommand } from '@shared'
import { call, describeError, subscribe } from '../platform/ipc'
import { useLocaleBootstrap } from '../i18n/useLocale'
import { SettingsDialogHost } from '../theme/SettingsDialogHost'
import { useThemeBootstrap } from '../theme/hooks'
import { useShellStore } from './store'
import { AiPanel } from './placeholders/AiPanel'
import { HostSidebar } from './placeholders/HostSidebar'
import { LockScreen } from './placeholders/LockScreen'
import { StatusBar } from './placeholders/StatusBar'
import { TabStrip } from './placeholders/TabStrip'
import { TerminalArea } from './placeholders/TerminalArea'

/**
 * 应用外壳（**布局骨架，集成点**）。
 *
 * 归属：integration 成员在真实模块就绪后替换 `placeholders/*`，本文件的结构可以保留：
 *
 *   ┌──────────┬──────────────────────────────┬──────────┐
 *   │ 主机库    │ 页签条                        │ AI 面板  │
 *   │ (aside)  ├──────────────────────────────┤ (aside)  │
 *   │          │ 终端区 (main)                 │          │
 *   ├──────────┴──────────────────────────────┴──────────┤
 *   │ 状态条                                              │
 *   └────────────────────────────────────────────────────┘
 *
 * 锁定态（加密包 locked / 预览锁）→ 解锁屏覆盖整个窗口，其余 UI 不卸载（避免丢失 xterm 会话）。
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

  // ① 启动握手：拉 app:info / settings:get / vault:status（后两者可能是未接线桩）
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
      try {
        const status = await call('vault:status')
        store.setVault(status.state)
      } catch {
        // 骨架期 vault 模块未接线：保持 unknown，UI 不锁
        store.setVault('unknown')
      }
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

  const locked = previewLocked || vault === 'locked'

  return (
    <div className="ts-app" data-platform={platform} data-booted={booted} data-testid="app-shell">
      <HostSidebar />
      <div className="ts-workspace">
        <TabStrip />
        <TerminalArea />
      </div>
      {aiPanelVisible ? <AiPanel /> : null}
      <StatusBar />
      {lastError ? <div className="ts-toast" role="alert">{lastError}</div> : null}
      <SettingsDialogHost />
      {locked ? <LockScreen /> : null}
    </div>
  )
}

function handleMenuCommand(command: MenuCommand): void {
  const store = useShellStore.getState()
  switch (command) {
    case 'new-tab':
      store.openTab()
      break
    case 'close-tab':
      if (store.activeTabId) store.closeTab(store.activeTabId)
      break
    case 'toggle-ai-panel':
      store.toggleAiPanel()
      break
    case 'lock-vault':
      store.setPreviewLocked(true)
      break
    default:
      // 其余命令（open-settings / import-ssh-config / sync-now …）由对应 feature 接线后处理
      break
  }
}
