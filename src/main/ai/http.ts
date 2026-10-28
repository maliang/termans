/**
 * AI 模块的 HTTP 传输层（只用全局 fetch，不引第三方 SDK）。
 *
 * 职责与边界：
 * - 负责超时（连接超时 / 空闲超时）、用户取消（AbortSignal）、429/5xx 的一次退避重试。
 * - 只产出**原始字节分片**（`Uint8Array`），UTF-8 解码交给 `stream.ts` 的解析器，
 *   避免多字节字符被切在分片边界上变成乱码。
 * - 不在这一层打日志（错误原文可能回显 key，脱敏由 service 统一做）。
 */
import type { BuiltRequest } from './adapters'

export type AiRequestErrorKind = 'network' | 'timeout' | 'http' | 'aborted'

export class AiRequestError extends Error {
  readonly kind: AiRequestErrorKind
  readonly status: number | null
  readonly retryable: boolean
  /** 供应商返回的错误体原文（未脱敏，禁止直接透出） */
  readonly bodyText: string

  constructor(message: string, init: { kind: AiRequestErrorKind; status?: number | null; retryable?: boolean; bodyText?: string }) {
    super(message)
    this.name = 'AiRequestError'
    this.kind = init.kind
    this.status = init.status ?? null
    this.retryable = init.retryable ?? false
    this.bodyText = init.bodyText ?? ''
  }
}

export interface TransportOptions {
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface OpenStreamOptions extends TransportOptions {
  request: BuiltRequest
  signal: AbortSignal
  /** 连接（拿到响应头）超时，默认 20s */
  connectTimeoutMs?: number
  /** 两个分片之间的空闲超时，默认 30s */
  idleTimeoutMs?: number
  /** 429/5xx 的重试次数，默认 1（只允许 0 或 1：需求是「一次退避重试」） */
  maxRetries?: number
  /** 重试时回调（service 用它向 UI 说明「正在重试」） */
  onRetry?: (info: { attempt: number; status: number | null; waitMs: number; message: string }) => void
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 20_000
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000
export const DEFAULT_RETRY_BACKOFF_MS = 800

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500
}

function abortedError(): AiRequestError {
  return new AiRequestError('生成已取消', { kind: 'aborted', retryable: false })
}

function timeoutError(what: string, ms: number): AiRequestError {
  return new AiRequestError(`${what}超时（${Math.round(ms / 1000)}s 无响应）`, { kind: 'timeout', retryable: true })
}

function networkError(error: unknown): AiRequestError {
  const message = error instanceof Error ? error.message : String(error)
  return new AiRequestError(`网络请求失败：${message}`, { kind: 'network', retryable: true })
}

/** 带超时的 promise 竞速：超时先 abort 再抛错，确保底层连接被释放 */
function raceTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void, what: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      onTimeout()
      reject(timeoutError(what, ms))
    }, ms)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

interface OpenedStream {
  response: Response
  controller: AbortController
  cleanup: () => void
}

/** 建立流式连接；429/5xx 与连接期网络错误会退避重试一次（此时尚未吐出任何字节） */
async function openStream(opts: OpenStreamOptions): Promise<OpenedStream> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const sleep = opts.sleep ?? defaultSleep
  const maxRetries = Math.min(Math.max(opts.maxRetries ?? 1, 0), 1)
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const { request, signal } = opts

  let lastError: AiRequestError | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal.aborted) throw abortedError()
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    try {
      const response = await raceTimeout(
        fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ?? undefined,
          signal: controller.signal,
          redirect: 'follow'
        }),
        connectTimeoutMs,
        () => controller.abort(),
        '连接供应商'
      )

      if (!response.ok) {
        const bodyText = await readErrorBody(response, idleTimeoutMs, controller)
        const error = new AiRequestError(`HTTP ${response.status}${bodyText ? `: ${bodyText}` : ''}`, {
          kind: 'http',
          status: response.status,
          retryable: isRetryableStatus(response.status),
          bodyText
        })
        cleanup()
        if (error.retryable && attempt < maxRetries) {
          const waitMs = DEFAULT_RETRY_BACKOFF_MS * (attempt + 1)
          opts.onRetry?.({ attempt: attempt + 1, status: response.status, waitMs, message: error.message })
          await sleep(waitMs)
          lastError = error
          continue
        }
        throw error
      }

      return { response, controller, cleanup }
    } catch (error) {
      cleanup()
      if (signal.aborted) throw abortedError()
      const normalized = error instanceof AiRequestError ? error : networkError(error)
      if (normalized.retryable && attempt < maxRetries) {
        const waitMs = DEFAULT_RETRY_BACKOFF_MS * (attempt + 1)
        opts.onRetry?.({ attempt: attempt + 1, status: normalized.status, waitMs, message: normalized.message })
        await sleep(waitMs)
        lastError = normalized
        continue
      }
      throw normalized
    }
  }
  throw lastError ?? networkError(new Error('未知错误'))
}

async function readErrorBody(response: Response, idleTimeoutMs: number, controller: AbortController): Promise<string> {
  try {
    if (!response.body) return ''
    const text = await raceTimeout(response.text(), Math.min(idleTimeoutMs, 5_000), () => controller.abort(), '读取错误响应')
    return text.slice(0, 2_000)
  } catch {
    return ''
  }
}

/**
 * 打开流式响应并逐片产出原始字节。
 *
 * 用法：
 * ```ts
 * for await (const bytes of streamRequest({ request, signal })) decoder.push(bytes)
 * ```
 */
export async function* streamRequest(opts: OpenStreamOptions): AsyncGenerator<Uint8Array, void, void> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const { response, controller, cleanup } = await openStream(opts)
  const onAbort = (): void => controller.abort()
  opts.signal.addEventListener('abort', onAbort, { once: true })
  const reader = response.body?.getReader()
  if (!reader) {
    cleanup()
    opts.signal.removeEventListener('abort', onAbort)
    throw new AiRequestError('供应商返回了空响应体', { kind: 'network', retryable: true })
  }
  try {
    for (;;) {
      const result = await raceTimeout(reader.read(), idleTimeoutMs, () => controller.abort(), '等待下一个数据分片')
      if (result.done) return
      if (result.value && result.value.byteLength > 0) yield result.value
    }
  } catch (error) {
    if (opts.signal.aborted) throw abortedError()
    if (error instanceof AiRequestError) throw error
    throw networkError(error)
  } finally {
    opts.signal.removeEventListener('abort', onAbort)
    cleanup()
    try {
      await reader.cancel()
    } catch {
      /* 已结束的流取消失败可忽略 */
    }
  }
}

export interface JsonResponse {
  status: number
  ok: boolean
  /** 原始响应文本（未脱敏） */
  text: string
  durationMs: number
}

/** 非流式请求（「测试连接」用）：返回状态码与原始响应文本，不抛 HTTP 错误 */
export async function requestJson(
  request: BuiltRequest,
  opts: TransportOptions & { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<JsonResponse> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const now = opts.now ?? Date.now
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  const startedAt = now()
  try {
    const response = await raceTimeout(
      fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        signal: controller.signal,
        redirect: 'follow'
      }),
      timeoutMs,
      () => controller.abort(),
      '连接供应商'
    )
    const text = await raceTimeout(response.text(), timeoutMs, () => controller.abort(), '读取响应')
    return { status: response.status, ok: response.ok, text, durationMs: now() - startedAt }
  } catch (error) {
    if (error instanceof AiRequestError) throw error
    throw networkError(error)
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
}

/** 从供应商错误体里抽出可读的一行（OpenAI/Anthropic/Gemini 都有 `error.message`） */
export function extractProviderErrorMessage(status: number, bodyText: string): string {
  const trimmed = bodyText.trim()
  if (!trimmed) return `HTTP ${status}`
  try {
    const json = JSON.parse(trimmed) as { error?: { message?: string } | string; message?: string; detail?: string }
    if (typeof json.error === 'string' && json.error) return `${json.error}`
    if (json.error && typeof json.error === 'object' && json.error.message) return json.error.message
    if (json.message) return json.message
    if (json.detail) return json.detail
  } catch {
    /* 非 JSON：直接截断原文 */
  }
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}
