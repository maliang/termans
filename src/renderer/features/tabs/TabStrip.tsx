import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { registerTabCommandHooks, requestCloseTab, useTabStore, type NewTabPickerMode, type TabStatus, type TerminalTab } from './tab-store'
import { NewTabPicker } from './NewTabPicker'
import { CloseTabDialog } from './CloseTabDialog'
import './tabs.css'

/**
 * 多页签条（替换 `app/placeholders/TabStrip.tsx`，由 integration 任务接线）。
 *
 * 交互清单：
 * - 点击切换（不重建终端：终端实例按 tabId 常驻，见 `features/terminal/terminal-pool`）；
 * - 中键（auxclick button=1）与双击关闭；关闭按钮同样走「活跃会话二次确认」；
 * - 拖拽重排（HTML5 DnD，落点用 hover 位置的 index，不做逐像素插入线）；
 * - 状态点：连接中/已连接/重连中/断开/错误；非激活页签有新输出时显示未读徽标；
 * - 「+」打开新建页签面板（主机库列表 + 快速连接）。
 *
 * 键盘快捷键不在这里注册：全局只挂一个 window 监听器（`features/terminal/use-global-shortcuts`），
 * 否则每多一个组件就多一份 preventDefault 竞争，按一次 ⌘W 会关掉两个页签。
 */

export interface TerminalTabStripProps {
  className?: string
  /** settings.ui.confirmOnCloseTab；默认 true（有活跃会话时二次确认） */
  confirmOnClose?: boolean
}

const STATUS_LABEL_KEY: Record<TabStatus, string> = {
  idle: 'tab.status.idle',
  connecting: 'tab.status.connecting',
  connected: 'tab.status.connected',
  reconnecting: 'tab.status.reconnecting',
  closed: 'tab.status.closed',
  error: 'tab.status.error'
}

function statusDefaultLabel(status: TabStatus): string {
  switch (status) {
    case 'idle':
      return 'Idle'
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'reconnecting':
      return 'Reconnecting'
    case 'closed':
      return 'Disconnected'
    default:
      return 'Error'
  }
}

export function TerminalTabStrip({ className, confirmOnClose = true }: TerminalTabStripProps): JSX.Element {
  const { t } = useTranslation()
  const tabs = useTabStore((state) => state.tabs)
  const activeTabId = useTabStore((state) => state.activeTabId)
  const closeTab = useTabStore((state) => state.closeTab)
  const activateTab = useTabStore((state) => state.activateTab)
  const moveTab = useTabStore((state) => state.moveTab)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerMode, setPickerMode] = useState<NewTabPickerMode>('hosts')
  const [pendingClose, setPendingClose] = useState<TerminalTab | null>(null)
  const [dragTabId, setDragTabId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  // 菜单「新建页签」由本组件应答：选择器就长在这里，别处再复制一份会开出两个面板
  useEffect(
    () =>
      registerTabCommandHooks({
        openNewTabPicker: (mode) => {
          setPickerMode(mode ?? 'hosts')
          setPickerOpen(true)
        }
      }),
    []
  )

  const requestClose = useCallback(
    (tabId: string) => {
      const decision = requestCloseTab(tabId, { confirmOnClose })
      if (decision.closed) {
        closeTab(tabId)
        setPendingClose(null)
        return
      }
      if (decision.reason === 'active-session') setPendingClose(decision.tab)
    },
    [closeTab, confirmOnClose]
  )

  // 页签全关掉后把焦点还给终端区，否则焦点停在已卸载的按钮上，键盘输入会「消失」
  useEffect(() => {
    if (tabs.length === 0) setPickerOpen(false)
  }, [tabs.length])

  return (
    <header
      className={['ts-tabstrip', className].filter(Boolean).join(' ')}
      data-testid="tab-strip"
    >
      <div className="ts-tabstrip__tabs" role="tablist">
        {tabs.map((tab, index) => {
          const statusLabel = t(`terminal:${STATUS_LABEL_KEY[tab.status]}`, {
            defaultValue: statusDefaultLabel(tab.status)
          })
          const isActive = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              title={`${tab.title} · ${statusLabel}`}
              data-testid={`tab-${tab.seq}`}
              data-tab-id={tab.id}
              data-status={tab.status}
              draggable
              className={[
                'ts-tab',
                isActive ? 'ts-tab--active' : '',
                dropIndex === index && dragTabId && dragTabId !== tab.id ? 'ts-tab--drop-target' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => activateTab(tab.id)}
              onDoubleClick={() => requestClose(tab.id)}
              onAuxClick={(event) => {
                // 中键关闭（Linux/Windows 用户的主力手势）
                if (event.button === 1) {
                  event.preventDefault()
                  requestClose(tab.id)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  activateTab(tab.id)
                }
                if (event.key === 'Delete') {
                  event.preventDefault()
                  requestClose(tab.id)
                }
              }}
              onDragStart={(event) => {
                setDragTabId(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                // Firefox 必须 setData 才会真的开始拖拽
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragOver={(event) => {
                if (!dragTabId) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropIndex(index)
              }}
              onDragEnd={() => {
                setDragTabId(null)
                setDropIndex(null)
              }}
              onDrop={(event) => {
                event.preventDefault()
                const movingId = dragTabId ?? event.dataTransfer.getData('text/plain')
                if (movingId) moveTab(movingId, index)
                setDragTabId(null)
                setDropIndex(null)
              }}
            >
              <span
                className={`ts-tab__dot ts-tab__dot--${tab.status}`}
                aria-label={statusLabel}
                role="img"
              />
              <span className="ts-tab__title">{tab.title}</span>
              {tab.unreadCount > 0 && (
                <span
                  className="ts-tab__unread"
                  data-testid={`tab-unread-${tab.seq}`}
                  aria-label={t('terminal:tab.unread', { count: tab.unreadCount, defaultValue: 'New output' })}
                >
                  {tab.unreadCount > 99 ? '99+' : tab.unreadCount}
                </span>
              )}
              <button
                type="button"
                className="ts-tab__close"
                data-testid={`tab-close-${tab.seq}`}
                aria-label={t('common:action.closeTab', { defaultValue: 'Close tab' })}
                onClick={(event) => {
                  event.stopPropagation()
                  requestClose(tab.id)
                }}
              >
                <X size={12} strokeWidth={2.4} />
              </button>
            </div>
          )
        })}
        {/* 新建按钮贴着最后一个页签；页签溢出滚动时靠 sticky 钉在页签条右端，
            不再飘在窗口最右上（审计 #1）。面板提到 header 层，避免被滚动容器裁掉。 */}
        <button
          type="button"
          className="ts-tabstrip__new ts-icon-btn"
          data-testid="tab-new"
          title={t('terminal:tab.new', { defaultValue: 'New tab' })}
          aria-label={t('terminal:tab.new', { defaultValue: 'New tab' })}
          aria-expanded={pickerOpen}
          aria-haspopup="dialog"
          onClick={() => setPickerOpen((open) => !open)}
        >
          <Plus size={15} strokeWidth={2.2} />
        </button>
      </div>

      {pickerOpen && <NewTabPicker initialMode={pickerMode} onClose={() => setPickerOpen(false)} />}

      {pendingClose && (
        <CloseTabDialog
          tab={pendingClose}
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            closeTab(pendingClose.id)
            setPendingClose(null)
          }}
        />
      )}
    </header>
  )
}
