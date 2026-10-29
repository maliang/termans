/**
 * 右侧 AI 面板：供应商配置 + 流式对话 + 终端上下文 + 命令确认。
 *
 * 交互红线（task t5 第 4/5 条）：
 * 1. 带上下文发送前，**一定**先弹「将要发送的内容」预览——用户能看见终端缓冲真的被带上去了；
 * 2. AI 给出的命令默认只复制；点「执行」→ 二次确认 → 才调用 `runCommand` 写入终端；
 *    危险命令在确认框里用危险色列出命中原因（rm -rf / dd / mkfs / shutdown / fork bomb …）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Copy,
  Eraser,
  Eye,
  Plus,
  PowerOff,
  Send,
  Settings2,
  Sparkles,
  Square,
  TerminalSquare,
  Wand2
} from 'lucide-react'
import type { AiUsage } from '@shared/models/ai'
import { useShellStore } from '@renderer/app/store'
import { openSettingsDialog } from '@renderer/theme/settings-dialog'
import * as api from './api'
import { ProviderForm } from './ProviderForm'
import { CommandGuard, extractCommandBlocks } from './command-guard'
import type { CommandAssessment, CommandBlock } from './command-guard'
import { buildPreview, estimatePreviewSize } from './prompt-preview'
import { DEFAULT_TEMPLATES, errorMessageKey, fillTemplate, useAiStore } from './store'
import type { PromptTemplates, TerminalSnapshot } from './store'
import './ai.css'

/** 面板向宿主（集成时的 App/终端区）要的东西；都是「拉取式」，面板不订阅终端 store */
export interface AiPanelProps {
  /** 取当前终端的快照；返回 null 表示当前没有连接中的会话 */
  getContext?: () => TerminalSnapshot | null
  /** 取终端里选中的文本（用于「解释选中内容」） */
  getSelection?: () => string | null
  /** 把一行命令写进当前终端（集成方实现：`session.write(command + '\r')`） */
  runCommand?: (command: string, sessionId: string | null) => void | Promise<void>
  /** 是否有可用终端会话（没有时禁用上下文开关） */
  hasSession?: boolean
}

interface PreviewState {
  prompt: string
  snapshot: TerminalSnapshot | null
  text: string
  size: number
}

interface PendingExecution {
  token: string
  command: string
  assessment: CommandAssessment
  sessionId: string | null
}

export function AiPanel({ getContext, getSelection, runCommand, hasSession = false }: AiPanelProps): JSX.Element {
  const { t } = useTranslation(['ai', 'common'])
  const aiSettings = useShellStore((state) => state.settings.ai)
  /** 总开关（设置 → AI）。关掉时这里只显示「未启用」空态，绝不发请求、也不留红色报错 */
  const aiEnabled = aiSettings.enabled
  const providers = useAiStore((state) => state.providers)
  const providersLoaded = useAiStore((state) => state.providersLoaded)
  const activeProviderId = useAiStore((state) => state.activeProviderId)
  const messages = useAiStore((state) => state.messages)
  const streaming = useAiStore((state) => state.streaming)
  const usage = useAiStore((state) => state.usage)
  const error = useAiStore((state) => state.error)
  const notice = useAiStore((state) => state.notice)
  const view = useAiStore((state) => state.view)
  const templates = useAiStore((state) => state.templates)
  const contextEnabled = useAiStore((state) => state.contextEnabled)
  const contextLines = useAiStore((state) => state.contextLines)

  const [draft, setDraft] = useState('')
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [pending, setPending] = useState<PendingExecution | null>(null)
  const [localNotice, setLocalNotice] = useState<string | null>(null)
  const guardRef = useRef(new CommandGuard())
  const bodyRef = useRef<HTMLDivElement>(null)

  // ① 初始化：拉供应商、对齐设置里的上下文默认值、订阅流事件
  useEffect(() => {
    useAiStore.getState().setContextEnabled(aiSettings.autoContext)
    useAiStore.getState().setContextLines(aiSettings.contextLines || 200)
    void useAiStore.getState().init()
  }, [aiSettings.autoContext, aiSettings.contextLines])

  useEffect(() => {
    return api.subscribeStream({
      onDelta: (payload) => useAiStore.getState().handleDelta(payload.requestId, payload.delta),
      onDone: (payload) => useAiStore.getState().handleDone(payload.requestId, payload.message, payload.usage),
      onError: (payload) => useAiStore.getState().handleError(payload.requestId, payload.message)
    })
  }, [])

  // 关掉总开关后，上一次失败留下的红条会让人以为「配置坏了」——面板该表达的是「没启用」而不是「出错了」。
  // 只在关闭时清；开启时不主动清，免得把真正的配置错误（例如没配 key）藏起来。
  useEffect(() => {
    if (!aiEnabled) useAiStore.getState().setError(null)
  }, [aiEnabled])

  // 设置里的「默认供应商」：新会话/首次进入时生效；用户在本面板手动切过之后不再覆盖。
  // 用 ref 记住「已经为哪个默认值做过决定」，避免 providers 列表刷新时把用户的手选抢回去。
  const appliedDefaultProvider = useRef<string | null>(null)
  useEffect(() => {
    const defaultProviderId = aiSettings.defaultProviderId
    if (!defaultProviderId) return
    if (providers.length === 0) return
    if (appliedDefaultProvider.current === defaultProviderId) return
    if (!providers.some((provider) => provider.id === defaultProviderId)) return
    appliedDefaultProvider.current = defaultProviderId
    useAiStore.getState().setActiveProvider(defaultProviderId)
  }, [aiSettings.defaultProviderId, providers])

  // ② 自动滚到底（流式输出时跟随）
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    body.scrollTop = body.scrollHeight
  }, [messages])

  useEffect(() => {
    if (!localNotice) return
    const timer = window.setTimeout(() => setLocalNotice(null), 2600)
    return () => window.clearTimeout(timer)
  }, [localNotice])

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.id === activeProviderId) ?? null,
    [providers, activeProviderId]
  )

  const takeSnapshot = useCallback((): TerminalSnapshot | null => {
    if (!contextEnabled) return null
    return getContext?.() ?? null
  }, [contextEnabled, getContext])

  /** 所有「要发送」的入口都走这里：有上下文必须先看预览 */
  const composeAndSend = useCallback(
    (prompt: string, snapshotOverride?: TerminalSnapshot | null) => {
      // 关闭状态下不建预览、不发请求（主进程也会以 E_AI_PROVIDER 拒绝，这里先挡住，
      // 免得把用户的真实终端输出打进一个「本来就不打算发出去」的预览里）
      if (!aiEnabled) return
      const trimmed = prompt.trim()
      if (trimmed.length === 0) return
      const snapshot = snapshotOverride !== undefined ? snapshotOverride : takeSnapshot()
      if (snapshot) {
        const built = buildPreview({
          messages: [{ role: 'user', content: trimmed }],
          context: {
            sessionId: snapshot.sessionId,
            hostLabel: snapshot.hostLabel,
            cwd: snapshot.cwd,
            recentOutput: snapshot.recentOutput.slice(-20000)
          },
          contextLines,
          os: snapshot.os
        })
        setPreview({
          prompt: trimmed,
          snapshot,
          text: built.text,
          size: estimatePreviewSize(built)
        })
        return
      }
      void useAiStore.getState().send(trimmed, null)
    },
    [aiEnabled, contextLines, takeSnapshot]
  )

  const confirmPreview = useCallback(() => {
    const current = preview
    if (!current) return
    setPreview(null)
    void useAiStore.getState().send(current.prompt, current.snapshot)
  }, [preview])

  const handleSend = useCallback(() => {
    composeAndSend(draft)
    setDraft('')
  }, [composeAndSend, draft])

  const handleExplain = useCallback(
    (kind: 'explain' | 'error') => {
      const selection = getSelection?.()?.trim() ?? ''
      if (selection.length === 0) {
        setLocalNotice(t('ai:notice.selectFirst'))
        return
      }
      const template = kind === 'error' ? templates.error : templates.explain
      composeAndSend(fillTemplate(template, { selection }))
    },
    [composeAndSend, getSelection, t, templates]
  )

  const handleCommand = useCallback((command: string) => {
    const snapshot = getContext?.() ?? null
    const ticket = guardRef.current.request(command)
    setPending({
      token: ticket.token,
      command: ticket.command,
      assessment: ticket.assessment,
      sessionId: snapshot?.sessionId ?? null
    })
  }, [getContext])

  const confirmExecution = useCallback(() => {
    const current = pending
    if (!current) return
    const result = guardRef.current.confirm(current.token)
    if (!result.ok) {
      setLocalNotice(t('ai:notice.executeBlocked'))
      setPending(null)
      return
    }
    const permitted = guardRef.current.take(current.token)
    if (!permitted) {
      setLocalNotice(t('ai:notice.executeBlocked'))
      setPending(null)
      return
    }
    setPending(null)
    if (!runCommand) {
      setLocalNotice(t('ai:notice.noTerminal'))
      return
    }
    void runCommand(permitted, current.sessionId)
  }, [pending, runCommand, t])

  async function copyCommand(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command)
      setLocalNotice(t('ai:notice.copied'))
    } catch {
      setLocalNotice(t('ai:notice.copyFailed'))
    }
  }

  const disabled = !aiEnabled || streaming || providers.length === 0

  return (
    <aside className="ts-ai-panel" data-testid="ai-panel" aria-label={t('ai:panel.title')}>
      <div className="ts-ai-panel__head">
        {view !== 'chat' ? (
          <button
            type="button"
            className="ts-icon-btn"
            onClick={() => useAiStore.getState().setView('chat')}
            aria-label={t('ai:action.back')}
          >
            <ChevronLeft size={15} />
          </button>
        ) : (
          <Sparkles size={15} aria-hidden="true" />
        )}
        <span className="ts-ai-panel__title">
          {view === 'providers'
            ? t('ai:provider.title')
            : view === 'templates'
              ? t('ai:templates.title')
              : t('ai:panel.title')}
        </span>
        {view === 'chat' && (
          <>
            <select
              className="ts-ai-panel__provider"
              value={activeProviderId ?? ''}
              onChange={(event) => useAiStore.getState().setActiveProvider(event.target.value || null)}
              aria-label={t('ai:provider.field.active')}
              disabled={!aiEnabled || providers.length === 0}
            >
              {providers.length === 0 && <option value="">{t('ai:provider.list.empty')}</option>}
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} · {provider.model}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ts-icon-btn"
              onClick={() => useAiStore.getState().newConversation()}
              aria-label={t('ai:action.newChat')}
              title={t('ai:action.newChat')}
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              className="ts-icon-btn"
              onClick={() => useAiStore.getState().setView('providers')}
              aria-label={t('ai:provider.title')}
              title={t('ai:provider.title')}
            >
              <Settings2 size={15} />
            </button>
          </>
        )}
      </div>

      <div className="ts-ai-panel__body" ref={bodyRef}>
        {view === 'providers' && (
          <ProviderForm
            providers={providers}
            activeProviderId={activeProviderId}
            onSaved={() => useAiStore.getState().reloadProviders()}
            onSelect={(providerId) => useAiStore.getState().setActiveProvider(providerId)}
          />
        )}

        {view === 'templates' && (
          <TemplateEditor templates={templates} onSave={(next) => useAiStore.getState().setTemplates(next)} />
        )}

        {view === 'chat' && (
          <>
            {/* 总开关关闭：只表达「未启用」+ 一个直达设置页的入口。
                主进程本来会以 E_AI_PROVIDER 硬拒，用户看到的却是一条红色错误，容易被当成故障。 */}
            {!aiEnabled && (
              <div className="ts-empty ts-empty--compact" data-testid="ai-disabled">
                <PowerOff size={20} aria-hidden="true" />
                <p className="ts-empty__title">{t('ai:disabled.title')}</p>
                <p className="ts-empty__body">{t('ai:disabled.body')}</p>
                <button
                  type="button"
                  className="ts-btn ts-btn--primary"
                  data-testid="ai-disabled-open-settings"
                  onClick={() => openSettingsDialog('ai')}
                >
                  {t('ai:disabled.action')}
                </button>
              </div>
            )}

            {aiEnabled && providersLoaded && providers.length === 0 && (
              <div className="ts-empty ts-empty--compact">
                <Sparkles size={20} aria-hidden="true" />
                <p className="ts-empty__title">{t('ai:empty.title')}</p>
                <p className="ts-empty__body">{t('ai:empty.body')}</p>
                <button
                  type="button"
                  className="ts-btn ts-btn--primary"
                  onClick={() => useAiStore.getState().setView('providers')}
                >
                  {t('ai:provider.action.add')}
                </button>
              </div>
            )}

            {aiEnabled && messages.length === 0 && providers.length > 0 && (
              <div className="ts-empty ts-empty--compact">
                <TerminalSquare size={20} aria-hidden="true" />
                <p className="ts-empty__title">{t('ai:chat.empty.title')}</p>
                <p className="ts-empty__body">{t('ai:chat.empty.body')}</p>
              </div>
            )}

            {messages.map((message) => (
              <article
                key={message.id}
                className={`ts-ai-msg ts-ai-msg--${message.role}`}
                data-testid={`ai-message-${message.role}`}
              >
                <p className="ts-ai-msg__role">
                  {message.role === 'user' ? t('ai:chat.role.user') : (activeProvider?.name ?? t('ai:chat.role.assistant'))}
                  {message.streaming && <span className="ts-ai-msg__caret" aria-hidden="true" />}
                </p>
                <MessageBody content={message.content} />
                {message.role === 'assistant' && !message.streaming && (
                  <CommandCards
                    content={message.content}
                    onCopy={copyCommand}
                    onExecute={handleCommand}
                    canExecute={Boolean(runCommand)}
                  />
                )}
              </article>
            ))}

            {aiEnabled && error && (
              <p className="ts-ai-error" data-testid="ai-error">
                <AlertTriangle size={13} /> <span>{t(`ai:error.${errorMessageKey(error)}`, { defaultValue: error })}</span>
              </p>
            )}

            {aiEnabled && usage && <UsageLine usage={usage} />}
          </>
        )}
      </div>

      {view === 'chat' && aiEnabled && (
        <div className="ts-ai-panel__composer">
          <div className="ts-ai-context">
            <label className="ts-ai-context__toggle">
              <input
                type="checkbox"
                checked={contextEnabled}
                onChange={(event) => useAiStore.getState().setContextEnabled(event.target.checked)}
              />
              <span>{t('ai:context.toggle')}</span>
            </label>
            <label className="ts-ai-context__lines">
              <span>{t('ai:context.lines')}</span>
              <input
                type="number"
                min={0}
                max={500}
                step={50}
                value={contextLines}
                onChange={(event) => useAiStore.getState().setContextLines(Number(event.target.value))}
                disabled={!contextEnabled}
              />
            </label>
            {contextEnabled && !hasSession && <span className="ts-ai-context__warn">{t('ai:context.noSession')}</span>}
          </div>

          <textarea
            rows={2}
            value={draft}
            placeholder={t('ai:input.placeholder')}
            aria-label={t('ai:input.placeholder')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                handleSend()
              }
            }}
          />

          <div className="ts-ai-actions">
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              onClick={() => handleExplain('explain')}
              title={t('ai:action.explainSelection')}
            >
              <Eye size={14} />
              {t('ai:action.explainSelection')}
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              onClick={() => handleExplain('error')}
              title={t('ai:action.explainError')}
            >
              <Wand2 size={14} />
              {t('ai:action.explainError')}
            </button>
            <button
              type="button"
              className="ts-btn ts-btn--ghost"
              onClick={() => useAiStore.getState().setView('templates')}
              title={t('ai:templates.title')}
            >
              <Eraser size={14} />
            </button>
          </div>

          <div className="ts-ai-send">
            {contextEnabled && (
              <span className="ts-ai-send__hint">
                <Eye size={12} /> {t('ai:context.beforeSend')}
              </span>
            )}
            {streaming ? (
              <button type="button" className="ts-btn" onClick={() => void useAiStore.getState().cancel()}>
                <Square size={14} />
                {t('ai:action.stop')}
              </button>
            ) : (
              <button
                type="button"
                className="ts-btn ts-btn--primary"
                onClick={handleSend}
                disabled={disabled || draft.trim().length === 0}
              >
                <Send size={14} />
                {t('ai:action.send')}
              </button>
            )}
          </div>
        </div>
      )}

      {(localNotice || notice) && (
        <div className="ts-ai-toast" role="status">
          {localNotice ?? notice}
        </div>
      )}

      {preview && (
        <PreviewDialog
          preview={preview}
          contextLines={contextLines}
          onCancel={() => setPreview(null)}
          onSend={confirmPreview}
        />
      )}

      {pending && (
        <ConfirmExecuteDialog
          pending={pending}
          onCancel={() => {
            guardRef.current.cancel()
            setPending(null)
          }}
          onConfirm={confirmExecution}
        />
      )}
    </aside>
  )
}

function MessageBody({ content }: { content: string }): JSX.Element {
  // 极简渲染：代码块用 <pre>，其余按段落。不引 markdown 依赖（package.json 由 architect 独占）
  const parts = content.split(/```/)
  return (
    <div className="ts-ai-msg__body">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          const body = part.replace(/^[A-Za-z0-9_+-]*\n/, '')
          return (
            <pre key={index} className="ts-ai-msg__code">
              <code>{body.replace(/\s+$/, '')}</code>
            </pre>
          )
        }
        return part.trim().length > 0 ? <p key={index}>{part.trim()}</p> : null
      })}
    </div>
  )
}

interface CommandCardsProps {
  content: string
  onCopy: (command: string) => void | Promise<void>
  onExecute: (command: string) => void
  canExecute: boolean
}

function CommandCards({ content, onCopy, onExecute, canExecute }: CommandCardsProps): JSX.Element | null {
  const blocks = extractCommandBlocks(content)
  if (blocks.length === 0) return null
  return (
    <div className="ts-ai-commands" data-testid="ai-command-cards">
      {blocks.map((block, index) => (
        <CommandCard
          key={`${index}-${block.command.slice(0, 24)}`}
          block={block}
          onCopy={onCopy}
          onExecute={onExecute}
          canExecute={canExecute}
        />
      ))}
    </div>
  )
}

function CommandCard({
  block,
  onCopy,
  onExecute,
  canExecute
}: {
  block: CommandBlock
  onCopy: (command: string) => void | Promise<void>
  onExecute: (command: string) => void
  canExecute: boolean
}): JSX.Element {
  const { t } = useTranslation(['ai'])
  return (
    <div className="ts-ai-card" data-testid="ai-command-card">
      {block.explanation && <p className="ts-ai-card__explain">{block.explanation}</p>}
      <pre className="ts-ai-card__cmd">
        <code>{block.command}</code>
      </pre>
      <div className="ts-ai-card__actions">
        <button type="button" className="ts-btn ts-btn--ghost" onClick={() => void onCopy(block.command)}>
          <Copy size={13} />
          {t('ai:action.copy')}
        </button>
        <button
          type="button"
          className="ts-btn ts-btn--primary"
          onClick={() => onExecute(block.command)}
          disabled={!canExecute}
          title={canExecute ? t('ai:action.execute') : t('ai:notice.noTerminal')}
        >
          <TerminalSquare size={13} />
          {t('ai:action.execute')}
        </button>
        <span className="ts-ai-card__hint">{t('ai:action.executeHint')}</span>
      </div>
    </div>
  )
}

function UsageLine({ usage }: { usage: AiUsage }): JSX.Element {
  const { t } = useTranslation(['ai'])
  const prompt = usage.promptTokens
  const completion = usage.completionTokens
  const total = prompt !== null && completion !== null ? prompt + completion : null
  return (
    <p className="ts-ai-usage" data-testid="ai-usage">
      {prompt !== null && <span>{t('ai:usage.prompt', { tokens: prompt })}</span>}
      {completion !== null && <span>{t('ai:usage.completion', { tokens: completion })}</span>}
      {total !== null && <span>{t('ai:usage.total', { tokens: total })}</span>}
      {total === null && <span>{t('ai:usage.unknown')}</span>}
    </p>
  )
}

function PreviewDialog({
  preview,
  contextLines,
  onCancel,
  onSend
}: {
  preview: PreviewState
  contextLines: number
  onCancel: () => void
  onSend: () => void
}): JSX.Element {
  const { t } = useTranslation(['ai', 'common'])
  return (
    <div className="ts-ai-modal" role="dialog" aria-modal="true" data-testid="ai-preview-dialog">
      <div className="ts-ai-modal__panel">
        <h3 className="ts-ai-modal__title">
          <Eye size={15} /> {t('ai:context.previewTitle')}
        </h3>
        <p className="ts-ai-modal__hint">
          {t('ai:context.previewHint', { lines: contextLines, size: preview.size })}
        </p>
        <pre className="ts-ai-modal__preview" data-testid="ai-preview-content">
          {preview.text}
        </pre>
        <div className="ts-ai-modal__actions">
          <button type="button" className="ts-btn ts-btn--ghost" onClick={onCancel}>
            {t('common:action.cancel')}
          </button>
          <button type="button" className="ts-btn ts-btn--primary" onClick={onSend} data-testid="ai-preview-send">
            <Send size={14} /> {t('ai:context.previewSend')}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmExecuteDialog({
  pending,
  onCancel,
  onConfirm
}: {
  pending: PendingExecution
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  const { t } = useTranslation(['ai', 'common'])
  const { assessment } = pending
  return (
    <div className="ts-ai-modal" role="dialog" aria-modal="true" data-testid="ai-execute-dialog">
      <div className={`ts-ai-modal__panel ${assessment.highRisk ? 'is-danger' : ''}`}>
        <h3 className="ts-ai-modal__title">
          <AlertTriangle size={15} /> {t('ai:command.confirmTitle')}
        </h3>
        <pre className="ts-ai-modal__preview">
          <code>{pending.command}</code>
        </pre>
        {assessment.dangerous ? (
          <div className="ts-ai-modal__reasons" data-testid="ai-danger-reasons">
            <p className="ts-ai-modal__danger">
              <AlertTriangle size={13} /> {t('ai:command.dangerTitle')}
            </p>
            <ul>
              {assessment.reasons.map((reason) => (
                <li key={reason}>{t(`ai:danger.${reason}`)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="ts-ai-modal__hint">{t('ai:command.confirmBody')}</p>
        )}
        <p className="ts-ai-modal__hint">{t('ai:command.defaultCopy')}</p>
        <div className="ts-ai-modal__actions">
          <button type="button" className="ts-btn ts-btn--ghost" onClick={onCancel} data-testid="ai-execute-cancel">
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            className={`ts-btn ${assessment.highRisk ? 'ts-btn--danger' : 'ts-btn--primary'}`}
            onClick={onConfirm}
            data-testid="ai-execute-confirm"
          >
            <Check size={14} /> {t('ai:command.confirmExecute')}
          </button>
        </div>
      </div>
    </div>
  )
}

function TemplateEditor({
  templates,
  onSave
}: {
  templates: PromptTemplates
  onSave: (templates: PromptTemplates) => void
}): JSX.Element {
  const { t } = useTranslation(['ai', 'common'])
  const [draft, setDraft] = useState<PromptTemplates>(templates)
  useEffect(() => setDraft(templates), [templates])
  const fields: Array<{ key: keyof PromptTemplates; label: string; placeholder: string }> = [
    { key: 'explain', label: t('ai:templates.explain'), placeholder: '{{selection}}' },
    { key: 'error', label: t('ai:templates.error'), placeholder: '{{selection}}' },
    { key: 'command', label: t('ai:templates.command'), placeholder: '{{goal}}' }
  ]
  return (
    <div className="ts-ai-form">
      <p className="ts-ai-form__note">{t('ai:templates.hint')}</p>
      {fields.map((field) => (
        <label className="ts-field" key={field.key}>
          <span className="ts-field__label">{field.label}</span>
          <textarea
            rows={4}
            value={draft[field.key]}
            placeholder={field.placeholder}
            onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
          />
        </label>
      ))}
      <div className="ts-ai-form__actions">
        <button type="button" className="ts-btn ts-btn--primary" onClick={() => onSave(draft)}>
          {t('common:action.save')}
        </button>
        <button
          type="button"
          className="ts-btn ts-btn--ghost"
          onClick={() => {
            setDraft({ ...DEFAULT_TEMPLATES })
            onSave({ ...DEFAULT_TEMPLATES })
          }}
        >
          {t('ai:templates.reset')}
        </button>
      </div>
    </div>
  )
}
