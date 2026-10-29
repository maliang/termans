import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isIpcCallError } from '@shared'
import type { AiProvider } from '@shared/models/ai'
import type { SettingsPatch } from '@shared'
import { useShellStore } from '@renderer/app/store'
import { useAiStore } from '@renderer/features/ai/store'
import { call, describeError } from '@renderer/platform/ipc'
import { closeSettingsDialog } from './settings-dialog'

/**
 * 设置 → AI：总开关、默认供应商、终端上下文行数。
 *
 * 为什么这三项必须在这里（历史缺口）：`AiService.chat` 在 `settings.ai.enabled === false` 时
 * 以 `E_AI_PROVIDER`「AI 辅助未启用」硬拒，而设置对话框原先只有「外观」一页 —— 用户把供应商与
 * key 都配好了仍然发不出消息。t7 曾在主进程接线层「首次保存供应商就偷偷把 enabled 置 true」
 * 兜住这个缺口（等于替用户做安全决定）。本页补齐后那段兜底已删除，开关只由用户操作。
 *
 * 供应商列表来自 `ai:list-providers`（真身在加密包）：加密包锁定时读不出来，这是正常状态，
 * 不应该渲染成红色错误 —— 提示「解锁后可选」并给一次重试入口。
 */

/** 与 `aiSettingsSchema.contextLines` 的 max 保持一致（契约改动要同步这里） */
const MAX_CONTEXT_LINES = 500
/** 默认值来自 DEFAULT_SETTINGS.ai.contextLines；页面上要显式告诉用户「没调过就是 200」 */
const DEFAULT_CONTEXT_LINES = 200

type ProvidersState = 'loading' | 'ready' | 'locked' | 'error'

export function AiSettings(): JSX.Element {
  const { t } = useTranslation(['settings', 'ai', 'common'])
  const ai = useShellStore((state) => state.settings.ai)

  const [providers, setProviders] = useState<AiProvider[]>([])
  const [providersState, setProvidersState] = useState<ProvidersState>('loading')
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [linesDraft, setLinesDraft] = useState(String(ai.contextLines))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const loadProviders = useCallback(async (): Promise<void> => {
    setProvidersState('loading')
    try {
      const result = await call('ai:list-providers')
      setProviders(result.providers)
      setProvidersError(null)
      setProvidersState('ready')
    } catch (error) {
      setProviders([])
      setProvidersError(describeError(error))
      setProvidersState(isIpcCallError(error) && error.code === 'E_VAULT_LOCKED' ? 'locked' : 'error')
    }
  }, [])

  useEffect(() => {
    void loadProviders()
  }, [loadProviders])

  // 外部改了设置（另一个窗口、设置页别的入口）时把输入框对齐回来
  useEffect(() => {
    setLinesDraft(String(ai.contextLines))
  }, [ai.contextLines])

  const patch = useCallback(async (next: SettingsPatch): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await call('settings:update', next)
      // 主进程同时会广播 settings:changed（App 订阅），这里直接写一次让 UI 立刻反映，不等事件回路
      useShellStore.getState().setSettings(updated)
    } catch (error) {
      setSaveError(describeError(error))
    } finally {
      setSaving(false)
    }
  }, [])

  const commitContextLines = useCallback((): void => {
    const parsed = Number.parseInt(linesDraft, 10)
    const clamped = Number.isNaN(parsed) ? ai.contextLines : Math.min(MAX_CONTEXT_LINES, Math.max(0, parsed))
    setLinesDraft(String(clamped))
    if (clamped !== ai.contextLines) void patch({ ai: { contextLines: clamped } })
  }, [ai.contextLines, linesDraft, patch])

  /** 面板藏起来时用户找不到「去哪儿加供应商」，这里替他打开 AI 面板并切到供应商页 */
  const openAiProviders = useCallback((): void => {
    useAiStore.getState().setView('providers')
    closeSettingsDialog()
    void patch({ ui: { aiPanelVisible: true } })
  }, [patch])

  const providersUsable = providersState === 'ready' && providers.length > 0

  return (
    <section className="ts-settings__section" data-testid="ai-settings">
      <div className="ts-settings__field">
        <label className="ts-settings__checkbox">
          <input
            type="checkbox"
            data-testid="ai-enabled-toggle"
            checked={ai.enabled}
            disabled={saving}
            onChange={(event) => void patch({ ai: { enabled: event.target.checked } })}
          />
          <span>{t('settings:ai.enabled')}</span>
        </label>
        <p className="ts-settings__hint" data-testid="ai-enabled-hint">
          {t('settings:ai.enabledHint')}
        </p>
        <p className="ts-settings__warning" data-testid="ai-disclosure">
          {t('settings:ai.disclosure')}
        </p>
      </div>

      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-ai-provider">
          {t('settings:ai.provider.label')}
        </label>
        <select
          id="ts-ai-provider"
          className="ts-settings__select"
          data-testid="ai-default-provider"
          value={ai.defaultProviderId ?? ''}
          disabled={saving || !providersUsable}
          onChange={(event) =>
            void patch({ ai: { defaultProviderId: event.target.value === '' ? null : event.target.value } })
          }
        >
          <option value="">{t('settings:ai.provider.none')}</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} · {provider.model}
            </option>
          ))}
        </select>
        <p className="ts-settings__hint">{t('settings:ai.provider.hint')}</p>

        {providersState === 'loading' ? (
          <p className="ts-settings__hint" data-testid="ai-providers-loading">
            {t('common:state.loading')}
          </p>
        ) : null}

        {providersState === 'locked' ? (
          <p className="ts-settings__hint" data-testid="ai-providers-locked">
            {t('settings:ai.provider.locked')}
          </p>
        ) : null}

        {providersState === 'error' ? (
          <p className="ts-settings__warning" data-testid="ai-providers-error">
            {t('settings:ai.provider.loadFailed', { detail: providersError ?? '' })}
          </p>
        ) : null}

        {providersState === 'ready' && providers.length === 0 ? (
          <div className="ts-settings__actions">
            <span className="ts-settings__hint" data-testid="ai-providers-empty">
              {t('settings:ai.provider.empty')}
            </span>
            <button type="button" className="ts-btn" data-testid="ai-providers-add" onClick={openAiProviders}>
              {t('settings:ai.provider.add')}
            </button>
          </div>
        ) : null}

        {providersState === 'locked' || providersState === 'error' ? (
          <div className="ts-settings__actions">
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="ai-providers-retry"
              onClick={() => void loadProviders()}
            >
              {t('common:action.retry')}
            </button>
          </div>
        ) : null}
      </div>

      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-ai-context-lines">
          {t('settings:ai.contextLines.label')}
        </label>
        <input
          id="ts-ai-context-lines"
          type="number"
          min={0}
          max={MAX_CONTEXT_LINES}
          step={50}
          className="ts-settings__input"
          data-testid="ai-context-lines"
          value={linesDraft}
          disabled={saving}
          onChange={(event) => setLinesDraft(event.target.value)}
          onBlur={commitContextLines}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitContextLines()
          }}
        />
        <p className="ts-settings__hint" data-testid="ai-context-lines-hint">
          {t('settings:ai.contextLines.hint', { max: MAX_CONTEXT_LINES, fallback: DEFAULT_CONTEXT_LINES })}
        </p>
      </div>

      {saveError ? (
        <p className="ts-settings__error" role="alert" data-testid="ai-settings-error">
          {saveError}
        </p>
      ) : null}
    </section>
  )
}
