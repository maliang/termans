import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RotateCw,
  Save,
  Star,
  Trash2,
  XCircle
} from 'lucide-react'
import type { AiListModelsFailure, AiProvider, AiProviderInput, AiProviderKind } from '@shared/models/ai'
import { ANTHROPIC_MIN_MAX_TOKENS, anthropicEffectiveMaxTokens, type ReasoningEffort } from '@shared/reasoning'
import * as aiApi from '@renderer/features/ai/api'
import { PROVIDER_PRESETS, findPreset, matchPresetByBaseUrl, presetToInput } from '@renderer/features/ai/presets'
import { useAiStore } from '@renderer/features/ai/store'
import { describeError } from '@renderer/platform/ipc'
import { ModelCombobox } from './ModelCombobox'

/**
 * 一张供应商卡片 = 行摘要（六项） + 行内编辑区。
 *
 * 编辑态**全部收在卡片内部**（r1 是「列表 + 下方一个单栏表单」，改谁都得先在上面选中，
 * 视线要在列表和表单之间来回跳）。这样带来的两个直接后果，也是本组件的两个设计约束：
 *
 * 1. 展开时才挂载、收起即卸载 ⇒ 表单 / 模型清单 / 删除确认态天然重置，不用手写 reset，
 *    也不会有「切到另一张卡还残留上一次的模型列表」。
 * 2. 同一时刻最多一张展开 ⇒ 由父层 `expanded` 单点控制（父层只存一个 id），
 *    本组件自身不持「我是否展开」，避免两处状态打架。
 */

export interface ProviderCardProps {
  /** null = 新建草稿卡（还没有保存过任何记录） */
  provider: AiProvider | null
  expanded: boolean
  isDefault: boolean
  /** 全局默认思考强度（卡片内只读展示，改要去 A1） */
  effort: ReasoningEffort
  onToggle: () => void
  onSaved: (provider: AiProvider) => void
  onDeleted: (providerId: string) => void
  onMakeDefault: (providerId: string) => void
  /** 清 key / 测试连接之后让父层重拉一次列表（契约外的可选钩子，仅供卡片自用） */
  onRefresh?: () => void
}

type Mode = 'catalog' | 'custom'
type Busy = 'save' | 'test' | 'delete' | 'models' | null

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

interface EditorMessage {
  ok: boolean
  /** 首行：分类（含 HTTP 状态） */
  headline: string
  /** 次行：服务商原文（已脱敏、已截断） */
  detail: string | null
  /** 供 e2e / 样式区分失败族 */
  errorKind?: AiListModelsFailure['kind'] | 'generic'
}

const KIND_OPTIONS: AiProviderKind[] = ['openai', 'openai-compatible', 'anthropic', 'ollama']

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

function formFromPreset(presetId?: string): FormState {
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

function formFromProvider(provider: AiProvider): FormState {
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

/** 尾 4 位：只在脱敏分支里用，绝不吐整串 key */
function tailOf(secret: string): string {
  return secret.trim().slice(-4)
}

/**
 * 服务商回来的 message 要过两道脱敏才允许进 DOM（`title` / `aria-label` 同样算 DOM）：
 * ① 本次输入的明文 key 整串替换；② 正则兜底，防止服务商把我们没传过的 key 回显出来。
 */
function redactMessage(message: string, apiKey: string): string {
  let next = message
  const secret = apiKey.trim()
  if (secret.length >= 8) next = next.split(secret).join(`…${tailOf(secret)}`)
  return next.replace(/\b(sk|pk|api)[-_][A-Za-z0-9_-]{8,}\b/gi, (match) => `…${match.slice(-4)}`)
}

/** 主进程已截断到 300；这里只补省略号，不改内容 */
function clip(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

export function ProviderCard({
  provider,
  expanded,
  isDefault,
  effort,
  onToggle,
  onSaved,
  onDeleted,
  onMakeDefault,
  onRefresh
}: ProviderCardProps): JSX.Element {
  const { t } = useTranslation(['settings', 'ai', 'common'])
  const isNew = provider === null

  const [mode, setMode] = useState<Mode>('catalog')
  const [presetId, setPresetId] = useState<string>(PROVIDER_PRESETS[0].id)
  const [form, setForm] = useState<FormState>(() => formFromPreset())
  const [apiKey, setApiKey] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState<EditorMessage | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [openToken, setOpenToken] = useState(0)
  const confirmTimer = useRef<number | null>(null)

  // 展开即挂载：收起时整块卸载，下一次展开从真实供应商数据重新建表单
  useEffect(() => {
    if (provider === null) {
      setForm(formFromPreset(PROVIDER_PRESETS[0].id))
      setPresetId(PROVIDER_PRESETS[0].id)
      setMode('catalog')
    } else {
      setForm(formFromProvider(provider))
      setPresetId(matchPresetByBaseUrl(provider.baseUrl)?.id ?? 'custom')
      setMode('custom')
    }
    setApiKey('')
    setKeyVisible(false)
    setAdvancedOpen(false)
    setMessage(null)
    setConfirmDelete(false)
    setFetchedModels([])
  }, [provider])

  // 删除确认 3s 后自动回退（避免整行长期停在红色状态）
  useEffect(() => {
    if (!confirmDelete) return
    confirmTimer.current = window.setTimeout(() => setConfirmDelete(false), 3000)
    return () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    }
  }, [confirmDelete])

  const keyMask = aiApi.maskFromKeyRef(form.apiKeyRef)
  /**
   * 读取模型的禁用条件刻意只与「本地知不知道去哪拿 key」有关：
   * 草稿没填 key 才禁用（AC-4：填完 key 立刻能读）。已保存的供应商即使没显示 key
   * 也允许点 —— key 在加密包里，主进程读得到；由服务端返回 no-key 比 UI 猜更准。
   */
  const modelsDisabled = apiKey.trim().length === 0 && isNew

  const presetModels = useMemo(() => matchPresetByBaseUrl(form.baseUrl)?.models ?? [], [form.baseUrl])
  const modelOptions = useMemo(() => [...new Set([...fetchedModels, ...presetModels])], [fetchedModels, presetModels])

  const applyPreset = useCallback((nextPresetId: string): void => {
    setPresetId(nextPresetId)
    const preset = findPreset(nextPresetId)
    if (!preset) return
    const input = presetToInput(preset)
    setForm((current) => ({
      ...current,
      kind: input.kind,
      name: preset.name,
      baseUrl: input.baseUrl,
      model: input.model,
      headersText: headersToText(preset.extraHeaders)
    }))
  }, [])

  const handleFetchModels = useCallback(async (): Promise<void> => {
    if (apiKey.trim().length === 0 && provider === null) {
      setMessage({ ok: false, headline: t('ai:provider.models.needKey'), detail: null, errorKind: 'no-key' })
      return
    }
    setBusy('models')
    setMessage(null)
    const parsed = parseHeaders(form.headersText)
    const kind = form.kind
    const baseUrl = form.baseUrl.trim()
    const model = form.model.trim()
    const secret = apiKey.trim()
    // 已保存、且「身份相关字段」一个都没动 ⇒ 走 providerId，由主进程取加密包里的 key；
    // 只要动了 kind/baseUrl/model/key 就走 draft，否则读到的还是旧配置（用户会以为没生效）
    const identityUnchanged =
      provider !== null &&
      secret.length === 0 &&
      kind === provider.kind &&
      baseUrl === provider.baseUrl.trim() &&
      model === provider.model
    try {
      const result = identityUnchanged
        ? await aiApi.listModels({ providerId: provider.id })
        : await aiApi.listModels({
            draft: {
              kind,
              baseUrl,
              ...(model.length > 0 ? { model } : {}),
              ...(secret.length > 0 ? { apiKey: secret } : {}),
              ...(parsed.error === null && Object.keys(parsed.headers).length > 0 ? { headers: parsed.headers } : {})
            }
          })
      if (result.failure !== null) {
        const failure = result.failure
        if (failure.kind === 'no-key') {
          setMessage({ ok: false, headline: t('ai:provider.models.needKey'), detail: null, errorKind: 'no-key' })
        } else if (failure.kind === 'empty') {
          setMessage({ ok: false, headline: t('ai:provider.models.empty'), detail: null, errorKind: 'empty' })
        } else if (failure.kind === 'http') {
          const detail = clip(redactMessage(failure.message, secret))
          setMessage({
            ok: false,
            headline:
              failure.status === 401 || failure.status === 403
                ? `HTTP ${failure.status} · ${t('ai:provider.models.error.auth')}`
                : `HTTP ${failure.status ?? '—'}`,
            detail: detail.length > 0 ? detail : null,
            errorKind: 'http'
          })
        } else {
          setMessage({
            ok: false,
            headline: t('ai:provider.models.error.network'),
            detail: clip(redactMessage(failure.message, secret)) || null,
            errorKind: failure.kind
          })
        }
        setFetchedModels([])
        return
      }
      if (result.models.length === 0) {
        setMessage({ ok: false, headline: t('ai:provider.models.empty'), detail: null, errorKind: 'empty' })
        return
      }
      setFetchedModels(result.models)
      setOpenToken((token) => token + 1)
      setMessage({
        ok: true,
        headline: t('ai:provider.models.count', { count: result.models.length }),
        detail: null
      })
    } catch (error) {
      setMessage({ ok: false, headline: describeError(error), detail: null, errorKind: 'generic' })
    } finally {
      setBusy(null)
    }
  }, [apiKey, form.baseUrl, form.headersText, form.kind, form.model, provider, t])

  const handleSave = useCallback(async (): Promise<void> => {
    const parsed = parseHeaders(form.headersText)
    if (parsed.error) {
      setMessage({ ok: false, headline: parsed.error, detail: null, errorKind: 'generic' })
      return
    }
    const temperature = Number(form.temperature)
    const maxTokens = Number(form.maxTokens)
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setMessage({ ok: false, headline: t('ai:provider.error.temperature'), detail: null, errorKind: 'generic' })
      return
    }
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 200000) {
      setMessage({ ok: false, headline: t('ai:provider.error.maxTokens'), detail: null, errorKind: 'generic' })
      return
    }
    const input: AiProviderInput = {
      id: provider?.id ?? 'new',
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
      setMessage({ ok: false, headline: t('ai:provider.error.name'), detail: null, errorKind: 'generic' })
      return
    }
    if (input.model.length === 0) {
      setMessage({ ok: false, headline: t('ai:provider.error.model'), detail: null, errorKind: 'generic' })
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
      useAiStore.getState().setActiveProvider(saved.id)
      onSaved(saved)
    } catch (error) {
      setMessage({ ok: false, headline: describeError(error), detail: null, errorKind: 'generic' })
    } finally {
      setBusy(null)
    }
  }, [apiKey, form, onSaved, provider, t])

  const handleTest = useCallback(async (): Promise<void> => {
    if (provider === null) return
    setBusy('test')
    setMessage(null)
    try {
      const result = await aiApi.testProvider(provider.id)
      setMessage({ ok: result.ok, headline: result.message, detail: null })
    } catch (error) {
      setMessage({ ok: false, headline: describeError(error), detail: null, errorKind: 'generic' })
    } finally {
      setBusy(null)
    }
  }, [provider])

  const handleClearKey = useCallback(async (): Promise<void> => {
    if (provider === null) return
    setBusy('save')
    setMessage(null)
    try {
      await aiApi.clearApiKey(provider.id)
      setForm((current) => ({ ...current, apiKeyRef: null }))
      setApiKey('')
      setMessage({ ok: true, headline: t('ai:provider.keyCleared'), detail: null })
      onRefresh?.()
    } catch (error) {
      setMessage({ ok: false, headline: describeError(error), detail: null, errorKind: 'generic' })
    } finally {
      setBusy(null)
    }
  }, [onRefresh, provider, t])

  const handleDelete = useCallback(async (): Promise<void> => {
    if (provider === null) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy('delete')
    setMessage(null)
    try {
      await aiApi.deleteProvider(provider.id)
      setConfirmDelete(false)
      onDeleted(provider.id)
    } catch (error) {
      setMessage({ ok: false, headline: describeError(error), detail: null, errorKind: 'generic' })
    } finally {
      setBusy(null)
    }
  }, [confirmDelete, onDeleted, provider])

  const goGlobalEffort = useCallback((): void => {
    const target = document.querySelector<HTMLElement>('[data-testid="ai-reasoning-effort-global"]')
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    target.querySelector<HTMLButtonElement>('input[type="radio"]:checked')?.focus()
  }, [])

  const summaryName = isNew ? t('ai:provider.add') : form.name.trim().length > 0 ? form.name : (provider?.name ?? '')
  const summaryModel = isNew ? t('ai:provider.catalog.pending') : form.model.trim()

  const anthropicSelected = form.kind === 'anthropic'

  return (
    <div
      className={expanded ? 'ts-ai-provider-card is-expanded' : 'ts-ai-provider-card'}
      // 卡片根元素必须保留旧 testid `ai-provider-item-<id>`（v1 就有，改名会打断既有用法）；
      // 计数选择器 `ai-provider-card` 下移到摘要行：同一张卡挂两个 testid，既能按 id 精确定位，
      // 也能按「已保存卡片数」计数，且不必为测试插任何假元素。
      data-testid={isNew ? 'ai-provider-card-new' : `ai-provider-item-${provider?.id ?? ''}`}
      data-provider-id={provider?.id}
    >
      <div className="ts-ai-provider-card__summary" data-testid={isNew ? undefined : 'ai-provider-card'}>
        <button
          type="button"
          className="ts-ai-provider-card__main"
          aria-expanded={expanded}
          data-testid={isNew ? 'ai-provider-toggle-new' : `ai-provider-toggle-${provider?.id ?? ''}`}
          onClick={onToggle}
        >
          <span
            className={
              isNew || form.apiKeyRef === null
                ? 'ts-ai-provider-card__dot is-missing'
                : 'ts-ai-provider-card__dot is-ok'
            }
            title={
              isNew || form.apiKeyRef === null
                ? t('ai:provider.keyMissing')
                : t('ai:provider.keyConfigured')
            }
            aria-hidden="true"
          />
          {/* 名称后必须留一个空格：可访问名以「名称 」开头，外部用例靠这个前缀认人 */}
          <span className="ts-ai-provider-card__name">
            {summaryName}
            {' '}
          </span>
          <span className="ts-ai-provider-card__model">{summaryModel}</span>
          <span className={keyMask ? 'ts-ai-provider-card__key' : 'ts-ai-provider-card__key is-empty'}>
            {isNew ? t('ai:provider.keyTailMissing') : (keyMask ?? t('ai:provider.keyTailMissing'))}
          </span>
          {isDefault && !isNew ? (
            <span className="ts-ai-provider-card__badge" data-testid="ai-provider-default-badge">
              {t('settings:ai.providers.isDefault')}
            </span>
          ) : null}
          {!isNew && !form.enabled ? <span className="ts-ai-provider-card__badge">{t('settings:ai.providers.disabled')}</span> : null}
        </button>

        <div className="ts-ai-provider-card__actions">
          {isNew || confirmDelete ? null : (
            <>
              <button
                type="button"
                className="ts-ai-provider-card__icon"
                data-testid={`ai-provider-edit-${provider?.id ?? ''}`}
                aria-label={t('ai:provider.edit')}
                title={t('ai:provider.edit')}
                onClick={onToggle}
              >
                <Pencil size={14} aria-hidden="true" />
              </button>
              {isDefault ? null : (
                <button
                  type="button"
                  className="ts-ai-provider-card__icon"
                  data-testid={`ai-provider-make-default-${provider?.id ?? ''}`}
                  aria-label={t('settings:ai.providers.makeDefault')}
                  title={t('settings:ai.providers.makeDefault')}
                  onClick={() => onMakeDefault(provider?.id ?? '')}
                >
                  <Star size={14} aria-hidden="true" />
                </button>
              )}
            </>
          )}
          {isNew ? null : confirmDelete ? (
            <>
              <button
                type="button"
                className="ts-btn ts-btn--danger ts-btn--sm"
                data-testid={`ai-provider-delete-confirm-${provider?.id ?? ''}`}
                disabled={busy !== null}
                onClick={() => void handleDelete()}
              >
                {t('ai:provider.action.deleteConfirm')}
              </button>
              <button
                type="button"
                className="ts-btn ts-btn--ghost ts-btn--sm"
                onClick={() => setConfirmDelete(false)}
              >
                {t('ai:provider.deleteCancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ts-ai-provider-card__icon is-danger"
              data-testid={`ai-provider-delete-${provider?.id ?? ''}`}
              aria-label={t('ai:provider.action.delete')}
              title={t('ai:provider.action.delete')}
              onClick={() => void handleDelete()}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {expanded ? (
        <div className="ts-ai-provider-card__editor" data-testid="ai-provider-editor">
          {isNew ? (
            <div className="ts-ai-mode" role="tablist" aria-label={t('ai:provider.mode.label')}>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'catalog'}
                className={mode === 'catalog' ? 'ts-ai-mode__tab is-active' : 'ts-ai-mode__tab'}
                data-testid="ai-provider-mode-catalog"
                onClick={() => setMode('catalog')}
              >
                {t('ai:provider.catalog.mode')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'custom'}
                className={mode === 'custom' ? 'ts-ai-mode__tab is-active' : 'ts-ai-mode__tab'}
                data-testid="ai-provider-mode-custom"
                onClick={() => setMode('custom')}
              >
                {t('ai:provider.custom.mode')}
              </button>
            </div>
          ) : null}

          {isNew && mode === 'catalog' ? (
            <div className="ts-ai-catalog" data-testid="ai-catalog">
              {PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={presetId === preset.id ? 'ts-ai-catalog__item is-selected' : 'ts-ai-catalog__item'}
                  data-testid={`ai-catalog-item-${preset.id}`}
                  aria-pressed={presetId === preset.id}
                  onClick={() => applyPreset(preset.id)}
                >
                  <span className="ts-ai-catalog__head">
                    <span className="ts-ai-catalog__name">{preset.name}</span>
                    <span className="ts-ai-catalog__kind">{t(`ai:provider.kind.${preset.kind}`)}</span>
                  </span>
                  <span className="ts-ai-catalog__url" title={preset.baseUrl}>
                    {preset.baseUrl}
                  </span>
                  <span className="ts-ai-catalog__note">
                    {preset.needsKey ? t('ai:provider.catalog.needsKey') : t('ai:provider.catalog.noKey')}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="ts-ai-provider-card__grid">
            <label className="ts-field">
              <span className="ts-field__label">{t('ai:provider.field.preset')}</span>
              <select
                className="ts-settings__select"
                data-testid="ai-provider-preset"
                value={presetId}
                disabled={!isNew}
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
                disabled={isNew && mode === 'catalog'}
                onChange={(event) =>
                  setForm((current) => ({ ...current, kind: event.target.value as AiProviderKind }))
                }
              >
                {KIND_OPTIONS.map((kind) => (
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
            <span className="ts-field__label">{t('ai:provider.field.apiKey')}</span>
            <span className="ts-ai-provider-card__keyfield">
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
                aria-label={keyVisible ? t('settings:ai.providers.keyHide') : t('settings:ai.providers.keyShow')}
                title={keyVisible ? t('settings:ai.providers.keyHide') : t('settings:ai.providers.keyShow')}
                onClick={() => setKeyVisible((visible) => !visible)}
              >
                {keyVisible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              </button>
            </span>
          </label>
          <p className="ts-settings__hint">
            {keyMask ? t('settings:ai.providers.keySaved', { mask: keyMask }) : t('ai:provider.hint.keyVault')}
          </p>
          {keyMask ? (
            <div className="ts-ai-provider-card__inline-actions">
              <button
                type="button"
                className="ts-btn ts-btn--ghost ts-btn--sm"
                data-testid="ai-provider-clear-key"
                disabled={busy !== null}
                onClick={() => void handleClearKey()}
              >
                {t('ai:provider.action.clearKey')}
              </button>
            </div>
          ) : null}

          <div className="ts-field">
            <span className="ts-field__label ts-ai-provider-card__label-row">
              {t('ai:provider.field.model')}
              <button
                type="button"
                className="ts-btn ts-btn--ghost ts-btn--sm"
                data-testid="ai-provider-models-fetch"
                disabled={busy !== null || modelsDisabled}
                title={t('ai:provider.models.hint')}
                onClick={() => void handleFetchModels()}
              >
                {busy === 'models' ? (
                  <Loader2 size={12} className="ts-spin" aria-hidden="true" />
                ) : (
                  <RotateCw size={12} aria-hidden="true" />
                )}
                {busy === 'models' ? t('ai:provider.models.loading') : t('ai:provider.models.fetch')}
              </button>
            </span>
            <ModelCombobox
              value={form.model}
              options={modelOptions}
              onChange={(model) => setForm((current) => ({ ...current, model }))}
              ariaLabel={t('ai:provider.field.model')}
              openToken={openToken}
              disabled={busy === 'save'}
            />
          </div>

          {message ? (
            <p
              className={message.ok ? 'ts-ai-form__message is-ok' : 'ts-ai-form__message is-error'}
              role={message.ok ? 'status' : 'alert'}
              data-testid="ai-provider-message"
              data-error-kind={message.errorKind}
            >
              {message.ok ? (
                <CheckCircle2 size={13} aria-hidden="true" />
              ) : (
                <XCircle size={13} aria-hidden="true" />
              )}
              <span className="ts-ai-form__message-body">
                <span>{message.headline}</span>
                {message.detail ? <span className="ts-ai-form__message-detail">{message.detail}</span> : null}
              </span>
            </p>
          ) : null}

          <div className="ts-ai-provider-card__effort" data-testid="ai-reasoning-effort">
            <span className="ts-ai-provider-card__effort-label">{t('ai:provider.field.effort')}</span>
            <span className="ts-ai-provider-card__effort-value">
              {t('ai:provider.effortFollowing', {
                level: t(`settings:ai.reasoningEffort.${effort}`)
              })}
            </span>
            <button type="button" className="ts-link-btn" onClick={goGlobalEffort}>
              {t('ai:provider.effortGoGlobal')}
            </button>
          </div>

          <button
            type="button"
            className={advancedOpen ? 'ts-ai-advanced__head is-open' : 'ts-ai-advanced__head'}
            data-testid="ai-advanced-toggle"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <span>{t('ai:provider.advanced.title')}</span>
            <span className="ts-ai-advanced__summary">
              {t('ai:provider.advanced.summary', { temperature: form.temperature, maxTokens: form.maxTokens })}
            </span>
          </button>

          {advancedOpen ? (
            <div className="ts-ai-advanced">
              <div className="ts-ai-provider-card__grid">
                <label className="ts-field">
                  <span className="ts-field__label">{t('ai:provider.field.temperature')}</span>
                  <input
                    className="ts-settings__input"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.temperature}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, temperature: event.target.value }))
                    }
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

              {anthropicSelected ? (
                <>
                  <p className="ts-settings__hint" data-testid="ai-provider-anthropic-temperature">
                    {t('ai:provider.effortAnthropicTemperature', { value: form.temperature })}
                  </p>
                  <p className="ts-settings__hint" data-testid="ai-provider-anthropic-budget">
                    {t('ai:provider.effortAnthropicBudget', {
                      min: ANTHROPIC_MIN_MAX_TOKENS[effort],
                      effective: anthropicEffectiveMaxTokens(effort, Number(form.maxTokens) || 0),
                      current: form.maxTokens
                    })}
                  </p>
                </>
              ) : null}

              <label className="ts-field">
                <span className="ts-field__label">{t('ai:provider.field.headers')}</span>
                <textarea
                  className="ts-settings__textarea"
                  rows={2}
                  spellCheck={false}
                  value={form.headersText}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, headersText: event.target.value }))
                  }
                />
              </label>
              <p className="ts-settings__hint">{t('ai:provider.hint.headers')}</p>

              <label className="ts-ai-form__check">
                <input
                  type="checkbox"
                  data-testid="ai-provider-enabled"
                  checked={form.enabled}
                  onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
                />
                <span>{t('ai:provider.field.enabled')}</span>
              </label>
            </div>
          ) : null}

          <div className="ts-ai-provider-card__footer">
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="ai-provider-test"
              disabled={busy !== null || isNew}
              onClick={() => void handleTest()}
            >
              {busy === 'test' ? (
                <Loader2 size={14} className="ts-spin" aria-hidden="true" />
              ) : (
                <PlugZap size={14} aria-hidden="true" />
              )}
              {t('ai:provider.action.test')}
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              data-testid="ai-provider-cancel"
              disabled={busy !== null}
              onClick={onToggle}
            >
              {t('common:action.cancel')}
            </button>
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
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** 卡片列表末尾的「添加供应商」占位卡（与 ProviderCard 同宽，视觉上是列表的一员） */
export function AddProviderCard({ onClick, disabled }: { onClick: () => void; disabled?: boolean }): JSX.Element {
  const { t } = useTranslation(['ai'])
  return (
    <button
      type="button"
      className="ts-ai-provider-card ts-ai-provider-card--add"
      data-testid="ai-providers-add"
      disabled={disabled}
      onClick={onClick}
    >
      <Plus size={14} aria-hidden="true" />
      {t('ai:provider.add')}
    </button>
  )
}
