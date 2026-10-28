import { z } from 'zod'
import {
  hostInputSchema,
  groupInputSchema,
  hostSortUpdateSchema,
  knownHostTrustRequestSchema,
  knownHostRemoveRequestSchema,
  sshConfigImportRequestSchema,
  sshConfigParseRequestSchema,
  sshConfigWriteRequestSchema,
  syncBootstrapRequestSchema,
  syncResolveRequestSchema,
  vaultRecoveryRequestSchema,
  vaultRotateRequestSchema,
  type HostInput,
  type HostLibrary,
  type HostSortUpdate
} from '@shared'
import { IPC_CHANNELS } from '@shared/ipc'
import { handle } from '../ipc/registry'
import type { VaultManager } from './manager'
import type { SyncCoordinator } from '../git/sync'
import { defaultSshConfigPaths, exportSshConfigText, readSshConfigFile, writeSshConfig } from './ssh-config-file'

/**
 * 我（vault-sync）的 IPC 接线：26 个通道全部在这里实现，**不改 src/main/ipc/index.ts**，
 * 集成任务（t7）只需要 `registerVaultHandlers({ manager, sync })` 一行。
 *
 * 约定：
 * - 请求体用 zod 再校验一遍（IPC 边界不信任渲染层），失败 → E_INVALID_ARGUMENT；
 * - 锁定态一律抛 `E_VAULT_LOCKED`（`lockedError()`），绝不在锁定时返回任何主机信息；
 * - 每个 handler 都是同步/异步纯转发，业务规则都在 manager / coordinator 里（便于单测）。
 */

export interface VaultHandlerContext {
  manager: VaultManager
  sync: SyncCoordinator
}

const createRequestSchema = z.object({ passphrase: z.string().min(1).max(4096) }).strict()
const unlockRequestSchema = z
  .object({ passphrase: z.string().min(1).max(4096), rememberWithKeychain: z.boolean() })
  .strict()
const hostsCreateSchema = z.object({ host: hostInputSchema }).strict()
/**
 * `notes` 是 Termans 的扩展键：`HostInput`（src/shared，冻结契约）没有备注字段，
 * 备注存在 payload.hostNotes 里。这里放行它，IPC 契约类型本身不变。
 */
const hostsUpdateSchema = z
  .object({ hostId: z.string().min(1), patch: hostInputSchema, notes: z.string().max(2_000).optional() })
  .strict()

/** `privatekey:<hostId>` = 本机私钥的引用约定（私钥只进 safeStorage 包裹的本机库，永不进仓库） */
const PRIVATE_KEY_REF_PREFIX = 'privatekey:'
/** `passphrase:<ref>` = 同一凭据引用下的 key passphrase（密码用裸引用，passphrase 加前缀区分） */
const PASSPHRASE_REF_PREFIX = 'passphrase:'
/** 只存在本机、永不同步的两类凭据 */
const LOCAL_REFERENCES = new Set(['git:token', 'vault:session'])

function withHostNotes(manager: VaultManager): HostLibrary {
  const library = manager.listLibrary()
  const notes = manager.listHostNotes()
  const hosts = library.hosts.map((host) => ({ ...host, notes: notes[host.id] ?? '' }))
  return { ...library, hosts } as HostLibrary
}
const idSchema = z.object({ hostId: z.string().min(1) }).strict()
const groupCreateSchema = z.object({ group: groupInputSchema }).strict()
const groupUpdateSchema = z.object({ groupId: z.string().min(1), patch: groupInputSchema }).strict()
const groupIdSchema = z.object({ groupId: z.string().min(1) }).strict()
const credentialSetSchema = z.object({ reference: z.string().min(1), secret: z.string().max(64 * 1024) }).strict()
const credentialClearSchema = z.object({ reference: z.string().min(1) }).strict()
const exportRequestSchema = z.object({ path: z.string().min(1), aliases: z.array(z.string()).nullable() }).strict()

export function registerVaultHandlers(context: VaultHandlerContext): void {
  const { manager, sync } = context

  /* vault ------------------------------------------------------------- */

  handle(IPC_CHANNELS.vault.status, () => manager.status())

  handle(IPC_CHANNELS.vault.create, (request) => manager.create(request.passphrase), createRequestSchema)

  handle(
    IPC_CHANNELS.vault.unlock,
    (request) => manager.unlock(request.passphrase, request.rememberWithKeychain),
    unlockRequestSchema
  )

  handle(IPC_CHANNELS.vault.lock, () => manager.lock())

  handle(IPC_CHANNELS.vault.rotate, (request) => manager.rotate(request), vaultRotateRequestSchema)

  handle(IPC_CHANNELS.vault.recover, (request) => manager.recover(request), vaultRecoveryRequestSchema)

  /* hosts & groups ---------------------------------------------------- */

  handle(IPC_CHANNELS.hosts.list, () => withHostNotes(manager))

  handle(IPC_CHANNELS.hosts.create, (request) => manager.createHost(request.host as HostInput), hostsCreateSchema)

  handle(
    IPC_CHANNELS.hosts.update,
    (request) => {
      const updated = manager.updateHost(request.hostId, request.patch as HostInput)
      const notes = (request as { notes?: string }).notes
      if (notes !== undefined) manager.setHostNotes(request.hostId, notes)
      return updated
    },
    hostsUpdateSchema
  )

  handle(IPC_CHANNELS.hosts.delete, (request) => {
    manager.deleteHost(request.hostId)
  }, idSchema)

  handle(
    IPC_CHANNELS.hosts.reorder,
    (request) => manager.reorderHosts([request as HostSortUpdate]),
    hostSortUpdateSchema
  )

  handle(IPC_CHANNELS.groups.create, (request) => manager.createGroup(request.group), groupCreateSchema)

  handle(
    IPC_CHANNELS.groups.update,
    (request) => manager.updateGroup(request.groupId, request.patch),
    groupUpdateSchema
  )

  handle(IPC_CHANNELS.groups.delete, (request) => {
    manager.deleteGroup(request.groupId)
  }, groupIdSchema)

  /* credentials（按引用前缀分流：私钥/Git token 只在本机，主机密码进密文包） ---- */

  handle(
    IPC_CHANNELS.credentials.set,
    (request) => {
      const reference = request.reference
      if (reference.startsWith(PRIVATE_KEY_REF_PREFIX)) {
        manager.importPrivateKey(reference.slice(PRIVATE_KEY_REF_PREFIX.length), request.secret)
        return { reference }
      }
      // Git token / 会话密钥：只在本机，不进仓库
      if (LOCAL_REFERENCES.has(reference)) return manager.setLocalCredential(reference, request.secret)
      // 主机密码 / passphrase：进密文包（这样 B 机同步下来才能真的连上）
      if (reference.startsWith(PASSPHRASE_REF_PREFIX)) {
        manager.setSecret(reference.slice(PASSPHRASE_REF_PREFIX.length), { passphrase: request.secret })
        return { reference }
      }
      manager.setSecret(reference, { password: request.secret })
      return { reference }
    },
    credentialSetSchema
  )

  handle(
    IPC_CHANNELS.credentials.clear,
    (request) => {
      const reference = request.reference
      if (reference.startsWith(PRIVATE_KEY_REF_PREFIX)) {
        manager.clearPrivateKey(reference.slice(PRIVATE_KEY_REF_PREFIX.length))
        return
      }
      if (LOCAL_REFERENCES.has(reference)) {
        manager.clearLocalCredential(reference)
        return
      }
      if (reference.startsWith(PASSPHRASE_REF_PREFIX)) {
        manager.setSecret(reference.slice(PASSPHRASE_REF_PREFIX.length), { passphrase: null })
        return
      }
      manager.setSecret(reference, { password: null })
    },
    credentialClearSchema
  )

  /* known_hosts（密文包里的指纹库） ------------------------------------ */

  handle(IPC_CHANNELS.knownHosts.list, () => ({ entries: manager.listKnownHosts() }))

  handle(IPC_CHANNELS.knownHosts.trust, (request) => manager.trustKnownHost(request), knownHostTrustRequestSchema)

  handle(IPC_CHANNELS.knownHosts.remove, (request) => {
    manager.removeKnownHost(request)
  }, knownHostRemoveRequestSchema)

  /* ssh_config（密文里存全文；系统文件只显式读写） ---------------------- */

  handle(IPC_CHANNELS.sshConfig.defaultPaths, () => ({ paths: defaultSshConfigPaths() }))

  handle(IPC_CHANNELS.sshConfig.parse, (request) => readSshConfigFile(request.path), sshConfigParseRequestSchema)

  handle(IPC_CHANNELS.sshConfig.write, (request) => writeSshConfig(request), sshConfigWriteRequestSchema)

  handle(
    IPC_CHANNELS.sshConfig.import,
    (request) => {
      const parsed = readSshConfigFile(request.path)
      return manager.importSshConfig(parsed, request.overwriteExisting, request.aliases)
    },
    sshConfigImportRequestSchema
  )

  handle(
    IPC_CHANNELS.sshConfig.export,
    (request) => {
      const text = manager.exportSshConfigText(request.aliases)
      return exportSshConfigText(request.path, text, true, false)
    },
    exportRequestSchema
  )

  /* sync -------------------------------------------------------------- */

  handle(IPC_CHANNELS.sync.status, async () => sync.refresh())

  handle(IPC_CHANNELS.sync.bootstrap, async (request) => sync.bootstrap(request), syncBootstrapRequestSchema)

  handle(IPC_CHANNELS.sync.pull, async () => sync.pull())

  handle(IPC_CHANNELS.sync.push, async () => sync.push())

  handle(IPC_CHANNELS.sync.conflicts, () => ({ conflicts: sync.conflicts() }))

  handle(IPC_CHANNELS.sync.resolve, async (request) => sync.resolve(request), syncResolveRequestSchema)
}
