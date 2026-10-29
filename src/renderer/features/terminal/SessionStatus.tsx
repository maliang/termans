import { useTranslation } from 'react-i18next'
import { findTab, useTabStore, type TabStatus } from '../tabs/tab-store'
import { useSessionStore } from './session-store'

/**
 * 「当前会话」状态串：主机 · 列×行 · 渲染器 · 连接态。
 *
 * 它原来居中漂在终端工具条里（审计 #2：状态信息塞进工具栏，和页签争位置），
 * 现在统一挂在状态栏左段。抽成组件而不是复制两处文案，是因为 mock 页
 * （`features/terminal/dev`）没有外壳状态栏，那里要自己渲染一份。
 *
 * 文案来源约定：连接态一律用 `terminal:tab.status.*`（`TabStatus` 的六个值
 * 在 locales 里都有），**不用** `SshPhase`——后者多出 authenticating /
 * host-key-verification 两个没有文案的中间态，界面会露出原始 key。
 */

const STATUS_KEY: Record<TabStatus, string> = {
  idle: 'tab.status.idle',
  connecting: 'tab.status.connecting',
  connected: 'tab.status.connected',
  reconnecting: 'tab.status.reconnecting',
  closed: 'tab.status.closed',
  error: 'tab.status.error'
}

export interface SessionStatusProps {
  className?: string
}

export function SessionStatus({ className }: SessionStatusProps): JSX.Element {
  const { t } = useTranslation()
  const tab = useTabStore((state) => findTab(state.tabs, state.activeTabId))
  const view = useSessionStore((state) => (tab ? state.byTab[tab.id] : undefined))

  if (!tab) {
    return (
      <span className={['ts-term-session', 'ts-term-session--empty', className].filter(Boolean).join(' ')}>
        {t('terminal:empty.title', { defaultValue: 'No session open' })}
      </span>
    )
  }

  const parts = [
    tab.hostLabel ?? t('terminal:tab.local', { defaultValue: 'Local' }),
    view ? `${view.cols}×${view.rows}` : null,
    view ? view.renderer.toUpperCase() : null,
    t(`terminal:${STATUS_KEY[tab.status]}`, { defaultValue: tab.status })
  ].filter((part): part is string => Boolean(part))

  const text = parts.join(' · ')

  return (
    <span
      className={['ts-term-session', `ts-term-session--${tab.status}`, className].filter(Boolean).join(' ')}
      data-testid="term-status"
      data-status={tab.status}
      title={text}
    >
      {text}
    </span>
  )
}
