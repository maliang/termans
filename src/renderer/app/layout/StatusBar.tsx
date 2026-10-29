import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch, Lock, LockOpen } from 'lucide-react'
import { SettingsButton } from '@renderer/theme/SettingsDialogHost'
import { SessionStatus } from '@renderer/features/terminal/SessionStatus'
import { useTabStore } from '@renderer/features/tabs/tab-store'
import { SyncPanel, useVaultStore } from '@renderer/features/vault'
import type { SyncState } from '@shared'
import { useShellStore } from '../store'
import './statusbar.css'

/**
 * 底部状态条。
 *
 * 审计 #3 的整改：原来是一行到底的一串文字（版本号和「同步未开启」同权重，
 * 扫不出重点）。现在按**语义分三段**，段间用 1px 分隔线：
 *
 *   左  会话：当前页签的主机 · 列×行 · 渲染器 · 连接态（来自 terminal feature 的 SessionStatus）
 *   中  加密包：解锁态；同步：状态（未开启/已同步/有改动待推/有更新待拉/冲突/失败）——**可点**，
 *       点开 Git 同步面板；冲突与失败换色，因为它们是「该行动了」的告警
 *   右  页签数 · 版本号（弱化）· AI 开关 · 设置；最近错误仍在最右（role=alert）
 *
 * 数据来源按模块归属分开取，外壳里不复制业务状态：
 * - 版本/平台/加密包状态/最近错误：`useShellStore`
 * - 页签数：`useTabStore`；会话串：`SessionStatus`（tabs + session store）
 * - 同步状态：`useVaultStore.syncStatus`
 */

/** 同步状态的语气：只有「冲突/失败」才用错误色，否则告警色会把正常状态也弄得像出事了 */
function syncTone(state: SyncState | null): 'off' | 'ok' | 'busy' | 'warn' | 'error' {
  switch (state) {
    case 'idle':
      return 'ok'
    case 'syncing':
      return 'busy'
    case 'ahead':
    case 'behind':
      return 'warn'
    case 'diverged':
    case 'error':
      return 'error'
    default:
      return 'off'
  }
}

export function StatusBar(): JSX.Element {
  const { t } = useTranslation(['common', 'sync', 'ai'])
  const appInfo = useShellStore((state) => state.appInfo)
  const vault = useShellStore((state) => state.vault)
  const lastError = useShellStore((state) => state.lastError)
  const aiPanelVisible = useShellStore((state) => state.aiPanelVisible)
  const toggleAiPanel = useShellStore((state) => state.toggleAiPanel)
  const tabCount = useTabStore((state) => state.tabs.length)
  const syncStatus = useVaultStore((state) => state.syncStatus)
  const conflictCount = useVaultStore((state) => state.conflicts.length)
  const [syncOpen, setSyncOpen] = useState(false)

  const syncState: SyncState | null = syncStatus?.state ?? null
  const tone = conflictCount > 0 ? 'error' : syncTone(syncState)
  const vaultUnlocked = vault === 'unlocked'

  // 同步状态的文案在 `vaultsync` 里（7 个状态齐全）；`sync:status.*` 只有 off/idle，
  // 用它会在 ahead/behind/diverged 时把原始 key 露到界面上。
  const syncLabel = t(`vaultsync:sync.state.${syncState ?? 'off'}`, { defaultValue: syncState ?? 'off' })

  return (
    <>
      <footer className="ts-statusbar" data-testid="status-bar">
        <div className="ts-statusbar__segment">
          <SessionStatus />
        </div>

        <span className="ts-statusbar__sep" aria-hidden="true" />

        <div className="ts-statusbar__segment">
          <span
            className={`ts-statusbar__item ts-statusbar__item--${vaultUnlocked ? 'ok' : 'warn'}`}
            data-testid="status-vault"
            title={t('common:state.vault', { state: vault })}
          >
            {vaultUnlocked ? (
              <LockOpen size={11} aria-hidden="true" />
            ) : (
              <Lock size={11} aria-hidden="true" />
            )}
            {t('common:state.vault', { state: vault })}
          </span>

          <button
            type="button"
            className={`ts-statusbar__action ts-statusbar__action--${tone}`}
            data-testid="status-sync"
            data-state={syncState ?? 'off'}
            data-conflicts={conflictCount}
            title={
              vaultUnlocked ? syncLabel : t('common:state.vault', { state: vault })
            }
            disabled={!vaultUnlocked}
            onClick={() => setSyncOpen(true)}
          >
            <GitBranch size={11} aria-hidden="true" />
            {syncLabel}
            {conflictCount > 0 ? <span className="ts-statusbar__badge">{conflictCount}</span> : null}
          </button>
        </div>

        <span className="ts-statusbar__spacer" />

        <div className="ts-statusbar__segment ts-statusbar__segment--end">
          <span className="ts-statusbar__item" data-testid="status-tabs">
            {t('common:state.tabs', { count: tabCount })}
          </span>
          <span className="ts-statusbar__version" data-testid="status-version">
            {appInfo ? `Termans ${appInfo.version} · ${appInfo.platform}/${appInfo.arch}` : t('common:state.loading')}
          </span>
          <button
            type="button"
            className="ts-statusbar__action ts-statusbar__action--toggle"
            data-testid="status-toggle-ai"
            aria-pressed={aiPanelVisible}
            title={t('ai:panel.title')}
            onClick={toggleAiPanel}
          >
            AI
          </button>
          <SettingsButton />
        </div>

        {lastError ? (
          <span className="ts-statusbar__item ts-statusbar__item--error" role="alert" data-testid="status-error">
            {lastError}
          </span>
        ) : null}
      </footer>

      {/*
        同步面板从两个地方打开：侧栏底部按钮（vault feature 内部状态）和这里。
        复用同一个公开组件而不是自己拼一份 UI —— 内容、冲突逐条选边、凭据清除都只有一套实现。
      */}
      {syncOpen ? <SyncPanel onClose={() => setSyncOpen(false)} /> : null}
    </>
  )
}
