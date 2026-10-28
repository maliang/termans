import {
  IpcCallError,
  type ConflictStrategy,
  type GroupInput,
  type GroupRecord,
  type HostInput,
  type HostLibrary,
  type HostRecord,
  type HostSortUpdate,
  type KnownHostEntry,
  type KnownHostRemoveRequest,
  type KnownHostTrustRequest,
  type SshConfigImportRequest,
  type SshConfigImportResult,
  type SshConfigParseResult,
  type SshConfigWriteRequest,
  type SshConfigWriteResult,
  type SyncBootstrapRequest,
  type SyncConflict,
  type SyncRepo,
  type SyncResolveRequest,
  type SyncStatus,
  type VaultCreateResult,
  type VaultStatus
} from '@shared'
import { call, describeError } from '../../platform/ipc'

/** 备注存在 payload.hostNotes 里，由主进程在 `hosts:list` 时挂回每条记录（HostInput 没有 notes 字段） */
export type HostView = HostRecord & { notes?: string }
export type LibraryView = Omit<HostLibrary, 'hosts'> & { hosts: HostView[] }

/**
 * 本机私钥的引用约定，与 `src/main/vault/register.ts` 的 `PRIVATE_KEY_REF_PREFIX` 必须一致。
 * 私钥走 `credentials:set` 进本机 safeStorage 包裹的库，**永不进 Git 仓库**。
 */
export const PRIVATE_KEY_REF_PREFIX = 'privatekey:'

export function privateKeyReference(hostId: string): string {
  return `${PRIVATE_KEY_REF_PREFIX}${hostId}`
}

/** Git token 也是本机凭据（不同步），同步时由主进程从本机库取 */
export const GIT_TOKEN_REFERENCE = 'git:token'
/** 会话密钥（「记住本机 7 天」）在本机库里的引用名 */
export const SESSION_REFERENCE = 'vault:session'

/* vault ---------------------------------------------------------------- */

export function vaultStatus(): Promise<VaultStatus> {
  return call('vault:status')
}

export function createVault(passphrase: string): Promise<VaultCreateResult> {
  return call('vault:create', { passphrase })
}

export function unlockVault(passphrase: string, rememberWithKeychain: boolean): Promise<VaultStatus> {
  return call('vault:unlock', { passphrase, rememberWithKeychain })
}

export function rotateVault(currentPassphrase: string, newPassphrase: string): Promise<VaultCreateResult> {
  return call('vault:rotate', { currentPassphrase, newPassphrase })
}

export function recoverVault(recoveryCode: string, newPassphrase: string): Promise<VaultStatus> {
  return call('vault:recover', { recoveryCode, newPassphrase })
}

export function lockVault(): Promise<VaultStatus> {
  return call('vault:lock')
}

/* hosts / groups ------------------------------------------------------- */

export async function fetchLibrary(): Promise<LibraryView> {
  // `notes` 是主进程在响应里额外挂上的键（契约类型 HostLibrary 没有它，故需要一次收敛转换）
  return (await call('hosts:list')) as unknown as LibraryView
}

export function createHost(host: HostInput): Promise<HostRecord> {
  return call('hosts:create', { host })
}

export function updateHost(hostId: string, patch: HostInput, notes?: string): Promise<HostRecord> {
  // `notes` 是 register.ts 放行的扩展键（备注存在 payload.hostNotes，HostInput 无此字段）
  const request = (notes === undefined ? { hostId, patch } : { hostId, patch, notes }) as {
    hostId: string
    patch: HostInput
  }
  return call('hosts:update', request)
}

export async function deleteHost(hostId: string): Promise<void> {
  await call('hosts:delete', { hostId })
}

export function reorderHost(update: HostSortUpdate): Promise<HostLibrary> {
  return call('hosts:reorder', update)
}

export function createGroup(group: GroupInput): Promise<GroupRecord> {
  return call('groups:create', { group })
}

export function updateGroup(groupId: string, patch: GroupInput): Promise<GroupRecord> {
  return call('groups:update', { groupId, patch })
}

export async function deleteGroup(groupId: string): Promise<void> {
  await call('groups:delete', { groupId })
}

/* credentials ---------------------------------------------------------- */

export async function setLocalCredential(reference: string, secret: string): Promise<string> {
  const result = await call('credentials:set', { reference, secret })
  return result.reference
}

export async function clearLocalCredential(reference: string): Promise<void> {
  await call('credentials:clear', { reference })
}

/** 主机密码：进密文包（同步到其它机器），不是本机凭据 */
export async function setHostPassword(reference: string, password: string): Promise<void> {
  await call('credentials:set', { reference, secret: password })
}

/** 主机私钥的 passphrase：同一引用加 `passphrase:` 前缀，也进密文包 */
export async function setHostPassphrase(reference: string, passphrase: string): Promise<void> {
  await call('credentials:set', { reference: `passphrase:${reference}`, secret: passphrase })
}

export async function clearHostSecret(reference: string): Promise<void> {
  await call('credentials:clear', { reference })
}

export async function importPrivateKey(hostId: string, privateKey: string): Promise<void> {
  await call('credentials:set', { reference: privateKeyReference(hostId), secret: privateKey })
}

export async function clearPrivateKey(hostId: string): Promise<void> {
  await call('credentials:clear', { reference: privateKeyReference(hostId) })
}

/* known hosts ---------------------------------------------------------- */

export async function listKnownHosts(): Promise<KnownHostEntry[]> {
  const result = await call('known-hosts:list')
  return result.entries
}

export function trustKnownHost(request: KnownHostTrustRequest): Promise<KnownHostEntry> {
  return call('known-hosts:trust', request)
}

export async function removeKnownHost(request: KnownHostRemoveRequest): Promise<void> {
  await call('known-hosts:remove', request)
}

/* ssh config ----------------------------------------------------------- */

export async function defaultSshConfigPaths(): Promise<string[]> {
  const result = await call('ssh-config:default-paths')
  return result.paths
}

export function parseSshConfig(path: string | null): Promise<SshConfigParseResult> {
  return call('ssh-config:parse', { path })
}

export function writeSshConfig(request: SshConfigWriteRequest): Promise<SshConfigWriteResult> {
  return call('ssh-config:write', request)
}

export function importSshConfig(request: SshConfigImportRequest): Promise<SshConfigImportResult> {
  return call('ssh-config:import', request)
}

export function exportSshConfig(path: string, aliases: string[] | null): Promise<SshConfigWriteResult> {
  return call('ssh-config:export', { path, aliases })
}

/* sync ----------------------------------------------------------------- */

export function syncStatus(): Promise<SyncStatus> {
  return call('sync:status')
}

export function bootstrapSync(remoteUrl: string, branch: string, auth: SyncRepo['auth']): Promise<SyncStatus> {
  const request: SyncBootstrapRequest = { remoteUrl, branch, auth }
  return call('sync:bootstrap', request)
}

export function pullSync(): Promise<SyncStatus> {
  return call('sync:pull')
}

export function pushSync(): Promise<SyncStatus> {
  return call('sync:push')
}

export async function listConflicts(): Promise<SyncConflict[]> {
  const result = await call('sync:conflicts')
  return result.conflicts
}

export function resolveConflict(conflictId: string, strategy: ConflictStrategy): Promise<SyncStatus> {
  const request: SyncResolveRequest = { conflictId, strategy }
  return call('sync:resolve', request)
}

/* 错误 → 文案 ----------------------------------------------------------- */

/** 取主进程塞在 `details.reason` 里的语义码（渲染层据此做 i18n，而不是展示英文原文） */
export function errorReason(error: unknown): string {
  if (error instanceof IpcCallError && error.details !== null && typeof error.details === 'object') {
    const reason = (error.details as { reason?: unknown }).reason
    if (typeof reason === 'string') return reason
  }
  return 'unknown'
}

export function errorText(error: unknown): string {
  return describeError(error)
}
