/**
 * AI 模块的 IPC 注册。
 *
 * 边界：
 * - 本文件只做「请求校验 → 调 service → 返回契约结构」，不含业务逻辑；
 * - 契约外但必需的两个兼容字段（见 docs/ai-providers.md「契约差异」）：
 *   1. `ai:save-provider` 额外接受 `headers`（自定义请求头）与 `apiKey`（与配置一起保存），
 *      因为 `AiProvider` 结构里既没有 headers 也没有明文 key 字段；两者都写进 vault。
 *   2. `ai:chat` 额外接受 `os` / `hostId`，因为 `AiTerminalContext` 没有系统信息字段，
 *      而需求要求上下文里带「主机名/用户/系统」。
 *   这些字段全部可选：不带时行为与契约完全一致。
 */
import { z } from 'zod'
import {
  aiChatRequestSchema,
  aiProviderInputSchema,
  aiTerminalContextSchema,
  type AiProvider,
  type AiSettings
} from '@shared'
import { handle } from '../ipc/registry'
import { AiService, type EmitEvent } from './service'
import { ConversationStore, purgeLegacyConversationFiles } from './conversations'
import { ProviderRepository } from './provider-store'
import type { AiVaultPort } from './vault-port'

/** `ai:save-provider` 的扩展请求结构 */
export const saveProviderRequestSchema = z.object({
  provider: aiProviderInputSchema,
  headers: z.record(z.string(), z.string()).optional(),
  /** 与配置一起提交的 key（写进 vault；空串表示清除） */
  apiKey: z.string().max(8_192).optional()
})

/** `ai:chat` 的扩展请求结构：上下文可携带 os，请求可携带 hostId */
export const chatRequestSchema = z.object({
  requestId: aiChatRequestSchema.shape.requestId,
  conversationId: aiChatRequestSchema.shape.conversationId,
  providerId: aiChatRequestSchema.shape.providerId,
  messages: aiChatRequestSchema.shape.messages,
  context: aiTerminalContextSchema
    .extend({ os: z.string().max(120).nullable().optional() })
    .nullable(),
  hostId: z.string().max(120).nullable().optional(),
  os: z.string().max(120).nullable().optional()
})

export const providerIdRequestSchema = z.object({ providerId: z.string().min(1) })
export const setApiKeyRequestSchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1).max(8_192)
})
export const cancelRequestSchema = z.object({ requestId: z.string().min(1) })

interface SaveProviderExtrasShape {
  headers?: Record<string, string>
  apiKey?: string
}

interface ChatExtrasShape {
  hostId?: string | null
  os?: string | null
}

export function registerAiHandlers(service: AiService): void {
  handle('ai:list-providers', async () => ({ providers: await service.listProviders() }))

  handle(
    'ai:save-provider',
    async (request) => {
      const extras = request as unknown as SaveProviderExtrasShape
      return service.saveProvider(request.provider, {
        headers: extras.headers,
        apiKey: extras.apiKey
      })
    },
    saveProviderRequestSchema
  )

  handle(
    'ai:delete-provider',
    async (request) => {
      await service.deleteProvider(request.providerId)
    },
    providerIdRequestSchema
  )

  handle(
    'ai:set-api-key',
    async (request) => {
      await service.setApiKey(request.providerId, request.apiKey)
    },
    setApiKeyRequestSchema
  )

  handle(
    'ai:clear-api-key',
    async (request) => {
      await service.clearApiKey(request.providerId)
    },
    providerIdRequestSchema
  )

  handle('ai:test-provider', (request) => service.testProvider(request.providerId), providerIdRequestSchema)

  handle(
    'ai:chat',
    async (request) => {
      const extras = request as unknown as ChatExtrasShape
      const context = request.context
        ? {
            sessionId: request.context.sessionId,
            hostLabel: request.context.hostLabel,
            recentOutput: request.context.recentOutput,
            cwd: request.context.cwd
          }
        : null
      return service.chat(
        {
          requestId: request.requestId,
          conversationId: request.conversationId,
          providerId: request.providerId,
          messages: request.messages,
          context
        },
        {
          hostId: extras.hostId ?? null,
          os: extras.os ?? (request.context as { os?: string | null } | null)?.os ?? null
        }
      )
    },
    chatRequestSchema
  )

  handle(
    'ai:cancel',
    (request) => {
      service.cancel(request.requestId)
    },
    cancelRequestSchema
  )

  handle('ai:list-conversations', () => ({ conversations: service.listConversations() }))
}

export interface AiModuleDeps {
  /** t4 加密包适配器（锁定时所有调用返回 E_VAULT_LOCKED） */
  vault: AiVaultPort
  /**
   * userData 目录。**只用于删除老版本遗留的明文对话文件**（`ai-conversations.json*`），
   * 不用于存储——v1 的对话只在内存里（见 conversations.ts 顶部说明）。
   */
  userDataDir?: string
  getSettings: () => AiSettings
  emit: EmitEvent
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (line: string) => void
  connectTimeoutMs?: number
  idleTimeoutMs?: number
  maxRetries?: number
}

export interface AiModule {
  service: AiService
  providers: ProviderRepository
  conversations: ConversationStore
}

/**
 * 组装 AI 模块（供 `src/main/ipc/index.ts` 接线用，一行即可）：
 * ```ts
 * const ai = createAiModule({ vault, userDataDir: app.getPath('userData'), getSettings: () => settings.get().ai, emit: emitToAll })
 * registerAiHandlers(ai.service)
 * ```
 */
export function createAiModule(deps: AiModuleDeps): AiModule {
  const log = deps.log ?? ((line: string) => console.log(`[ai] ${line}`))
  if (deps.userDataDir) {
    // 老版本（t5 首版）曾把对话明文写到 userData；启动即删，绝不读取、不做迁移。
    const removed = purgeLegacyConversationFiles(deps.userDataDir, (message) => log(message))
    if (removed.length > 0) log(`purged legacy plaintext conversations files=${removed.length}`)
  }
  const providers = new ProviderRepository({ vault: deps.vault, now: deps.now })
  const conversations = new ConversationStore({ now: deps.now })
  const service = new AiService({
    providers,
    conversations,
    getSettings: deps.getSettings,
    emit: deps.emit,
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
    now: deps.now,
    log: deps.log,
    connectTimeoutMs: deps.connectTimeoutMs,
    idleTimeoutMs: deps.idleTimeoutMs,
    maxRetries: deps.maxRetries
  })
  return { service, providers, conversations }
}

export type { AiProvider }
