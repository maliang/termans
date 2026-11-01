// 必须在 features/vault 之前求值：它给 i18next v26 补回 addResourceBundle（原因见该文件头）
import './layout/i18next-compat'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { MenuCommand } from '@shared'
import { AiPanel } from '@renderer/features/ai'
import { runMenuCommand, useTabStore } from '@renderer/features/tabs/tab-store'
import { TerminalTabStrip } from '@renderer/features/tabs/TabStrip'
import { TerminalWorkspace } from '@renderer/features/terminal/TerminalWorkspace'
import { UnlockScreen } from '@renderer/features/unlock'
// 深路径：`features/unlock/index.ts` 不在 t9 的可写清单里，直接引组件文件
import { VaultNoticeBar } from '@renderer/features/unlock/VaultNoticeBar'
import { initializeVaultFeature, useVaultStore } from '@renderer/features/vault'
import { call, describeError, subscribe } from '../platform/ipc'
import { useLocaleBootstrap } from '../i18n/useLocale'
import { SettingsDialogHost, SettingsEntry } from '../theme/SettingsDialogHost'
import { closeSettingsDialog } from '../theme/settings-dialog'
import { useThemeBootstrap } from '../theme/hooks'
import { useShellStore } from './store'
import { ErrorToast } from './layout/ErrorToast'
import { HostKeyPrompt } from './layout/HostKeyPrompt'
import { HostLibraryPane } from './layout/HostLibraryPane'
import { PanelSplitter } from './layout/PanelSplitter'

/* 面板宽度的边界（t56）：下限对齐主进程 `uiSettingsSchema`，上限受「工作区最小宽」约束 */
const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 560
const AI_PANEL_MIN = 320
const AI_PANEL_MAX = 720
/** 工作区（终端 + 页签区）在任何窗口尺寸下都要保留的最小宽度，低于它终端就没有可用列数了。
 *  取 400：窗口最小 960 − 侧栏 220 − AI 320 = 420，再留 20px 余量给栅格列与边框。 */
const WORKSPACE_MIN = 400
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
  // AI 面板的 grid 列宽跟着「是否展开」走：不展开时列宽 0，展开时用用户拖出来的宽度
  const aiVisibleForLayout = aiPanelVisible
  const platform = useShellStore((state) => state.platform)
  const lastError = useShellStore((state) => state.lastError)
  const terminalSettings = useShellStore((state) => state.settings.terminal)
  // 侧栏/AI 面板宽度（t53）：拖拽期间只改本地 state，松手才落盘——
  // 拖动时每帧发一次 settings:update 会让主进程反复写 settings.json 并广播事件。
  const uiSettings = useShellStore((state) => state.settings.ui)
  const [sidebarWidth, setSidebarWidth] = useState(uiSettings.sidebarWidth)
  const [aiPanelWidth, setAiPanelWidth] = useState(uiSettings.aiPanelWidth)
  const sidebarVisible = uiSettings.showHostTree
  useEffect(() => setSidebarWidth(uiSettings.sidebarWidth), [uiSettings.sidebarWidth])
  useEffect(() => setAiPanelWidth(uiSettings.aiPanelWidth), [uiSettings.aiPanelWidth])

  /*
   * 面板宽度上下限（t56）。
   *
   * 下限（可读性/美观）：侧栏 200、AI 面板 280 —— 实测 180 时侧栏空态文案折成三行、
   * 240 时 AI 面板的说明文字被面板边缘切掉，所以画面可读的下限比 schema 的存储下限（180/240）
   * 更高；两者之差由下面的 clamp effect 在加载时抹平。
   * 上限（可用性）：不只看 schema 的硬上限 560/720，还要**给工作区留够** ——
   * 实测两个面板都拖到硬上限时工作区只剩 38px，终端等于被挤没了（主人 2026-10-30 提的就是这件事）。
   * 所以动态上限 = min(硬上限, 窗口宽 - 另一侧面板宽 - 工作区最小宽 480)。
   */
  // persistUi 定义在本文件更后面，用 ref 转发：否则「窗口变窄就收回宽度」的 effect 会落在它的声明之前（TDZ）
  const persistUiRef = useRef<((patch: Partial<typeof uiSettings>) => Promise<void>) | null>(null)

  const [windowWidth, setWindowWidth] = useState(() => (typeof window === 'undefined' ? 1320 : window.innerWidth))
  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const sidebarMax = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - (aiVisibleForLayout ? aiPanelWidth : 0) - WORKSPACE_MIN))
  const aiPanelMax = Math.max(AI_PANEL_MIN, Math.min(AI_PANEL_MAX, windowWidth - (sidebarVisible ? sidebarWidth : 0) - WORKSPACE_MIN))

  // 窗口变小后，上一次落盘的宽度可能已经不合法（两个面板合计超宽）——按当前窗口把宽度收回来并落盘，
  // 否则用户下次启动看到的还是「工作区被挤没」的状态。
  useEffect(() => {
    // 两个方向都收：窗口变窄时收回上限；旧版本存下的宽度可能低于新下限（schema 的 min 是 180/240，
    // 界面的可读下限提高到了 200/280），加载后同样拉回来并落盘。
    const nextSidebar = Math.min(sidebarMax, Math.max(SIDEBAR_MIN, sidebarWidth))
    if (nextSidebar !== sidebarWidth) {
      setSidebarWidth(nextSidebar)
      void persistUiRef.current?.({ sidebarWidth: nextSidebar })
    }
    const nextAi = Math.min(aiPanelMax, Math.max(AI_PANEL_MIN, aiPanelWidth))
    if (nextAi !== aiPanelWidth) {
      setAiPanelWidth(nextAi)
      void persistUiRef.current?.({ aiPanelWidth: nextAi })
    }
  }, [sidebarMax, aiPanelMax, sidebarWidth, aiPanelWidth])

  /** 只提交 ui 里的一个字段；主进程会广播 settings:changed，这里再写一次让界面立刻反映 */
  const persistUi = useCallback(async (patch: Partial<typeof uiSettings>): Promise<void> => {
    try {
      // `aiPanelVisible` 只活在内存里（面板开关不落盘），而 `setSettings` 会用落盘值覆盖它——
      // 只提交宽度的话，一松手 AI 面板就被判定成「关闭」而消失（t53 实测：拖完 AI 分栏条面板直接没了）。
      const updated = await call('settings:update', {
        ui: { ...patch, aiPanelVisible: useShellStore.getState().aiPanelVisible }
      })
      useShellStore.getState().setSettings(updated)
    } catch (error) {
      useShellStore.getState().setLastError(describeError(error))
    }
  }, [])
  // 把 persistUi 挂到上面那个 ref 上（见 `persistUiRef` 的声明处）
  persistUiRef.current = persistUi

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
  // `recoveryPending`：建库成功后主进程已是 unlocked，但恢复码只显示这一次 ——
  // 确认之前不许外壳接管，否则恢复码页会一闪而过（r3 AC-16）。
  const recoveryPending = useVaultStore((state) => state.recoveryPending)
  const locked = previewLocked || recoveryPending || vault === 'locked' || vault === 'uninitialized'

  // 锁定时必须收起设置对话框：`.ts-dialog` 在锁定态被抬到 z-index 70（高于解锁屏 60），
  // 对话框一旦开着，遮罩就会挡住解锁屏的「解锁」按钮，用户点不动、也看不出为什么。
  // 只在「进入锁定」的那一次转换里关，不阻止用户在锁定态主动点齿轮进设置（那是 t45 的兜底入口）。
  const wasLocked = useRef(locked)
  useEffect(() => {
    if (locked && !wasLocked.current) closeSettingsDialog()
    wasLocked.current = locked
  }, [locked])

  return (
    <div
      className="ts-app"
      data-platform={platform}
      data-booted={booted}
      data-locked={locked ? 'true' : undefined}
      data-sidebar-hidden={sidebarVisible ? undefined : 'true'}
      data-testid="app-shell"
      style={
        {
          // 折叠时列宽归零（`data-sidebar-hidden` 同时把侧栏整块 display:none，避免留下 0 宽边框）
          '--ts-sidebar-width': `${sidebarVisible ? sidebarWidth : 0}px`,
          '--ts-ai-panel-width': `${aiVisibleForLayout ? aiPanelWidth : 0}px`
        } as CSSProperties
      }
    >
      {/*
        锁定态：外壳保持挂载（终端会话、页签、AI 草稿都不销毁），但**不可见也不可聚焦** ——
        否则解锁屏只是「盖在上面」，主机名、IP、终端回显仍然能被截图、被读屏、被 DOM 抓走。
        规则只作用于 `.ts-unlock` 之外的一级子节点，所以解锁屏自己照常显示。
      */}
      <style>{LOCKED_SHELL_CSS}</style>
      {sidebarVisible ? (
        <>
          <HostLibraryPane />
          <PanelSplitter
            side="left"
            value={sidebarWidth}
            min={SIDEBAR_MIN}
            max={sidebarMax}
            label="调整主机库宽度"
            testId="sidebar-splitter"
            onLive={setSidebarWidth}
            onCommit={(width) => void persistUi({ sidebarWidth: width })}
          />
        </>
      ) : null}
      <div className="ts-workspace">
        {/*
          折叠/展开按钮长在页签条左端（t54）：主人要求「关闭显示按钮固定在顶部新建标签按钮前面，
          底部的去掉」。同一颗按钮切换两种状态，折叠后它自己还留在原地——不再需要「折叠后去外面找把手」。
        */}
        <TerminalTabStrip
          sidebarVisible={sidebarVisible}
          onToggleSidebar={() => void persistUi({ showHostTree: !sidebarVisible })}
        />
        {/* 口令变体命中的一次性告知条（r3 AC-7）：标题栏之下、主内容之上的流式元素，
            所以挂在 `.ts-workspace` 里 —— `.ts-app` 是 5 列栅格，多一个直属子节点会破坏布局 */}
        <VaultNoticeBar />
        <TerminalWorkspace transport={getCaptureTransport()} settings={terminalSettings} platform={platform} />
      </div>
      {aiPanelVisible ? (
        <>
          <PanelSplitter
            side="right"
            value={aiPanelWidth}
            min={AI_PANEL_MIN}
            max={aiPanelMax}
            label="调整 AI 面板宽度"
            testId="ai-splitter"
            onLive={setAiPanelWidth}
            onCommit={(width) => void persistUi({ aiPanelWidth: width })}
          />
          <AiPanel
            hasSession={hasSession}
            getContext={() => activeTerminalSnapshot()}
            runCommand={writeCommand}
          />
        </>
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
