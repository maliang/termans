import { BaseAgent, type IdentityCallback, type ParsedKey } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshError } from '../errors'
import type { SshSession } from '../session'
import { FakeSshServer, startSilentTcpServer } from './helpers/fake-server'
import { FIXTURE_CLIENT_KEY, FIXTURE_CLIENT_PUBLIC, validateKeyPair } from './helpers/keys'
import {
  createHarness,
  createOpenSshKey,
  createPemKey,
  dataText,
  delay,
  expectReject,
  waitFor,
  type Harness
} from './helpers/harness'

/**
 * 连接 / 认证 / PTY / exec 的主路径与失败路径。
 *
 * 断言原则：每条都能被「把实现改错」打破。
 * - 生命周期断言看**事件序列**（漏发/错序都会红）；
 * - PTY 断言看**服务器端记录**（term/cols/rows 传错就红）；
 * - 认证失败看**错误码 + IPC 码**（映射错就红）；
 * - 背压断言看**每帧大小**（整块塞进 IPC 就红）。
 */

const harnesses: Harness[] = []
const servers: FakeSshServer[] = []

function harness(options: Parameters<typeof createHarness>[0]): Harness {
  const value = createHarness(options)
  harnesses.push(value)
  return value
}

async function server(options: ConstructorParameters<typeof FakeSshServer>[0] = {}): Promise<FakeSshServer> {
  const value = await new FakeSshServer(options).start()
  servers.push(value)
  return value
}

afterEach(async () => {
  while (harnesses.length > 0) harnesses.pop()?.dispose()
  while (servers.length > 0) await servers.pop()?.stop()
})

/** 取会话：终态会话会被 manager 摘除，测试里用这个 helper 把「不存在」当成硬错误 */
function sessionOf(h: Harness, sessionId: string): SshSession {
  const session = h.manager.getSession(sessionId)
  if (!session) throw new Error(`session ${sessionId} is missing`)
  return session
}

/** 取唯一 shell 流（假服务器上一个会话只有一条） */
function firstShell(fake: FakeSshServer) {
  const stream = fake.shellStreams[0]
  if (!stream) throw new Error('no shell stream')
  return stream
}

describe('SshSession 连接与认证', () => {
  it('密码认证：生命周期事件按 connecting→host-key-verification→authenticating→connected 顺序推送', async () => {
    const fake = await server({ shellBanner: 'banner\r\n' })
    const h = harness({ server: fake })

    const result = await h.connect({ size: { cols: 132, rows: 43 } })

    expect(result.sessionId).toBeTruthy()
    expect(result.hostKeyDecision).toBe('accepted-now')
    // 指纹格式 = OpenSSH 的 SHA256 base64（32 字节 → 43 个 base64 字符，无填充）
    expect(result.hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)

    expect(h.events.states.map((state) => state.phase)).toEqual([
      'connecting',
      'host-key-verification',
      'authenticating',
      'connected'
    ])

    // 服务器端真实收到的 PTY 请求
    expect(fake.records.ptys).toHaveLength(1)
    expect(fake.records.ptys[0]).toMatchObject({ term: 'xterm-256color', cols: 132, rows: 43 })
    expect(fake.records.shells).toBe(1)
  })

  it('PTY：stdin 经 chunks 到达远端，stdout 与 stderr 都回流成 ssh:data', async () => {
    const fake = await server({ shellBanner: 'banner\r\n', shellStderr: 'ERR-LINE\r\n' })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()
    const session = sessionOf(h, sessionId)

    await waitFor(() => dataText(h.events).includes('banner'), { label: 'shell banner' })
    expect(dataText(h.events)).toContain('ERR-LINE')

    session.write('echo hello\n')
    await waitFor(() => dataText(h.events).includes('echo hello'), { label: 'PTY echo' })
  })

  it('resize：本地尺寸变化会以 setWindow(rows, cols) 发到远端（顺序颠倒即失败）', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect({ size: { cols: 100, rows: 30 } })
    const session = sessionOf(h, sessionId)

    session.resize({ cols: 120, rows: 40 })
    await waitFor(() => fake.records.windowChanges.length > 0, { label: 'window-change' })

    expect(fake.records.windowChanges[0]).toMatchObject({ cols: 120, rows: 40 })
  })

  it('exec：stdout / stderr 分离，exit code 透传', async () => {
    const fake = await server({
      shellBanner: '',
      execOutput: (command) =>
        command === 'whoami'
          ? { stdout: 'tester\n', stderr: 'warn: deprecated\n', code: 0 }
          : { stdout: '', stderr: `unknown command: ${command}\n`, code: 127 }
    })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()
    const session = sessionOf(h, sessionId)

    const ok = await session.exec('whoami')
    expect(ok.stdout).toBe('tester\n')
    expect(ok.stderr).toBe('warn: deprecated\n')
    expect(ok.code).toBe(0)
    expect(ok.truncated).toBe(false)
    expect(fake.records.execCommands).toEqual(['whoami'])

    const bad = await session.exec('nope')
    expect(bad.code).toBe(127)
    expect(bad.stderr).toContain('unknown command: nope')
  })

  it('exec：输出超过 maxBytes 时截断并显式标记 truncated（不静默丢数据）', async () => {
    const fake = await server({
      shellBanner: '',
      execOutput: () => ({ stdout: 'a'.repeat(4096), stderr: '', code: 0 })
    })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()
    const session = sessionOf(h, sessionId)

    const result = await session.exec('cat big.log', { maxBytes: 1024 })
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBe(1024)
  })

  it('错误密码：归一化成 auth-failed / E_SSH，并把会话标为 error', async () => {
    const fake = await server()
    const h = harness({ server: fake, password: 'wrong-password' })

    const error = await expectReject(h.connect(), 'auth-failed')
    expect(error.ipc).toBe('E_SSH')
    expect(error.message).toMatch(/authentication methods failed/i)
    expect(h.events.states.at(-1)?.phase).toBe('error')
  })

  it('连接超时：对端只接受 TCP 不说话时在 connectTimeoutMs 内以 timeout 结束', async () => {
    const silent = await startSilentTcpServer()
    try {
      const h = harness({ server: { host: '127.0.0.1', port: silent.port }, settings: { connectTimeoutMs: 250 } })
      const startedAt = Date.now()
      const error = await expectReject(h.connect(), 'timeout')
      const elapsed = Date.now() - startedAt
      expect(error.ipc).toBe('E_NETWORK')
      expect(error.details.timeoutMs).toBe(250)
      // 必须是我们自己的 deadline 生效，而不是等系统 TCP 超时（几十秒）
      expect(elapsed).toBeGreaterThanOrEqual(200)
      expect(elapsed).toBeLessThan(3_000)
    } finally {
      await silent.close()
    }
  })

  it('keyboard-interactive：非回显提示用已存密码作答（空字符串会认证失败）', async () => {
    const fake = await server({
      keyboardInteractive: { prompts: [{ prompt: 'Password: ', echo: false }], expected: ['secret'] }
    })
    const h = harness({ server: fake, authMethod: 'keyboard-interactive' })

    const result = await h.connect()
    expect(result.hostKeyFingerprint).toBeTruthy()
    expect(fake.records.keyboardResponses).toEqual([['secret']])
  })

  it('publickey（OpenSSH 格式私钥）认证成功', async () => {
    const fake = await server()
    const key = createOpenSshKey()
    try {
      const h = harness({ server: fake, authMethod: 'publickey', privateKeyPath: key.privateKeyPath, credentialRef: null })
      await h.connect()
      expect(fake.records.authAttempts.map((attempt) => attempt.method)).toContain('publickey')
    } finally {
      key.cleanup()
    }
  })

  it('publickey（PEM/PKCS#1 格式私钥）认证成功', async () => {
    const fake = await server()
    const key = createPemKey()
    try {
      const h = harness({ server: fake, authMethod: 'publickey', privateKeyPath: key.privateKeyPath, credentialRef: null })
      await h.connect()
      expect(fake.records.authAttempts.map((attempt) => attempt.method)).toContain('publickey')
    } finally {
      key.cleanup()
    }
  })

  it('加密 PEM 私钥：passphrase 来自 credentialRef 时能连上', async () => {
    const fake = await server()
    const key = createPemKey({ encrypted: true, passphrase: 'key-passphrase' })
    try {
      const h = harness({
        server: fake,
        authMethod: 'publickey',
        privateKeyPath: key.privateKeyPath,
        password: 'key-passphrase'
      })
      await h.connect()
    } finally {
      key.cleanup()
    }
  })

  it('私钥文件不存在：key-missing（含本地路径提示），不是笼统的认证失败', async () => {
    const fake = await server()
    const h = harness({
      server: fake,
      authMethod: 'publickey',
      privateKeyPath: '/nonexistent/termans/id_ed25519',
      credentialRef: null
    })
    const error = await expectReject(h.connect(), 'key-missing')
    expect(error.ipc).toBe('E_SSH')
    expect(String(error.details.path)).toBe('/nonexistent/termans/id_ed25519')
    expect(error.message).toMatch(/private key/i)
  })

  it('agent 认证：注入的 BaseAgent 提供身份并签名', async () => {
    const fake = await server()
    const agentKey = createAgentKeyInTest()
    const h = harness({ server: fake, authMethod: 'agent', credentialRef: null })
    h.deps.createAgent = () => new FakeAgent(agentKey)

    await h.connect()
    expect(fake.records.authAttempts.map((attempt) => attempt.method)).toContain('publickey')
  })

  it('agent 不可用：没有 SSH_AUTH_SOCK 时给 agent-unavailable（而非静默重试密码）', async () => {
    const fake = await server()
    const h = harness({ server: fake, authMethod: 'agent', credentialRef: null })
    h.deps.env = {} // 显式清空，避免开发机上的 SSH_AUTH_SOCK 影响结果
    h.deps.createAgent = () => null

    const error = await expectReject(h.connect(), 'agent-unavailable')
    expect(error.ipc).toBe('E_SSH')
  })

  it('并发的 5 条会话互相隔离（各自独立 sessionId 与输出）', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })

    const sessions = await Promise.all([0, 1, 2, 3, 4].map(() => h.connect()))
    const ids = new Set(sessions.map((session) => session.sessionId))
    expect(ids.size).toBe(5)
    expect(h.manager.listSessions().sessions).toHaveLength(5)

    const target = sessionOf(h, sessions[2].sessionId)
    target.write('only-in-third\n')
    await waitFor(() => dataText(h.events).includes('only-in-third'), { label: 'echo from third session' })

    // 唯一性：这条输出只应该出现一次（其它会话若串了会重复）
    const occurrences = dataText(h.events).split('only-in-third').length - 1
    expect(occurrences).toBe(1)
  })

  it('reuseExisting 复用已连上的同主机会话，否则新建', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })

    const first = await h.connect()
    const reused = await h.connect({ reuseExisting: true })
    expect(reused.sessionId).toBe(first.sessionId)

    const separate = await h.connect({ reuseExisting: false })
    expect(separate.sessionId).not.toBe(first.sessionId)
    expect(h.manager.listSessions().sessions).toHaveLength(2)
  })

  it('未知 sessionId：write/resize 给 session-not-found（E_NOT_FOUND），不是静默丢弃', () => {
    const fake = new FakeSshServer({})
    const h = harness({ server: fake })
    for (const action of [() => h.manager.write('nope', 'x'), () => h.manager.resize('nope', { cols: 10, rows: 10 })]) {
      try {
        action()
        throw new Error('expected throw')
      } catch (error) {
        const sshError = error as SshError
        expect(sshError.code).toBe('session-not-found')
        expect(sshError.toIpcError().code).toBe('E_NOT_FOUND')
      }
    }
  })

  it('用户主动断开：closed reason=user，且会话从列表移除', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()

    await h.manager.disconnect(sessionId)
    const closed = h.events.closed.at(-1)
    expect(closed).toMatchObject({ sessionId, reason: 'user' })
    expect(h.manager.listSessions().sessions).toHaveLength(0)
    // 幂等：重复断开不抛
    await expect(h.manager.disconnect(sessionId)).resolves.toBeUndefined()
  })

  it('远端 shell 退出：closed reason=exit 且带 exit code', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()

    fake.exitShell(7)
    await waitFor(() => h.events.closed.length > 0, { label: 'closed event' })

    expect(h.events.closed.at(-1)).toMatchObject({ sessionId, reason: 'exit', exitCode: 7 })
    // 终态会话会从 manager 摘除（listSessions 只返回活着的会话）
    expect(h.manager.getSession(sessionId)).toBeUndefined()
    expect(h.events.states.at(-1)?.phase).toBe('closed')
  })

  it('流式输出：每帧不超过 8KB，且总量与远端写入一致（不允许整块塞 IPC）', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()
    expect(sessionOf(h, sessionId).isReady).toBe(true)

    const payload = 'x'.repeat(200_000)
    firstShell(fake).write(Buffer.from(payload))

    await waitFor(() => dataText(h.events).length >= payload.length, { label: '200KB of output', timeoutMs: 10_000 })

    expect(h.events.data.length).toBeGreaterThan(10)
    for (const event of h.events.data) {
      expect(Buffer.byteLength(event.data, 'utf8')).toBeLessThanOrEqual(8192)
    }
    expect(dataText(h.events).length).toBe(payload.length)
  })

  it('流式解码：跨帧切断的 4 字节 emoji 不会变成 U+FFFD', async () => {
    const fake = await server({ shellBanner: '' })
    const h = harness({ server: fake })
    const { sessionId } = await h.connect()
    expect(sessionOf(h, sessionId).isReady).toBe(true)

    const emoji = Buffer.from('😀', 'utf8')
    expect(emoji.length).toBe(4)
    const stream = firstShell(fake)
    stream.write(emoji.subarray(0, 2))
    // 让它成为两个独立的 channel data 帧（StringDecoder 必须在帧边界上兜住半个字符）
    await delay(30)
    stream.write(emoji.subarray(2))
    stream.write(Buffer.from('done', 'utf8'))

    await waitFor(() => dataText(h.events).includes('done'), { label: 'multibyte output' })
    expect(dataText(h.events)).toContain('😀')
    expect(dataText(h.events)).not.toContain('\uFFFD')
  })
})

/* ----------------------------------------------------------------- 夹具 */

interface AgentKey {
  parsed: ParsedKey
}

/** ssh2 的 ParsedKey 自带 sign()：OpenSSH 格式私钥 node crypto 读不了，只有它能签 */
function createAgentKeyInTest(): AgentKey {
  // 用钉死的密钥：generateKeyPairSync 在 ssh2 1.17 上约 1/256 会产出 parseKey 解析不了的坏私钥
  return { parsed: validateKeyPair({ private: FIXTURE_CLIENT_KEY, public: FIXTURE_CLIENT_PUBLIC }).parsed }
}

class FakeAgent extends BaseAgent<ParsedKey> {
  constructor(private readonly key: AgentKey) {
    super()
  }

  getIdentities(cb: IdentityCallback<ParsedKey>): void {
    cb(undefined, [this.key.parsed])
  }

  sign(pubKey: ParsedKey, data: Buffer, optionsOrCb: unknown, maybeCb?: unknown): void {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as
      | ((error?: Error | null, signature?: Buffer) => void)
      | undefined
    void pubKey
    cb?.(undefined, this.key.parsed.sign(data))
  }
}
