/**
 * 供应商配置仓库 —— 配置与 API key **都放在加密包（vault）里**。
 *
 * 存储布局（vault 内的 key）：
 * - `ai/providers.json`            → `{ version: 1, providers: StoredProvider[] }`
 * - `ai/api-key.<providerId>`      → API key 原文（vault 负责加密落盘）
 *
 * 三条不可协商的规则：
 * 1. 明文 key 只在这里「从 vault 读出、写进 HTTP 头」；不写进 `ai/providers.json`，
 *    不进 `AiProvider` 结构（那里只有 `apiKeyRef = vault:ai-key:<id>:<last4>`）。
 * 2. 任何写盘路径的数据都来自「显式字段白名单」，不 spread 渲染层传来的对象，
 *    防止 `{...input}` 把 `apiKey` 一起带进文档。
 * 3. vault 未解锁 → 抛 `E_VAULT_LOCKED`，没有明文回退分支。
 */
import { z } from 'zod'
import { IpcCallError, aiProviderSchema, type AiProvider, type AiProviderInput } from '@shared'
import { type AiVaultPort, assertVaultUnlocked, toVaultIpcError } from './vault-port'
import { buildApiKeyRef } from './redact'

export const PROVIDER_DOC_KEY = 'ai/providers.json'
export const apiKeyDocKey = (providerId: string): string => `ai/api-key.${providerId}`

/** 额外 header 持久化在 vault 文档里（契约 `AiProvider` 没有该字段，见 docs 的契约差异一节） */
export type ExtraHeaders = Record<string, string>

export interface StoredProvider extends AiProvider {
  headers: ExtraHeaders
}

const headersSchema = z.record(z.string(), z.string())

const storedProviderSchema = aiProviderSchema.extend({
  headers: headersSchema.optional()
})

const providerDocSchema = z.object({
  version: z.literal(1),
  providers: z.array(storedProviderSchema)
})

const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])

/** header 名归一化 + 危险 header 过滤（fetch 会拒绝，且可被用来做请求走私） */
export function sanitizeHeaders(raw: Record<string, string> | undefined): ExtraHeaders {
  const out: ExtraHeaders = {}
  if (!raw) return out
  for (const [key, value] of Object.entries(raw)) {
    const name = key.trim().toLowerCase()
    if (!name || !/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
    if (BLOCKED_HEADERS.has(name)) continue
    if (typeof value !== 'string') continue
    if (value.length > 2_000) continue
    out[name] = value
  }
  return out
}

export interface ProviderRepositoryOptions {
  vault: AiVaultPort
  now?: () => number
  idFactory?: () => string
  /** 文档损坏时的告警出口（默认 console.warn；测试可注入） */
  onWarn?: (message: string) => void
}

export interface SaveProviderExtras {
  headers?: Record<string, string>
  /** 与配置一起提交的 key（空串 = 清除）；由本仓库写进 vault，不落明文 */
  apiKey?: string | null
}

export class ProviderRepository {
  private readonly vault: AiVaultPort
  private readonly now: () => number
  private readonly idFactory: () => string
  private readonly onWarn: (message: string) => void

  constructor(options: ProviderRepositoryOptions) {
    this.vault = options.vault
    this.now = options.now ?? Date.now
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID())
    this.onWarn = options.onWarn ?? ((message) => console.warn(`[ai] ${message}`))
  }

  /** 列表（不含额外 header；含 apiKeyRef 供 UI 显示尾 4 位） */
  async list(): Promise<AiProvider[]> {
    const doc = await this.readDoc()
    return doc.providers.map(({ headers: _headers, ...provider }) => provider)
  }

  /** 完整内部视图（含 header），只给主进程内部使用 */
  async listStored(): Promise<StoredProvider[]> {
    const doc = await this.readDoc()
    return doc.providers.map((provider) => ({ ...provider, headers: sanitizeHeaders(provider.headers) }))
  }

  async get(providerId: string): Promise<StoredProvider> {
    const doc = await this.readDoc()
    const found = doc.providers.find((provider) => provider.id === providerId)
    if (!found) {
      throw new IpcCallError({ code: 'E_NOT_FOUND', message: `供应商不存在：${providerId}` })
    }
    return { ...found, headers: sanitizeHeaders(found.headers) }
  }

  /**
   * 新建或更新供应商。
   * `id` 由渲染层生成（新建设置 uuid），主进程按 id 是否存在决定新建/更新。
   */
  async save(input: AiProviderInput, extras: SaveProviderExtras = {}): Promise<AiProvider> {
    try {
      assertVaultUnlocked(this.vault)
      const doc = await this.readDoc()
      // 新建时渲染层可以传 'new' 占位，由主进程生成 id（避免渲染层与控制 id 生成规则）
      const providerId = input.id === 'new' || input.id.trim().length === 0 ? this.idFactory() : input.id
      const index = doc.providers.findIndex((provider) => provider.id === providerId)
      const existing = index >= 0 ? doc.providers[index] : undefined
      const timestamp = new Date(this.now()).toISOString()

      let apiKeyRef = existing?.apiKeyRef ?? null
      if (extras.apiKey !== undefined && extras.apiKey !== null) {
        if (extras.apiKey.length > 0) {
          await this.vault.writeDoc(apiKeyDocKey(providerId), extras.apiKey)
          apiKeyRef = buildApiKeyRef(providerId, extras.apiKey)
        } else {
          await this.vault.deleteDoc(apiKeyDocKey(providerId))
          apiKeyRef = null
        }
      }

      // 显式字段白名单：绝不 spread input，避免把 apiKey/headers 之外的字段带进文档
      const stored: StoredProvider = {
        id: providerId,
        name: input.name,
        kind: input.kind,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyRef,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        enabled: input.enabled,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        headers: sanitizeHeaders(extras.headers ?? existing?.headers)
      }

      const providers = [...doc.providers]
      if (index >= 0) providers[index] = stored
      else providers.push(stored)

      await this.writeDoc({ version: 1, providers })
      const { headers: _headers, ...provider } = stored
      return provider
    } catch (error) {
      throw toVaultIpcError(error)
    }
  }

  async remove(providerId: string): Promise<void> {
    try {
      assertVaultUnlocked(this.vault)
      const doc = await this.readDoc()
      const providers = doc.providers.filter((provider) => provider.id !== providerId)
      if (providers.length === doc.providers.length) {
        throw new IpcCallError({ code: 'E_NOT_FOUND', message: `供应商不存在：${providerId}` })
      }
      await this.writeDoc({ version: 1, providers })
      await this.vault.deleteDoc(apiKeyDocKey(providerId))
    } catch (error) {
      throw toVaultIpcError(error)
    }
  }

  /** 写入/替换 API key（只进 vault，文档里仅更新尾 4 位掩码） */
  async setApiKey(providerId: string, apiKey: string): Promise<AiProvider> {
    const trimmed = apiKey.trim()
    if (trimmed.length < 4) {
      throw new IpcCallError({ code: 'E_INVALID_ARGUMENT', message: 'API key 太短' })
    }
    try {
      assertVaultUnlocked(this.vault)
      const doc = await this.readDoc()
      const index = doc.providers.findIndex((provider) => provider.id === providerId)
      if (index < 0) throw new IpcCallError({ code: 'E_NOT_FOUND', message: `供应商不存在：${providerId}` })
      const timestamp = new Date(this.now()).toISOString()
      const next: StoredProvider = {
        ...doc.providers[index],
        apiKeyRef: buildApiKeyRef(providerId, trimmed),
        updatedAt: timestamp,
        headers: sanitizeHeaders(doc.providers[index].headers)
      }
      await this.vault.writeDoc(apiKeyDocKey(providerId), trimmed)
      const providers = [...doc.providers]
      providers[index] = next
      await this.writeDoc({ version: 1, providers })
      const { headers: _headers, ...provider } = next
      return provider
    } catch (error) {
      throw toVaultIpcError(error)
    }
  }

  async clearApiKey(providerId: string): Promise<AiProvider> {
    try {
      assertVaultUnlocked(this.vault)
      const doc = await this.readDoc()
      const index = doc.providers.findIndex((provider) => provider.id === providerId)
      if (index < 0) throw new IpcCallError({ code: 'E_NOT_FOUND', message: `供应商不存在：${providerId}` })
      const timestamp = new Date(this.now()).toISOString()
      const next: StoredProvider = {
        ...doc.providers[index],
        apiKeyRef: null,
        updatedAt: timestamp,
        headers: sanitizeHeaders(doc.providers[index].headers)
      }
      await this.vault.deleteDoc(apiKeyDocKey(providerId))
      const providers = [...doc.providers]
      providers[index] = next
      await this.writeDoc({ version: 1, providers })
      const { headers: _headers, ...provider } = next
      return provider
    } catch (error) {
      throw toVaultIpcError(error)
    }
  }

  /** 读明文 key（只用于构造请求头；调用方不得记录返回值） */
  async getApiKey(providerId: string): Promise<string | null> {
    try {
      assertVaultUnlocked(this.vault)
      const value = await this.vault.readDoc(apiKeyDocKey(providerId))
      const trimmed = value?.trim() ?? ''
      return trimmed.length > 0 ? trimmed : null
    } catch (error) {
      throw toVaultIpcError(error)
    }
  }

  /** 序列化当前文档（测试用来断言文档里不含 key 明文） */
  async serializeDoc(): Promise<string> {
    const doc = await this.readDoc()
    return JSON.stringify(doc)
  }

  private async readDoc(): Promise<z.infer<typeof providerDocSchema>> {
    const raw = await this.vault.readDoc(PROVIDER_DOC_KEY)
    if (raw === null) return { version: 1, providers: [] }
    try {
      const parsed = providerDocSchema.parse(JSON.parse(raw))
      return parsed
    } catch (error) {
      // 文档损坏：不静默清空（可能还能人工恢复），但也不能阻塞 AI 功能
      this.onWarn(`供应商配置解析失败，已按空列表处理：${error instanceof Error ? error.message : String(error)}`)
      return { version: 1, providers: [] }
    }
  }

  private async writeDoc(doc: z.infer<typeof providerDocSchema>): Promise<void> {
    await this.vault.writeDoc(PROVIDER_DOC_KEY, JSON.stringify(doc, null, 2))
  }
}
