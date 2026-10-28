import { z } from 'zod'
import { hostIdSchema } from './host'

/**
 * SSH 连接生命周期与终端通道契约。
 *
 * 数据流：
 *   renderer --terminal:input/resize--> main(engine) --ssh2 stream--> remote
 *   main(engine) --event ssh:data / ssh:state-changed / ssh:closed--> renderer
 *
 * 会话与页签解耦：一个 sessionId 对应一条 SSH 连接；一个页签可以持有多个分屏/会话，
 * 页签 id 由渲染层（terminal-ui）自己维护，不进 IPC。
 */

export const sshPhaseSchema = z.enum([
  'idle',
  'connecting',
  'authenticating',
  'host-key-verification',
  'connected',
  'reconnecting',
  'closed',
  'error'
])
export type SshPhase = z.infer<typeof sshPhaseSchema>

export const terminalSizeSchema = z.object({
  cols: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(2).max(1_000)
})
export type TerminalSize = z.infer<typeof terminalSizeSchema>

export const sshSessionSchema = z.object({
  sessionId: z.string().min(1),
  hostId: hostIdSchema,
  hostLabel: z.string(),
  phase: sshPhaseSchema,
  openedAt: z.string().nullable(),
  lastError: z.string().nullable()
})
export type SshSession = z.infer<typeof sshSessionSchema>

export const sshConnectRequestSchema = z.object({
  hostId: hostIdSchema,
  size: terminalSizeSchema,
  /** 覆盖主机的启动命令（一次性，不回写主机库） */
  startupCommand: z.string().max(2_000).nullable(),
  /** true 时会话已存在则直接复用（同一主机多页签共用连接） */
  reuseExisting: z.boolean()
})
export type SshConnectRequest = z.infer<typeof sshConnectRequestSchema>

export const sshConnectResultSchema = z.object({
  sessionId: z.string().min(1),
  hostKeyFingerprint: z.string().nullable(),
  hostKeyDecision: z.enum(['trusted', 'accepted-now', 'not-verified'])
})
export type SshConnectResult = z.infer<typeof sshConnectResultSchema>

export const hostKeyDecisionSchema = z.object({
  sessionId: z.string().min(1),
  decision: z.enum(['accept', 'reject']),
  /** accept 时是否写入 known_hosts（false = 只本次信任） */
  remember: z.boolean()
})
export type HostKeyDecision = z.infer<typeof hostKeyDecisionSchema>

export const sshDataEventSchema = z.object({
  sessionId: z.string().min(1),
  /** 主进程已按 UTF-8 流式解码的文本 */
  data: z.string()
})
export type SshDataEvent = z.infer<typeof sshDataEventSchema>

export const sshStateEventSchema = z.object({
  sessionId: z.string().min(1),
  phase: sshPhaseSchema,
  message: z.string().nullable()
})
export type SshStateEvent = z.infer<typeof sshStateEventSchema>

export const sshClosedEventSchema = z.object({
  sessionId: z.string().min(1),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  reason: z.enum(['exit', 'error', 'disconnected', 'user'])
})
export type SshClosedEvent = z.infer<typeof sshClosedEventSchema>

/** 首次见到主机密钥 / 指纹与 known_hosts 不一致时下发；回答走 ssh:answer-host-key */
export const hostKeyChallengeSchema = z.object({
  sessionId: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  keyType: z.string().min(1),
  fingerprintSha256: z.string().min(1),
  previousFingerprintSha256: z.string().nullable(),
  reason: z.enum(['unknown', 'mismatch'])
})
export type HostKeyChallenge = z.infer<typeof hostKeyChallengeSchema>
