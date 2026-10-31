import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import { isIpcCallError } from '@shared'
import type { SettingsPatch } from '@shared'
import type { AiProvider } from '@shared/models/ai'
import { resolveReasoningMode, type ReasoningEffort } from '@shared/reasoning'
import { DEFAULT_SETTINGS } from '@shared/models/settings'
import { useShellStore } from '@renderer/app/store'
import { useAiStore } from '@renderer/features/ai/store'
import { call, describeError } from '@renderer/platform/ipc'
import '@renderer/features/ai/ai.css'
import { AddProviderCard, ProviderCard } from './ProviderCard'
import { ReasoningEffortControl } from './ReasoningEffortControl'

/**
 * 设置 → AI（r2 形态）：纵向单列四段
 *
 *   A0 总开关与披露 → A1 全局默认思考强度 → A2 供应商卡片列表 → A3 默认供应商 / 上下文行数
 *
 * 本组件只做**编排与全局设置写入**：卡片里的表单、模型清单、删除确认全在 `ProviderCard` 内部，
 * 这里只持有「哪一张展开」（`expandedId`）与供应商列表本身。r1 的「列表 + 下方单栏表单」
 * 之所以要拆开：改一个供应商要在上下两块之间来回对照，且列表行只显示名称，看不出这个供应商
 * 用哪个模型、key 配没配。
 *
 * 安全口径不变：key 只写不读 —— 输入框 `type="password"`、保存后立刻清空本地 state，
 * 界面永远只显示 `••••尾4位`。
 */

const MAX_CONTEXT_LINES = 500

type ProvidersState = 'loading' | 'ready' | 'locked' | 'error'
type ExpandedTarget = 'new' | string | null

export function AiSettings(): JSX.Element {
  const { t } = useTranslation(['settings', 'ai', 'common'])
  const ai = useShellStore((state) => state.settings.ai)

  const [providers, setProviders] = useState<AiProvider[]>([])
  const [providersState, setProvidersState] = useState<ProvidersState>('loading')
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<ExpandedTarget>(null)
  const [linesDraft, setLinesDraft] = useState(String(ai.contextLines))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<string | null>(null)

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

  /**
   * 供应商列表只有一个真源：主进程的加密包。任何增删改之后都重新读一次，
   * 并让右侧 AI 面板的选择器跟着刷新（`useAiStore.reloadProviders` 读的是同一个 `ai:list-providers`）。
   */
  const refreshProviders = useCallback(async (): Promise<void> => {
    await loadProviders()
    await useAiStore.getState().reloadProviders()
  }, [loadProviders])

  const patch = useCallback(async (next: SettingsPatch): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      // 把「AI 面板此刻是否展开」一起带上：`useShellStore.setSettings` 会用**落盘值**覆盖
      // `aiPanelVisible`，而面板开关只改内存态（`toggleAiPanel`）不落盘。若这里只提交 ai 字段，
      // 任何一次「在设置里改 AI」都会把已展开的面板重新判定成关闭（t47 实测：保存供应商后面板被关掉）。
      const visible = useShellStore.getState().aiPanelVisible
      const updated = await call('settings:update', { ...next, ui: { aiPanelVisible: visible } })
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

  // 一个供应商都没有时直接把新建卡摊开（空列表上的「添加」按钮会是多余的第二次点击）
  useEffect(() => {
    if (providersState === 'ready' && providers.length === 0) {
      setExpandedId((current) => (current === null ? 'new' : current))
    }
  }, [providers.length, providersState])

  // 删光之后新建卡重新自动展开
  useEffect(() => {
    if (expandedId !== null && expandedId !== 'new' && !providers.some((item) => item.id === expandedId)) {
      setExpandedId(null)
    }
  }, [expandedId, providers])

  const toggleExpanded = useCallback((target: 'new' | string): void => {
    setExpandedId((current) => (current === target ? null : target))
  }, [])

  const handleSaved = useCallback(
    async (saved: AiProvider): Promise<void> => {
      await refreshProviders()
      // 第一个供应商自动成为默认（否则用户还得去下面那个下拉框再选一次）
      if (ai.defaultProviderId === null) void patch({ ai: { defaultProviderId: saved.id } })
      setAnnouncement(t('ai:provider.saved'))
      setExpandedId(null)
    },
    [ai.defaultProviderId, patch, refreshProviders, t]
  )

  const handleDeleted = useCallback(
    async (providerId: string): Promise<void> => {
      const wasDefault = ai.defaultProviderId === providerId
      await refreshProviders()
      setExpandedId(null)
      setAnnouncement(t('ai:provider.deleted'))
      if (wasDefault) void patch({ ai: { defaultProviderId: null } })
    },
    [ai.defaultProviderId, patch, refreshProviders, t]
  )

  const makeDefault = useCallback(
    (providerId: string): void => {
      void patch({ ai: { defaultProviderId: providerId } })
    },
    [patch]
  )

  const effort = ai.reasoningEffort
  /**
   * 支持度由 shared 的映射表算好再传下去：UI 不重复判定协议（AC-9 单点）。
   * 默认供应商决定「这一档会不会真的发出去」，因此跟着默认供应商走而不是当前展开的卡片。
   *
   * 未设默认供应商时必须传 null（TECHNICAL §4.2 契约 + §5 行为表：`null = 未设置默认供应商`，
   * 只显示「还没有默认供应商」一行提示，不显示「已忽略」）。这里**不能**回退到 `providers[0]`：
   * 主进程并不按「列表第一家」发请求（`src/renderer/features/ai/AiPanel.tsx:118-125` 只在
   * defaultProviderId 非空时 setActiveProvider），回退会把警告错误地挂到一家并未生效的供应商名下。
   */
  const effortSupport = useMemo(() => {
    const provider =
      ai.defaultProviderId === null
        ? undefined
        : providers.find((item) => item.id === ai.defaultProviderId)
    if (!provider) return null
    const plan = resolveReasoningMode({ kind: provider.kind, baseUrl: provider.baseUrl })
    return { providerName: provider.name, supported: plan.mode !== 'none' }
  }, [ai.defaultProviderId, providers])

  const handleEffortChange = useCallback(
    (level: ReasoningEffort): void => {
      if (level === ai.reasoningEffort) return
      void patch({ ai: { reasoningEffort: level } })
      setAnnouncement(t('settings:ai.reasoningEffort.saved', { level: t(`settings:ai.reasoningEffort.${level}`) }))
    },
    [ai.reasoningEffort, patch, t]
  )

  /* 出错时思考强度仍然可见（它和供应商读取失败无关），锁定态不拦它：档位存在 settings 里，不在加密包 */
  const canEdit = providersState === 'ready' || providersState === 'locked'
  const hasDraft = expandedId === 'new'

  const globalEffortRef = useRef<HTMLDivElement>(null)

  /** 卡片里「去全局设置」的唯一实现：滚到 A1 并把当前档位的单选项聚焦（跨组件 DOM 查询已移除） */
  const revealGlobalEffort = useCallback((): void => {
    const host = globalEffortRef.current
    if (!host) return
    host.scrollIntoView({ block: 'center' })
    host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus()
  }, [])

  return (
    <section className="ts-settings__section ts-ai-settings" data-testid="ai-settings">
      {/* A0 总开关 */}
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

      {/* A1 全局默认思考强度。ref 供卡片里的「去全局设置」跳转用：
          跳转由本组件提供，卡片不再自己去 document 里 querySelector 别人的 DOM。 */}
      <div className="ts-settings__field" ref={globalEffortRef}>
        <ReasoningEffortControl
          value={effort}
          disabled={saving}
          onChange={handleEffortChange}
          support={effortSupport}
        />
        <p className="ts-settings__hint" data-testid="ai-reasoning-effort-hint">
          {t('settings:ai.reasoningEffort.hint')}
        </p>
      </div>

      {/* A2 供应商卡片列表 */}
      <div className="ts-settings__field">
        <div className="ts-settings__row">
          <span className="ts-settings__label">
            {t('settings:ai.providers.label')}
            {providers.length > 0 ? (
              <span className="ts-ai-provider-count" data-testid="ai-providers-count">
                {t('ai:provider.count', { count: providers.length })}
              </span>
            ) : null}
          </span>
        </div>

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
          <p className="ts-settings__hint" data-testid="ai-providers-empty">
            {t('settings:ai.provider.empty')}
          </p>
        ) : null}

        {providersState === 'locked' || providersState === 'error' ? (
          <div className="ts-settings__actions">
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="ai-providers-retry"
              onClick={() => void loadProviders()}
            >
              <RotateCw size={13} aria-hidden="true" />
              {t('common:action.retry')}
            </button>
          </div>
        ) : null}

        {/* 卡片列表 + 新建卡同一个容器：`ai-provider-form` 是面板/测试定位这块区域的锚点，
            保存后新出现的卡片也必须落在它内部（e2e 与人工检查都按这个范围找）。 */}
        <div className="ts-ai-provider-form" data-testid="ai-provider-form">
          <ul className="ts-ai-provider-cards" data-testid="ai-provider-list">
            {providers.map((provider) => (
              <li key={provider.id}>
                <ProviderCard
                  provider={provider}
                  expanded={expandedId === provider.id}
                  isDefault={ai.defaultProviderId === provider.id}
                  effort={effort}
                  onToggle={() => toggleExpanded(provider.id)}
                  onSaved={(saved) => void handleSaved(saved)}
                  onDeleted={(providerId) => void handleDeleted(providerId)}
                  onMakeDefault={makeDefault}
                  onRefresh={() => void refreshProviders()}
                  onRevealGlobalEffort={revealGlobalEffort}
                />
              </li>
            ))}
            {hasDraft ? (
              <li>
                <ProviderCard
                  provider={null}
                  expanded
                  isDefault={false}
                  effort={effort}
                  onToggle={() => toggleExpanded('new')}
                  onSaved={(saved) => void handleSaved(saved)}
                  onDeleted={() => undefined}
                  onMakeDefault={() => undefined}
                  onRefresh={() => void refreshProviders()}
                />
              </li>
            ) : null}
          </ul>

          {hasDraft ? null : (
            <AddProviderCard onClick={() => setExpandedId('new')} disabled={!canEdit || saving} />
          )}
        </div>
        <p className="ts-settings__hint">{t('settings:ai.providers.hint')}</p>
      </div>

      {/* A3 默认供应商 / 上下文行数 */}
      <div className="ts-settings__field">
        <label className="ts-settings__label" htmlFor="ts-ai-provider">
          {t('settings:ai.provider.label')}
        </label>
        <select
          id="ts-ai-provider"
          className="ts-settings__select"
          data-testid="ai-default-provider"
          value={ai.defaultProviderId ?? ''}
          disabled={saving || providers.length === 0}
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
          {t('settings:ai.contextLines.hint', {
            max: MAX_CONTEXT_LINES,
            fallback: DEFAULT_SETTINGS.ai.contextLines
          })}
        </p>
      </div>

      {announcement ? (
        <p className="ts-visually-hidden" role="status" aria-live="polite" data-testid="ai-settings-status">
          {announcement}
        </p>
      ) : null}

      {saveError ? (
        <p className="ts-settings__error" role="alert" data-testid="ai-settings-error">
          {saveError}
        </p>
      ) : null}
    </section>
  )
}
