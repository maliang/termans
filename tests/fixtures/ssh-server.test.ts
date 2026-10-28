import { createHash } from 'node:crypto'
import { Client, Server, utils } from 'ssh2'
import type { ClientChannel, ConnectConfig, ParsedKey } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIXTURE_HOST_KEY,
  FIXTURE_HOST_KEY_FINGERPRINT,
  makeValidEd25519KeyPair,
  startSshFixture,
  type SshFixture
} from './ssh-server'

/**
 * 进程内 SSH 夹具自检。
 *
 * 这里**只测夹具本身**（能不能起、能不能连、指纹算得对不对、关得掉不掉），
 * 不测 Termans 的 SSH 引擎 —— 引擎的断言归 t8。写这层的理由：
 * t8 一旦连不上，必须能立刻区分「引擎的 bug」还是「夹具的 bug」，
 * 否则每次红都要人工判断十分钟。
 */

const fixtures: SshFixture[] = []

async function fixture(options?: Parameters<typeof startSshFixture>[0]): Promise<SshFixture> {
  const started = await startSshFixture(options)
  fixtures.push(started)
  return started
}

afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.stop()
})

function baseConfig(target: SshFixture, overrides: Partial<ConnectConfig> = {}): ConnectConfig {
  return {
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    readyTimeout: 5_000,
    ...overrides
  }
}

function connect(config: ConnectConfig): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client()
    // error 监听必须是**常驻**的：夹具 stop() 会强制断开还活着的 socket，
    // 只挂 once('error') 的话，握手成功后这条 RST 会变成 unhandled 'error' 直接冒到进程上。
    client.on('error', reject)
    client.once('ready', () => resolve(client))
    client.connect(config)
  })
}

async function connectError(config: ConnectConfig): Promise<Error> {
  try {
    const client = await connect(config)
    client.end()
    throw new Error('期望连接失败，但握手成功了')
  } catch (error) {
    return error as Error
  }
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
}

function exec(client: Client, command: string): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error)
      const channel = stream as ClientChannel
      let stdout = ''
      let stderr = ''
      let code: number | null = null
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      channel.on('exit', (exitCode: number | null) => {
        code = exitCode
      })
      channel.on('close', () => resolve({ stdout, stderr, code }))
    })
  })
}

function shell(client: Client): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (error, stream) => {
      if (error) reject(error)
      else resolve(stream as ClientChannel)
    })
  })
}

/** 等通道输出里出现某段文本（或通道关闭），超时即失败并带上已收到的内容 */
function waitForOutput(channel: ClientChannel, needle: string, timeoutMs = 5_000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`等待 ${JSON.stringify(needle)} 超时，已收到：${JSON.stringify(buffer)}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (buffer.includes(needle)) {
        cleanup()
        resolve(buffer)
      }
    }
    const onClose = (): void => {
      cleanup()
      reject(new Error(`通道提前关闭，已收到：${JSON.stringify(buffer)}`))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      channel.off('data', onData)
      channel.off('close', onClose)
    }
    channel.on('data', onData)
    channel.on('close', onClose)
  })
}

describe('SSH 夹具：认证', () => {
  it('密码认证可用，exec 通道回显命令输出', async () => {
    const target = await fixture()
    const client = await connect(baseConfig(target))

    try {
      const result = await exec(client, 'echo hi')
      expect(result.stdout).toBe('hi\n')
      expect(result.code).toBe(0)
      // 夹具把「客户端到底发了什么」记下来，t8 可以直接断言
      expect(target.execs).toHaveLength(1)
      expect(target.execs[0]?.command).toBe('echo hi')
    } finally {
      client.end()
    }

    const accepted = target.authAttempts.filter((attempt) => attempt.accepted)
    expect(accepted.map((attempt) => attempt.method)).toContain('password')
  })

  it('publickey 认证可用（用夹具自带的测试密钥对）', async () => {
    const target = await fixture()
    const client = await connect(
      baseConfig(target, { password: undefined, privateKey: target.clientKey.privateKey })
    )

    try {
      const result = await exec(client, 'whoami')
      expect(result.stdout).toBe(`${target.username}\n`)
    } finally {
      client.end()
    }

    const accepted = target.authAttempts.filter((attempt) => attempt.accepted)
    // publickey 是两段式：先发不带签名的探测请求（夹具回 PK_OK），再发带签名的正式请求，
    // 所以「accepted」会出现两次；断言的是「只走 publickey、没走密码」
    expect(new Set(accepted.map((attempt) => attempt.method))).toEqual(new Set(['publickey']))
    expect(accepted.length).toBeGreaterThan(0)
  })

  it('密码错误被拒，并记录原因', async () => {
    const target = await fixture()
    const error = await connectError(baseConfig(target, { password: 'wrong-password' }))
    expect(error.message).toMatch(/authentication methods failed/i)
    expect(target.authAttempts.some((attempt) => attempt.reason === 'bad-password')).toBe(true)
    expect(target.authAttempts.some((attempt) => attempt.accepted)).toBe(false)
  })

  it('未授权公钥被拒', async () => {
    const target = await fixture()
    // 不能直接用 utils.generateKeyPairSync('ed25519')：ssh2 1.17 约 1/256 会产出 malformed 密钥
    // （公钥首字节 0x00 被当 mpint 符号位吞掉 → blob 50 字节而非 51），会让本用例偶发假红。
    // 用自校验重掷版（详见 ssh-server.ts 里 makeValidEd25519KeyPair 的注释）。
    const stranger = makeValidEd25519KeyPair()
    const error = await connectError(
      baseConfig(target, { password: undefined, privateKey: stranger.privateKey })
    )
    expect(error.message).toMatch(/authentication methods failed/i)
    expect(target.authAttempts.some((attempt) => attempt.reason === 'unauthorized-key')).toBe(true)
  })

  it('用户名不对直接拒绝（不给「密码错」的机会）', async () => {
    const target = await fixture()
    const error = await connectError(baseConfig(target, { username: 'nobody' }))
    expect(error.message).toMatch(/authentication methods failed/i)
    expect(target.authAttempts.some((attempt) => attempt.reason === 'unknown-user')).toBe(true)
  })
})

describe('SSH 夹具：shell 通道', () => {
  it('echo hi 回 hi，exit 关通道', async () => {
    const target = await fixture()
    const client = await connect(baseConfig(target))

    try {
      const channel = await shell(client)
      const closed = new Promise<number | null>((resolve) => {
        channel.on('close', () => resolve(0))
      })
      channel.write('echo hi\r')
      const output = await waitForOutput(channel, 'hi\r\n')
      expect(output).toContain('hi\r\n')
      // 回车是 \r、输出是 \r\n：终端语义（xterm 需要 \r 复位列）
      expect(output).not.toContain('hi\n\n')

      channel.write('exit\r')
      await expect(closed).resolves.toBe(0)
    } finally {
      client.end()
    }

    expect(target.shellLines).toEqual(['echo hi', 'exit'])
  })

  it('命令不存在回 127 并给出 shell 风格报错', async () => {
    const target = await fixture()
    const client = await connect(baseConfig(target))
    try {
      const channel = await shell(client)
      channel.write('definitely-not-a-command\r')
      const output = await waitForOutput(channel, 'command not found')
      expect(output).toContain('bash: definitely-not-a-command: command not found\r\n')
    } finally {
      client.end()
    }
  })
})

describe('SSH 夹具：host key', () => {
  it('指纹与 ssh-keygen 口径一致（对线格式公钥 blob 求 SHA256）', async () => {
    const target = await fixture()

    // 独立算一遍：从 host 公钥重新解析 → 取线格式 blob → SHA256
    const parsed = utils.parseKey(target.hostPublicKey)
    if (parsed instanceof Error) throw parsed
    const expected = `SHA256:${createHash('sha256')
      .update(parsed.getPublicSSH())
      .digest('base64')
      .replace(/=+$/, '')}`
    expect(target.hostKeyFingerprint).toBe(expected)
    expect(target.hostKeyFingerprint.startsWith('SHA256:')).toBe(true)
  })

  it('hostVerifier 能看到同一个指纹；指纹不符时握手失败', async () => {
    const target = await fixture()
    const seen: string[] = []

    const client = await connect(
      baseConfig(target, {
        hostVerifier: (key: Buffer) => {
          seen.push(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`)
          return true
        }
      })
    )
    client.end()
    expect(seen).toEqual([target.hostKeyFingerprint])

    // 期望值写错 = 中间人：必须在握手阶段就断开
    const error = await connectError(
      baseConfig(target, {
        hostVerifier: (key: Buffer) =>
          `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === 'SHA256:wrong',
        password: target.password
      })
    )
    expect(error.message).toMatch(/Host denied/i)
  })

  it('host key 写死：两个独立夹具（= 两次进程/两次运行）指纹完全相同', async () => {
    const first = await fixture()
    const second = await fixture()
    expect(first.hostKey).toBe(FIXTURE_HOST_KEY)
    expect(first.hostKeyFingerprint).toBe(FIXTURE_HOST_KEY_FINGERPRINT)
    expect(second.hostKeyFingerprint).toBe(first.hostKeyFingerprint)
    // 公钥从私钥派生（不是占位符），known_hosts 里能直接粘
    expect(first.hostPublicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/)
    expect(second.hostPublicKey).toBe(first.hostPublicKey)
  })

  it('传入别的 hostKey 时指纹随之改变（造「主机密钥变了」的中间人场景）', async () => {
    const pinned = await fixture()
    // 这里必须是一把**新**钥匙（语义就是「主机换了密钥」），不能用 FIXTURE_HOST_KEY 钉死版；
    // 但也不能裸用 utils.generateKeyPairSync('ed25519')——ssh2 1.17 约 1/256 产出 malformed 密钥，
    // 会让本用例偶发假红。用自校验重掷版（根因见 ssh-server.ts 的 makeValidEd25519KeyPair 注释）。
    const stranger = makeValidEd25519KeyPair()
    const impostor = await fixture({ hostKey: stranger.privateKey })
    expect(impostor.hostKeyFingerprint).not.toBe(pinned.hostKeyFingerprint)
    expect(impostor.hostPublicKey).toBe(stranger.publicKey.trim())
  })
})

describe('SSH 夹具：ed25519 密钥生成自校验（ssh2 1.17 malformed 缺陷的防线）', () => {
  it('makeValidEd25519KeyPair 连续 200 把全部可解析、blob 51 字节、Server 吃得住，且两两不同', () => {
    const seen = new Set<string>()
    for (let index = 0; index < 200; index += 1) {
      const pair = makeValidEd25519KeyPair()

      // 1) ssh2 自己必须能解析（未校验的原始生成有约 1/256 在这步就报 Malformed OpenSSH private key）
      const privateParsed = utils.parseKey(pair.privateKey)
      expect(privateParsed instanceof Error).toBe(false)
      expect(utils.parseKey(pair.publicKey) instanceof Error).toBe(false)

      // 2) 公钥线格式必须正好 51 字节（坏样本 50：公钥首字节 0x00 被当 mpint 符号位吞掉）
      const blob = (privateParsed as ParsedKey).getPublicSSH()
      expect(blob.length).toBe(51)

      // 3) 缺陷的真实爆点是构造 Server 时的 hostKeys 解析，这里必须不抛
      expect(() => new Server({ hostKeys: [pair.privateKey] }, () => undefined)).not.toThrow()

      // 4) 指纹与公钥自洽
      expect(pair.fingerprintSha256).toBe(
        `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
      )

      // 5) 保留随机性：别为了「稳」改成返回同一把 key（「密钥变了」用例就失效了）
      expect(seen.has(pair.privateKey)).toBe(false)
      seen.add(pair.privateKey)
    }
    expect(seen.size).toBe(200)
  })
})

describe('SSH 夹具：生命周期', () => {
  it('每个夹具端口 0 分配、互不冲突；stop 后端口不再接受连接', async () => {
    const a = await fixture()
    const b = await fixture()
    expect(a.port).toBeGreaterThan(0)
    expect(a.port).not.toBe(b.port)

    await a.stop()
    await a.stop() // 幂等

    const error = await connectError(baseConfig(a))
    expect(error.message).toMatch(/ECONNREFUSED|connect/i)

    // b 不受影响
    const client = await connect(baseConfig(b))
    client.end()
  })
})
