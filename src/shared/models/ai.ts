import { z } from 'zod'
import { isoTimestampSchema } from './app'
import { hostIdSchema } from './host'

/**
 * AI 辅助契约。
 *
 * 安全约束（不可协商，SPEC.md 有对应判据）：
 * - API key **随端到端加密包同步**：与主机密码同一份 `vault.enc` 里的 `payload.integrations.aiApiKeys`
 *   （scrypt + AES-256-GCM，主口令不在仓库，Git 里 grep 不到明文）。适配器经 `manager.getAiApiKey()` 取值，
 *   `apiKeyRef` 只是模型里的引用槽位（不是存储位置）。明文 key 不落主机库、不落日志、不回传渲染层。
 * - AI 产出的命令**必须**经用户二次确认才允许写入终端（`AiCommandSuggestion.requiresConfirmation` 恒为 true）。
 * - 发送给供应商的终端上下文由用户显式开启（`autoContext`），并只取最近 N 行且做脱敏。
 */

export const aiProviderKindSchema = z.enum(['openai', 'anthropic', 'openai-compatible', 'ollama'])
export type AiProviderKind = z.infer<typeof aiProviderKindSchema>

export const aiProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: aiProviderKindSchema,
  baseUrl: z.string().url(),
  model: z.string().min(1),
  /** 密文包里的 key 引用槽位（写 uuid）；ollama 等本地供应商可为 null。明文 key 在 vault.enc 的 aiApiKeys 里 */
  apiKeyRef: z.string().nullable(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(1).max(200_000),
  enabled: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
})
export type AiProvider = z.infer<typeof aiProviderSchema>

/** 新建/更新供应商时用的输入（不含 id 与时间戳，由主进程生成/维护） */
export const aiProviderInputSchema = aiProviderSchema.omit({ createdAt: true, updatedAt: true })
export type AiProviderInput = z.infer<typeof aiProviderInputSchema>

/**
 * 「读模型清单」用的临时草稿（r2 AC-4：刚填完 key 就能读模型，不必先保存）。
 *
 * 只活在单次 IPC 调用里：主进程用它现拼请求、读完即弃，**不落 providers.json、不写 vault**。
 * 因此这里不收 `id`/时间戳，`apiKey` 是明文（与 `apiKeyRef` 的引用槽位是两码事）。
 */
export const aiProviderDraftSchema = z
  .object({
    kind: aiProviderKindSchema,
    /** 不强制 `url()`：用户可能正边输边点「读取模型」，合法性交给真正的请求去报错 */
    baseUrl: z.string().min(1),
    model: z.string().optional(),
    apiKey: z.string().optional(),
    /** 自定义请求头（代理/网关用），与 provider-store 的 ExtraHeaders 同形 */
    headers: z.record(z.string(), z.string()).optional()
  })
  .strict()
export type AiProviderDraft = z.infer<typeof aiProviderDraftSchema>

/**
 * 读模型清单的请求：**二选一**（`providerId` 已保存的供应商 / `draft` 未保存的草稿）。
 * strict 是关键——两个都传时无法判断该用谁的 key 与 baseUrl，必须在 IPC 边界就拒绝，
 * 而不是在 service 里靠「先判断哪个非空」的隐式优先级。
 */
export const aiListModelsRequestSchema = z.union([
  z.object({ providerId: z.string().min(1) }).strict(),
  z.object({ draft: aiProviderDraftSchema }).strict()
])
export type AiListModelsRequest = z.infer<typeof aiListModelsRequestSchema>

/**
 * 失败原因结构化（而不是一句自由文本）：UI 要能显示 HTTP 状态码、并区分
 * 「没填 key」「有 key 但服务商返回空列表」「网络/超时」，靠字符串猜是猜不准的。
 * - no-key：本地就知道缺 key，没有发请求
 * - empty：请求成功但 0 个模型
 * - http：服务商返回非 2xx，`status` 有值、`message` 已脱敏且截断到 300 字
 * - timeout / network：请求没走完
 */
export const aiListModelsFailureKindSchema = z.enum(['no-key', 'empty', 'http', 'timeout', 'network'])
export type AiListModelsFailureKind = z.infer<typeof aiListModelsFailureKindSchema>

export const aiListModelsFailureSchema = z.object({
  kind: aiListModelsFailureKindSchema,
  /** 仅 `http` 有值；其余恒 null（本地失败没有状态码） */
  status: z.number().int().nullable(),
  /** 已脱敏、已截断（主进程 `clipFailureMessage` 之后）才允许跨进程序列化 */
  message: z.string()
})
export type AiListModelsFailure = z.infer<typeof aiListModelsFailureSchema>

export const aiListModelsResultSchema = z.object({
  models: z.array(z.string()),
  /** 兼容字段：失败时给一个可展示的整句；成功为 null */
  error: z.string().nullable(),
  failure: aiListModelsFailureSchema.nullable()
})
export type AiListModelsResult = z.infer<typeof aiListModelsResultSchema>

export const aiMessageRoleSchema = z.enum(['system', 'user', 'assistant'])
export type AiMessageRole = z.infer<typeof aiMessageRoleSchema>

export const aiMessageSchema = z.object({
  role: aiMessageRoleSchema,
  content: z.string()
})
export type AiMessage = z.infer<typeof aiMessageSchema>

export const aiTerminalContextSchema = z.object({
  sessionId: z.string().min(1),
  hostLabel: z.string(),
  /** 最近的终端输出（已脱敏、已截断） */
  recentOutput: z.string().max(20_000),
  cwd: z.string().nullable()
})
export type AiTerminalContext = z.infer<typeof aiTerminalContextSchema>

export const aiChatRequestSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  providerId: z.string().min(1),
  messages: z.array(aiMessageSchema).min(1),
  context: aiTerminalContextSchema.nullable()
})
export type AiChatRequest = z.infer<typeof aiChatRequestSchema>

export const aiStreamDeltaSchema = z.object({
  requestId: z.string().min(1),
  delta: z.string()
})
export type AiStreamDelta = z.infer<typeof aiStreamDeltaSchema>

export const aiUsageSchema = z.object({
  promptTokens: z.number().int().min(0).nullable(),
  completionTokens: z.number().int().min(0).nullable()
})
export type AiUsage = z.infer<typeof aiUsageSchema>

export const aiStreamDoneSchema = z.object({
  requestId: z.string().min(1),
  message: aiMessageSchema,
  usage: aiUsageSchema.nullable()
})
export type AiStreamDone = z.infer<typeof aiStreamDoneSchema>

export const aiStreamErrorSchema = z.object({
  requestId: z.string().min(1),
  message: z.string(),
  retryable: z.boolean()
})
export type AiStreamError = z.infer<typeof aiStreamErrorSchema>

export const aiConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  hostId: hostIdSchema.nullable(),
  messages: z.array(aiMessageSchema),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
})
export type AiConversation = z.infer<typeof aiConversationSchema>

/**
 * AI 建议写入终端的命令。`requiresConfirmation` 是字面量 true：
 * 任何绕过确认直接执行的设计都会在类型层被拒绝。
 */
export const aiCommandSuggestionSchema = z.object({
  command: z.string().min(1).max(4_000),
  explanation: z.string(),
  requiresConfirmation: z.literal(true)
})
export type AiCommandSuggestion = z.infer<typeof aiCommandSuggestionSchema>
