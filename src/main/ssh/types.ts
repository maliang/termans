import type { BaseAgent } from 'ssh2'
import type { HostRecord, IpcEventMap, IpcEventName, SshSettings } from '@shared'
import type { BackoffPolicy } from './backoff'
import type { KnownHostsGateway } from './known-hosts'
import type { SshLogger } from './redact'

/**
 * 引擎的依赖注入面。
 *
 * 设计原则：**引擎不 import electron、不读 userData、不自己找主机库**。
 * 所有「外部世界」都从这里进来，于是整个 SSH 栈可以在 vitest 里跑真实 ssh2 服务器，
 * 而不需要启动 Electron（`app.getPath` 在测试进程里根本不存在）。
 * 集成的接线点只有 src/main/ipc/index.ts 一处（由 integration 任务负责），
 * 引擎自己绝不注册 known-hosts:* 通道（那是 vault-sync 的命名空间）。
 */

/** 定时器抽象：重连/超时用它，测试可以注入「立刻触发」的假定时器，避免真等 30 秒 */
export interface SshTimers {
  /** 延时执行，返回取消函数 */
  after(ms: number, fn: () => void): () => void
}

export const defaultSshTimers: SshTimers = {
  after(ms, fn) {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  }
}

export interface SshEngineDeps {
  /** hostId → 主机记录；不存在时抛 E_NOT_FOUND 语义的错误 */
  resolveHost(hostId: string): HostRecord | Promise<HostRecord>
  /**
   * credentialRef → 明文密码/passphrase。
   * 明文只在这一刻存在：不缓存、不落盘、不进日志（日志器按值脱敏）。
   */
  resolveSecret(credentialRef: string): string | null | Promise<string | null>
  knownHosts: KnownHostsGateway
  /** ssh 设置段（SettingsStore 的 ssh 部分） */
  getSettings(): SshSettings
  /** 推送事件；集成方传 registry 的 emitToAll */
  emit<E extends IpcEventName>(event: E, payload: IpcEventMap[E]): void
  log?: SshLogger
  /** 读私钥文件（测试注入；默认 fs.readFileSync utf8） */
  readPrivateKey?(path: string): string
  /**
   * ssh-agent 来源。返回 BaseAgent 实例、socket 路径，或 null（= 不可用）。
   * 默认读 SSH_AUTH_SOCK；测试注入进程内假 agent。
   */
  createAgent?(env: NodeJS.ProcessEnv): BaseAgent | string | null
  env?: NodeJS.ProcessEnv
  now?(): number
  random?(): number
  timers?: SshTimers
  /** 用户回答指纹确认的最长等待；超时按拒绝处理（默认 120s） */
  hostKeyDecisionTimeoutMs?: number
  /** 重连曲线覆盖（次数来自设置项 autoReconnectAttempts） */
  reconnect?: Partial<BackoffPolicy>
  /** exec 单流最大保留字节（默认 1MiB，超出丢弃并置 truncated） */
  execMaxBytes?: number
}

/** 引擎内部使用的连接描述（由 HostRecord 投影而来，不含任何凭据） */
export interface SshTarget {
  hostId: string
  label: string
  hostname: string
  port: number
  username: string
  authMethod: HostRecord['authMethod']
  privateKeyPath: string | null
  credentialRef: string | null
  forwardAgent: boolean
  keepaliveSeconds: number
  startupCommand: string | null
  env: Record<string, string>
}

export function toSshTarget(host: HostRecord): SshTarget {
  return {
    hostId: host.id,
    label: host.label,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    authMethod: host.authMethod,
    privateKeyPath: host.privateKeyPath,
    credentialRef: host.credentialRef,
    forwardAgent: host.forwardAgent,
    keepaliveSeconds: host.keepaliveSeconds,
    startupCommand: host.startupCommand,
    env: host.env
  }
}

/** 一次连接尝试用到的凭据（用完即弃，不挂在 session 上长期持有） */
export interface SshCredential {
  password?: string
  passphrase?: string
}

/** 便于日志/测试判断「哪些值必须被脱敏」 */
export function credentialSecrets(credential: SshCredential | null): string[] {
  const secrets: string[] = []
  if (credential?.password) secrets.push(credential.password)
  if (credential?.passphrase) secrets.push(credential.passphrase)
  return secrets
}
