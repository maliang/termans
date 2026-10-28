import { z } from 'zod'
import { isoTimestampSchema } from './app'

/**
 * 加密包 / Git 同步契约。
 *
 * 数据流（vault-sync 实现细节，这里只锁对外形状）：
 *   payload{hosts, groups, knownHosts, secrets, integrations, settings, sshConfig, …}(明文 JSON)
 *     --scrypt 派生密钥 + AES-256-GCM--> vault.enc --isomorphic-git--> 远端私有仓库
 *
 * 四条不可协商约束（SPEC.md 逐条给了可执行判据）：
 * 1. **密文仓库**：远端仓库里不能出现明文主机名 / 用户名 / 端口 / 标签 / 密码 / 指纹
 *    （只有 `vault.enc`、`manifest.json` 元数据，以及非敏感的主题文件）。
 * 2. **私钥文件不同步**：`~/.ssh/id_*` 的**文件本体**永不进 vault.enc，也不进 Git；跨机同步的只是
 *    `host.privateKeyPath`（IdentityFile 路径引用）。B 机缺这个文件时连接前明确报错，由用户在本机补齐。
 * 3. **密码/passphrase 随端到端加密包同步**：主机密码与私钥 passphrase 存在 `payload.secrets`
 *    （key = `host.credentialRef`），被 scrypt + AES-256-GCM 整体加密；**主口令不在仓库**，Git 里 grep 不到明文。
 *    这是「A 机 3 台主机同步到 B 机、B 机用同一主口令解包即可连上」的前提 —— 若只存本机 keychain，
 *    B 机只会看到条目却连不上，等于废条目。模型层仍只有 `credentialRef`，明文凭据不进 `HostRecord`。
 *    AI 供应商 key 走同一份密文包（`payload.integrations.aiApiKeys`）；Git 远端 token 同样在密文包里
 *    （`payload.integrations.gitToken`），本机 `credentials.json` 的 `git:token` 只是首次 clone / 未解锁时的兜底。
 *    这两类凭据都不允许以明文出现在仓库、日志或渲染层。
 * 4. **恢复码**：创建/轮换主口令时展示一次，足够恢复（不需要旧口令）。恢复码**可重复使用**：`vault:recover`
 *    只替换主口令槽、恢复码本身不变；只有 `vault:rotate` 轮换主口令时才重新生成恢复码（旧码随之失效）。
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
  /**
   * 远端认证方式。
   *
   * token 的存放（与实现一致）：**Git token 随密文包同步** —— 取 `payload.integrations.gitToken`，
   * 因此换机器后不用重新贴 token；本机 `credentials.json` 里的 `git:token` 只是首次 clone /
   * 加密包未解锁时的兜底，两条路径都不以明文进仓库。
   *
   * AI 供应商 key 同理进加密包（`payload.integrations.aiApiKeys`）；
   * **私钥文件本体永不入 vault**，同步的只是 `host.privateKeyPath` 路径。
   */
  auth: z.enum(['token', 'ssh-agent', 'none'])
})
export type SyncRepo = z.infer<typeof syncRepoSchema>

/**
 * 加密包内容策略（对外公告的硬承诺，三个字面量都不允许被配置成别的值）。
 *
 * 语义以「**仓库里的明文**」为准 —— 密文内部当然可以有这些数据，那是设计前提：
 * - `secretsExcluded`：仓库的明文里不出现密码 / passphrase / API key / Git token
 *   （它们只在 `vault.enc` 的 payload 内，读写全程不落明文；字段名写的是「明文排除」，不是「不同步」）；
 * - `privateKeysExcluded`：仓库里不出现私钥文件内容，只有 `privateKeyPath` 路径引用；
 * - `plaintextHostnamesInRepo`：仓库里不出现明文主机名 / IP / 端口 / 用户名。
 *
 * 判定照旧走 `git grep`：在 clone 出来的仓库里 grep 明文与 `PRIVATE KEY` 均应为 0 命中（SPEC S-05）。
 */
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
