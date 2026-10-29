import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Plus,
  PlugZap,
  RotateCw,
  Save,
  Trash2,
  XCircle
} from 'lucide-react'
import { isIpcCallError } from '@shared'
import type { SettingsPatch } from '@shared'
import type { AiProvider, AiProviderInput, AiProviderKind } from '@shared/models/ai'
import { useShellStore } from '@renderer/app/store'
import * as aiApi from '@renderer/features/ai/api'
import { PROVIDER_PRESETS, findPreset, matchPresetByBaseUrl, presetToInput } from '@renderer/features/ai/presets'
import { useAiStore } from '@renderer/features/ai/store'
import { call, describeError } from '@renderer/platform/ipc'
import '@renderer/features/ai/ai.css'

/**
 * 设置 → AI：总开关、供应商（增删改 / 默认 / 测试连接 / API key）、终端上下文行数。
 *
 * 为什么供应商配置必须在这里（历史缺口，两次搬家）：
 * 1. `AiService.chat` 在 `settings.ai.enabled === false` 时以 `E_AI_PROVIDER`「AI 辅助未启用」硬拒，
 *    而设置对话框原先只有「外观」一页 —— 用户配好供应商与 key 仍发不出消息。t7 曾在主进程接线层
 *    「首次保存供应商就偷偷把 enabled 置 true」兜住这个缺口（等于替用户做安全决定），t19 补齐本页后删除。
 * 2. 供应商 CRUD 原在右侧 AI 面板的「供应商」视图里：面板是临时浮层，配 key 这种一次性动作藏在
 *    里面既难找、又把面板撑成了半个设置页。t47 把它搬回设置页，面板只留「在设置中管理」入口。
 *
 * 安全：key 只写不读 —— 输入框 `type="password"`、保存后立即清空本地 state，界面永远只显示
 * `••••尾4位`（`aiApi.maskFromKeyRef`）。主进程写进加密包，渲染层不缓存、不进日志、不进提示词。
 */

/** 与 `aiSettingsSchema.contextLines` 的 max 保持一致（契约改动要同步这里） */
const MAX_CONTEXT_LINES = 500
/** 默认值来自 DEFAULT_SETTINGS.ai.contextLines；页面上要显式告诉用户「没调过就是 200」 */
const DEFAULT_CONTEXT_LINES = 200

const KINDS: AiProviderKind[] = ['openai', 'openai-compatible', 'anthropic', 'ollama']

type ProvidersState = 'loading' | 'ready' | 'locked' | 'error'

interface FormState {
  kind: AiProviderKind
  name: string
  baseUrl: string
  model: string
  temperature: string
  maxTokens: string
  enabled: boolean
  headersText: string
  apiKeyRef: string | null
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers) return ''
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function parseHeaders(text: string): { headers: Record<string, string>; error: string | null } {
  const headers: Record<string, string> = {}
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index <= 0) return { headers: {}, error: `HEADER_FORMAT:${line}` }
    const name = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (!/^[A-Za-z0-9-]+$/.test(name)) return { headers: {}, error: `HEADER_NAME:${name}` }
    headers[name] = value
  }
  return { headers, error: null }
}

function draftFromPreset(presetId?: string): FormState {
  const preset = (presetId ? findPreset(presetId) : undefined) ?? PROVIDER_PRESETS[0]
  const input = presetToInput(preset)
  return {
    kind: input.kind,
    name: input.name,
    baseUrl: input.baseUrl,
    model: input.model,
    temperature: String(input.temperature),
    maxTokens: String(input.maxTokens),
    enabled: true,
    headersText: headersToText(preset.extraHeaders),
    apiKeyRef: null
  }
}

function draftFromProvider(provider: AiProvider): FormState {
  // headers 是 `ai:save-provider` 的可选扩展字段（不进 `AiProvider` 契约），由主进程随供应商文档存回
  const headers = (provider as AiProvider & { headers?: Record<string, string> }).headers
  return {
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    temperature: String(provider.temperature),
    maxTokens: String(provider.maxTokens),
    enabled: provider.enabled,
    headersText: headersToText(headers),
    apiKeyRef: provider.apiKeyRef
  }
}

export function AiSettings(): JSX.Element {
  const { t } = useTranslation(['settings', 'ai', 'common'])
  const ai = useShellStore((state) => state.settings.ai)

  const [providers, setProviders] = useState<AiProvider[]>([])
  const [providersState, setProvidersState] = useState<ProvidersState>('loading')
  const [providersError, setProvidersError] = useState<string | null>(null)
  const [linesDraft, setLinesDraft] = useState(String(ai.contextLines))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // 供应商编辑态
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(() => draftFromPreset())
  const [presetId, setPresetId] = useState<string>(PROVIDER_PRESETS[0].id)
  const [apiKey, setApiKey] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

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
   * 并让右侧 AI 面板的选择器跟着刷新（`useAiStore.reloadProviders` 读的是同一个 `ai:list-providers`），
   * 不在这里造第二份状态 —— 否则面板与设置页会各显示一套「以为存在」的供应商。
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
      // 任何一次「在设置里改 AI」都会把已展开的面板重新判定成关闭 —— e2e 里表现为
      // 面板连同 `.ts-ai-context__toggle` 直接消失（t47 实测：保存供应商后面板被关掉）。
      // 只写这一个 ui 字段，不碰用户的其他界面偏好。
      const visible = useShellStore.getState().aiPanelVisible
      const updated = await call('settings:update', { ...next, ui: { aiPanelVisible: visible } })
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

  const startCreate = useCallback((nextPresetId?: string): void => {
    const id = nextPresetId ?? PROVIDER_PRESETS[0].id
    setPresetId(id)
    setEditingId(null)
    setForm(draftFromPreset(id))
    setApiKey('')
    setKeyVisible(false)
    setConfirmDelete(false)
    setMessage(null)
    setEditorOpen(true)
  }, [])

  const startEdit = useCallback((provider: AiProvider): void => {
    setEditingId(provider.id)
    setForm(draftFromProvider(provider))
    setPresetId(matchPresetByBaseUrl(provider.baseUrl)?.id ?? 'custom')
    setApiKey('')
    setKeyVisible(false)
    setConfirmDelete(false)
    setMessage(null)
    setEditorOpen(true)
  }, [])

  // 一个供应商都没有时，直接把新建表单摊开（验收要求 5：不许再「点一下被踢到别处」）
  useEffect(() => {
    if (providersState === 'ready' && providers.length === 0 && !editorOpen) {
      startCreate()
    }
  }, [providers.length, providersState, editorOpen, startCreate])

  const applyPreset = useCallback((nextPresetId: string): void => {
    setPresetId(nextPresetId)
    const preset = findPreset(nextPresetId)
    if (!preset) return
    const input = presetToInput(preset)
    setForm((current) => ({
      ...current,
      kind: input.kind,
      name: current.name.trim().length > 0 && current.name !== PROVIDER_PRESETS[0].name ? current.name : preset.name,
      baseUrl: input.baseUrl,
      model: input.model,
      headersText: headersToText(preset.extraHeaders)
    }))
  }, [])

  const modelOptions = useMemo(() => {
    const matched = matchPresetByBaseUrl(form.baseUrl)
    return matched?.models ?? []
  }, [form.baseUrl])

  const handleSave = useCallback(async (): Promise<void> => {
    const parsed = parseHeaders(form.headersText)
    if (parsed.error) {
      setMessage({ kind: 'error', text: parsed.error })
      return
    }
    const temperature = Number(form.temperature)
    const maxTokens = Number(form.maxTokens)
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setMessage({ kind: 'error', text: t('ai:provider.error.temperature') })
      return
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 200000) {
      setMessage({ kind: 'error', text: t('ai:provider.error.maxTokens') })
      return
    }
    const input: AiProviderInput = {
      id: editingId ?? 'new',
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      apiKeyRef: form.apiKeyRef,
      temperature,
      maxTokens,
      enabled: form.enabled
    }
    if (input.name.length === 0) {
      setMessage({ kind: 'error', text: t('ai:provider.error.name') })
      return
    }
    if (input.model.length === 0) {
      setMessage({ kind: 'error', text: t('ai:provider.error.model') })
      return
    }

    setBusy('save')
    setMessage(null)
    try {
      const saved = await aiApi.saveProvider(input, {
        headers: Object.keys(parsed.headers).length > 0 ? parsed.headers : undefined,
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined
      })
      setApiKey('')
      setEditingId(saved.id)
      setForm(draftFromProvider(saved))
      setConfirmDelete(false)
      setMessage({ kind: 'ok', text: t('ai:provider.saved') })
      await refreshProviders()
      // 第一个供应商自动成为默认（否则用户还得去下面那个下拉框再选一次）
      if (ai.defaultProviderId === null) {
        void patch({ ai: { defaultProviderId: saved.id } })
      }
      useAiStore.getState().setActiveProvider(saved.id)
    } catch (error) {
      setMessage({ kind: 'error', text: describeError(error) })
    } finally {
      setBusy(null)
    }
  }, [ai.defaultProviderId, apiKey, editingId, form, patch, refreshProviders, t])

  const handleTest = useCallback(async (): Promise<void> => {
    if (!editingId) {
      setMessage({ kind: 'error', text: t('ai:provider.test.saveFirst') })
      return
    }
    setBusy('test')
    setMessage(null)
    try {
      const result = await aiApi.testProvider(editingId)
      setMessage({ kind: result.ok ? 'ok' : 'error', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: describeError(error) })
    } finally {
      setBusy(null)
    }
  }, [editingId, t])

  const handleDelete = useCallback(async (): Promise<void> => {
    if (!editingId) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy('delete')
    setMessage(null)
    try {
      await aiApi.deleteProvider(editingId)
      const wasDefault = ai.defaultProviderId === editingId
      setConfirmDelete(false)
      setEditingId(null)
      setForm(draftFromPreset())
      setEditorOpen(false)
      setMessage({ kind: 'ok', text: t('ai:provider.deleted') })
      await refreshProviders()
      if (wasDefault) void patch({ ai: { defaultProviderId: null } })
    } catch (error) {
      setMessage({ kind: 'error', text: describeError(error) })
    } finally {
      setBusy(null)
    }
  }, [ai.defaultProviderId, confirmDelete, editingId, patch, refreshProviders, t])

  const handleClearKey = useCallback(async (): Promise<void> => {
    if (!editingId) return
    setBusy('save')
    setMessage(null)
    try {
      await aiApi.clearApiKey(editingId)
      setMessage({ kind: 'ok', text: t('ai:provider.keyCleared') })
      await refreshProviders()
      const refreshed = (await call('ai:list-providers')).providers.find((item) => item.id === editingId)
      if (refreshed) setForm(draftFromProvider(refreshed))
    } catch (error) {
      setMessage({ kind: 'error', text: describeError(error) })
    } finally {
      setBusy(null)
    }
  }, [editingId, refreshProviders, t])

  const makeDefault = useCallback(
    (providerId: string): void => {
      void patch({ ai: { defaultProviderId: providerId } })
    },
    [patch]
  )

  const canEdit = providersState === 'ready'
  const keyMask = aiApi.maskFromKeyRef(form.apiKeyRef)

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
        <div className="ts-settings__row ts-settings__row--split">
          <span className="ts-settings__label">{t('settings:ai.providers.label')}</span>
          <button
            type="button"
            className="ts-btn ts-btn--ghost"
            data-testid="ai-providers-add"
            disabled={!canEdit || busy !== null}
            onClick={() => startCreate()}
          >
            <Plus size={14} aria-hidden="true" />
            {t('settings:ai.providers.add')}
          </button>
        </div>
        <p className="ts-settings__hint">{t('settings:ai.providers.hint')}</p>

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

        {/* 列表 + 编辑器同一个容器：`ai-provider-form` 是面板/测试定位这块区域的锚点，
            保存后新出现的供应商条目也必须落在它内部（e2e 与人工检查都按这个范围找）。 */}
        <div className="ts-ai-provider-manager" data-testid="ai-provider-form">
          {providers.length > 0 ? (
            <ul className="ts-ai-form__list" data-testid="ai-provider-list">
              {providers.map((provider) => {
                const isDefault = ai.defaultProviderId === provider.id
                const mask = aiApi.maskFromKeyRef(provider.apiKeyRef) ?? t('ai:provider.list.noKey')
                return (
                  <li key={provider.id} className="ts-ai-provider-row" data-testid={`ai-provider-item-${provider.id}`}>
                    <button
                      type="button"
                      className={
                        provider.id === editingId ? 'ts-ai-form__item is-active' : 'ts-ai-form__item'
                      }
                      onClick={() => startEdit(provider)}
                    >
                      {/* 可访问名以「名称 」开头：外部用例与读屏都靠这个前缀认人 */}
                      <span className="ts-ai-form__item-name">{provider.name} </span>
                      <span className="ts-ai-form__item-model">{provider.model}</span>
                      <span className="ts-ai-form__item-key">{mask}</span>
                      {isDefault ? (
                        <span className="ts-ai-form__badge" data-testid="ai-provider-default-badge">
                          {t('settings:ai.providers.isDefault')}
                        </span>
                      ) : null}
                      {provider.enabled ? null : (
                        <span className="ts-ai-form__badge">{t('settings:ai.providers.disabled')}</span>
                      )}
                    </button>
                    {isDefault ? null : (
                      <button
                        type="button"
                        className="ts-btn ts-btn--ghost ts-ai-provider-row__default"
                        data-testid={`ai-provider-make-default-${provider.id}`}
                        disabled={saving}
                        onClick={() => makeDefault(provider.id)}
                      >
                        {t('settings:ai.providers.makeDefault')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : null}

          {editorOpen && canEdit ? (
            <div className="ts-ai-form" data-testid="ai-provider-editor">
              <div className="ts-ai-form__row">
                <label className="ts-field">
                  <span className="ts-field__label">{t('ai:provider.field.preset')}</span>
                  <select
                    className="ts-settings__select"
                    data-testid="ai-provider-preset"
                    value={presetId}
                    onChange={(event) => applyPreset(event.target.value)}
                  >
                    {PROVIDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name}
                      </option>
                    ))}
                    <option value="custom">{t('ai:provider.preset.custom')}</option>
                  </select>
                </label>
                <label className="ts-field">
                  <span className="ts-field__label">{t('ai:provider.field.kind')}</span>
                  <select
                    className="ts-settings__select"
                    data-testid="ai-provider-kind"
                    value={form.kind}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, kind: event.target.value as AiProviderKind }))
                    }
                  >
                    {KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {t(`ai:provider.kind.${kind}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="ts-field">
                <span className="ts-field__label">{t('ai:provider.field.name')}</span>
                <input
                  className="ts-settings__input"
                  data-testid="ai-provider-name"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                />
              </label>

              <label className="ts-field">
                <span className="ts-field__label">{t('ai:provider.field.baseUrl')}</span>
                <input
                  className="ts-settings__input"
                  data-testid="ai-provider-base-url"
                  spellCheck={false}
                  value={form.baseUrl}
                  onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                />
              </label>

              <label className="ts-field">
                <span className="ts-field__label">{t('ai:provider.field.model')}</span>
                <input
                  className="ts-settings__input"
                  data-testid="ai-provider-model"
                  list="ts-ai-provider-models"
                  spellCheck={false}
                  value={form.model}
                  onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                />
                <datalist id="ts-ai-provider-models">
                  {modelOptions.map((model) => (
                    <option key={model} value={model} />
                  ))}
                </datalist>
              </label>

              <div className="ts-ai-form__row">
                <label className="ts-field">
                  <span className="ts-field__label">{t('ai:provider.field.temperature')}</span>
                  <input
                    className="ts-settings__input"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.temperature}
                    onChange={(event) => setForm((current) => ({ ...current, temperature: event.target.value }))}
                  />
                </label>
                <label className="ts-field">
                  <span className="ts-field__label">{t('ai:provider.field.maxTokens')}</span>
                  <input
                    className="ts-settings__input"
                    type="number"
                    min={1}
                    max={200000}
                    step={256}
                    value={form.maxTokens}
                    onChange={(event) => setForm((current) => ({ ...current, maxTokens: event.target.value }))}
                  />
                </label>
              </div>

              <label className="ts-field">
                <span className="ts-field__label">{t('ai:provider.field.apiKey')}</span>
                <span className="ts-ai-form__key">
                  <input
                    className="ts-settings__input"
                    type={keyVisible ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={keyMask ?? t('ai:provider.field.apiKey.placeholder')}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <button
                    type="button"
                    className="ts-icon-btn"
                    data-testid="ai-provider-key-visibility"
                    aria-pressed={keyVisible}
                    aria-label={
                      keyVisible ? t('settings:ai.providers.keyHide') : t('settings:ai.providers.keyShow')
                    }
                    title={keyVisible ? t('settings:ai.providers.keyHide') : t('settings:ai.providers.keyShow')}
                    onClick={() => setKeyVisible((visible) => !visible)}
                  >
                    {keyVisible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                  </button>
                </span>
              </label>
              <p className="ts-ai-form__note">
                {keyMask
                  ? t('settings:ai.providers.keySaved', { mask: keyMask })
                  : t('ai:provider.hint.keyVault')}
              </p>
              {keyMask ? (
                <div className="ts-ai-form__actions">
                  <button
                    type="button"
                    className="ts-btn ts-btn--ghost"
                    data-testid="ai-provider-clear-key"
                    disabled={busy !== null}
                    onClick={() => void handleClearKey()}
                  >
                    {t('ai:provider.action.clearKey')}
                  </button>
                </div>
              ) : null}

              <label className="ts-field">
                <span className="ts-field__label">{t('ai:provider.field.headers')}</span>
                <textarea
                  className="ts-settings__textarea"
                  rows={2}
                  spellCheck={false}
                  value={form.headersText}
                  onChange={(event) => setForm((current) => ({ ...current, headersText: event.target.value }))}
                />
              </label>
              <p className="ts-ai-form__note">{t('ai:provider.hint.headers')}</p>

              <label className="ts-ai-form__check">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                <span>{t('ai:provider.field.enabled')}</span>
              </label>

              {message ? (
                <p
                  className={
                    message.kind === 'ok' ? 'ts-ai-form__message is-ok' : 'ts-ai-form__message is-error'
                  }
                  role={message.kind === 'ok' ? 'status' : 'alert'}
                  data-testid="ai-provider-message"
                >
                  {message.kind === 'ok' ? (
                    <CheckCircle2 size={13} aria-hidden="true" />
                  ) : (
                    <XCircle size={13} aria-hidden="true" />
                  )}
                  {message.text}
                </p>
              ) : null}

              <div className="ts-ai-form__actions">
                <button
                  type="button"
                  className="ts-btn ts-btn--primary"
                  data-testid="ai-provider-save"
                  disabled={busy !== null}
                  onClick={() => void handleSave()}
                >
                  {busy === 'save' ? (
                    <Loader2 size={14} className="ts-spin" aria-hidden="true" />
                  ) : (
                    <Save size={14} aria-hidden="true" />
                  )}
                  {t('ai:provider.action.save')}
                </button>
                <button
                  type="button"
                  className="ts-btn"
                  data-testid="ai-provider-test"
                  disabled={busy !== null || !editingId}
                  onClick={() => void handleTest()}
                >
                  {busy === 'test' ? (
                    <Loader2 size={14} className="ts-spin" aria-hidden="true" />
                  ) : (
                    <PlugZap size={14} aria-hidden="true" />
                  )}
                  {t('ai:provider.action.test')}
                </button>
                {editingId ? (
                  <button
                    type="button"
                    className={confirmDelete ? 'ts-btn ts-btn--danger' : 'ts-btn ts-btn--ghost'}
                    data-testid="ai-provider-delete"
                    disabled={busy !== null}
                    onClick={() => void handleDelete()}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    {confirmDelete ? t('ai:provider.action.deleteConfirm') : t('ai:provider.action.delete')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ts-btn ts-btn--ghost"
                  data-testid="ai-provider-cancel"
                  disabled={busy !== null}
                  onClick={() => {
                    setEditorOpen(false)
                    setEditingId(null)
                    setConfirmDelete(false)
                    setMessage(null)
                  }}
                >
                  {t('common:action.cancel')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
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
