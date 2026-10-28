import { z } from 'zod'
import { isoTimestampSchema } from './app'

/**
 * 主机库数据模型。
 *
 * 安全约束（不可协商）：
 * - **密码 / passphrase / AI key 不作为字段存在**，模型里只有 `credentialRef`。
 *   `credentialRef` 指向密文包内的 `payload.secrets[ref]`（`vault.enc`，随 Git 同步、端到端加密），
 *   不是本机钥匙串条目；明文凭据不进 `HostRecord`，也不进仓库、日志、渲染层。
 *   这也正是 A→B 迁移的前提：B 机用同一主口令解包即可直接连接；若把密码退回「只存本机」，
 *   B 机会看到条目却连不上，等于废条目。
 * - `privateKeyPath` 只存路径（IdentityFile 引用）；私钥**文件本体**永不进 vault.enc、永不进 Git，
 *   B 机缺文件时连接前明确报错，由用户在本机补齐。
 */

export const hostIdSchema = z.uuid()
export const groupIdSchema = z.uuid()

export const authMethodSchema = z.enum(['password', 'publickey', 'agent', 'keyboard-interactive'])
export type AuthMethod = z.infer<typeof authMethodSchema>

export const portRangeSchema = z.number().int().min(1).max(65_535)

export const portForwardSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['local', 'remote', 'dynamic']),
  bindHost: z.string().min(1),
  bindPort: portRangeSchema,
  targetHost: z.string().nullable(),
  targetPort: portRangeSchema.nullable()
})
export type PortForward = z.infer<typeof portForwardSchema>

/** 从 ~/.ssh/config 导入的溯源信息，写回时靠它定位原始 Host 块 */
export const sshConfigOriginSchema = z.object({
  file: z.string().min(1),
  alias: z.string().min(1)
})
export type SshConfigOrigin = z.infer<typeof sshConfigOriginSchema>

export const hostInputSchema = z.object({
  label: z.string().min(1).max(120),
  groupId: groupIdSchema.nullable(),
  // 允许 FQDN / IPv4 / [IPv6] 字面量；不接受空白与任意符号（粘贴带空格的地址是最常见的输入错误）
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._:[\]-]+$/, 'hostname may only contain letters, digits, dot, dash, underscore, colon, brackets'),
  port: portRangeSchema,
  username: z.string().min(1).max(128),
  authMethod: authMethodSchema,
  /** 私钥路径（本地路径，不同步私钥内容） */
  privateKeyPath: z.string().nullable(),
  /** 密文包里的凭据引用（`payload.secrets[ref]`，即 vault.enc 内）；明文密码/passphrase 永远不在这里 */
  credentialRef: z.string().nullable(),
  /** 跳板机：引用另一台主机，而不是内联地址 */
  jumpHostId: hostIdSchema.nullable(),
  forwardAgent: z.boolean(),
  /** 0 = 关闭 keepalive */
  keepaliveSeconds: z.number().int().min(0).max(3_600),
  terminalProfileId: z.string().nullable(),
  startupCommand: z.string().max(2_000).nullable(),
  env: z.record(z.string(), z.string()),
  tags: z.array(z.string().min(1).max(40)),
  /** 主机在侧栏的标记色（#RRGGBB），null = 继承分组 */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  portForwards: z.array(portForwardSchema),
  sshConfigOrigin: sshConfigOriginSchema.nullable()
})
export type HostInput = z.infer<typeof hostInputSchema>

export const hostRecordSchema = hostInputSchema.extend({
  id: hostIdSchema,
  sortIndex: z.number().int().min(0),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
})
export type HostRecord = z.infer<typeof hostRecordSchema>

export const hostSortUpdateSchema = z.object({
  id: hostIdSchema,
  sortIndex: z.number().int().min(0),
  groupId: groupIdSchema.nullable()
})
export type HostSortUpdate = z.infer<typeof hostSortUpdateSchema>

export const groupInputSchema = z.object({
  name: z.string().min(1).max(80),
  parentId: groupIdSchema.nullable(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
})
export type GroupInput = z.infer<typeof groupInputSchema>

export const groupRecordSchema = groupInputSchema.extend({
  id: groupIdSchema,
  sortIndex: z.number().int().min(0),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
})
export type GroupRecord = z.infer<typeof groupRecordSchema>

/** 主机库整体快照（Git 同步的序列化单元，也是加密包的明文结构） */
export const hostLibrarySchema = z.object({
  schemaVersion: z.literal(1),
  hosts: z.array(hostRecordSchema),
  groups: z.array(groupRecordSchema)
})
export type HostLibrary = z.infer<typeof hostLibrarySchema>
