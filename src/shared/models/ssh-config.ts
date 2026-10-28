import { z } from 'zod'
import { portRangeSchema, sshConfigOriginSchema } from './host'

/**
 * ~/.ssh/config 双向解析与写回契约。
 *
 * 为什么值得单列一块：用户真实环境里既有 Termans 主机库，也有历史 ~/.ssh/config。
 * 单向导入会让两边长期失同步，所以契约要求「解析结果带行号、写回只改命中的字段、其余原文一字不动」。
 *
 * 写回必须满足：
 * - 只改指定 alias 的指定字段；区间外文本（注释、缩进、大小写、行序）逐字节保留。
 * - `dryRun` 返回 diff 而不落盘；落盘前默认生成 `<path>.termans-backup-<ts>`。
 * - 目标文件权限保持 0600（OpenSSH 对过宽权限会直接拒用）。
 */

export const sshConfigEntrySchema = z.object({
  /** Host 行之后的第一个 pattern，作为该块的稳定标识 */
  alias: z.string().min(1),
  /** Host 行可能写多个 pattern（`Host a b`），全部保留 */
  patterns: z.array(z.string().min(1)).min(1),
  hostname: z.string().nullable(),
  port: portRangeSchema.nullable(),
  user: z.string().nullable(),
  identityFile: z.string().nullable(),
  proxyJump: z.string().nullable(),
  proxyCommand: z.string().nullable(),
  /** 其余键值原样保留（键名保留原大小写），用于无损写回 */
  options: z.record(z.string(), z.string()),
  /** Host 行在文件中的 1-based 行号 */
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1)
})
export type SshConfigEntry = z.infer<typeof sshConfigEntrySchema>

export const sshConfigParseWarningSchema = z.object({
  line: z.number().int().min(1),
  message: z.string()
})
export type SshConfigParseWarning = z.infer<typeof sshConfigParseWarningSchema>

export const sshConfigParseRequestSchema = z.object({
  /** null = 使用默认路径（见 ssh-config:default-paths） */
  path: z.string().nullable()
})
export type SshConfigParseRequest = z.infer<typeof sshConfigParseRequestSchema>

export const sshConfigParseResultSchema = z.object({
  path: z.string().min(1),
  exists: z.boolean(),
  entries: z.array(sshConfigEntrySchema),
  /** `Include` 指令展开后的文件列表 */
  includedFiles: z.array(z.string()),
  warnings: z.array(sshConfigParseWarningSchema)
})
export type SshConfigParseResult = z.infer<typeof sshConfigParseResultSchema>

/** 单个别名的字段修改；value 为 null 表示删除该字段 */
export const sshConfigFieldUpdateSchema = z.object({
  alias: z.string().min(1),
  fields: z.record(z.string(), z.string().nullable())
})
export type SshConfigFieldUpdate = z.infer<typeof sshConfigFieldUpdateSchema>

export const sshConfigWriteRequestSchema = z.object({
  path: z.string().min(1),
  updates: z.array(sshConfigFieldUpdateSchema).min(1),
  createBackup: z.boolean(),
  dryRun: z.boolean()
})
export type SshConfigWriteRequest = z.infer<typeof sshConfigWriteRequestSchema>

export const sshConfigWriteResultSchema = z.object({
  path: z.string().min(1),
  backupPath: z.string().nullable(),
  /** 命中并修改的别名 */
  modifiedAliases: z.array(z.string()),
  /** 文件里不存在、已追加新 Host 块的别名 */
  appendedAliases: z.array(z.string()),
  /** 未变化的行数 / 变化行数，便于测试断言「只改了 1 行」 */
  changedLineCount: z.number().int().min(0),
  diff: z.string(),
  dryRun: z.boolean()
})
export type SshConfigWriteResult = z.infer<typeof sshConfigWriteResultSchema>

export const sshConfigImportRequestSchema = z.object({
  path: z.string().min(1),
  /** null = 导入全部 alias */
  aliases: z.array(z.string().min(1)).nullable(),
  /** 已存在同名（hostname+username+port 相同）时是否覆盖 */
  overwriteExisting: z.boolean()
})
export type SshConfigImportRequest = z.infer<typeof sshConfigImportRequestSchema>

export const sshConfigImportSkipSchema = z.object({
  alias: z.string().min(1),
  reason: z.enum(['duplicate', 'no-hostname', 'wildcard', 'excluded'])
})
export type SshConfigImportSkip = z.infer<typeof sshConfigImportSkipSchema>

export const sshConfigImportResultSchema = z.object({
  importedAliases: z.array(z.string()),
  skipped: z.array(sshConfigImportSkipSchema),
  origins: z.array(sshConfigOriginSchema)
})
export type SshConfigImportResult = z.infer<typeof sshConfigImportResultSchema>
