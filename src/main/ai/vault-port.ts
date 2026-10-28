/**
 * AI 模块与加密包（vault，t4 负责实现）之间的最小端口。
 *
 * 为什么是「端口 + 适配器」而不是直接 import `src/main/vault`：
 * - AI 模块的要求是**配置与 API key 全部进加密包、不单独落明文**，但加密包的实现由
 *   t4（vault 任务）交付，两边并行开发；这里只依赖 4 个方法，接线时一行适配即可。
 * - 单测可以注入 `createInMemoryAiVault()` 验证「vault 锁定时报 E_VAULT_LOCKED、
 *   任何写盘路径都不含 key 明文」，不需要真的起 Electron。
 *
 * 安全约定：
 * - **没有明文回退分支**。vault 未解锁时所有读写都抛 `AiVaultLockedError`，
 *   而不是退化成 `~/.config/xxx.json` 之类的明文文件。
 * - 适配器实现（t4）必须把内容加密后落盘；本模块只传字符串，不关心加密方式。
 */
import { IpcCallError } from '@shared'

export interface AiVaultPort {
  /** 加密包是否已解锁（未解锁时读写都会抛错） */
  isUnlocked(): boolean
  /** 读取一个文档；不存在返回 null */
  readDoc(key: string): Promise<string | null>
  /** 写入（覆盖）一个文档 */
  writeDoc(key: string, value: string): Promise<void>
  /** 删除一个文档（不存在时静默成功） */
  deleteDoc(key: string): Promise<void>
}

export class AiVaultLockedError extends Error {
  constructor(message = '加密包未解锁，请先解锁后再使用 AI 辅助') {
    super(message)
    this.name = 'AiVaultLockedError'
  }
}

/** 统一转成 IPC 错误信封（渲染层据 code 弹解锁引导，而不是猜文案） */
export function toVaultIpcError(error: unknown): IpcCallError {
  if (error instanceof IpcCallError) return error
  if (error instanceof AiVaultLockedError) {
    return new IpcCallError({ code: 'E_VAULT_LOCKED', message: error.message })
  }
  return new IpcCallError({
    code: 'E_IO',
    message: error instanceof Error ? error.message : String(error)
  })
}

export function assertVaultUnlocked(vault: AiVaultPort): void {
  if (!vault.isUnlocked()) throw new AiVaultLockedError()
}

/**
 * 内存实现：单测用。
 * 记录每次写入的 key 与全部内容，便于断言「写进 vault 的文档里不含 key 明文」。
 */
export interface InMemoryAiVault extends AiVaultPort {
  unlock(): void
  lock(): void
  /** 当前所有文档的快照（key → 原文） */
  snapshot(): Record<string, string>
  /** 写入历史（按调用顺序，便于断言删除/覆盖行为） */
  writeLog(): ReadonlyArray<{ key: string; value: string }>
  /** 全文搜索：断言某个密钥没有出现在任何文档里 */
  containsText(needle: string): boolean
}

export function createInMemoryAiVault(initial: Record<string, string> = {}, unlocked = true): InMemoryAiVault {
  const docs = new Map<string, string>(Object.entries(initial))
  const writes: Array<{ key: string; value: string }> = []
  let open = unlocked

  return {
    isUnlocked: () => open,
    unlock: () => {
      open = true
    },
    lock: () => {
      open = false
    },
    async readDoc(key) {
      assertVaultUnlockedFor(open)
      return docs.has(key) ? (docs.get(key) as string) : null
    },
    async writeDoc(key, value) {
      assertVaultUnlockedFor(open)
      docs.set(key, value)
      writes.push({ key, value })
    },
    async deleteDoc(key) {
      assertVaultUnlockedFor(open)
      docs.delete(key)
      writes.push({ key, value: '' })
    },
    snapshot: () => Object.fromEntries(docs.entries()),
    writeLog: () => writes,
    containsText: (needle) => [...docs.values()].some((value) => value.includes(needle))
  }
}

function assertVaultUnlockedFor(unlocked: boolean): void {
  if (!unlocked) throw new AiVaultLockedError()
}
