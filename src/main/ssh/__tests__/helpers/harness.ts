import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ssh2'
import type {
  HostKeyChallenge,
  HostKeyDecision,
  HostRecord,
  SshClosedEvent,
  SshDataEvent,
  SshSettings,
  SshStateEvent
} from '@shared'
import { DEFAULT_SETTINGS } from '@shared'
import { MemoryKnownHostsGateway, fingerprintSha256FromKey, type KnownHostsGateway } from '../../known-hosts'
import { FIXTURE_CLIENT_FINGERPRINT, FIXTURE_CLIENT_KEY, FIXTURE_CLIENT_PUBLIC } from './keys'
import { SshManager } from '../../manager'
import type { BackoffPolicy } from '../../backoff'
import type { SshLogger } from '../../redact'
import { toSshTarget, type SshEngineDeps, type SshTarget } from '../../types'
import type { FakeSshServer } from './fake-server'

/**
 * 测试脚手架：造 host / deps / manager，并把 IPC 事件收集到数组里。
 *
 * 刻意不 mock ssh2 —— 被测的 `SshSession` 与假服务器之间是真实 SSH 协议；
 * 只把「进程外的东西」换成注入点：时钟、随机数、known_hosts 存储、密钥文件、事件总线。
 */

export interface EventSink {
  data: SshDataEvent[]
  states: SshStateEvent[]
  closed: SshClosedEvent[]
  challenges: HostKeyChallenge[]
}

export function createEventSink(): EventSink {
  return { data: [], states: [], closed: [], challenges: [] }
}

export function dataText(sink: EventSink): string {
  return sink.data.map((event) => event.data).join('')
}

/** 跳板机夹具：给目标机挂一台「跳板机」，跳板机自己也是普通 SSH 服务器 */
export interface JumpHarnessOptions {
  server: Pick<FakeSshServer, 'port' | 'host'>
  id?: string
  label?: string
  hostname?: string
  port?: number
  username?: string
  authMethod?: SshTarget['authMethod']
  credentialRef?: string | null
  privateKeyPath?: string | null
  keepaliveSeconds?: number
  /** 跳板机自己也配一层跳板（用于「多级跳板明确拒绝」用例） */
  jumpHostId?: string | null
  /** true = 这台跳板机已从主机库删除（resolveHost 抛错） */
  deleted?: boolean
}

export interface HarnessOptions {
  server: Pick<FakeSshServer, 'port' | 'host'>
  /** 目标机的跳板机；省略 = 直连 */
  jump?: JumpHarnessOptions
  authMethod?: SshTarget['authMethod']
  username?: string
  password?: string
  privateKeyPath?: string | null
  credentialRef?: string | null
  /** credentialRef → secret 的解析表（模拟 vault） */
  secrets?: Record<string, string | null>
  settings?: Partial<SshSettings>
  knownHosts?: KnownHostsGateway
  reconnect?: Partial<BackoffPolicy>
  hostKeyDecisionTimeoutMs?: number
  /** 缺省：自动接受并记住（大多数用例只关心连接本身） */
  answerHostKey?: (challenge: HostKeyChallenge) => HostKeyDecision | Promise<HostKeyDecision>
  extraEnv?: Record<string, string>
  keepaliveSeconds?: number
  log?: SshLogger
}

export interface Harness {
  deps: SshEngineDeps
  manager: SshManager
  events: EventSink
  settings: SshSettings
  host: HostRecord
  target: SshTarget
  /** 跳板机条目（未配置跳板时为 null） */
  jumpHost: HostRecord | null
  jumpTarget: SshTarget | null
  /** 发起连接（用默认 size 100x30） */
  connect: (overrides?: { size?: { cols: number; rows: number }; reuseExisting?: boolean }) => Promise<{
    sessionId: string
    hostKeyFingerprint: string | null
    hostKeyDecision: 'trusted' | 'accepted-now' | 'not-verified'
  }>
  waitForConnect: () => Promise<void>
  dispose: () => void
}

export function makeHostRecord(overrides: Partial<HostRecord> = {}): HostRecord {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString()
  return {
    id: randomUUID(),
    label: 'test-host',
    groupId: null,
    hostname: '127.0.0.1',
    port: 22,
    username: 'tester',
    authMethod: 'password',
    privateKeyPath: null,
    credentialRef: 'cred-1',
    jumpHostId: null,
    forwardAgent: false,
    keepaliveSeconds: 0,
    terminalProfileId: null,
    startupCommand: null,
    env: {},
    tags: [],
    color: null,
    portForwards: [],
    sshConfigOrigin: null,
    sortIndex: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

export function createHarness(options: HarnessOptions): Harness {
  const events = createEventSink()
  const settings: SshSettings = { ...DEFAULT_SETTINGS.ssh, ...options.settings }
  const knownHosts = options.knownHosts ?? new MemoryKnownHostsGateway()

  const jump = options.jump ?? null
  const jumpRecord: HostRecord | null = jump
    ? makeHostRecord({
        id: jump.id ?? randomUUID(),
        label: jump.label ?? 'jump-host',
        hostname: jump.hostname ?? jump.server.host,
        port: jump.port ?? jump.server.port,
        username: jump.username ?? 'tester',
        authMethod: jump.authMethod ?? 'password',
        credentialRef: jump.credentialRef === undefined ? 'jump-cred' : jump.credentialRef,
        privateKeyPath: jump.privateKeyPath ?? null,
        keepaliveSeconds: jump.keepaliveSeconds ?? 0,
        jumpHostId: jump.jumpHostId ?? null
      })
    : null

  const host = makeHostRecord({
    hostname: options.server.host,
    port: options.server.port,
    username: options.username ?? 'tester',
    authMethod: options.authMethod ?? 'password',
    credentialRef: options.credentialRef === undefined ? 'cred-1' : options.credentialRef,
    privateKeyPath: options.privateKeyPath ?? null,
    keepaliveSeconds: options.keepaliveSeconds ?? 0,
    jumpHostId: jumpRecord ? jumpRecord.id : (options.jump ? 'missing-jump-host' : null)
  })

  const secrets: Record<string, string | null> =
    options.secrets ??
    ({
      // 默认凭据：同一个 ref 同时当密码和 passphrase 用（与 SshSession.loadCredentialFor 的语义一致）
      'cred-1': options.password ?? 'secret',
      ...(jumpRecord ? { 'jump-cred': 'secret' } : {})
    } satisfies Record<string, string | null>)

  const deps: SshEngineDeps = {
    resolveHost: (hostId: string) => {
      if (hostId === host.id) return host
      if (jumpRecord && hostId === jumpRecord.id) {
        if (jump?.deleted) throw new Error(`host ${hostId} was deleted`)
        return jumpRecord
      }
      throw new Error(`unknown host ${hostId}`)
    },
    resolveSecret: (ref: string) => (ref in secrets ? secrets[ref] : null),
    knownHosts,
    getSettings: () => settings,
    emit: (event, payload) => {
      if (event === 'ssh:data') events.data.push(payload as SshDataEvent)
      else if (event === 'ssh:state-changed') events.states.push(payload as SshStateEvent)
      else if (event === 'ssh:closed') events.closed.push(payload as SshClosedEvent)
      else if (event === 'ssh:host-key-challenge') {
        events.challenges.push(payload as HostKeyChallenge)
        void answer(payload as HostKeyChallenge)
      }
    },
    reconnect: options.reconnect,
    hostKeyDecisionTimeoutMs: options.hostKeyDecisionTimeoutMs,
    env: options.extraEnv,
    // 用例默认静音引擎日志（否则 21 个用例会刷几百行 [ssh] 行）；需要断言的用例注入 createMemoryLogger
    log: options.log ?? (() => {})
  }

  const manager = new SshManager({ deps })

  const answer = async (challenge: HostKeyChallenge): Promise<void> => {
    const handler = options.answerHostKey ?? ((value: HostKeyChallenge) => ({
      sessionId: value.sessionId,
      decision: 'accept' as const,
      remember: true
    }))
    try {
      const decision = await handler(challenge)
      // 给 challenge 事件一个 tick 落地（真实链路里这是 IPC 往返）
      manager.answerHostKey(decision)
    } catch {
      /* 用例自己等超时 */
    }
  }

  const connect: Harness['connect'] = (overrides = {}) =>
    manager.connect({
      hostId: host.id,
      size: overrides.size ?? { cols: 100, rows: 30 },
      startupCommand: null,
      reuseExisting: overrides.reuseExisting ?? false
    })

  return {
    deps,
    manager,
    events,
    settings,
    host,
    target: toSshTarget(host),
    jumpHost: jumpRecord,
    jumpTarget: jumpRecord ? toSshTarget(jumpRecord) : null,
    connect,
    waitForConnect: () => waitFor(() => events.states.some((state) => state.phase === 'connected')),
    dispose: () => manager.disposeAll()
  }
}

/* ------------------------------------------------------------------ 密钥 */

export interface KeyFixture {
  dir: string
  privateKeyPath: string
  publicKeyLine: string
  fingerprintSha256: string
  cleanup: () => void
}

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `termans-${prefix}-`))
}

/**
 * 生成 OpenSSH 格式（`-----BEGIN OPENSSH PRIVATE KEY-----`）的 ed25519 私钥。
 *
 * 用**钉死的**客户端密钥而不是 `generateKeyPairSync`：后者在 ssh2 1.17 上约 1/256 产出
 * 无法被 parseKey 解析的坏私钥，会把「单跑绿、全量红」带进夹具（详见 helpers/keys.ts）。
 */
export function createOpenSshKey(): KeyFixture {
  const dir = makeTempDir('openssh')
  const privateKeyPath = join(dir, 'id_ed25519')
  writeFileSync(privateKeyPath, FIXTURE_CLIENT_KEY, { mode: 0o600 })
  return {
    dir,
    privateKeyPath,
    publicKeyLine: FIXTURE_CLIENT_PUBLIC,
    fingerprintSha256: FIXTURE_CLIENT_FINGERPRINT,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** 生成 PEM 格式私钥（PKCS#1 RSA 或 PKCS#8 ed25519），可选加密 */
export function createPemKey(options: { encrypted?: boolean; passphrase?: string } = {}): KeyFixture {
  const dir = makeTempDir('pem')
  const algorithm = 'rsa'
  const passphrase = options.passphrase ?? 'key-passphrase'
  // 这里的 generateKeyPairSync 是 **node:crypto** 的 RSA 生成器（返回 PEM），不是 ssh2 的
  // utils.generateKeyPairSync —— 后者对 ed25519 有 1/256 的坏样本缺陷（见 helpers/keys.ts），
  // node 的 RSA 生成没有该问题，所以这一处保留随机生成（每次用到不同的 PEM 密钥更接近真实场景）。
  const { privateKey, publicKey } = generateKeyPairSync(algorithm, {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
      ...(options.encrypted ? { cipher: 'aes-256-cbc', passphrase } : {})
    },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const privateKeyPath = join(dir, 'id_rsa')
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 })
  // 私钥对应的公钥指纹：用 ssh2 解析私钥后取 getPublicSSH()，保证与服务器看到的一致
  const parsed = utils.parseKey(privateKey as string, options.encrypted ? passphrase : undefined)
  if (parsed instanceof Error) throw parsed
  return {
    dir,
    privateKeyPath,
    publicKeyLine: publicKey,
    fingerprintSha256: fingerprintSha256FromKey(parsed.getPublicSSH()),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ 等待 */

export async function waitFor(predicate: () => boolean, options: { timeoutMs?: number; label?: string } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms${options.label ? ` waiting for ${options.label}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 断言 Promise 以指定的 SshError code 拒绝，返回该错误（避免每个用例重复样板） */
export async function expectReject(
  promise: Promise<unknown>,
  code: string
): Promise<{ code: string; message: string; ipc: string; hint?: string; details: Record<string, unknown> }> {
  try {
    await promise
  } catch (error) {
    const value = error as {
      code?: string
      message?: string
      ipc?: string
      hint?: string
      details?: Record<string, unknown>
    }
    if (value.code !== code) {
      throw new Error(`expected rejection code "${code}" but got "${value.code}" (${value.message})`)
    }
    return {
      code: value.code ?? '',
      message: value.message ?? '',
      ipc: value.ipc ?? '',
      hint: value.hint,
      details: value.details ?? {}
    }
  }
  throw new Error(`expected promise to reject with "${code}" but it resolved`)
}
