/**
 * 跨进程错误契约。
 *
 * 所有 `ipcRenderer.invoke` 的返回值都是 `IpcResult<T>` 信封，而不是「抛异常」：
 * Electron 把主进程 handler 抛出的 Error 序列化成 `Error invoking remote method ...` 字符串，
 * 错误码（如 `E_VAULT_LOCKED`）会全部丢失，渲染层只能靠匹配文案——那是不可维护的。
 * 约定：主进程 handler 内部照常 throw，`ipc/registry.ts` 统一包成信封。
 */

export const IPC_ERROR_CODES = [
  /** 兜底：未分类失败 */
  'E_UNKNOWN',
  /** 入参不满足 shared 里的 zod schema */
  'E_INVALID_ARGUMENT',
  /** 通道已进契约，但对应模块还没接线（骨架期默认返回这个） */
  'E_NOT_IMPLEMENTED',
  'E_NOT_FOUND',
  /** 乐观并发 / Git 冲突 */
  'E_CONFLICT',
  'E_UNAUTHORIZED',
  /** 加密包未解锁，必须先 vault:unlock */
  'E_VAULT_LOCKED',
  'E_NETWORK',
  /** SSH 协议层错误（认证失败、握手失败、PTY 请求失败） */
  'E_SSH',
  /** 主机密钥首次出现或与已信任指纹不一致 */
  'E_HOST_KEY_UNVERIFIED',
  'E_AI_PROVIDER',
  'E_GIT',
  'E_IO'
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcError {
  code: IpcErrorCode
  message: string
  /** 结构化补充信息（例如 zod issues、冲突 id、主机指纹） */
  details?: unknown
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export function isIpcErrorCode(value: string): value is IpcErrorCode {
  return (IPC_ERROR_CODES as readonly string[]).includes(value)
}

/** 渲染层拿到失败信封后抛这个，便于 try/catch 与错误码判断 */
export class IpcCallError extends Error {
  readonly code: IpcErrorCode
  readonly details?: unknown

  constructor(error: IpcError) {
    super(`[${error.code}] ${error.message}`)
    this.name = 'IpcCallError'
    this.code = error.code
    this.details = error.details
  }
}

export function isIpcCallError(value: unknown): value is IpcCallError {
  return value instanceof IpcCallError
}
