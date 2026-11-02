import { z } from 'zod'
import {
  DEFAULT_SETTINGS,
  hostRecordSchema,
  groupRecordSchema,
  isoTimestampSchema,
  knownHostEntrySchema,
  settingsSchema,
  themeDefinitionSchema,
  withDefaults,
  type HostLibrary
} from '@shared'
import { vaultFail } from './errors'

/**
 * 加密包（`vault.enc` 里的 payload，JSON 文本）的数据模型。
 *
 * 这是**唯一的敏感数据载体**：仓库里除了 `manifest.json`（不含任何主机信息）和
 * `themes/*.json`（非敏感）之外，只有这份密文。
 *
 * 与 `src/shared/models/*` 的关系：
 * - hosts / groups / knownHosts / themes / settings 直接复用 shared 的 zod schema，
 *   避免「主进程一套、渲染层一套」两份真相；
 * - **密码 / passphrase 放在 `secrets` 表里，key 是 host.credentialRef**。
 *   shared 的 `hostRecord` 依然只有 `credentialRef`（模型层不出现明文凭据），
 *   而为了让 B 机同步后能真的连上，「凭据本体」必须跟着密文走 —— 它进的是
 *   `payload.secrets`，被 AES-256-GCM 整体加密，仓库里 grep 不到。
 *   这是对 `host.ts` 头注释「密码只存 safeStorage」的一处**有意偏差**，
 *   理由与取舍写在 docs/ARCHITECTURE.md 的 vault 章节。
 */

export const VAULT_SCHEMA_VERSION = 1

export const vaultSecretSchema = z.object({
  password: z.string().max(4_096).nullable(),
  passphrase: z.string().max(4_096).nullable(),
  updatedAt: isoTimestampSchema
})
export type VaultSecret = z.infer<typeof vaultSecretSchema>

export const vaultSnippetSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  command: z.string().min(1).max(8_000),
  tags: z.array(z.string().min(1).max(40)).max(20),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
})
export type VaultSnippet = z.infer<typeof vaultSnippetSchema>

export const vaultSshConfigSchema = z.object({
  /** 完整 ssh_config 文本：注释、未知指令、空行逐字保留（导入导出靠它，不靠重建） */
  text: z.string().max(2_000_000),
  /** Host 别名 → hostId 的稳定映射（改别名不影响主机 id） */
  aliasMap: z.record(z.string(), z.string()),
  /** 最近一次导入/导出的绝对路径，仅用于 UI 展示 */
  sourcePath: z.string().nullable()
})
export type VaultSshConfig = z.infer<typeof vaultSshConfigSchema>

/**
 * 第三方集成凭据。
 *
 * - `gitToken`：Git 远端 token（t5 之前的 Git 同步由本任务实现，token 在密文里而不是明文配置文件）；
 * - `aiApiKeys`：providerId → API key，t5（AI 面板）接入后写入这里；
 * - `aiProvidersConfig`：t5 的 `ai/providers.json` 全文（字符串，原样保存），
 *   这样「换机器后 AI 供应商列表也一起同步」，而它同样只以密文形式进仓库。
 *
 * 放在密文里而不是只放本机 safeStorage 的理由：用户换机器后仍然能继续用同一套 AI 配置；
 * 而它们同样被端到端加密保护，仓库里只有密文。
 */
export const vaultIntegrationsSchema = z.object({
  gitToken: z.string().max(8_192).nullable(),
  aiApiKeys: z.record(z.string(), z.string()),
  /** t5 的 ai/providers.json 全文；**必须 nullable 且带默认 null**，否则旧 vault 解包会校验失败 */
  aiProvidersConfig: z.string().max(1_000_000).nullable().default(null),
  /**
   * 多条 Git 令牌（t57）。`token` 只有密文包里有；界面只看得到掩码，复制走一次性 reveal。
   *
   * 为什么不用「一条 gitToken + 一堆 label」的写法：仓库可能同时推 GitHub（个人）与内网 GitLab
   * （公司）两个远端，换环境时改的是「用哪一条」，不是「重新贴一遍」。
   * 三个 `.default()` 都是必需的：旧 vault 解包时这些键不存在，没有默认值会 zod 校验失败。
   */
  gitTokens: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().max(120),
        source: z.enum(['manual', 'env', 'gh', 'git-credentials', 'file', 'migrated']),
        token: z.string().min(1).max(8_192),
        createdAt: isoTimestampSchema
      })
    )
    .default([]),
  defaultGitTokenId: z.string().max(64).nullable().default(null),
  /**
   * 令牌文件路径：设了它就以文件内容为准（同步时实时读取）。
   * 这样 CI / 密钥管理工具写出来的令牌文件可以直接被吃掉，不必每次手动粘贴。
   */
  gitTokenFilePath: z.string().max(4_096).nullable().default(null)
})
export type VaultIntegrations = z.infer<typeof vaultIntegrationsSchema>

export const vaultPayloadSchema = z.object({
  schemaVersion: z.number().int().min(1),
  hosts: z.array(hostRecordSchema),
  groups: z.array(groupRecordSchema),
  knownHosts: z.array(knownHostEntrySchema),
  themes: z.array(themeDefinitionSchema),
  snippets: z.array(vaultSnippetSchema),
  /**
   * 主机备注（逐主机一段自由文本）。
   *
   * 为什么单独放一层：`HostInput`（src/shared，不可改）里没有 notes 字段，
   * 而备注属于「敏感数据必须进密文包」的范畴，所以按 hostId 存在 payload 里。
   */
  hostNotes: z.record(z.string(), z.string().max(2_000)).default({}),
  secrets: z.record(z.string(), vaultSecretSchema),
  settings: settingsSchema,
  sshConfig: vaultSshConfigSchema,
  integrations: vaultIntegrationsSchema,
  updatedAt: isoTimestampSchema
})
export type VaultPayload = z.infer<typeof vaultPayloadSchema>

export function emptyPayload(now: string): VaultPayload {
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    hosts: [],
    groups: [],
    knownHosts: [],
    themes: [],
    snippets: [],
    hostNotes: {},
    secrets: {},
    settings: structuredClone(DEFAULT_SETTINGS),
    sshConfig: { text: '', aliasMap: {}, sourcePath: null },
    integrations: {
      gitToken: null,
      aiApiKeys: {},
      aiProvidersConfig: null,
      gitTokens: [],
      defaultGitTokenId: null,
      gitTokenFilePath: null
    },
    updatedAt: now
  }
}

export function serializePayload(payload: VaultPayload): string {
  // 稳定键序：同一个逻辑内容产生同一份 JSON，方便 payload_sha256 做「有没有真改动」的判据
  const ordered: VaultPayload = {
    schemaVersion: payload.schemaVersion,
    hosts: [...payload.hosts].sort((a, b) => (a.sortIndex - b.sortIndex) || a.id.localeCompare(b.id)),
    groups: [...payload.groups].sort((a, b) => (a.sortIndex - b.sortIndex) || a.id.localeCompare(b.id)),
    knownHosts: [...payload.knownHosts].sort((a, b) => (a.host + a.port + a.keyType).localeCompare(b.host + b.port + b.keyType)),
    themes: [...payload.themes].sort((a, b) => a.id.localeCompare(b.id)),
    snippets: [...payload.snippets].sort((a, b) => a.id.localeCompare(b.id)),
    hostNotes: Object.fromEntries(Object.entries(payload.hostNotes).sort(([a], [b]) => a.localeCompare(b))),
    secrets: Object.fromEntries(Object.entries(payload.secrets).sort(([a], [b]) => a.localeCompare(b))),
    settings: payload.settings,
    sshConfig: payload.sshConfig,
    integrations: {
      gitToken: payload.integrations.gitToken,
      aiApiKeys: Object.fromEntries(Object.entries(payload.integrations.aiApiKeys).sort(([a], [b]) => a.localeCompare(b))),
      aiProvidersConfig: payload.integrations.aiProvidersConfig ?? null,
      // 稳定键序同样覆盖令牌列表：否则「同一逻辑内容」会因数组顺序产生不同 payload_sha256，
      // 乐观锁会误判成「有改动」，同步每次都要用户确认。按 id 排序可消除这个抖动。
      gitTokens: [...(payload.integrations.gitTokens ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      defaultGitTokenId: payload.integrations.defaultGitTokenId ?? null,
      gitTokenFilePath: payload.integrations.gitTokenFilePath ?? null
    },
    updatedAt: payload.updatedAt
  }
  return JSON.stringify(ordered)
}

/**
 * 解析 + 迁移 + 严格校验。
 *
 * 三种失败必须分清（否则「脏数据」会被当成「口令错」，用户会一直重试同一个口令）：
 * - JSON 本身坏了 → `invalid-payload`
 * - `schemaVersion` 比客户端新 → `unsupported-format`（提示升级客户端，绝不尝试猜结构）
 * - 结构不符合当前 schema → `invalid-payload`，附带 chips 化的字段路径
 */
export function parsePayload(json: string): VaultPayload {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (error) {
    throw vaultFail('E_INVALID_ARGUMENT', 'vault payload is not valid JSON', {
      reason: 'invalid-payload',
      message: error instanceof Error ? error.message : String(error)
    })
  }
  return migratePayload(raw)
}

export function migratePayload(raw: unknown): VaultPayload {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw vaultFail('E_INVALID_ARGUMENT', 'vault payload must be a JSON object', { reason: 'invalid-payload' })
  }
  const record = raw as Record<string, unknown>
  const version = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0
  if (!Number.isInteger(version) || version < 0) {
    throw vaultFail('E_INVALID_ARGUMENT', 'vault payload schemaVersion is invalid', { reason: 'invalid-payload' })
  }
  if (version > VAULT_SCHEMA_VERSION) {
    throw vaultFail(
      'E_INVALID_ARGUMENT',
      `vault payload was written by a newer Termans (schema v${version}, this build supports v${VAULT_SCHEMA_VERSION})`,
      { reason: 'unsupported-format', schemaVersion: version, supported: VAULT_SCHEMA_VERSION }
    )
  }

  const migrated = applyMigrations(record, version)
  const parsed = vaultPayloadSchema.safeParse(migrated)
  if (!parsed.success) {
    throw vaultFail('E_INVALID_ARGUMENT', 'vault payload does not match the data model', {
      reason: 'invalid-payload',
      issues: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    })
  }
  return parsed.data
}

/**
 * 版本迁移链（v0 = 早期/手工构造的包）。
 *
 * 每次只前进一步，`applyMigrations` 循环到最后，这样以后加 v2 只需再写一步。
 * v0 → v1：补齐 settings / sshConfig / integrations / secrets / snippets / knownHosts，
 * 主机记录缺 `sortIndex` 时按数组顺序补，凭据条目一律留空（不能凭猜测恢复密码）。
 */
function applyMigrations(record: Record<string, unknown>, version: number): unknown {
  let current: Record<string, unknown> = record
  let at = version
  const now = new Date().toISOString()

  if (at < 1) {
    const hosts = Array.isArray(current.hosts) ? current.hosts : []
    const groups = Array.isArray(current.groups) ? current.groups : []
    current = {
      ...current,
      schemaVersion: 1,
      hosts: hosts.map((host, index) => {
        const item = (typeof host === 'object' && host !== null ? host : {}) as Record<string, unknown>
        return { sortIndex: index, ...item }
      }),
      groups: groups.map((group, index) => {
        const item = (typeof group === 'object' && group !== null ? group : {}) as Record<string, unknown>
        return { sortIndex: index, ...item }
      }),
      knownHosts: current.knownHosts ?? [],
      themes: current.themes ?? [],
      snippets: current.snippets ?? [],
      hostNotes: current.hostNotes ?? {},
      secrets: current.secrets ?? {},
      settings: current.settings === undefined ? structuredClone(DEFAULT_SETTINGS) : withDefaults(current.settings),
      sshConfig: current.sshConfig ?? { text: '', aliasMap: {}, sourcePath: null },
      integrations: {
        gitToken: null,
        aiApiKeys: {},
        aiProvidersConfig: null,
        ...(typeof current.integrations === 'object' && current.integrations !== null ? current.integrations : {})
      },
      updatedAt: current.updatedAt ?? now
    }
    at = 1
  }

  if (at > VAULT_SCHEMA_VERSION) {
    throw vaultFail('E_INVALID_ARGUMENT', `cannot migrate payload from v${version}`, { reason: 'unsupported-format' })
  }
  return current
}

/** 主机库视图（`hosts:list` 的响应）；锁定时由 manager 直接抛 E_VAULT_LOCKED，不会走到这里 */
export function toHostLibrary(payload: VaultPayload): HostLibrary {
  return {
    schemaVersion: 1,
    hosts: [...payload.hosts].sort((a, b) => (a.sortIndex - b.sortIndex) || a.createdAt.localeCompare(b.createdAt)),
    groups: [...payload.groups].sort((a, b) => (a.sortIndex - b.sortIndex) || a.createdAt.localeCompare(b.createdAt))
  }
}

/** 解锁后状态里展示的条目计数（锁定时为 null，绝不泄漏「有几台机」以外的信息） */
export function countItems(payload: VaultPayload, themeCount: number): {
  hosts: number
  groups: number
  knownHosts: number
  themes: number
} {
  return {
    hosts: payload.hosts.length,
    groups: payload.groups.length,
    knownHosts: payload.knownHosts.length,
    themes: themeCount
  }
}

export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && isoTimestampSchema.safeParse(value).success
}
