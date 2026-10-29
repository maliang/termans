/**
 * AI 面板状态（zustand）。
 *
 * 划界：
 * - 这里只放「AI 面板自己的东西」：当前会话消息、流式缓冲、供应商列表、提示词模板；
 * - 终端缓冲、页签、主机库分别属于 terminal / tabs / vault-sync 的 store，**不复制**过来，
 *   需要终端快照时由面板通过 `getContext()` 现取（一次性读 buffer 尾 N 行）。
 * - 对话历史 v1 **只在内存**（主进程 ConversationStore，重启即失；不落盘、不进 Git 同步），
 *   这里只保留当前会话的消息用于渲染。
 */
import { create } from 'zustand'
import type { AiMessage, AiProvider, AiUsage } from '@shared/models/ai'
import * as api from './api'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 流式生成中（UI 显示光标/停止按钮） */
  streaming?: boolean
}

export interface TerminalSnapshot {
  sessionId: string
  hostLabel: string
  cwd: string | null
  os: string | null
  /** 原始终端输出（含 ANSI，注入前由主进程剥离） */
  recentOutput: string
}

export interface PromptTemplates {
  /** 选中文本 → 解释（`{{selection}}` 占位） */
  explain: string
  /** 目标 → 命令（`{{goal}}` 占位） */
  command: string
  /** 报错 → 排查建议（`{{selection}}` 占位） */
  error: string
}

/**
 * 错误码 → i18n key 的映射。
 *
 * 后端给的是稳定的大写错误码（`E_VAULT_LOCKED`），而 i18n 约定 key 只能是
 * `[a-z][A-Za-z0-9-]*`（契约测试会拦下划线），所以这里做一次确定性转换；
 * 没有对应词条时 UI 回退显示原始错误码（比空白更有助于排查）。
 */
export function errorMessageKey(code: string): string {
  const body = code.startsWith('E_') ? code.slice(2) : code
  const parts = body.split('_').filter((part) => part.length > 0)
  if (parts.length === 0) return 'unknown'
  return parts[0].toLowerCase() + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase()).join('')
}

/**
 * 从展示文案里取回稳定错误码（`[E_VAULT_LOCKED] 加密包已锁定…` → `E_VAULT_LOCKED`）。
 *
 * 为什么需要它：store 里存的是「可展示文案」（`IpcCallError.message` 自带 `[CODE]` 前缀），
 * 而面板要按**码**决定「是空态还是报错」——加密包锁定时这不是故障，不该出现红色错误条。
 * 取不到码时返回 null，调用方回退到「按文案显示」的老路径。
 */
export function errorCodeOf(message: string | null): string | null {
  if (!message) return null
  const matched = /^\s*\[([A-Z][A-Z0-9_]*)\]/.exec(message)
  return matched ? matched[1] : null
}

export const TEMPLATE_STORAGE_KEY = 'termans.ai.templates.v1'

export const DEFAULT_TEMPLATES: PromptTemplates = {
  explain:
    '解释下面这段终端输出/报错，用一句话说结论，再给出排查步骤与具体命令（命令放 ```bash 代码块）。\n\n{{selection}}',
  command:
    '我想在当前主机上完成：{{goal}}\n\n请给出可直接执行的命令（放 ```bash 代码块），并说明每一步的作用与风险。',
  error:
    '下面是我终端里的报错。请判断根因、给出修复命令，并说明如何验证修复成功（命令放 ```bash 代码块）。\n\n{{selection}}'
}

export function loadTemplates(): PromptTemplates {
  try {
    const raw = window.localStorage.getItem(TEMPLATE_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_TEMPLATES }
    const parsed = JSON.parse(raw) as Partial<PromptTemplates>
    return {
      explain: typeof parsed.explain === 'string' ? parsed.explain : DEFAULT_TEMPLATES.explain,
      command: typeof parsed.command === 'string' ? parsed.command : DEFAULT_TEMPLATES.command,
      error: typeof parsed.error === 'string' ? parsed.error : DEFAULT_TEMPLATES.error
    }
  } catch {
    return { ...DEFAULT_TEMPLATES }
  }
}

export function saveTemplates(templates: PromptTemplates): void {
  try {
    window.localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates))
  } catch {
    // 存储不可用（隐私模式）时忽略：模板丢了不影响会话，但不要让面板崩掉
  }
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{{${key}}}`).join(value),
    template
  )
}

export type AiView = 'chat' | 'providers' | 'templates'

export interface AiState {
  providers: AiProvider[]
  providersLoaded: boolean
  activeProviderId: string | null
  conversationId: string
  messages: ChatMessage[]
  streaming: boolean
  streamRequestId: string | null
  usage: AiUsage | null
  error: string | null
  /** 非错误提示（「已复制」「已连接」） */
  notice: string | null
  view: AiView
  templates: PromptTemplates
  /** 上下文注入开关（默认关；打开后发送前必看预览） */
  contextEnabled: boolean
  contextLines: number
  busy: boolean

  init: () => Promise<void>
  reloadProviders: () => Promise<void>
  setActiveProvider: (providerId: string | null) => void
  setView: (view: AiView) => void
  setTemplates: (templates: PromptTemplates) => void
  setContextEnabled: (enabled: boolean) => void
  setContextLines: (lines: number) => void
  setNotice: (notice: string | null) => void
  setError: (error: string | null) => void
  newConversation: () => void

  send: (text: string, context: TerminalSnapshot | null, providerId?: string | null) => Promise<void>
  cancel: () => Promise<void>
  handleDelta: (requestId: string, delta: string) => void
  handleDone: (requestId: string, message: AiMessage, usage: AiUsage | null) => void
  handleError: (requestId: string, message: string) => void
}

let messageSeq = 0
function nextId(prefix: string): string {
  messageSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${messageSeq}`
}

function toRequestMessages(messages: ChatMessage[]): AiMessage[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({ role: message.role, content: message.content }))
}

export const useAiStore = create<AiState>((set, get) => ({
  providers: [],
  providersLoaded: false,
  activeProviderId: null,
  conversationId: nextId('conv'),
  messages: [],
  streaming: false,
  streamRequestId: null,
  usage: null,
  error: null,
  notice: null,
  view: 'chat',
  templates: typeof window === 'undefined' ? { ...DEFAULT_TEMPLATES } : loadTemplates(),
  contextEnabled: false,
  contextLines: 200,
  busy: false,

  init: async () => {
    if (get().busy) return
    set({ busy: true, error: null })
    try {
      await get().reloadProviders()
    } finally {
      set({ busy: false })
    }
  },

  reloadProviders: async () => {
    try {
      const providers = await api.listProviders()
      const current = get().activeProviderId
      const stillThere = providers.some((provider) => provider.id === current)
      const enabled = providers.filter((provider) => provider.enabled)
      set({
        providers,
        providersLoaded: true,
        activeProviderId: stillThere
          ? current
          : (enabled[0]?.id ?? providers[0]?.id ?? null),
        error: null
      })
    } catch (error) {
      set({ providersLoaded: true, error: describe(error) })
    }
  },

  setActiveProvider: (providerId) => set({ activeProviderId: providerId }),
  setView: (view) => set({ view }),
  setTemplates: (templates) => {
    saveTemplates(templates)
    set({ templates })
  },
  setContextEnabled: (enabled) => set({ contextEnabled: enabled }),
  setContextLines: (lines) => set({ contextLines: Math.max(0, Math.min(500, Math.trunc(lines))) }),
  setNotice: (notice) => set({ notice }),
  setError: (error) => set({ error }),

  newConversation: () =>
    set({
      conversationId: nextId('conv'),
      messages: [],
      usage: null,
      error: null,
      streaming: false,
      streamRequestId: null
    }),

  send: async (text, context, providerId) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const state = get()
    if (state.streaming) return
    const provider = providerId ?? state.activeProviderId
    if (!provider) {
      set({ error: 'NO_PROVIDER' })
      return
    }
    const userMessage: ChatMessage = { id: nextId('msg'), role: 'user', content: trimmed }
    const assistantMessage: ChatMessage = {
      id: nextId('msg'),
      role: 'assistant',
      content: '',
      streaming: true
    }
    const nextMessages = [...state.messages, userMessage]
    set({ messages: [...nextMessages, assistantMessage], streaming: true, error: null, notice: null, usage: null })

    const requestId = nextId('req')
    try {
      await api.chat(
        {
          requestId,
          conversationId: state.conversationId,
          providerId: provider,
          messages: toRequestMessages(nextMessages),
          context: context
            ? {
                sessionId: context.sessionId,
                hostLabel: context.hostLabel,
                cwd: context.cwd,
                recentOutput: context.recentOutput.slice(-20000)
              }
            : null
        },
        { hostId: null, os: context?.os ?? null }
      )
      set({ streamRequestId: requestId })
    } catch (error) {
      set({
        streaming: false,
        streamRequestId: null,
        error: describe(error)
      })
      set((current) => ({
        messages: current.messages.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, streaming: false, content: message.content }
            : message
        )
      }))
    }
  },

  cancel: async () => {
    const requestId = get().streamRequestId
    if (!requestId) return
    try {
      await api.cancelChat(requestId)
    } catch (error) {
      set({ error: describe(error) })
    }
  },

  handleDelta: (requestId, delta) => {
    if (get().streamRequestId !== requestId) return
    set((state) => {
      const messages = [...state.messages]
      const index = messages.length - 1
      const last = messages[index]
      if (!last || last.role !== 'assistant') return { messages: state.messages }
      messages[index] = { ...last, content: last.content + delta }
      return { messages }
    })
  },

  handleDone: (requestId, message, usage) => {
    if (get().streamRequestId !== requestId) return
    set((state) => {
      const messages = [...state.messages]
      const index = messages.length - 1
      const last = messages[index]
      if (last && last.role === 'assistant') {
        messages[index] = {
          ...last,
          // 主进程的完整消息是权威值：流式过程中若丢过帧，以它为准
          content: message.content.length > 0 ? message.content : last.content,
          streaming: false
        }
      }
      return { messages, streaming: false, streamRequestId: null, usage }
    })
  },

  handleError: (requestId, message) => {
    if (get().streamRequestId !== requestId) return
    set((state) => {
      const messages = state.messages.map((item) =>
        item.streaming ? { ...item, streaming: false } : item
      )
      return { messages, streaming: false, streamRequestId: null, error: message }
    })
  }
}))

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
