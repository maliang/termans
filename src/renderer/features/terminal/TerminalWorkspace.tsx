import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_SETTINGS, type AppPlatform, type TerminalSettings } from '@shared'
import { CloseTabDialog } from '../tabs/CloseTabDialog'
import { registerTabCommandHooks, requestCloseTab, runMenuCommand, useTabStore, type TerminalTab } from '../tabs/tab-store'
import { PasteWarningDialog } from './PasteWarningDialog'
import { singleLineText } from './paste'
import { TerminalSearchBar } from './TerminalSearchBar'
import { TerminalToolbar } from './TerminalToolbar'
import { XtermSurface } from './XtermSurface'
import { createTerminalRuntime, type ZoomDirection } from './runtime'
import { TerminalRuntimeContext, TerminalUiContext, type TerminalUiActions } from './runtime-context'
import { useSessionStore } from './session-store'
import type { TerminalTransport } from './types'
import type { PasteInspection } from './paste'
import { useTerminalShortcuts, type TerminalShortcutActions } from './use-global-shortcuts'
import './terminal.css'

/**
 * 终端工作区：本 feature 的组合根（integration 用它替换 `app/placeholders/TerminalArea.tsx`）。
 *
 * 职责：创建 runtime（一次）、把页签列表渲染成常驻的 xterm 面板、挂搜索/确认弹窗、
 * 注册菜单命令与全局快捷键。
 *
 * 显式接收 `settings` / `transport` / `platform`，是为了**可测**：
 * e2e 和不依赖主进程的 mock 场景直接注入假 transport 与固定设置，
 * 生产则由 App 把 `useShellStore().settings` 传进来。
 */

export interface TerminalWorkspaceProps {
  className?: string
  /** 不传则用 IPC 传输（生产默认）；dev/qa 注入 mock */
  transport?: TerminalTransport
  settings?: TerminalSettings
  platform?: AppPlatform
  /** settings.ui.confirmOnCloseTab；默认 true */
  confirmOnClose?: boolean
  /** 排障用：关掉 WebGL 强制 DOM 渲染 */
  webgl?: boolean
}

function detectPlatform(): AppPlatform {
  if (typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)) return 'darwin'
  if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform)) return 'win32'
  return 'linux'
}

interface PastePrompt {
  tabId: string
  inspection: PasteInspection
}

export function TerminalWorkspace({
  className,
  transport,
  settings = DEFAULT_SETTINGS.terminal,
  platform,
  confirmOnClose = true,
  webgl
}: TerminalWorkspaceProps): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const [searchOpen, setSearchOpen] = useState(false)
  const [pastePrompt, setPastePrompt] = useState<PastePrompt | null>(null)
  const [pendingClose, setPendingClose] = useState<TerminalTab | null>(null)

  // runtime 只建一次：重建等于把所有终端扔掉
  const runtime = useMemo(
    () => createTerminalRuntime({ settings, transport, webgl }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  useEffect(() => {
    runtime.setSettings(settings)
  }, [runtime, settings])

  // 订阅 ssh:data / state / closed：不 start 的话终端一个字都收不到（静默失效）
  useEffect(() => runtime.controller.start(), [runtime])

  useEffect(() => () => runtime.dispose(), [runtime])

  const resolvedPlatform = platform ?? detectPlatform()

  const requestPaste = useCallback(
    async (tabId: string) => {
      const inspection = await runtime.requestPaste(tabId)
      if (!inspection) return
      if (inspection.needsConfirm) {
        setPastePrompt({ tabId, inspection })
        return
      }
      runtime.paste(tabId, inspection.text)
    },
    [runtime]
  )

  const requestClose = useCallback(
    (tabId: string) => {
      const decision = requestCloseTab(tabId, { confirmOnClose })
      if (decision.closed) {
        useTabStore.getState().closeTab(tabId)
        setPendingClose(null)
        return
      }
      if (decision.reason === 'active-session') setPendingClose(decision.tab)
    },
    [confirmOnClose]
  )

  const ui = useMemo<TerminalUiActions>(
    () => ({
      openSearch: () => setSearchOpen(true),
      closeSearch: () => setSearchOpen(false),
      requestPaste,
      zoom: (direction: ZoomDirection) => runtime.zoom(useTabStore.getState().activeTabId, direction),
      clearActive: () => runtime.clear(useTabStore.getState().activeTabId),
      copyAllActive: () => runtime.copyAll(useTabStore.getState().activeTabId)
    }),
    [runtime, requestPaste]
  )

  const shortcuts = useMemo<TerminalShortcutActions>(
    () => ({
      newTab: () => {
        // 走菜单同一入口：页签条注册过选择器就用选择器，否则退化成开一个空页签
        runMenuCommand('new-tab')
      },
      closeTab: () => {
        const activeId = useTabStore.getState().activeTabId
        if (activeId) requestClose(activeId)
      },
      find: () => setSearchOpen(true),
      clear: () => runtime.clear(useTabStore.getState().activeTabId),
      copyAll: () => void runtime.copyAll(useTabStore.getState().activeTabId),
      paste: () => {
        const activeId = useTabStore.getState().activeTabId
        if (activeId) void requestPaste(activeId)
      },
      zoom: (direction: ZoomDirection) => runtime.zoom(useTabStore.getState().activeTabId, direction)
    }),
    [runtime, requestClose, requestPaste]
  )

  useTerminalShortcuts(shortcuts, resolvedPlatform)

  // 菜单命令里属于终端的两项（新建由页签条自己注册）
  useEffect(
    () =>
      registerTabCommandHooks({
        requestCloseTab: requestClose,
        openSearch: () => setSearchOpen(true)
      }),
    [requestClose]
  )

  const activeView = useSessionStore((state) => (activeTabId ? state.byTab[activeTabId] : undefined))

  return (
    <TerminalRuntimeContext.Provider value={runtime}>
      <TerminalUiContext.Provider value={ui}>
        <main
          className={`ts-terminal ts-term-workspace${className ? ` ${className}` : ''}`}
          data-testid="terminal-workspace"
          data-active-tab={activeTabId ?? ''}
          data-renderer={activeView?.renderer ?? ''}
        >
          <TerminalToolbar />
          <div className="ts-term-stack" data-testid="term-stack">
            {tabs.map((tab) => (
              <XtermSurface key={tab.id} tabId={tab.id} active={tab.id === activeTabId} />
            ))}
            {tabs.length === 0 && (
              <div className="ts-terminal__placeholder ts-term-empty" data-testid="term-empty">
                <p className="ts-empty__title">{t('terminal:empty.title', { defaultValue: '还没有打开的终端' })}</p>
                <p className="ts-empty__body">
                  {t('terminal:empty.body', {
                    defaultValue: '从左侧主机库双击一台主机，或点页签条上的「+」新建。'
                  })}
                </p>
              </div>
            )}
          </div>
          {searchOpen && <TerminalSearchBar tabId={activeTabId} onClose={() => setSearchOpen(false)} />}
          {pastePrompt && (
            <PasteWarningDialog
              inspection={pastePrompt.inspection}
              onCancel={() => setPastePrompt(null)}
              onConfirm={() => {
                runtime.paste(pastePrompt.tabId, pastePrompt.inspection.text)
                setPastePrompt(null)
              }}
              onInsertAsText={() => {
                // 折成一行再粘：只落到命令行上，不回车执行（换行信息已由提示框告知）
                runtime.paste(pastePrompt.tabId, singleLineText(pastePrompt.inspection.text))
                setPastePrompt(null)
              }}
            />
          )}
          {pendingClose && (
            <CloseTabDialog
              tab={pendingClose}
              onCancel={() => setPendingClose(null)}
              onConfirm={() => {
                useTabStore.getState().closeTab(pendingClose.id)
                setPendingClose(null)
              }}
            />
          )}
        </main>
      </TerminalUiContext.Provider>
    </TerminalRuntimeContext.Provider>
  )
}

export default TerminalWorkspace
