/**
 * AI 对话历史（**v1 只在内存**，不写磁盘）。
 *
 * 为什么 v1 不持久化：
 * - 聊天记录里必然出现 `user@1.2.3.4`、端口、命令输出、内网路径——这些正是我们
 *   「锁屏时不显示任何主机信息、仓库里 grep 不到 IP/密码」的安全姿态要保护的东西；
 * - 明文 JSON 落 `userData/ai-conversations.json` 会直接把上面这些内容摊在磁盘上，
 *   与「凭据/敏感数据只进加密包」的设计打架，安全审查必然判红。
 *
 * 所以 v1 的语义是：**当前会话内可见，重启即失**；跨重启的历史留到「加密历史」
 * 里程碑（写进 vault payload 或加密文件）再做。`ai:list-conversations` 保留，
 * 但只返回本进程内的会话。
 *
 * 将来接加密存储时的唯一改法：把 `entries` 换成「加密后端 + 内存缓存」，
 * 对外方法签名（list/get/remove/recordTurn）保持不变。
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { AiConversation, AiMessage } from '@shared'

/**
 * 老版本（t5 首版）的明文对话文件名。现在**只用来删除**，永远不读、也不写。
 * JsonStore 在文件损坏时会生成 `ai-conversations.json.corrupt-<ts>` 备份，同样是明文，
 * 一并清掉——否则「改成内存态」只清主文件，残留在备份里的主机地址照样躺在磁盘上。
 */
export const LEGACY_CONVERSATION_FILE_PREFIX = 'ai-conversations.json'

export const MAX_CONVERSATIONS = 100
export const MAX_MESSAGES_PER_CONVERSATION = 200

export interface ConversationStoreOptions {
  now?: () => number
  maxConversations?: number
  maxMessages?: number
}

export interface RecordTurnInput {
  conversationId: string
  hostId: string | null
  /** 本轮完整消息（通常是「用户消息 + 助手回复」） */
  messages: AiMessage[]
  /** 可选的标题（默认取第一条 user 消息） */
  title?: string
}

export function deriveTitle(messages: readonly AiMessage[], fallback = '新对话'): string {
  const first = messages.find((message) => message.role === 'user' && message.content.trim().length > 0)
  if (!first) return fallback
  const flattened = first.content.replace(/\s+/g, ' ').trim()
  return flattened.length > 60 ? `${flattened.slice(0, 60)}…` : flattened
}

/**
 * 内存会话表（进程内单例；不进 Git 同步、不落盘、vault 锁定也能看本轮对话）。
 * 容量上限仍保留：一场长会话不该无限吃内存。
 */
export class ConversationStore {
  private entries: AiConversation[] = []
  private readonly now: () => number
  private readonly maxConversations: number
  private readonly maxMessages: number

  constructor(options: ConversationStoreOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxConversations = options.maxConversations ?? MAX_CONVERSATIONS
    this.maxMessages = options.maxMessages ?? MAX_MESSAGES_PER_CONVERSATION
  }

  /** 最近更新的在前 */
  list(): AiConversation[] {
    return [...this.entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(conversationId: string): AiConversation | null {
    return this.entries.find((item) => item.id === conversationId) ?? null
  }

  remove(conversationId: string): void {
    this.entries = this.entries.filter((item) => item.id !== conversationId)
  }

  /** 清空（退出登录 / 锁屏时调用，避免内存里留主机信息） */
  clear(): void {
    this.entries = []
  }

  /** 追加一轮对话（不存在则新建）；返回更新后的会话 */
  recordTurn(input: RecordTurnInput): AiConversation {
    const timestamp = new Date(this.now()).toISOString()
    const existing = this.entries.find((item) => item.id === input.conversationId)
    const messages = [...(existing?.messages ?? []), ...input.messages].slice(-this.maxMessages)
    const next: AiConversation = {
      id: input.conversationId,
      title: existing?.title ?? input.title ?? deriveTitle(messages),
      hostId: input.hostId ?? existing?.hostId ?? null,
      messages,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    const others = this.entries.filter((item) => item.id !== input.conversationId)
    this.entries = [next, ...others]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, this.maxConversations)
    return next
  }
}

/**
 * 删除老版本遗留的明文对话文件（`ai-conversations.json` 及其 `.corrupt-*` 备份）。
 *
 * 为什么是**删**而不是**迁移**：
 * - 这些文件里是明文的主机地址、端口、命令输出，安全姿态要求「磁盘上不留」，
 *   迁移进内存也只是把数据搬一遍、文件仍要删，且多了一段「解析老格式」的失败路径；
 * - 旧格式没有版本迁移契约（写它的是已删除的 JsonStore 路径），解析失败就只能丢弃，
 *   不如显式丢弃；
 * - 用户视角损失极小：v1 之前的历史本来就不承诺保留（历史属「加密历史」里程碑）。
 *
 * 幂等：目录不存在 / 没有残留文件都返回空数组，永不抛异常（启动路径不能因为清理失败而起不来）。
 */
export function purgeLegacyConversationFiles(
  userDataDir: string,
  onWarn?: (message: string) => void
): string[] {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(userDataDir)
  } catch {
    // 目录还不存在（首启）→ 没有残留可清
    return removed
  }
  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_CONVERSATION_FILE_PREFIX)) continue
    try {
      unlinkSync(join(userDataDir, entry))
      removed.push(entry)
    } catch (error) {
      onWarn?.(
        `删除明文对话残留失败（已忽略）：${entry}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return removed
}
