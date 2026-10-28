import { z } from 'zod'
import { isoTimestampSchema } from './app'

/**
 * 加密包 / Git 同步契约。
 *
 * 数据流（vault-sync 实现细节，这里只锁对外形状）：
 *   hostLibrary(明文 JSON) --AES-256-GCM(主口令派生密钥)--> vault.enc --isomorphic-git--> 远端私有仓库
 *
 * 四条不可协商约束（SPEC.md 逐条给了可执行判据）：
 * 1. **密文仓库**：远端仓库里不能出现明文主机名 / 用户名 / 端口 / 标签（只有 vault.enc 与元数据）。
 * 2. **私钥不同步**：`~/.ssh/id_*` 内容永不进 vault.enc，也不进 Git；模型里只有 `privateKeyPath` 路径。
 * 3. **凭据不同步**：密码/passphrase 只存 safeStorage（本机 keychain），同步包里只有 `credentialRef` 指针，
 *    且该指针在另一台机器上解不出东西（必须重新输入）。
 * 4. **恢复码**：创建/轮换主口令时一次性展示，足够恢复（不需要旧口令）；恢复后主口令可重设。
 */

export const vaultStateSchema = z.enum(['uninitialized', 'locked', 'unlocked'])
export type VaultState = z.infer<typeof vaultStateSchema>

export const vaultKdfSchema = z.object({
  name: z.literal('scrypt'),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive()
})
export type VaultKdf = z.infer<typeof vaultKdfSchema>

export const syncRepoSchema = z.object({
  remoteUrl: z.string().min(1),
  branch: z.string().min(1),
  /** 远端认证方式；token/私钥不入 vault，由 safeStorage 保存 */
  auth: z.enum(['token', 'ssh-agent', 'none'])
})
export type SyncRepo = z.infer<typeof syncRepoSchema>

export const vaultContentPolicySchema = z.object({
  secretsExcluded: z.literal(true),
  privateKeysExcluded: z.literal(true),
  plaintextHostnamesInRepo: z.literal(false)
})
export type VaultContentPolicy = z.infer<typeof vaultContentPolicySchema>

export const vaultStatusSchema = z.object({
  state: vaultStateSchema,
  cipher: z.literal('aes-256-gcm').nullable(),
  kdf: vaultKdfSchema.nullable(),
  /** 是否已生成恢复码（决定「忘了主口令」能否自救） */
  recoveryAvailable: z.boolean(),
  /** 主口令是否已托管给系统 keychain（支持快速解锁/生物识别） */
  keychainBacked: z.boolean(),
  repo: syncRepoSchema.nullable(),
  policy: vaultContentPolicySchema,
  itemCounts: z
    .object({
      hosts: z.number().int().min(0),
      groups: z.number().int().min(0),
      knownHosts: z.number().int().min(0),
      themes: z.number().int().min(0)
    })
    .nullable(),
  createdAt: isoTimestampSchema.nullable(),
  lastUnlockedAt: isoTimestampSchema.nullable(),
  lastSyncedAt: isoTimestampSchema.nullable()
})
export type VaultStatus = z.infer<typeof vaultStatusSchema>

export const vaultCreateResultSchema = z.object({
  status: vaultStatusSchema,
  /** 只在创建/轮换的这一刻返回一次，之后无法再读 */
  recoveryCode: z.string().min(16)
})
export type VaultCreateResult = z.infer<typeof vaultCreateResultSchema>

export const vaultRotateRequestSchema = z.object({
  currentPassphrase: z.string().min(1),
  newPassphrase: z.string().min(12)
})
export type VaultRotateRequest = z.infer<typeof vaultRotateRequestSchema>

export const vaultRecoveryRequestSchema = z.object({
  recoveryCode: z.string().min(16),
  newPassphrase: z.string().min(12)
})
export type VaultRecoveryRequest = z.infer<typeof vaultRecoveryRequestSchema>

export const syncStateSchema = z.enum(['off', 'idle', 'syncing', 'ahead', 'behind', 'diverged', 'error'])
export type SyncState = z.infer<typeof syncStateSchema>

export const syncStatusSchema = z.object({
  state: syncStateSchema,
  repo: syncRepoSchema.nullable(),
  localCommit: z.string().nullable(),
  remoteCommit: z.string().nullable(),
  pendingLocalChanges: z.number().int().min(0),
  conflictCount: z.number().int().min(0),
  lastSyncedAt: isoTimestampSchema.nullable(),
  error: z.string().nullable()
})
export type SyncStatus = z.infer<typeof syncStatusSchema>

export const syncConflictKindSchema = z.enum(['host', 'group', 'settings', 'theme', 'known-hosts'])
export type SyncConflictKind = z.infer<typeof syncConflictKindSchema>

export const syncConflictSchema = z.object({
  id: z.string().min(1),
  kind: syncConflictKindSchema,
  entityId: z.string().min(1),
  label: z.string(),
  path: z.string(),
  localUpdatedAt: isoTimestampSchema.nullable(),
  remoteUpdatedAt: isoTimestampSchema.nullable(),
  /** 渲染层展示给用户做选择用的摘要（不含任何密钥/密码） */
  localSummary: z.string(),
  remoteSummary: z.string()
})
export type SyncConflict = z.infer<typeof syncConflictSchema>

/** 冲突选择策略：保留本地 / 保留远端 / 两边都留（远端另存为副本） */
export const conflictStrategySchema = z.enum(['local', 'remote', 'duplicate'])
export type ConflictStrategy = z.infer<typeof conflictStrategySchema>

export const syncResolveRequestSchema = z.object({
  conflictId: z.string().min(1),
  strategy: conflictStrategySchema
})
export type SyncResolveRequest = z.infer<typeof syncResolveRequestSchema>

/** 「双机迁移 A→B」的验收接口：B 机只需要远端地址 + 主口令，就能拿到完整主机库 */
export const syncBootstrapRequestSchema = z.object({
  remoteUrl: z.string().min(1),
  branch: z.string().min(1),
  auth: z.enum(['token', 'ssh-agent', 'none'])
})
export type SyncBootstrapRequest = z.infer<typeof syncBootstrapRequestSchema>
