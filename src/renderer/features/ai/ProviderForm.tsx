/**
 * 供应商配置表单（新建 / 编辑 / 删除 / 测试连接）。
 *
 * 安全要点：
 * - API key 输入框是**只写**的：保存后立刻清空本地 state，界面只显示 `••••尾4位`；
 * - key 通过 `ai:save-provider` 或 `ai:set-api-key` 单次传给主进程，主进程写进加密包；
 * - 渲染层任何地方都不缓存明文 key，也不把它放进提示词/日志/错误文案。
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, KeyRound, Loader2, PlugZap, Save, Trash2, XCircle } from 'lucide-react'
import type { AiProvider, AiProviderInput, AiProviderKind } from '@shared/models/ai'
import * as api from './api'
import { PROVIDER_PRESETS, findPreset, matchPresetByBaseUrl, presetToInput } from './presets'

const KINDS: AiProviderKind[] = ['openai', 'openai-compatible', 'anthropic', 'ollama']

export interface ProviderFormProps {
  providers: AiProvider[]
  activeProviderId: string | null
  onSaved: () => Promise<void> | void
  onSelect: (providerId: string | null) => void
}

interface FormState {
  id: string
  name: string
  kind: AiProviderKind
  baseUrl: string
  model: string
  temperature: string
  maxTokens: string
  enabled: boolean
  headersText: string
  apiKeyRef: string | null
}

function emptyForm(): FormState {
  const preset = PROVIDER_PRESETS[0]
  const input = presetToInput(preset)
  return {
    ...input,
    temperature: String(input.temperature),
    maxTokens: String(input.maxTokens),
    headersText: headersToText(preset.extraHeaders)
  }
}

function headersToText(headers?: Record<string, string>): string {
  if (!headers) return ''
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function parseHeaders(text: string): { headers: Record<string, string>; error: string | null } {
  const headers: Record<string, string> = {}
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
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

function fromProvider(provider: AiProvider, headersText: string): FormState {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    model: provider.model,
    temperature: String(provider.temperature),
    maxTokens: String(provider.maxTokens),
    enabled: provider.enabled,
    headersText,
    apiKeyRef: provider.apiKeyRef
  }
}

export function ProviderForm({ providers, activeProviderId, onSaved, onSelect }: ProviderFormProps): JSX.Element {
  const { t } = useTranslation(['ai', 'common'])
  const [form, setForm] = useState<FormState>(() => emptyForm())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 切换编辑对象时同步表单（含从加密包读回的 headers 由上层透传给 provider 的扩展字段）
  useEffect(() => {
    if (!editingId) return
    const provider = providers.find((item) => item.id === editingId)
    if (!provider) return
    const headers = (provider as AiProvider & { headers?: Record<string, string> }).headers
    setForm(fromProvider(provider, headersToText(headers)))
    setApiKey('')
    setConfirmDelete(false)
    setMessage(null)
  }, [editingId, providers])

  const preset = useMemo(() => matchPresetByBaseUrl(form.baseUrl), [form.baseUrl])
  const modelOptions = preset?.models ?? []
  const keyMask = api.maskFromKeyRef(form.apiKeyRef)

  function startCreate(presetId?: string): void {
    const selected = (presetId && findPreset(presetId)) || PROVIDER_PRESETS[0]
    const input = presetToInput(selected)
    setEditingId(null)
    setForm({
      ...input,
      temperature: String(input.temperature),
      maxTokens: String(input.maxTokens),
      headersText: headersToText(selected.extraHeaders)
    })
    setApiKey('')
    setMessage(null)
    setConfirmDelete(false)
  }

  function applyPreset(presetId: string): void {
    const selected = findPreset(presetId)
    if (!selected) return
    const input = presetToInput(selected)
    setForm((current) => ({
      ...current,
      name: current.name.trim().length > 0 && current.name !== 'New provider' ? current.name : selected.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      model: input.model,
      headersText: headersToText(selected.extraHeaders)
    }))
  }

  async function handleSave(): Promise<void> {
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
    setSaving(true)
    setMessage(null)
    try {
      const saved = await api.saveProvider(input, {
        headers: Object.keys(parsed.headers).length > 0 ? parsed.headers : undefined,
        apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined
      })
      setApiKey('')
      setEditingId(saved.id)
      onSelect(saved.id)
      setMessage({ kind: 'ok', text: t('ai:provider.saved') })
      await onSaved()
    } catch (error) {
      setMessage({ kind: 'error', text: apiMessage(error) })
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(): Promise<void> {
    if (!editingId) {
      setMessage({ kind: 'error', text: t('ai:provider.test.saveFirst') })
      return
    }
    setTesting(true)
    setMessage(null)
    try {
      const result = await api.testProvider(editingId)
      setMessage({ kind: result.ok ? 'ok' : 'error', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: apiMessage(error) })
    } finally {
      setTesting(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (!editingId) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      await api.deleteProvider(editingId)
      setEditingId(null)
      startCreate()
      onSelect(null)
      await onSaved()
    } catch (error) {
      setMessage({ kind: 'error', text: apiMessage(error) })
    } finally {
      setConfirmDelete(false)
    }
  }

  async function handleClearKey(): Promise<void> {
    if (!editingId) return
    try {
      await api.clearApiKey(editingId)
      setForm((current) => ({ ...current, apiKeyRef: null }))
      setMessage({ kind: 'ok', text: t('ai:provider.keyCleared') })
      await onSaved()
    } catch (error) {
      setMessage({ kind: 'error', text: apiMessage(error) })
    }
  }

  return (
    <div className="ts-ai-form" data-testid="ai-provider-form">
      <div className="ts-ai-form__row">
        <label className="ts-field">
          <span className="ts-field__label">{t('ai:provider.field.preset')}</span>
          <select
            value={preset?.id ?? ''}
            onChange={(event) => {
              if (event.target.value === '__new') {
                startCreate()
                return
              }
              if (event.target.value.length > 0) applyPreset(event.target.value)
            }}
          >
            <option value="">{t('ai:provider.preset.custom')}</option>
            {PROVIDER_PRESETS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            <option value="__new">{t('ai:provider.action.new')}</option>
          </select>
        </label>
        <label className="ts-field">
          <span className="ts-field__label">{t('ai:provider.field.kind')}</span>
          <select
            value={form.kind}
            onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as AiProviderKind }))}
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
          value={form.name}
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          placeholder="DeepSeek"
        />
      </label>

      <label className="ts-field">
        <span className="ts-field__label">{t('ai:provider.field.baseUrl')}</span>
        <input
          value={form.baseUrl}
          onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
        />
      </label>

      <label className="ts-field">
        <span className="ts-field__label">{t('ai:provider.field.model')}</span>
        <input
          value={form.model}
          onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
          list="ai-model-options"
          placeholder="gpt-4.1-mini"
          spellCheck={false}
        />
        <datalist id="ai-model-options">
          {modelOptions.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </label>

      <div className="ts-ai-form__row">
        <label className="ts-field">
          <span className="ts-field__label">{t('ai:provider.field.temperature')}</span>
          <input
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
        <div className="ts-ai-form__key">
          <input
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={keyMask ?? t('ai:provider.field.apiKey.placeholder')}
          />
          {keyMask && <span className="ts-ai-form__keymask">{keyMask}</span>}
          {keyMask && (
            <button type="button" className="ts-btn ts-btn--ghost" onClick={() => void handleClearKey()}>
              {t('ai:provider.action.clearKey')}
            </button>
          )}
        </div>
        <span className="ts-field__hint">{t('ai:provider.hint.keyVault')}</span>
      </label>

      <label className="ts-field">
        <span className="ts-field__label">{t('ai:provider.field.headers')}</span>
        <textarea
          rows={2}
          value={form.headersText}
          spellCheck={false}
          onChange={(event) => setForm((current) => ({ ...current, headersText: event.target.value }))}
          placeholder={'HTTP-Referer: https://termans.app'}
        />
        <span className="ts-field__hint">{t('ai:provider.hint.headers')}</span>
      </label>

      <label className="ts-ai-form__check">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
        />
        <span>{t('ai:provider.field.enabled')}</span>
      </label>

      {preset && <p className="ts-ai-form__note">{preset.note}</p>}

      {message && (
        <p
          className={`ts-ai-form__message ${message.kind === 'ok' ? 'is-ok' : 'is-error'}`}
          data-testid="ai-provider-message"
        >
          {message.kind === 'ok' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
          <span>{message.text}</span>
        </p>
      )}

      <div className="ts-ai-form__actions">
        <button type="button" className="ts-btn ts-btn--primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 size={14} className="ts-spin" /> : <Save size={14} />}
          {t('ai:provider.action.save')}
        </button>
        <button type="button" className="ts-btn" onClick={() => void handleTest()} disabled={testing || !editingId}>
          {testing ? <Loader2 size={14} className="ts-spin" /> : <PlugZap size={14} />}
          {t('ai:provider.action.test')}
        </button>
        {editingId && (
          <button
            type="button"
            className={`ts-btn ${confirmDelete ? 'ts-btn--danger' : 'ts-btn--ghost'}`}
            onClick={() => void handleDelete()}
          >
            <Trash2 size={14} />
            {confirmDelete ? t('ai:provider.action.deleteConfirm') : t('ai:provider.action.delete')}
          </button>
        )}
      </div>

      <div className="ts-ai-form__list">
        <p className="ts-ai-form__list-title">
          <KeyRound size={13} /> {t('ai:provider.list.title')}
        </p>
        {providers.length === 0 && <p className="ts-ai-form__empty">{t('ai:provider.list.empty')}</p>}
        {providers.map((provider) => (
          <button
            type="button"
            key={provider.id}
            className={`ts-ai-form__item ${provider.id === editingId ? 'is-active' : ''}`}
            onClick={() => {
              setEditingId(provider.id)
              onSelect(provider.id)
            }}
          >
            <span className="ts-ai-form__item-name">{provider.name}</span>
            <span className="ts-ai-form__item-model">{provider.model}</span>
            <span className="ts-ai-form__item-key">
              {api.maskFromKeyRef(provider.apiKeyRef) ?? t('ai:provider.list.noKey')}
            </span>
          </button>
        ))}
      </div>

      <button type="button" className="ts-link" onClick={() => startCreate()}>
        {t('ai:provider.action.new')}
      </button>
      <span className="ts-ai-form__hint-active">{activeProviderId ? '' : t('ai:provider.list.hint')}</span>
    </div>
  )
}

function apiMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as Error).message)
  return String(error)
}
