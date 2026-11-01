import { IpcCallError, type IpcErrorCode } from '@shared'
import { VaultCryptoError } from '../crypto'

/**
 * 主进程内部的错误工厂。
 *
 * 约定：业务层照常 `throw`，`src/main/ipc/registry.ts` 统一包成 `IpcResult` 信封。
 * 所以这里抛的是 `IpcCallError`（信封错误类型），**错误码与 details.reason 都进信封**：
 * 渲染层据此决定文案与后续动作（例如 `reason=bad-passphrase` 显示「口令错误」而不是「数据损坏」）。
 */
export function vaultFail(code: IpcErrorCode, message: string, details?: unknown): IpcCallError {
  return new IpcCallError(details === undefined ? { code, message } : { code, message, details })
}

export type VaultFailureReason =
  | 'bad-passphrase'
  | 'bad-recovery-code'
  | 'corrupt'
  | 'unsupported-format'
  | 'bad-params'
  | 'locked'
  | 'uninitialized'
  | 'already-exists'
  | 'weak-passphrase'
  | 'too-short'
  | 'throttled'
  | 'stale-session'
  | 'invalid-payload'
  | 'not-found'
  | 'conflict'
  | 'git'
  /** r3：口令槽密文与 local.json 记录里的 8 位指纹对不上（AC-2 的归因原料） */
  | 'slot-record-mismatch'
  /** r3：同步换过槽（本机记录与远端槽不同源，manager 已保本地槽重封） */
  | 'slot-drift'
  /** r3：新建库时库名已被占用（AC-14 判重的第二个字段） */
  | 'name-taken'

/**
 * 把加密层的 `VaultCryptoError` 翻译成 IPC 错误。
 *
 * 这是「口令错 ≠ 数据损坏」在进程边界的落点：
 * - `bad-passphrase` / `bad-recovery-code` → `E_UNAUTHORIZED`（用户可重试）
 * - `corrupt` → `E_IO`（用户重试没有意义，必须提示恢复/重新拉取）
 */
export function rethrowCrypto(error: unknown): never {
  if (error instanceof VaultCryptoError) {
    switch (error.reason) {
      case 'bad-passphrase':
        throw vaultFail('E_UNAUTHORIZED', 'Incorrect master passphrase', { reason: 'bad-passphrase' })
      case 'bad-recovery-code':
        throw vaultFail('E_UNAUTHORIZED', 'Incorrect recovery code', { reason: 'bad-recovery-code' })
      case 'corrupt':
        throw vaultFail('E_IO', `Vault data is corrupt: ${error.message}`, { reason: 'corrupt' })
      case 'unsupported-format':
        throw vaultFail('E_INVALID_ARGUMENT', error.message, { reason: 'unsupported-format' })
      case 'bad-params':
        throw vaultFail('E_INVALID_ARGUMENT', error.message, { reason: 'bad-params' })
      default:
        throw vaultFail('E_IO', error.message, { reason: 'corrupt' })
    }
  }
  throw error
}

export function lockedError(): IpcCallError {
  return vaultFail('E_VAULT_LOCKED', 'Vault is locked; unlock it first', { reason: 'locked' })
}

export function notFound(label: string, id: string): IpcCallError {
  return vaultFail('E_NOT_FOUND', `${label} not found: ${id}`, { reason: 'not-found', id })
}
