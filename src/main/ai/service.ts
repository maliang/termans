/**
 * AI 服务：供应商 CRUD、连通性测试、流式对话（含取消 / 重试 / 用量）、对话记录（v1 仅内存）。
 *
 * 架构位置：主进程内唯一的编排层。IPC 层（`ipc.ts`）只做参数校验与信封，
 * 渲染层只做展示与二次确认；**任何 key 明文都不越过本文件**。
 *
 * 安全纪律（tests/unit/ai-redaction.test.ts 断言）：
 * - 拿到明文 key 后立刻登记进本次请求的 `Redactor`，之后所有日志 / 事件 / 错误消息
 *   都经过它；`emit` 出去的对象里不含 key、也不含 `Authorization` 头。
 * - 日志只打 requestId / providerId / model / 字符数 / 用量，从不打请求头或 body。
 */
import type { IpcEventMap, IpcEventName } from '@shared'
import { IpcCallError } from '@shared'
import {
  aiStreamDeltaSchema,
  aiStreamDoneSchema,
  aiStreamErrorSchema,
  type AiChatRequest,
  type AiConversation,
  type AiMessage,
  type AiProvider,
  type AiProviderInput,
  type AiUsage
} from '@shared/models/ai'
import type { AiSettings } from '@shared/models/settings'
import {
  buildChatRequest,
  buildModelsRequest,
  createDecoder,
  interpretChunk,
  type AdapterInput,
  type StreamFormat
} from './adapters'
import { composeMessages, resolveContextLines } from './context'
import { ConversationStore } from './conversations'
import { AiRequestError, extractProviderErrorMessage, requestJson, streamRequest } from './http'
import { ProviderRepository, type SaveProviderExtras, type StoredProvider } from './provider-store'
import { createRedactor, providerSecretValues, type Redactor } from './redact'
import type { StreamChunk } from './stream'

export type EmitEvent = <E extends IpcEventName>(event: E, payload: IpcEventMap[E]) => void

export interface AiServiceOptions {
  providers: ProviderRepository
  conversations: ConversationStore
  /** 读当前设置（每次调用都读，保证改设置立即生效） */
  getSettings: () => AiSettings
  emit: EmitEvent
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** 日志出口（默认 console.info；测试注入以断言不含 key） */
  log?: (line: string) => void
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  maxRetries?: number
}

export class StreamFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamFrameError'
  }
}

interface ActiveRequest {
  requestId: string
  providerId: string
  controller: AbortController
  cancelled: boolean
  content: string
  usage: AiUsage | null
  deltaCount: number
}

export interface ChatExtras {
  /** 契约外可选字段：当前主机 id（用于把对话归档到主机） */
  hostId?: string | null
  /** 契约外可选字段：系统信息，随上下文块一起发给模型 */
  os?: string | null
}

export interface TestProviderResult {
  ok: boolean
  message: string
}

function mergeUsage(current: AiUsage | null, patch: Partial<AiUsage> | undefined): AiUsage | null {
  if (!patch) return current
  return {
    promptTokens: patch.promptTokens ?? current?.promptTokens ?? null,
    completionTokens: patch.completionTokens ?? current?.completionTokens ?? null
  }
}

function requiresApiKey(provider: Pick<AiProvider, 'kind'>): boolean {
  // 本地 Ollama 默认无鉴权；其它供应商必须有 key（自建网关也至少要一个占位 token）
  return provider.kind !== 'ollama'
}

export class AiService {
  private readonly options: AiServiceOptions
  private readonly active = new Map<string, ActiveRequest>()
  private readonly settling = new Map<string, Promise<void>>()

  constructor(options: AiServiceOptions) {
    this.options = options
  }

  /* ----------------------------- 供应商 ----------------------------- */

  async listProviders(): Promise<AiProvider[]> {
    return this.options.providers.list()
  }

  async saveProvider(input: AiProviderInput, extras: SaveProviderExtras = {}): Promise<AiProvider> {
    const saved = await this.options.providers.save(input, extras)
    this.log(`provider saved id=${saved.id} kind=${saved.kind} model=${saved.model} hasKey=${saved.apiKeyRef !== null}`)
    return saved
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.options.providers.remove(providerId)
    this.log(`provider removed id=${providerId}`)
  }

  async setApiKey(providerId: string, apiKey: string): Promise<AiProvider> {
    const provider = await this.options.providers.setApiKey(providerId, apiKey)
    this.log(`provider key updated id=${providerId} tail=${provider.apiKeyRef?.split(':').pop() ?? ''}`)
    return provider
  }

  async clearApiKey(providerId: string): Promise<AiProvider> {
    const provider = await this.options.providers.clearApiKey(providerId)
    this.log(`provider key cleared id=${providerId}`)
    return provider
  }

  /**
   * 测试连接：真实发一次请求（`GET /models` 或最小 chat），把供应商的错误原文透出。
   * 永不抛异常（vault 未解锁除外），失败也返回 `{ok:false, message}`，UI 直接展示。
   */
  async testProvider(providerId: string): Promise<TestProviderResult> {
    const provider = await this.options.providers.get(providerId)
    const apiKey = await this.options.providers.getApiKey(providerId)
    // 自定义头里可能放的是 token → 与 API key 同样登记进脱敏器（供应商回显时被掩码）
    const redactor = createRedactor(providerSecretValues(apiKey, provider.headers))
    if (!apiKey && requiresApiKey(provider)) {
      return { ok: false, message: redactor.redactText('尚未配置 API key：请先在供应商设置里填写并保存') }
    }
    const request = buildModelsRequest({ provider, apiKey, extraHeaders: provider.headers })
    try {
      const response = await requestJson(request, {
        fetchImpl: this.options.fetchImpl,
        now: this.options.now,
        timeoutMs: this.options.connectTimeoutMs
      })
      if (response.ok) {
        const modelHint = this.describeModelPresence(provider, response.text)
        const message = redactor.redactText(
          `连接成功（HTTP ${response.status}，${response.durationMs}ms）${modelHint}`
        )
        this.log(`test provider ok id=${providerId} status=${response.status} ms=${response.durationMs}`)
        return { ok: true, message }
      }
      const detail = extractProviderErrorMessage(response.status, response.text)
      this.log(`test provider failed id=${providerId} status=${response.status}`)
      return {
        ok: false,
        message: redactor.redactText(`HTTP ${response.status}：${detail}`)
      }
    } catch (error) {
      const described = this.describeError(error, redactor)
      this.log(`test provider error id=${providerId} kind=${error instanceof AiRequestError ? error.kind : 'unknown'}`)
      return { ok: false, message: described.message }
    }
  }

  /** 连通成功时提示「模型名是否在返回列表里」——最常见的配置错误，能省一轮排查 */
  private describeModelPresence(provider: AiProvider, bodyText: string): string {
    try {
      const json = JSON.parse(bodyText) as {
        data?: Array<{ id?: string }>
        models?: Array<{ name?: string; model?: string }>
      }
      const ids = new Set<string>()
      for (const item of json.data ?? []) if (item.id) ids.add(item.id)
      for (const item of json.models ?? []) {
        const name = item.model ?? item.name
        if (name) ids.add(name)
      }
      if (ids.size === 0) return ''
      if (ids.has(provider.model)) return `，模型 ${provider.model} 可用`
      const preview = [...ids].slice(0, 5).join(', ')
      return `，但未在列表中找到模型 ${provider.model}（可用示例：${preview}）`
    } catch {
      return ''
    }
  }

  /* ----------------------------- 对话 ----------------------------- */

  listConversations(): AiConversation[] {
    return this.options.conversations.list()
  }

  /**
   * 发起一次流式对话。
   *
   * 参数错误（供应商不存在 / 未配置 key / 未启用）会**同步抛错**，让 invoke 直接拿到失败信封；
   * 流式阶段的错误一律通过 `ai:stream-error` 事件抛出（此时 invoke 早已返回 requestId）。
   */
  async chat(request: AiChatRequest, extras: ChatExtras = {}): Promise<{ requestId: string }> {
    const settings = this.options.getSettings()
    if (!settings.enabled) {
      throw new IpcCallError({ code: 'E_AI_PROVIDER', message: 'AI 辅助未启用：请先在设置中开启' })
    }
    const provider = await this.options.providers.get(request.providerId)
    if (!provider.enabled) {
      throw new IpcCallError({ code: 'E_AI_PROVIDER', message: `供应商已停用：${provider.name}` })
    }
    const apiKey = await this.options.providers.getApiKey(request.providerId)
    if (!apiKey && requiresApiKey(provider)) {
      throw new IpcCallError({
        code: 'E_AI_PROVIDER',
        message: `供应商「${provider.name}」尚未配置 API key`
      })
    }

    // 同一 requestId 重复发起：取消上一次，避免两条流同时往同一个气泡里写
    const previous = this.active.get(request.requestId)
    if (previous) previous.controller.abort()

    const contextLines = request.context ? resolveContextLines(settings.contextLines) : 0
    const messages = composeMessages({
      messages: request.messages,
      context: request.context,
      contextLines,
      os: extras.os ?? null
    })
    const adapterInput: AdapterInput = {
      provider,
      apiKey,
      extraHeaders: provider.headers,
      messages
    }
    const built = buildChatRequest(adapterInput)
    const active: ActiveRequest = {
      requestId: request.requestId,
      providerId: provider.id,
      controller: new AbortController(),
      cancelled: false,
      content: '',
      usage: null,
      deltaCount: 0
    }
    this.active.set(request.requestId, active)
    this.log(
      `chat start request=${request.requestId} provider=${provider.id} kind=${provider.kind} model=${provider.model} contextLines=${contextLines} messages=${messages.length}`
    )

    const settled = this.runChat({ request, provider, apiKey, active, built, extras }).finally(() => {
      this.active.delete(request.requestId)
      this.settling.delete(request.requestId)
    })
    this.settling.set(request.requestId, settled)
    return { requestId: request.requestId }
  }

  /** 中断生成（幂等：已经结束的 requestId 直接忽略） */
  cancel(requestId: string): void {
    const active = this.active.get(requestId)
    if (!active) return
    active.cancelled = true
    active.controller.abort()
    this.log(`chat cancel request=${requestId}`)
  }

  /** 测试辅助：等待某个请求结束（生产 IPC 不需要） */
  async whenSettled(requestId: string): Promise<void> {
    const promise = this.settling.get(requestId)
    if (promise) await promise
  }

  /** 当前在跑的请求数（诊断用） */
  get activeCount(): number {
    return this.active.size
  }

  private async runChat(args: {
    request: AiChatRequest
    provider: StoredProvider
    apiKey: string | null
    active: ActiveRequest
    built: ReturnType<typeof buildChatRequest>
    extras: ChatExtras
  }): Promise<void> {
    const { request, provider, apiKey, active, built, extras } = args
    const redactor = createRedactor(providerSecretValues(apiKey, provider.headers))
    const format: StreamFormat = built.format
    const decoder = createDecoder(format)
    let finished = false

    const applyChunk = (chunk: StreamChunk): void => {
      const interpreted = interpretChunk(format, chunk)
      if (interpreted.error) {
        throw new StreamFrameError(interpreted.error)
      }
      if (interpreted.usage) active.usage = mergeUsage(active.usage, interpreted.usage)
      if (interpreted.delta) {
        active.content += interpreted.delta
        active.deltaCount += 1
        this.emitStream('ai:stream-delta', { requestId: request.requestId, delta: interpreted.delta })
      }
      if (interpreted.done) finished = true
    }

    try {
      for await (const bytes of streamRequest({
        request: built,
        signal: active.controller.signal,
        fetchImpl: this.options.fetchImpl,
        sleep: this.options.sleep,
        connectTimeoutMs: this.options.connectTimeoutMs,
        idleTimeoutMs: this.options.idleTimeoutMs,
        maxRetries: this.options.maxRetries,
        onRetry: (info) => {
          this.log(`chat retry request=${request.requestId} attempt=${info.attempt} status=${info.status ?? 'n/a'} wait=${info.waitMs}`)
        }
      })) {
        for (const chunk of decoder.push(bytes)) {
          applyChunk(chunk)
          if (finished) break
        }
        if (finished) break
      }

      if (!finished) {
        // 流自然结束（没有显式结束标记）或连接被切断：把尾部残留帧处理掉再判断
        for (const chunk of decoder.flush()) {
          applyChunk(chunk)
          if (finished) break
        }
        if (decoder.incomplete && !finished) {
          throw new StreamFrameError('AI 响应意外中断：连接在传输完成前被切断')
        }
      }

      if (active.content.trim().length === 0) {
        throw new StreamFrameError('供应商没有返回任何内容（可能是模型名错误或额度不足）')
      }
      this.finishSuccess({ request, provider, active, extras })
    } catch (error) {
      if (active.cancelled || (error instanceof AiRequestError && error.kind === 'aborted')) {
        this.finishCancelled({ request, active })
        return
      }
      const described = this.describeError(error, redactor)
      this.log(
        `chat error request=${request.requestId} retryable=${described.retryable} message=${described.message.slice(0, 200)}`
      )
      this.emitStream('ai:stream-error', {
        requestId: request.requestId,
        message: described.message,
        retryable: described.retryable
      })
    } finally {
      this.settling.delete(request.requestId)
      this.active.delete(request.requestId)
    }
  }

  private finishSuccess(args: {
    request: AiChatRequest
    provider: AiProvider
    active: ActiveRequest
    extras: ChatExtras
  }): void {
    const { request, provider, active, extras } = args
    const message: AiMessage = { role: 'assistant', content: active.content }
    const usage = active.usage
    try {
      const turns = request.messages.filter((item) => item.role !== 'system')
      this.options.conversations.recordTurn({
        conversationId: request.conversationId,
        hostId: extras.hostId ?? null,
        messages: [...turns, message]
      })
    } catch (error) {
      // 落盘失败不影响本次回答（用户已经看到内容了），只留日志
      this.log(`conversation record failed request=${request.requestId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.log(
      `chat done request=${request.requestId} provider=${provider.id} deltas=${active.deltaCount} chars=${active.content.length} usage=${usage ? `${usage.promptTokens ?? '?'}/${usage.completionTokens ?? '?'}` : 'n/a'}`
    )
    this.emitStream('ai:stream-done', aiStreamDoneSchema.parse({ requestId: request.requestId, message, usage }))
  }

  private finishCancelled(args: { request: AiChatRequest; active: ActiveRequest }): void {
    const { request, active } = args
    this.log(`chat cancelled request=${request.requestId} chars=${active.content.length} deltas=${active.deltaCount}`)
    if (active.content.length === 0) {
      this.emitStream('ai:stream-error', {
        requestId: request.requestId,
        message: '已取消生成',
        retryable: false
      })
      return
    }
    // 有部分内容时按「完成」收尾，让用户保留已经生成的部分（契约没有 cancelled 字段）
    this.emitStream('ai:stream-done', {
      requestId: request.requestId,
      message: { role: 'assistant', content: active.content },
      usage: active.usage
    })
  }

  /** 把异常翻译成「用户能读懂 + 能判断该不该重试」的一句话（含供应商原文，已脱敏） */
  private describeError(error: unknown, redactor: Redactor): { message: string; retryable: boolean } {
    if (error instanceof AiRequestError) {
      const detail = error.bodyText ? extractProviderErrorMessage(error.status ?? 0, error.bodyText) : ''
      const suffix = detail ? `：${detail}` : ''
      switch (error.kind) {
        case 'timeout':
          return { message: redactor.redactText(`${error.message}。请检查网络或供应商地址后重试。`), retryable: true }
        case 'network':
          return { message: redactor.redactText(`${error.message}。已自动重试一次仍失败。`), retryable: true }
        case 'http': {
          const status = error.status ?? 0
          if (status === 401 || status === 403) {
            return { message: redactor.redactText(`鉴权失败（HTTP ${status}）${suffix}。请检查 API key 是否正确/过期。`), retryable: false }
          }
          if (status === 404) {
            return { message: redactor.redactText(`接口不存在（HTTP 404）${suffix}。请检查 baseURL 是否指向兼容端点。`), retryable: false }
          }
          if (status === 429) {
            return { message: redactor.redactText(`请求被限流（HTTP 429）${suffix}。已自动重试一次仍失败，请稍后再试。`), retryable: true }
          }
          if (status >= 500) {
            return { message: redactor.redactText(`供应商服务端错误（HTTP ${status}）${suffix}。已自动重试一次仍失败。`), retryable: true }
          }
          return { message: redactor.redactText(`请求失败（HTTP ${status}）${suffix}`), retryable: false }
        }
        case 'aborted':
        default:
          return { message: redactor.redactText(error.message), retryable: false }
      }
    }
    if (error instanceof StreamFrameError) {
      return { message: redactor.redactText(error.message), retryable: true }
    }
    if (error instanceof IpcCallError) {
      return { message: redactor.redactText(error.message), retryable: false }
    }
    return {
      message: redactor.redactText(error instanceof Error ? error.message : String(error)),
      retryable: false
    }
  }

  private emitStream<E extends 'ai:stream-delta' | 'ai:stream-done' | 'ai:stream-error'>(
    event: E,
    payload: IpcEventMap[E]
  ): void {
    try {
      this.options.emit(event, payload)
    } catch (error) {
      // 窗口已关闭 / 事件发不出去不该拖垮流
      this.log(`emit ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private log(line: string): void {
    const log = this.options.log ?? ((message: string) => console.info(`[ai] ${message}`))
    log(line)
  }
}

/** 事件 payoad 的 zod 校验常量，供测试直接复用（防止手写结构漂移） */
export const AI_STREAM_SCHEMAS = {
  delta: aiStreamDeltaSchema,
  done: aiStreamDoneSchema,
  error: aiStreamErrorSchema
} as const
