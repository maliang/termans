import { useEffect, useMemo, useRef } from 'react'
import { DEFAULT_SETTINGS } from '@shared'
import { registerTabBackend, resetTabBackend } from '../../tabs/backend'
import { TerminalTabStrip } from '../../tabs/TabStrip'
import { useTabStore } from '../../tabs/tab-store'
import { TerminalWorkspace } from '../TerminalWorkspace'
import { SessionStatus } from '../SessionStatus'
import { createMockTabBackend, MOCK_DEFAULT_HOST_ID } from './mock-backend'
import { createMockTransport } from './mock-transport'

/**
 * 免 SSH 的终端演示页（`/features/terminal/dev/mock.html`）。
 *
 * 用途：e2e / 手工验证 xterm 渲染、页签切换、搜索、粘贴确认、字号缩放——
 * 这些全都不需要真的连上服务器。启动时自动开一个页签并连上 mock shell，
 * 所以页面一打开就能看到提示符与欢迎语。
 */

export interface MockWorkspaceProps {
  /** 启动时自动开的页签数，默认 1 */
  initialTabs?: number
  /** 强制 DOM 渲染（验证回退路径）；不传则按 URL `?renderer=dom` 决定，缺省自动试 WebGL */
  webgl?: boolean
}

/** `?heartbeat=600` 让 mock shell 定期打点，验证「非激活页签有输出 → 未读标记」 */
function heartbeatFromUrl(): number | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = new URLSearchParams(window.location.search).get('heartbeat')
  if (!raw) return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function rendererPreference(forced: boolean | undefined): boolean | undefined {
  if (forced !== undefined) return forced
  if (typeof window === 'undefined') return undefined
  const requested = new URLSearchParams(window.location.search).get('renderer')
  if (requested === 'dom') return false
  if (requested === 'webgl') return true
  return undefined
}

export function MockWorkspace({ initialTabs = 1, webgl }: MockWorkspaceProps) {
  const transport = useMemo(
    () => createMockTransport({ hostLabel: 'mock-host', connectDelayMs: 60, heartbeatMs: heartbeatFromUrl() }),
    []
  )
  const bootstrapped = useRef(false)
  const wantsWebgl = rendererPreference(webgl)

  useEffect(() => {
    registerTabBackend(createMockTabBackend())
    return () => resetTabBackend()
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    const store = useTabStore.getState()
    if (store.tabs.length > 0) return
    for (let index = 0; index < Math.max(1, initialTabs); index += 1) {
      store.openTab({ hostId: MOCK_DEFAULT_HOST_ID, hostLabel: index === 0 ? 'mock-host' : `mock-host-${index + 1}` })
    }
  }, [initialTabs])

  return (
    <div className="ts-app" style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <TerminalTabStrip />
      <TerminalWorkspace
        transport={transport}
        settings={DEFAULT_SETTINGS.terminal}
        platform="darwin"
        webgl={wantsWebgl}
      />
      {/* 外壳状态栏不在这里（这是终端 feature 的演示页），但会话状态串在真实应用里挂在状态栏上，
          这里补一条同样的底栏，验证脚本才能用同一个 `term-status` 选择器复核尺寸/渲染器 */}
      <footer className="ts-statusbar" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px' }}>
        <SessionStatus />
      </footer>
    </div>
  )
}
