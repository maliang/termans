import { createHash, createHmac, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { KnownHostEntry, KnownHostRemoveRequest, KnownHostTrustRequest, KnownHostsPolicy } from '@shared'
import { knownHostEntrySchema } from '@shared'
import { JsonStore } from '../store/json-store'
import { SshError } from './errors'

/**
 * known_hosts：指纹计算 + 主机密钥校验 + 存储网关。
 *
 * 边界（重要，别把这一层做成第二个存储实现）：
 * - 本文件只定义 **`KnownHostsGateway` 接口** + 一个明文 JSON 的默认实现（引擎自足可跑、可测）；
 * - `src/main/known-hosts/` 属于 vault-sync（加密包 + Git 同步），它会提供同一接口的实现替换掉默认实现；
 * - 因此这里**不注册** `known-hosts:*` IPC 通道（那是 vault-sync 的命名空间），只有 `ssh:*` 归引擎。
 *
 * ⚠️ 安全警告（读代码请先看这段）：
 * 本文件里的 `JsonKnownHostsGateway` 是**明文 JSON** 默认实现——落盘内容是
 * `{host, port, keyType, fingerprintSha256}`，即「内网 IP + 端口 + 主机密钥指纹」的明文清单。
 * 它**仅供测试与降级使用**；生产接线必须由 vault 侧的**加密实现**替换（实现同一 `KnownHostsGateway`
 * 接口即可无缝替换），否则磁盘上 grep 得到内网拓扑，与本项目「仓库/磁盘上不出现 IP」的姿态冲突。
 *
 * 指纹格式与 `ssh-keygen -lf` 完全一致：`SHA256:` + base64(sha256(公钥blob)) 去掉尾部 `=`。
 * 公钥 blob 是 SSH 线格式（含类型前缀），不是 base64 解码后的裸密钥——这是最容易搞错的一处。
 */

export const KNOWN_HOSTS_SCHEMA_VERSION = 1

/** SSH 线格式：uint32 长度 + 类型字符串 + 密钥数据 */
export function keyTypeFromPublicKeyBlob(key: Buffer): string {
  if (key.length < 4) return 'unknown'
  const length = key.readUInt32BE(0)
  if (length <= 0 || 4 + length > key.length) return 'unknown'
  return key.subarray(4, 4 + length).toString('ascii')
}

export function fingerprintSha256FromKey(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/** `ssh-keygen -lf` 风格的短指纹（用于状态栏/日志，不含 SHA256: 前缀） */
export function shortFingerprint(fingerprintSha256: string): string {
  return fingerprintSha256.replace(/^SHA256:/, '')
}

/** 非 22 端口按 OpenSSH 习惯写成 `[host]:port` */
export function formatKnownHostHost(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/**
 * 主机名匹配：支持 OpenSSH 的三种写法
 * - 精确：`example.com`
 * - 带端口：`[example.com]:2222`
 * - 通配：`*.example.com`、`10.0.0.?`
 * 以及 hashed 形式 `|1|<salt-base64>|<hmac-sha1-base64>`。
 */
export function matchesHostPattern(pattern: string, host: string, port: number): boolean {
  if (pattern.startsWith('|1|')) return matchesHashedHost(pattern, host, port)

  const candidates = pattern.split(',')
  const wantPortSuffix = port === 22 ? null : `:${port}`
  const target = `${host}${wantPortSuffix ?? ''}`
  for (const raw of candidates) {
    if (raw === target) return true
    // `[host]:port` 形式：pattern 里有端口时必须端口匹配
    if (raw.startsWith('[')) {
      const close = raw.lastIndexOf(']')
      if (close < 0) continue
      const innerHost = raw.slice(1, close)
      const innerPort = raw.slice(close + 1).replace(/^:/, '')
      if (innerPort !== '' && Number(innerPort) !== port) continue
      if (wildcardMatch(innerHost, host)) return true
      continue
    }
    if (raw.includes(':') && !raw.startsWith('[')) continue
    // 裸主机名模式只比较主机名：端口在老实现里由 KnownHostEntry.port 精确判定
    // （JSON 里 port 是独立字段，比字符串模式更不容易出错）。需要端口语义时写 `[host]:port`。
    if (wildcardMatch(raw, host)) return true
  }
  return false
}

function wildcardMatch(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern.toLowerCase() === value.toLowerCase()
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

function matchesHashedHost(pattern: string, host: string, port: number): boolean {
  const parts = pattern.split('|')
  // ['', '1', salt, hash]
  if (parts.length !== 4) return false
  const salt = Buffer.from(parts[2], 'base64')
  const expected = parts[3]
  const candidates = [`${host}${port === 22 ? '' : `:${port}`}`, host]
  for (const candidate of candidates) {
    const digest = createHmac('sha1', salt).update(candidate).digest('base64')
    if (digest === expected) return true
  }
  return false
}

/** 用于生成 hashed 条目（导入/写入时可选，默认写明文，便于用户在设置页看到主机） */
export function hashKnownHostHost(host: string, port: number, salt = Buffer.from(randomUUID().replace(/-/g, ''), 'hex')): string {
  const name = `${host}${port === 22 ? '' : `:${port}`}`
  const digest = createHmac('sha1', salt).update(name).digest('base64')
  return `|1|${salt.toString('base64')}|${digest}`
}

export interface ParsedKnownHostsLine {
  /** 一行可能覆盖多个主机名（逗号分隔） */
  patterns: string[]
  hashed: boolean
  keyType: string
  key: Buffer
  fingerprintSha256: string
}

/**
 * 解析 OpenSSH known_hosts 的一行。
 * 用途：vault-sync 做「导入已有 known_hosts」时不必再写一遍 HMAC/指纹逻辑。
 */
export function parseKnownHostsLine(line: string): ParsedKnownHostsLine | null {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null
  const match = /^(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(trimmed)
  if (!match) return null
  const [, hostField, keyType, keyB64] = match
  const key = Buffer.from(keyB64, 'base64')
  if (key.length === 0) return null
  return {
    patterns: hostField.split(','),
    hashed: hostField.startsWith('|1|'),
    keyType,
    key,
    fingerprintSha256: fingerprintSha256FromKey(key)
  }
}

/* -------------------------------------------------------------------------- */
/* 网关接口 —— vault-sync 的加密实现替换掉这里的默认 JSON 实现                   */
/* -------------------------------------------------------------------------- */

export interface KnownHostsGateway {
  list(): KnownHostEntry[] | Promise<KnownHostEntry[]>
  find(host: string, port: number): KnownHostEntry[] | Promise<KnownHostEntry[]>
  trust(request: KnownHostTrustRequest): KnownHostEntry | Promise<KnownHostEntry>
  /** 返回是否真的删掉了东西（UI 需要区分「删了」和「本来就没有」） */
  remove(request: KnownHostRemoveRequest): boolean | Promise<boolean>
}

export interface HostKeyObservation {
  host: string
  port: number
  keyType: string
  fingerprintSha256: string
}

export interface HostKeyVerdict {
  status: 'trusted' | 'unknown' | 'mismatch'
  /** trusted 时是命中的那条已信任记录；mismatch 时是**旧的**记录（用于展示旧指纹） */
  entry: KnownHostEntry | null
}

/**
 * 判定「这台机器的这个公钥是否已被信任」。
 *
 * 关键安全语义：只有 (host, port, keyType) 三者都相同才算「同一条记录」；
 * 同类型不同指纹 = mismatch（必须硬失败，绝不静默覆盖）；
 * 记录里只有别的类型（例如旧的 ssh-rsa、服务器现在给 ssh-ed25519）= unknown（走首次确认流程）。
 * 这与 OpenSSH 的 known_hosts 行为一致，也让「服务器换掉密钥类型」不会误报中间人。
 */
export async function verifyHostKey(
  gateway: KnownHostsGateway,
  observation: HostKeyObservation
): Promise<HostKeyVerdict> {
  const entries = await gateway.find(observation.host, observation.port)
  const sameType = entries.filter((entry) => entry.keyType === observation.keyType)
  const matched = sameType.find((entry) => entry.fingerprintSha256 === observation.fingerprintSha256)
  if (matched) return { status: 'trusted', entry: matched }
  if (sameType.length > 0) return { status: 'mismatch', entry: sameType[0] }
  return { status: 'unknown', entry: null }
}

/* -------------------------------------------------------------------------- */
/* 默认实现：明文 JSON（单机可用；加密/同步由 vault-sync 接管）                   */
/* -------------------------------------------------------------------------- */

interface KnownHostsFile {
  schemaVersion: typeof KNOWN_HOSTS_SCHEMA_VERSION
  entries: KnownHostEntry[]
}

export interface JsonKnownHostsOptions {
  /** userData 目录 */
  dir: string
  fileName?: string
  now?: () => Date
}

/**
 * 明文 JSON 的默认实现（⚠️ 仅供测试与降级，生产接线必须由 vault 加密实现替换，见文件头警告）。
 *
 * 存在的理由：引擎要能脱离 vault 独立跑起来（单测、以及 vault 还没解锁时的降级路径）。
 * 一旦 vault 接线完成，`createSshEngine` 会把 `knownHosts` 换成加密实现，这个类只留在测试里。
 */
export class JsonKnownHostsGateway implements KnownHostsGateway {
  private readonly store: JsonStore<KnownHostsFile>
  private readonly now: () => Date

  constructor(options: JsonKnownHostsOptions) {
    this.now = options.now ?? (() => new Date())
    this.store = new JsonStore<KnownHostsFile>({
      dir: options.dir,
      fileName: options.fileName ?? 'known_hosts.json',
      defaults: () => ({ schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, entries: [] }),
      normalize: (raw, fallback) => {
        if (!raw || typeof raw !== 'object') return fallback
        const entries = (raw as { entries?: unknown }).entries
        if (!Array.isArray(entries)) return fallback
        const valid = entries.flatMap((entry) => {
          const parsed = knownHostEntrySchema.safeParse(entry)
          return parsed.success ? [parsed.data] : []
        })
        return { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, entries: valid }
      }
    })
  }

  get filePath(): string {
    return this.store.filePath
  }

  list(): KnownHostEntry[] {
    return [...this.store.read().entries]
  }

  find(host: string, port: number): KnownHostEntry[] {
    return this.store
      .read()
      .entries.filter(
        (entry) => entry.port === port && matchesHostPattern(entry.host, host, port)
      )
  }

  trust(request: KnownHostTrustRequest): KnownHostEntry {
    // 用容器而不是裸 let：赋值发生在 update 闭包里，TS 的控制流分析看不到
    const holder: { entry: KnownHostEntry | null } = { entry: null }
    this.store.update((current) => {
      const entries = [...current.entries]
      const existingIndex = entries.findIndex(
        (entry) =>
          entry.port === request.port &&
          entry.keyType === request.keyType &&
          matchesHostPattern(entry.host, request.host, request.port)
      )
      const existing = existingIndex >= 0 ? entries[existingIndex] : null
      if (existing && existing.fingerprintSha256 === request.fingerprintSha256) {
        // 幂等：重复确认同一指纹不产生重复记录，也不刷新 addedAt（时间是「首次信任」的证据）
        holder.entry = existing
        return current
      }
      if (existing && !request.replaceExisting) {
        throw new SshError(
          'host-key-mismatch',
          `Host key for ${request.host}:${request.port} is already trusted with a different fingerprint`,
          {
            details: {
              host: request.host,
              port: request.port,
              keyType: request.keyType,
              previousFingerprintSha256: existing.fingerprintSha256,
              fingerprintSha256: request.fingerprintSha256
            }
          }
        )
      }
      const entry: KnownHostEntry = {
        id: existing?.id ?? randomUUID(),
        host: request.host,
        port: request.port,
        keyType: request.keyType,
        fingerprintSha256: request.fingerprintSha256,
        hashed: false,
        addedAt: this.now().toISOString(),
        sourceFile: null
      }
      if (existingIndex >= 0) entries[existingIndex] = entry
      else entries.push(entry)
      holder.entry = entry
      return { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, entries }
    })
    if (holder.entry === null) throw new SshError('unknown', 'known_hosts write did not persist the entry')
    return holder.entry
  }

  remove(request: KnownHostRemoveRequest): boolean {
    let removed = false
    this.store.update((current) => {
      const entries = current.entries.filter((entry) => {
        const hit = entry.port === request.port && matchesHostPattern(entry.host, request.host, request.port)
        if (hit) removed = true
        return !hit
      })
      return removed ? { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, entries } : current
    })
    return removed
  }

  /** 仅供测试/迁移：整体替换 */
  replaceAll(entries: KnownHostEntry[]): void {
    this.store.write({ schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, entries })
  }
}

/** 内存实现：测试与「不落盘」的临时信任场景 */
export class MemoryKnownHostsGateway implements KnownHostsGateway {
  private entries: KnownHostEntry[]

  constructor(initial: KnownHostEntry[] = []) {
    this.entries = [...initial]
  }

  list(): KnownHostEntry[] {
    return [...this.entries]
  }

  find(host: string, port: number): KnownHostEntry[] {
    return this.entries.filter((entry) => entry.port === port && matchesHostPattern(entry.host, host, port))
  }

  trust(request: KnownHostTrustRequest): KnownHostEntry {
    const existing = this.entries.find(
      (entry) =>
        entry.port === request.port &&
        entry.keyType === request.keyType &&
        matchesHostPattern(entry.host, request.host, request.port)
    )
    if (existing && existing.fingerprintSha256 === request.fingerprintSha256) return existing
    if (existing && !request.replaceExisting) {
      throw new SshError('host-key-mismatch', 'Host key already trusted with a different fingerprint', {
        details: {
          previousFingerprintSha256: existing.fingerprintSha256,
          fingerprintSha256: request.fingerprintSha256
        }
      })
    }
    const entry: KnownHostEntry = {
      id: existing?.id ?? randomUUID(),
      host: request.host,
      port: request.port,
      keyType: request.keyType,
      fingerprintSha256: request.fingerprintSha256,
      hashed: false,
      addedAt: new Date().toISOString(),
      sourceFile: null
    }
    this.entries = existing
      ? this.entries.map((item) => (item === existing ? entry : item))
      : [...this.entries, entry]
    return entry
  }

  remove(request: KnownHostRemoveRequest): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter(
      (entry) => !(entry.port === request.port && matchesHostPattern(entry.host, request.host, request.port))
    )
    return this.entries.length !== before
  }
}

/**
 * 策略 → 是否需要用户确认。
 * strict：未知必须问（否则默认设置下永远连不上新主机），已信任不问；
 * ask：连已信任也再问一次（共享屏幕/高安全场景）；
 * accept-new：未知静默记录（TOFU）。三种策略下 mismatch 都硬失败。
 */
export function needsUserConfirmation(policy: KnownHostsPolicy, verdict: HostKeyVerdict['status']): boolean {
  if (verdict === 'mismatch') return true
  if (verdict === 'trusted') return policy === 'ask'
  return policy !== 'accept-new'
}

/** 便于集成方拼路径：known_hosts 默认落在 userData 根目录 */
export function defaultKnownHostsFile(userDataDir: string): string {
  return join(userDataDir, 'known_hosts.json')
}
