import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Server, Zap } from 'lucide-react'
import { describeError, isNotImplemented } from '@renderer/platform/ipc'
import { getTabBackend, type HostOption } from './backend'
import { useTabStore } from './tab-store'

/**
 * 新建页签面板：主机库列表 + 快速连接。
 *
 * 快速连接为什么是「保存后连接」：shared 契约里 `SshConnectRequest` 只接受 `hostId`(uuid)，
 * 没有按地址连接的通道。所以这里先 `hosts:create`（顺带落进主机库，可再编辑），再按返回的 id 连接。
 * 若后端模块尚未接线（骨架期返回 E_NOT_IMPLEMENTED），界面给出明确提示而不是静默失败。
 */

export interface NewTabPickerProps {
  onClose: () => void
  /** 打开时落在哪个分页：空会话态的「快速连接」直接进 quick */
  initialMode?: Mode
}

type Mode = 'hosts' | 'quick'

export function NewTabPicker({ onClose, initialMode = 'hosts' }: NewTabPickerProps): JSX.Element {
  const { t } = useTranslation()
  const openTab = useTabStore((state) => state.openTab)
  const [mode, setMode] = useState<Mode>(initialMode)
  const [hosts, setHosts] = useState<HostOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [quick, setQuick] = useState({ hostname: '', port: '22', username: '' })
  const rootRef = useRef<HTMLDivElement>(null)

  const loadHosts = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setHosts(await getTabBackend().listHosts())
    } catch (cause) {
      setHosts([])
      setError(
        isNotImplemented(cause)
          ? t('terminal:tab.hosts.unavailable', {
              defaultValue: 'Host library is not wired up yet'
            })
          : describeError(cause)
      )
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadHosts()
  }, [loadHosts])

  // 点面板外部 / Esc 关闭：不做这层的话面板会一直悬在终端上挡输入
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  const openHostTab = (host: HostOption, origin: 'host' | 'quick'): void => {
    openTab({
      hostId: host.id,
      hostLabel: host.label,
      title: host.label,
      origin,
      status: 'connecting'
    })
    onClose()
  }

  const submitQuick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const host = await getTabBackend().createQuickHost({
        hostname: quick.hostname.trim(),
        port: Number.parseInt(quick.port, 10) || 22,
        username: quick.username.trim()
      })
      openHostTab(host, 'quick')
    } catch (cause) {
      setError(
        isNotImplemented(cause)
          ? t('terminal:tab.quickConnect.unavailable', {
              defaultValue: 'Quick connect needs the host library (not wired up yet)'
            })
          : describeError(cause)
      )
    } finally {
      setBusy(false)
    }
  }

  const filtered = hosts.filter((host) => {
    if (!filter.trim()) return true
    const needle = filter.trim().toLowerCase()
    return (
      host.label.toLowerCase().includes(needle) ||
      host.hostname.toLowerCase().includes(needle) ||
      host.username.toLowerCase().includes(needle)
    )
  })

  return (
    <div className="ts-picker" ref={rootRef} data-testid="new-tab-picker">
      <div className="ts-picker__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'hosts'}
          className={`ts-picker__tab${mode === 'hosts' ? ' ts-picker__tab--active' : ''}`}
          data-testid="picker-mode-hosts"
          onClick={() => setMode('hosts')}
        >
          <Server size={13} strokeWidth={2} />
          {t('terminal:tab.hosts.title', { defaultValue: 'Hosts' })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'quick'}
          className={`ts-picker__tab${mode === 'quick' ? ' ts-picker__tab--active' : ''}`}
          data-testid="picker-mode-quick"
          onClick={() => setMode('quick')}
        >
          <Zap size={13} strokeWidth={2} />
          {t('terminal:tab.quickConnect.title', { defaultValue: 'Quick connect' })}
        </button>
      </div>

      {error && (
        <p className="ts-picker__error" role="alert">
          {error}
        </p>
      )}

      {mode === 'hosts' ? (
        <>
          <input
            className="ts-field ts-picker__search"
            data-testid="picker-host-filter"
            placeholder={t('terminal:tab.hosts.filter', { defaultValue: 'Filter hosts' })}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="ts-picker__list">
            {loading && (
              <p className="ts-picker__empty">
                <Loader2 size={14} className="ts-spin" />
                {t('common:state.loading', { defaultValue: 'Loading…' })}
              </p>
            )}
            {!loading && filtered.length === 0 && (
              <p className="ts-picker__empty">
                {t('terminal:tab.hosts.empty', { defaultValue: 'No hosts yet — use Quick connect' })}
              </p>
            )}
            {filtered.map((host) => (
              <button
                key={host.id}
                type="button"
                className="ts-picker__host"
                data-testid={`picker-host-${host.hostname}`}
                onClick={() => openHostTab(host, 'host')}
              >
                <span
                  className="ts-picker__host-color"
                  style={host.color ? { background: host.color } : undefined}
                />
                <span className="ts-picker__host-label">{host.label}</span>
                <span className="ts-picker__host-meta">
                  {host.username}@{host.hostname}:{host.port}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <form
          className="ts-picker__form"
          onSubmit={(event) => {
            event.preventDefault()
            void submitQuick()
          }}
        >
          <label className="ts-field">
            <span>{t('terminal:tab.quickConnect.hostname', { defaultValue: 'Hostname' })}</span>
            <input
              required
              data-testid="quick-hostname"
              value={quick.hostname}
              onChange={(event) => setQuick((prev) => ({ ...prev, hostname: event.target.value }))}
              placeholder="example.com"
            />
          </label>
          <label className="ts-field">
            <span>{t('terminal:tab.quickConnect.port', { defaultValue: 'Port' })}</span>
            <input
              required
              inputMode="numeric"
              data-testid="quick-port"
              value={quick.port}
              onChange={(event) => setQuick((prev) => ({ ...prev, port: event.target.value }))}
            />
          </label>
          <label className="ts-field">
            <span>{t('terminal:tab.quickConnect.username', { defaultValue: 'Username' })}</span>
            <input
              required
              data-testid="quick-username"
              value={quick.username}
              onChange={(event) => setQuick((prev) => ({ ...prev, username: event.target.value }))}
            />
          </label>
          <button type="submit" className="ts-btn ts-btn--primary" disabled={busy} data-testid="quick-connect">
            {busy
              ? t('terminal:tab.quickConnect.busy', { defaultValue: 'Connecting…' })
              : t('terminal:tab.quickConnect.submit', { defaultValue: 'Save & connect' })}
          </button>
        </form>
      )}
    </div>
  )
}
