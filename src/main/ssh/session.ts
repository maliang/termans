import type { Readable } from 'node:stream'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type {
  HostKeyChallenge,
  HostKeyDecision,
  SshClosedEvent,
  SshSession as SshSessionInfo,
  SshStateEvent,
  SshPhase,
  TerminalSize
} from '@shared'
import { buildAuthConfig, type KeyboardPrompt } from './auth'
import { DEFAULT_BACKOFF, computeBackoffDelay, type BackoffPolicy } from './backoff'
import { SshError, asSshError, normalizeSshError } from './errors'
import { fingerprintSha256FromKey, keyTypeFromPublicKeyBlob, needsUserConfirmation, verifyHostKey } from './known-hosts'
import { OutputPacer } from './pacer'
import { runCommand, type ExecOptions, type ExecResult } from './exec'
import {
  endpointKey,
  jumpEndpoint,
  openJumpTunnel,
  targetEndpoint,
  withJumpContext,
  type SshEndpoint
} from './jump'
import { SftpClient } from './sftp'
import { createConsoleLogger, createRedactingLogger } from './redact'
import { credentialSecrets, type SshCredential, type SshEngineDeps, type SshTarget } from './types'

/**
 * 一条 SSH 终端会话（一个 sessionId = 一条连接 = 一个页签的主通道）。
 *
 * 生命周期（与 shared 的 sshPhase 一一对应）：
 *   idle → connecting → [host-key-verification] → authenticating → connected
 *        → reconnecting* → connected
 *        → closed / error
 *
 * 两个关键设计：
 * 1. **两阶段校验主机密钥**。先用一条「只拿到 host key 就掐断」的探测连接做校验/等用户确认，
 *    再在真正认证的连接里用 `hostVerifier` 断言指纹与探测到的一致。
 *    少这一步的话，用户确认的是 A 指纹、实际认证用的是 B 密钥（中间人在两次连接之间换掉），
 *    而且没人会发现——这是 SSH 客户端最经典的 TOFU 漏洞。
 * 2. **输出整形与背压**在 pacer 里（切片 ≤8KB + 流式 UTF-8 + 高水位 pause 通道），
 *    绝不把 ssh2 的一大块 Buffer 直接塞进 `webContents.send`。
 */

/** TERM：xterm-256color 是 xterm.js 的能力上限，也是远端 vim/htop 配色的前提 */
export const TERMINAL_TYPE = 'xterm-256color'

/** keepalive 连续无响应次数上限（ssh2 默认 3；超过即判定链路死亡） */
const KEEPALIVE_COUNT_MAX = 3

export interface SshSessionOptions {
  sessionId: string
  target: SshTarget
  /**
   * 单层跳板机（已由 manager 解析并校验过层级/同一台机器）。
   * null = 直连；直连路径必须与加跳板前**完全一致**（不套 socket、不改时序）。
   */
  jump?: SshTarget | null
  size: TerminalSize
  /** 一次性启动命令（覆盖主机设置），连上后写入 shell */
  startupCommand: string | null
  deps: SshEngineDeps
  /** 询问用户是否信任该主机密钥（由 manager 实现：发事件 + 等 answerHostKey） */
  requestHostKeyDecision(challenge: HostKeyChallenge): Promise<HostKeyDecision>
  /** 会话进入终态（exit/error/disconnected/user）时通知 manager 从列表里摘掉 */
  onClosed?(sessionId: string, reason: SshClosedEvent['reason']): void
}

interface ProbeResult {
  key: Buffer
  keyType: string
  fingerprintSha256: string
}

export class SshSession {
  readonly sessionId: string
  readonly target: SshTarget

  phase: SshPhase = 'idle'
  lastError: string | null = null
  openedAt: string | null = null
  hostKeyFingerprint: string | null = null
  hostKeyDecision: 'trusted' | 'accepted-now' | 'not-verified' = 'not-verified'

  private readonly deps: SshEngineDeps
  private readonly options: SshSessionOptions
  private readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void
  private readonly secrets: string[] = []

  private client: Client | null = null
  private channel: ClientChannel | null = null
  /** 跳板机的 SSH 连接（与目标机连接同生共死，见 teardownTransport） */
  private jumpClient: Client | null = null
  private pacer: OutputPacer | null = null
  private sftpClient: SftpClient | null = null

  private size: TerminalSize
  private exitCode: number | null = null
  private exitSignal: string | null = null

  private closedByUser = false
  private disposed = false
  private closingTransport = false
  private reconnectLoopActive = false
  private closedEmitted = false
  private cancelSleep: (() => void) | null = null
  /** 本次会话内用户选择「只信任这一次、不写 known_hosts」的指纹；按端点（host:port）分开记 */
  private readonly sessionTrust = new Map<string, string>()
  /** 探测阶段之外的 MITM 证据（探测指纹 ≠ 认证阶段指纹） */
  private mismatchDetected: { expected: string; actual: string; keyType: string } | null = null

  constructor(options: SshSessionOptions) {
    this.options = options
    this.sessionId = options.sessionId
    this.target = options.target
    this.deps = options.deps
    this.size = options.size
    const base = options.deps.log ?? createConsoleLogger()
    this.log = createRedactingLogger(base, () => this.secrets)
  }

  /* ---------------------------------------------------------------- 对外 API */

  /** 建立连接（含指纹校验）。失败时已 setPhase('error') 并抛出 SshError */
  async open(): Promise<void> {
    try {
      await this.establish()
    } catch (error) {
      const sshError = asSshError(error)
      this.lastError = sshError.message
      this.teardownTransport()
      this.setPhase('error', sshError.message)
      this.log('error', `connect failed: ${sshError.message}`, { code: sshError.code })
      throw sshError
    }
  }

  toInfo(): SshSessionInfo {
    return {
      sessionId: this.sessionId,
      hostId: this.target.hostId,
      hostLabel: this.target.label,
      phase: this.phase,
      openedAt: this.openedAt,
      lastError: this.lastError
    }
  }

  get isReady(): boolean {
    return this.phase === 'connected' && this.channel !== null && this.client !== null
  }

  get isReconnecting(): boolean {
    return this.reconnectLoopActive
  }

  write(data: string): void {
    if (!this.channel || !this.isReady) {
      throw new SshError('closed', `Session ${this.sessionId} is not connected (phase=${this.phase})`, {
        details: { sessionId: this.sessionId, phase: this.phase }
      })
    }
    this.channel.write(data)
  }

  /** 本地终端尺寸变化 → 远端 PTY。重连成功后会用最后保存的尺寸重放一次 */
  resize(size: TerminalSize): void {
    this.size = size
    if (this.channel) {
      // ssh2 API 是 setWindow(rows, cols, height, width)，与直觉的 cols/rows 顺序相反
      this.channel.setWindow(size.rows, size.cols, 0, 0)
      return
    }
    if (this.phase !== 'connecting' && this.phase !== 'authenticating' && this.phase !== 'reconnecting') {
      throw new SshError('closed', `Session ${this.sessionId} is not connected (phase=${this.phase})`, {
        details: { sessionId: this.sessionId, phase: this.phase }
      })
    }
    // 连接中：新尺寸会在开 shell 时用上
  }

  /** 在已认证连接上跑一次性命令（AI / 一键操作复用） */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const client = this.client
    if (!client || !this.isReady) {
      throw new SshError('closed', `Session ${this.sessionId} is not connected`, {
        details: { sessionId: this.sessionId, phase: this.phase }
      })
    }
    return runCommand(client, command, { timers: this.deps.timers, ...options })
  }

  /** 懒开 SFTP 子系统；连接断开后缓存自动失效 */
  async sftp(): Promise<SftpClient> {
    if (this.sftpClient) return this.sftpClient
    const client = this.client
    if (!client || !this.isReady) {
      throw new SshError('closed', `Session ${this.sessionId} is not connected`, {
        details: { sessionId: this.sessionId }
      })
    }
    const opened = await SftpClient.open(client)
    this.sftpClient = opened
    return opened
  }

  /** 用户主动断开（不再重连）。closed 事件在 disconnect 里发出 */
  async close(): Promise<void> {
    if (this.closedByUser) return
    this.closedByUser = true
    this.cancelSleep?.()
    this.teardownTransport()
    this.setPhase('closed', null)
    this.emitClosed('user', this.exitCode, this.exitSignal)
  }

  dispose(): void {
    this.disposed = true
    this.cancelSleep?.()
    this.teardownTransport()
  }

  /* ------------------------------------------------------------- 建立连接 */

  private async establish(): Promise<void> {
    this.closedEmitted = false
    this.mismatchDetected = null
    this.exitCode = null
    this.exitSignal = null

    const settings = this.deps.getSettings()
    const connectTimeoutMs = settings.connectTimeoutMs
    const jump = this.options.jump ?? null

    // 直连时 message 为 null（与加跳板前逐字节一致）；走跳板时告诉 UI 现在卡在哪一跳
    this.setPhase('connecting', jump ? `via jump host "${jump.label}" (${jump.hostname}:${jump.port})` : null)

    // 1) 跳板机：自己的 host key 先过硬校验，再认证——不校验等于把地基交给中间人
    if (jump) await this.openJumpClient(jump, connectTimeoutMs)

    // 2) 目标机：探测与正式连接都从跳板机的 direct-tcpip 通道走；直连时 sock 为 null
    const targetRef = targetEndpoint(this.target)
    const probe = await this.probeHostKey(targetRef, connectTimeoutMs, await this.openStream(jump, connectTimeoutMs))
    this.hostKeyFingerprint = probe.fingerprintSha256
    const decision = await this.applyHostKeyPolicy(targetRef, probe)
    this.hostKeyDecision = decision

    this.setPhase('authenticating', null)
    const credential = await this.loadCredentialFor(this.target)
    const client = await this.connectClient(
      targetRef,
      this.target,
      probe,
      credential,
      connectTimeoutMs,
      await this.openStream(jump, connectTimeoutMs)
    )
    this.client = client
    this.attachLifecycle(client)

    await this.openShell(client)
    this.openedAt = new Date(this.now()).toISOString()
    this.lastError = null
    this.setPhase('connected', null)
  }

  /**
   * 建立跳板机连接：探测 host key（严格策略）→ 校验 → 用自己的凭据认证。
   * 任何一步失败都要点名「这是跳板机」——否则用户会去改目标机的密码/私钥。
   */
  private async openJumpClient(jump: SshTarget, timeoutMs: number): Promise<void> {
    const endpoint = jumpEndpoint(jump)
    this.log('info', `connecting to jump host ${jump.hostname}:${jump.port}`, {
      label: jump.label,
      username: jump.username,
      authMethod: jump.authMethod
    })
    try {
      const probe = await this.probeHostKey(endpoint, timeoutMs, null)
      await this.applyHostKeyPolicy(endpoint, probe)
      const credential = await this.loadCredentialFor(jump)
      this.jumpClient = await this.connectClient(endpoint, jump, probe, credential, timeoutMs, null)
    } catch (error) {
      throw withJumpContext(error, jump)
    }
  }

  /** 在跳板机上开一条直通目标机 sshd 的 TCP 通道；直连返回 null（不建 socket，时序不变） */
  private async openStream(jump: SshTarget | null, timeoutMs: number): Promise<ClientChannel | null> {
    if (!jump) return null
    const jumpClient = this.jumpClient
    if (!jumpClient) {
      throw new SshError('jump-failed', `Jump host "${jump.label}" is not connected`, {
        details: { jumpHostId: jump.hostId, jumpLabel: jump.label }
      })
    }
    return openJumpTunnel(jumpClient, jump, this.target, { timeoutMs, after: (ms, fn) => this.after(ms, fn) })
  }

  /**
   * 只验证 host key 的探测连接：拿到密钥就销毁 socket，不做认证。
   * 这样「未知主机」的确认对话框不会顺带泄露任何凭据。
   */
  private probeHostKey(endpoint: SshEndpoint, timeoutMs: number, sock: Readable | null): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve, reject) => {
      const client = new Client()
      let settled = false
      let cancelDeadline: (() => void) | null = null

      const closeSock = (): void => {
        // 探测用掉的那条隧道必须关掉，否则跳板机上挂着一条没人读的 direct-tcpip 通道
        try {
          ;(sock as ClientChannel | null)?.close()
        } catch {
          /* 已关闭 */
        }
      }
      const cleanup = (): void => {
        cancelDeadline?.()
        cancelDeadline = null
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        client.destroy()
        closeSock()
        reject(
          error instanceof SshError
            ? error
            : normalizeSshError(error, { host: endpoint.hostname, port: endpoint.port, phase: 'connecting' })
        )
      }

      client.on('error', fail)
      client.on('close', () => {
        // 探测连接被我们自己掐断是正常路径（此时 settled 已为 true）
        fail(new SshError('closed', 'Connection closed during host key probe'))
      })

      cancelDeadline = this.after(timeoutMs, () => {
        fail(
          new SshError(
            'timeout',
            `Timed out after ${timeoutMs}ms waiting for host key from ${endpoint.role} ${endpoint.hostname}:${endpoint.port}`,
            {
              details: { host: endpoint.hostname, port: endpoint.port, timeoutMs, endpointRole: endpoint.role }
            }
          )
        )
      })

      client.connect({
        host: endpoint.hostname,
        port: endpoint.port,
        username: endpoint.username,
        ...(sock ? { sock } : {}),
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
          if (settled) {
            verify(false)
            return
          }
          settled = true
          cleanup()
          const result: ProbeResult = {
            key: Buffer.from(key),
            keyType: keyTypeFromPublicKeyBlob(key),
            fingerprintSha256: fingerprintSha256FromKey(key)
          }
          // 拒绝这次认证并销毁连接：我们只要 host key
          verify(false)
          client.destroy()
          closeSock()
          resolve(result)
        }
      })
    })
  }

  /**
   * 主机密钥策略。返回本次连接最终认定的信任状态（写进 SshConnectResult）。
   *
   * - mismatch：硬失败（E_HOST_KEY_UNVERIFIED），details 同时带旧/新指纹；
   * - accept-new：未知主机静默写入 known_hosts（TOFU），不再打扰用户；
   * - strict/ask：未知（strict 下还有 trusted）走用户确认；
   * - 用户选「只信任一次」：记在本会话里，重连不再问，但不落盘。
   */
  private async applyHostKeyPolicy(
    endpoint: SshEndpoint,
    probe: ProbeResult
  ): Promise<'trusted' | 'accepted-now' | 'not-verified'> {
    const settings = this.deps.getSettings()
    const observation = {
      host: endpoint.hostname,
      port: endpoint.port,
      keyType: probe.keyType,
      fingerprintSha256: probe.fingerprintSha256
    }

    if (this.sessionTrust.get(endpointKey(endpoint)) === probe.fingerprintSha256) return 'accepted-now'

    const verdict = await verifyHostKey(this.deps.knownHosts, observation)

    const isMismatch = verdict.status === 'mismatch'

    if (isMismatch) {
      const previous = verdict.entry?.fingerprintSha256 ?? null
      this.log('error', 'host key mismatch', {
        host: observation.host,
        port: observation.port,
        keyType: observation.keyType,
        previousFingerprintSha256: previous,
        fingerprintSha256: observation.fingerprintSha256
      })
      throw new SshError(
        'host-key-mismatch',
        `Host key for ${endpoint.role} ${observation.host}:${observation.port} changed (${verdict.entry?.keyType ?? observation.keyType})`,
        {
          details: {
            host: observation.host,
            port: observation.port,
            keyType: observation.keyType,
            previousFingerprintSha256: previous,
            fingerprintSha256: observation.fingerprintSha256,
            reason: 'mismatch'
          }
        }
      )
    }

    if (!needsUserConfirmation(settings.knownHostsPolicy, verdict.status)) {
      if (verdict.status === 'unknown') {
        // accept-new：首次见到即记录（用户已在设置里明确接受 TOFU）
        await this.deps.knownHosts.trust({
          host: observation.host,
          port: observation.port,
          keyType: observation.keyType,
          fingerprintSha256: observation.fingerprintSha256,
          replaceExisting: false
        })
        return 'accepted-now'
      }
      return 'trusted'
    }

    this.setPhase('host-key-verification', `Waiting for host key confirmation (${probe.fingerprintSha256})`)
    const answer = await this.options.requestHostKeyDecision({
      sessionId: this.sessionId,
      host: observation.host,
      port: observation.port,
      keyType: observation.keyType,
      fingerprintSha256: observation.fingerprintSha256,
      previousFingerprintSha256: verdict.entry?.fingerprintSha256 ?? null,
      reason: isMismatch ? 'mismatch' : 'unknown'
    })

    if (answer.decision !== 'accept') {
      throw new SshError('host-key-unverified', `Host key for ${endpoint.role} ${observation.host}:${observation.port} was rejected by the user`, {
        details: {
          host: observation.host,
          port: observation.port,
          keyType: observation.keyType,
          fingerprintSha256: observation.fingerprintSha256,
          reason: 'rejected'
        }
      })
    }

    if (answer.remember) {
      await this.deps.knownHosts.trust({
        host: observation.host,
        port: observation.port,
        keyType: observation.keyType,
        fingerprintSha256: observation.fingerprintSha256,
        replaceExisting: isMismatch
      })
    } else {
      this.sessionTrust.set(endpointKey(endpoint), probe.fingerprintSha256)
    }
    return 'accepted-now'
  }

  /** 解析某个端点的凭据（目标机与跳板机各有自己的 credentialRef） */
  private async loadCredentialFor(target: SshTarget): Promise<SshCredential | null> {
    const ref = target.credentialRef
    if (!ref) return null
    const secret = await this.deps.resolveSecret(ref)
    if (secret === null) {
      this.log('warn', 'credentialRef not resolvable (vault locked?)', { credentialRef: ref, host: target.label })
      return null
    }
    this.secrets.push(secret)
    // 同一个 credentialRef 既可能是密码也可能是私钥 passphrase，取决于 authMethod
    return { password: secret, passphrase: secret }
  }

  /**
   * 真正的认证连接。`hostVerifier` 断言「这次握手拿到的密钥就是刚刚探测/确认过的那把」，
   * 不一致即判定 MITM：宁可断开也不降级。
   */
  private connectClient(
    endpoint: SshEndpoint,
    target: SshTarget,
    probe: ProbeResult,
    credential: SshCredential | null,
    timeoutMs: number,
    sock: Readable | null
  ): Promise<Client> {
    return new Promise<Client>((resolve, reject) => {
      const client = new Client()
      let settled = false
      let cancelDeadline: (() => void) | null = null

      const closeSock = (): void => {
        try {
          ;(sock as ClientChannel | null)?.close()
        } catch {
          /* 已关闭 */
        }
      }

      const auth = buildAuthConfig({ target, credential, deps: this.deps })
      this.secrets.push(...auth.secrets)
      if (auth.privateKeyPath) this.log('debug', 'using private key', { path: auth.privateKeyPath })

      const config: ConnectConfig = {
        ...auth.config,
        readyTimeout: timeoutMs,
        // 走跳板时用跳板机上的 direct-tcpip 通道作为传输层；直连保持原样（不传 sock）
        ...(sock ? { sock } : {}),
        // keepalive：0 = 关闭（主机设置里显式关掉，或设置段为 0）
        keepaliveInterval: target.keepaliveSeconds > 0 ? target.keepaliveSeconds * 1000 : 0,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void): void => {
          const actual = fingerprintSha256FromKey(key)
          if (actual === probe.fingerprintSha256) {
            verify(true)
            return
          }
          this.mismatchDetected = {
            expected: probe.fingerprintSha256,
            actual,
            keyType: keyTypeFromPublicKeyBlob(key)
          }
          verify(false)
        }
      }

      if (auth.keyboardAnswers) {
        const answers = auth.keyboardAnswers
        client.on(
          'keyboard-interactive',
          (
            _name: string,
            _instructions: string,
            _lang: string,
            prompts: { prompt: string; echo?: boolean }[],
            finish: (responses: string[]) => void
          ): void => {
            const normalized: KeyboardPrompt[] = prompts.map((prompt) => ({
              prompt: prompt.prompt,
              echo: prompt.echo === true
            }))
            this.log('debug', 'keyboard-interactive prompts', { count: normalized.length })
            finish(answers(normalized))
          }
        )
      }

      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cancelDeadline?.()
        cancelDeadline = null
        client.removeAllListeners()
        client.on('error', () => {})
        client.destroy()
        closeSock()
        if (this.mismatchDetected) {
          reject(
            new SshError('host-key-mismatch', 'Host key changed between verification and authentication (possible MITM)', {
              details: {
                host: endpoint.hostname,
                port: endpoint.port,
                keyType: this.mismatchDetected.keyType,
                previousFingerprintSha256: this.mismatchDetected.expected,
                fingerprintSha256: this.mismatchDetected.actual
              }
            })
          )
          return
        }
        reject(
          error instanceof SshError
            ? error
            : normalizeSshError(error, { host: endpoint.hostname, port: endpoint.port, phase: 'authenticating' })
        )
      }

      client.on('ready', () => {
        if (settled) return
        settled = true
        cancelDeadline?.()
        cancelDeadline = null
        resolve(client)
      })
      client.on('error', fail)
      client.on('close', () => fail(new SshError('network', 'Connection closed during SSH handshake')))

      cancelDeadline = this.after(timeoutMs, () => {
        fail(
          new SshError(
            'timeout',
            `Timed out after ${timeoutMs}ms connecting to ${endpoint.role} ${endpoint.hostname}:${endpoint.port}`,
            { details: { host: endpoint.hostname, port: endpoint.port, timeoutMs, endpointRole: endpoint.role } }
          )
        )
      })

      this.log('info', `connecting to ${endpoint.hostname}:${endpoint.port}`, {
        endpoint: endpoint.role,
        username: target.username,
        authMethod: target.authMethod,
        via: sock ? 'jump' : 'direct'
      })
      client.connect(config)
    })
  }

  private openShell(client: Client): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pty = {
        term: TERMINAL_TYPE,
        cols: this.size.cols,
        rows: this.size.rows,
        width: 0,
        height: 0
      }
      client.shell(pty, { env: this.target.env }, (error, channel) => {
        if (error) {
          reject(
            new SshError('pty-failed', `Cannot open PTY shell: ${error.message}`, {
              cause: error,
              details: { host: this.target.hostname, port: this.target.port, term: TERMINAL_TYPE }
            })
          )
          return
        }
        this.attachShell(client, channel)
        resolve()
      })
    })
  }

  private attachShell(client: Client, channel: ClientChannel): void {
    this.channel = channel
    const pacer = new OutputPacer({
      onData: (data) => this.deps.emit('ssh:data', { sessionId: this.sessionId, data }),
      onPause: () => channel.pause(),
      onResume: () => channel.resume()
    })
    this.pacer = pacer

    channel.on('data', (chunk: Buffer) => pacer.push(chunk))
    // 注意：ssh2 的 stderr 不是 channel 事件，而是 channel 上的可读流（SSH_MSG_CHANNEL_EXTENDED_DATA）。
    // 写成 channel.on('stderr') 永远收不到数据——这是实测踩到的坑。
    // PTY 会话里远端通常把 stderr 合并进 stdout；若服务器仍单独发扩展数据，同样转发给终端。
    channel.stderr?.on('data', (chunk: Buffer) => pacer.push(chunk))
    channel.on('exit', (code: number | null, signal: string | null) => {
      this.exitCode = code ?? null
      this.exitSignal = signal ?? null
    })
    channel.on('close', () => this.handleShellClose())
    channel.on('error', (error: Error) => {
      this.lastError = error.message
      this.log('warn', 'shell channel error', { message: error.message })
    })

    const startup = this.options.startupCommand ?? this.target.startupCommand
    if (startup && startup.trim().length > 0) {
      channel.write(`${startup}\n`)
    }
    void client
  }

  /** 连接级事件：socket 关闭 / 传输错误 → 判定是否重连 */
  private attachLifecycle(client: Client): void {
    client.on('error', (error: Error) => {
      this.lastError = error.message
      const normalized = normalizeSshError(error, {
        host: this.target.hostname,
        port: this.target.port,
        phase: this.phase
      })
      this.log('warn', 'transport error', { code: normalized.code, message: normalized.message })
      this.handleTransportClose()
    })
    client.on('close', () => this.handleTransportClose())
    // 'end' 只表示对端不再发送；真正清理在 close
    client.on('end', () => {
      this.log('debug', 'transport end')
    })
  }

  /* --------------------------------------------------------------- 断开处理 */

  private handleShellClose(): void {
    if (this.disposed || this.closedByUser || this.closingTransport) return
    // exit-status 已到达 = 远端 shell 自己退出（用户敲了 exit、或 disown 后 shell 结束）
    if (this.exitCode !== null || this.exitSignal !== null) {
      this.log('info', 'remote shell exited', { code: this.exitCode, signal: this.exitSignal })
      this.pacer?.end()
      this.pacer = null
      this.channel = null
      this.setPhase('closed', null)
      this.emitClosed('exit', this.exitCode, this.exitSignal)
      this.teardownTransport()
      return
    }
    this.handleTransportClose()
  }

  private handleTransportClose(): void {
    if (this.disposed || this.closedByUser || this.closingTransport || this.reconnectLoopActive) return
    this.log('info', 'transport closed', { phase: this.phase })
    this.pacer?.end()
    this.pacer = null
    this.channel = null
    this.sftpClient = null
    this.closingTransport = true
    void this.scheduleReconnect()
  }

  /**
   * 自动重连：指数退避 + 次数上限 + 可取消。
   * 重连成功后**重放 resize**（用户可能在断开期间改过窗口大小，随后又改回来了），
   * 并通过 state 事件的 message 告知 UI「已重连、尺寸已重放」。
   */
  private async scheduleReconnect(): Promise<void> {
    const settings = this.deps.getSettings()
    const policy: BackoffPolicy = {
      ...DEFAULT_BACKOFF,
      ...(this.deps.reconnect ?? {}),
      maxAttempts: settings.autoReconnectAttempts
    }

    if (policy.maxAttempts <= 0) {
      this.closingTransport = false
      this.setPhase('closed', null)
      this.emitClosed('disconnected', null, null)
      this.teardownTransport()
      return
    }

    this.reconnectLoopActive = true
    let lastError: SshError | null = null

    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      if (this.closedByUser || this.disposed) {
        this.reconnectLoopActive = false
        return
      }
      this.teardownTransport()
      const delay = computeBackoffDelay(attempt, policy, this.deps.random)
      this.setPhase('reconnecting', `reconnect ${attempt}/${policy.maxAttempts} in ${delay}ms`)
      const cancelled = await this.sleep(delay)
      if (cancelled || this.closedByUser || this.disposed) {
        this.reconnectLoopActive = false
        return
      }
      try {
        await this.establish()
        this.reconnectLoopActive = false
        this.closingTransport = false
        const replayed = this.size
        this.channel?.setWindow(replayed.rows, replayed.cols, 0, 0)
        this.setPhase('connected', `reconnected (attempt ${attempt}); terminal size replayed ${replayed.cols}x${replayed.rows}`)
        this.log('info', 'reconnected', { attempt, cols: replayed.cols, rows: replayed.rows })
        return
      } catch (error) {
        const sshError = asSshError(error)
        lastError = sshError
        this.lastError = sshError.message
        this.log('warn', 'reconnect attempt failed', { attempt, code: sshError.code })
        // 主机密钥变了：绝不重试，也绝不自动信任
        if (sshError.code === 'host-key-mismatch' || sshError.code === 'host-key-unverified') {
          this.reconnectLoopActive = false
          this.closingTransport = false
          this.setPhase('error', sshError.message)
          this.emitClosed('error', null, null)
          this.teardownTransport()
          return
        }
      }
    }

    this.reconnectLoopActive = false
    this.closingTransport = false
    this.lastError = lastError?.message ?? 'reconnect failed'
    this.setPhase('error', this.lastError)
    this.emitClosed('error', null, null)
    this.teardownTransport()
  }

  /* ----------------------------------------------------------------- 工具 */

  private after(ms: number, fn: () => void): () => void {
    if (this.deps.timers) return this.deps.timers.after(ms, fn)
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  }

  /** 可取消的等待：用户点「断开」时立刻返回，不等退避时间走完 */
  private sleep(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (cancelled: boolean): void => {
        if (settled) return
        settled = true
        this.cancelSleep = null
        resolve(cancelled)
      }
      const cancelTimer = this.after(ms, () => finish(false))
      this.cancelSleep = () => {
        cancelTimer()
        finish(true)
      }
    })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private setPhase(phase: SshPhase, message: string | null): void {
    this.phase = phase
    const payload: SshStateEvent = { sessionId: this.sessionId, phase, message }
    this.deps.emit('ssh:state-changed', payload)
  }

  private emitClosed(reason: SshClosedEvent['reason'], exitCode: number | null, signal: string | null): void {
    if (this.closedEmitted) return
    this.closedEmitted = true
    this.deps.emit('ssh:closed', { sessionId: this.sessionId, exitCode, signal, reason })
    this.options.onClosed?.(this.sessionId, reason)
  }

  /* ------------------------------------------------------- 凭据副本的生命周期 */

  /** 缓存里还有几条明文凭据副本（诊断/测试用；只返回条数，不返回内容） */
  get cachedSecretCount(): number {
    return this.secrets.length
  }

  /**
   * 清掉内存里的凭据副本（vault 上锁时由 `SshManager.releaseCredentials()` 调用）。
   *
   * 只清**缓存**，不动连接：已建立的通道用的是 ssh2 内部协商出的会话密钥，
   * 与这里缓存的明文口令/口令短语无关；用户可能正跑长任务，锁屏就断线不可接受
   * （产品口径见 docs/VAULT-SYNC.md §4「上锁不终止已建立的 SSH 会话」）。
   *
   * 注意 JS 字符串是不可变的，这里只能丢弃引用，无法像 Buffer 那样 zeroize；
   * 真正保证「不残留」的手段是：凭据只在连接期持有、不写日志、不落盘。
   */
  clearCachedSecrets(): void {
    this.secrets.length = 0
  }

  private teardownTransport(): void {
    const channel = this.channel
    const client = this.client
    const jumpClient = this.jumpClient
    this.channel = null
    this.client = null
    this.jumpClient = null
    this.pacer?.dispose()
    this.pacer = null
    this.sftpClient?.close()
    this.sftpClient = null
    if (channel) {
      try {
        channel.close()
      } catch {
        /* 已关闭 */
      }
    }
    if (client) {
      try {
        client.removeAllListeners()
        // removeAllListeners 之后底层 socket 的 ECONNRESET 会因为没有 'error' 监听者
        // 变成 unhandled 'error'（Node 直接抛异常）。收尾阶段必须挂一个空监听器吃掉它。
        client.on('error', () => {})
        client.end()
        client.destroy()
      } catch {
        /* 已关闭 */
      }
    }
    // 目标机连接关闭后，跳板机连接必须立刻跟着关：否则跳板机上留着一条 sshd 会话
    // （用户看到「已断开」，sshd 上却还有一条 ll 进程），重连几次就在跳板机上堆几条。
    if (jumpClient) {
      try {
        jumpClient.removeAllListeners()
        jumpClient.on('error', () => {})
        jumpClient.end()
        jumpClient.destroy()
      } catch {
        /* 已关闭 */
      }
    }
    // 收尾即丢弃明文凭据副本：close / error / 远端 exit / 重连前 都要经过这里，
    // 所以「会话生命周期结束后内存里不再有用户口令」不依赖调用方记得清。
    // 重连路径会在下一次 connectClient 之前重新 resolveSecret 并重新入缓存。
    this.clearCachedSecrets()
  }
}

export { credentialSecrets }
