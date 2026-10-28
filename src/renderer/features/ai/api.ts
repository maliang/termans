/**
 * AI 面板的 IPC 门面（渲染层唯一入口）。
 *
 * 为什么不直接在组件里 `call('ai:xxx')`：契约里的 4 个通道各自有「契约外的可选字段」
 * （`headers` / `apiKey` / 上下文里的 `os` / `hostId`），把类型断言、默认值和事件订阅
 * 收在这一个文件里，组件就只面对干净的领域类型。
 */
import {
  call,
  subscribe
} from '@renderer/platform/ipc'
import type { IpcRequestOf } from '@shared'
import type {
  AiChatRequest,
  AiConversation,
  AiProvider,
  AiProviderInput,
  AiStreamDelta,
  AiStreamDone,
  AiStreamError
} from '@shared/models/ai'

export interface SaveProviderExtras {
  /** 契约外的自定义请求头（OpenRouter 归属头、Azure 的 api-version 等） */
  headers?: Record<string, string>
  /** 只在这一个调用里传明文 key；它不会回到渲染层，主进程写进加密包 */
  apiKey?: string
}

export interface ChatExtras {
  hostId?: string | null
  /** 契约外的系统信息（os 字段 shared 里没有，主进程按可选字段接收） */
  os?: string | null
}

export async function listProviders(): Promise<AiProvider[]> {
  const result = await call('ai:list-providers')
  return result.providers
}

export async function saveProvider(
  provider: AiProviderInput,
  extras: SaveProviderExtras = {}
): Promise<AiProvider> {
  const payload = {
    provider,
    ...(extras.headers ? { headers: extras.headers } : {}),
    ...(extras.apiKey ? { apiKey: extras.apiKey } : {})
  }
  return call('ai:save-provider', payload as IpcRequestOf<'ai:save-provider'>)
}

export async function deleteProvider(providerId: string): Promise<void> {
  await call('ai:delete-provider', { providerId })
}

export async function setApiKey(providerId: string, apiKey: string): Promise<void> {
  await call('ai:set-api-key', { providerId, apiKey })
}

export async function clearApiKey(providerId: string): Promise<void> {
  await call('ai:clear-api-key', { providerId })
}

export async function testProvider(providerId: string): Promise<{ ok: boolean; message: string }> {
  return call('ai:test-provider', { providerId })
}

export async function listConversations(): Promise<AiConversation[]> {
  const result = await call('ai:list-conversations')
  return result.conversations
}

export async function chat(request: AiChatRequest, extras: ChatExtras = {}): Promise<{ requestId: string }> {
  const payload = {
    ...request,
    context: request.context
      ? { ...request.context, os: extras.os ?? null }
      : null,
    ...(extras.hostId ? { hostId: extras.hostId } : {})
  }
  return call('ai:chat', payload as IpcRequestOf<'ai:chat'>)
}

export async function cancelChat(requestId: string): Promise<void> {
  await call('ai:cancel', { requestId })
}

export interface StreamHandlers {
  onDelta?: (payload: AiStreamDelta) => void
  onDone?: (payload: AiStreamDone) => void
  onError?: (payload: AiStreamError) => void
}

/** 订阅三条流事件；返回一个同时解绑三个的取消函数 */
export function subscribeStream(handlers: StreamHandlers): () => void {
  const offs: Array<() => void> = []
  if (handlers.onDelta) offs.push(subscribe('ai:stream-delta', handlers.onDelta))
  if (handlers.onDone) offs.push(subscribe('ai:stream-done', handlers.onDone))
  if (handlers.onError) offs.push(subscribe('ai:stream-error', handlers.onError))
  return () => {
    for (const off of offs) off()
  }
}

/**
 * 从 `apiKeyRef` 里解出尾 4 位提示。
 *
 * 契约里 `AiProvider` 只有 `apiKeyRef`（不可逆指针）+ `apiKeyTail` 没有单独字段，
 * 因此主进程把尾 4 位编进 ref：`vault:ai-key:<providerId>:<last4>`。
 * 这样重开面板时能显示 `••••abcd`，而 key 本体永远不回渲染层。
 */
export function maskFromKeyRef(apiKeyRef: string | null): string | null {
  if (!apiKeyRef) return null
  const tail = apiKeyRef.split(':').pop() ?? ''
  if (tail.length === 0 || tail.length > 8) return null
  return `••••${tail}`
}

export function hasApiKey(provider: Pick<AiProvider, 'apiKeyRef'>): boolean {
  return Boolean(provider.apiKeyRef)
}
