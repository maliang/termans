import { z } from 'zod'
import { isoTimestampSchema } from './app'

/**
 * known_hosts 契约。
 *
 * 默认策略 `strict`：指纹未知或与已记录不一致时**拒绝连接**，由用户显式确认后才写入。
 * 不一致（mismatch）必须以红色高危提示呈现，绝不能静默覆盖——那是中间人攻击的典型入口。
 */

export const knownHostKeyTypeSchema = z.enum([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com'
])
export type KnownHostKeyType = z.infer<typeof knownHostKeyTypeSchema>

export const knownHostEntrySchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  keyType: z.string().min(1),
  /** SHA256:... 形式，与 `ssh-keygen -lf` 输出一致 */
  fingerprintSha256: z.string().min(1),
  /** known_hosts 里是否为 hashed 形式（|1|...） */
  hashed: z.boolean(),
  addedAt: isoTimestampSchema,
  /** 来源文件；null = Termans 自管存储 */
  sourceFile: z.string().nullable()
})
export type KnownHostEntry = z.infer<typeof knownHostEntrySchema>

export const knownHostTrustRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  keyType: z.string().min(1),
  fingerprintSha256: z.string().min(1),
  /** true = 覆盖已存在的不同指纹（仅在用户确认 mismatch 后由 UI 置 true） */
  replaceExisting: z.boolean()
})
export type KnownHostTrustRequest = z.infer<typeof knownHostTrustRequestSchema>

export const knownHostRemoveRequestSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535)
})
export type KnownHostRemoveRequest = z.infer<typeof knownHostRemoveRequestSchema>

export const knownHostsPolicySchema = z.enum(['strict', 'accept-new', 'ask'])
export type KnownHostsPolicy = z.infer<typeof knownHostsPolicySchema>
