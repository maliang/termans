import { createHash } from 'node:crypto'
import { Server, utils } from 'ssh2'
import type { Connection, ParsedKey, ServerChannel } from 'ssh2'

/**
 * e2e 专用 SSH 服务（**标准 ssh2 `Server`，走 `server.listen()`**）。
 *
 * 为什么这里不直接用 `tests/fixtures/ssh-server.ts`：
 * 那个夹具为了捕获原始 socket 自建了 `net.Server` + `injectSocket`，在 Electron 里连上约 1s 会被对端 FIN
 * （已由队长建 t18 交给 engine 定性，夹具文件归 engine 改）。e2e 需要一条**稳定不抖**的链路来验证产品行为，
 * 所以这里退回到最朴素的用法：`new Server({ hostKeys }, handler).listen(0, '127.0.0.1')`。
 * 两者**故意不共享代码**：t18 修夹具时不该连带改 e2e 的服务器，否则「谁把谁弄红了」说不清。
 *
 * 只实现验收需要的最小行为：
 * - 密码认证（固定测试账号）与 publickey 认证（固定测试密钥）；
 * - 固定 host key（写死在同一份文件里，known_hosts 用例才能对着**跨运行稳定**的指纹断言）；
 * - shell：回显（`echo hi\r` → `hi\r\n`），`exit` 关通道；
 * - exec：`echo/cat/whoami/pwd/uname` 的最小实现，供「命令执行」类用例使用。
 *
 * 端口一律 `listen(0)` 让系统分配：本机 2222 可能被占，写死端口会让用例变成「看运气」。
 */

/** 固定 host key（ed25519，仅测试用）。每次启动都生成会指纹漂移，known_hosts 断言就没意义了。 */
const HOST_KEY_SEED = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACBYbwLrysHu/8EVp94iqgJ+tLt+hNWRmOwB0MLdYP5pKgAA
AIgCSUAwAklAMAAAAAtzc2gtZWQyNTUxOQAAACBYbwLrysHu/8EVp94iqgJ+tLt+
hNWRmOwB0MLdYP5pKgAAAEDJ9jfp9bbSBqrkybtGaYVeBdYEpfXhrDlcVM0e3YPI
mlhvAuvKwe7/wRWn3iKqAn60u36E1ZGY7AHQwt1g/mkqAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`

export const E2E_SSH_HOST_KEY = HOST_KEY_SEED
export const E2E_SSH_HOST_KEY_FINGERPRINT = 'SHA256:JFBdXZUT972M8J3vCxY7vjCbanHm8qQYb7UI28O4dLk'

export const E2E_SSH_USERNAME = 'termans'
export const E2E_SSH_PASSWORD = 'termans-test'

export interface E2eSshServer {
  host: '127.0.0.1'
  port: number
  username: string
  password: string
  /** `SHA256:<base64>`（去尾部 `=`），与 `ssh-keygen -lf` 一致 */
  hostKeyFingerprint: string
  /** publickey 认证用的密钥对（私钥 OpenSSH 格式，可设进主机库的 IdentityFile 场景由用例自己写盘） */
  clientKey: { privateKey: string; publicKey: string }
  /** 认证尝试流水（断言「密码错/公钥不在白名单」用） */
  /** 认证尝试流水；publickey 额外带 `keyFingerprint`（`SHA256:…`），排查「客户端拿的是哪把 key」 */
  authAttempts: { method: string; username: string; accepted: boolean; keyFingerprint?: string }[]
  /** shell 里收到的原始行（断言命令确实到了服务端） */
  shellLines: string[]
  /** exec 请求记录 */
  execs: { command: string; exitCode: number }[]
  stop(): Promise<void>
}

/**
 * publickey 认证用的客户端密钥对（**写死**，仅测试用）。
 *
 * 一开始这里用 `utils.generateKeyPairSync('ed25519')` 现生成，但在 Playwright 的 TS 运行环境里
 * 它返回的 `private` 是 `undefined`（`parseKey: Key data must be a Buffer or string`，8/8 次复现），
 * 而同一句在 `node -e` 与 vitest 里完全正常——属运行时差异，不该让用例为它抖。
 * 写死一把可解析的 ed25519 既躲开这个坑，也让 publickey 用例的期望值稳定可断言。
 */
const CLIENT_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACDqja73H8JmynGfRfB9TbfMCPVS6al6FbulvgCsyu40AQAA
AIjl8QX/5fEF/wAAAAtzc2gtZWQyNTUxOQAAACDqja73H8JmynGfRfB9TbfMCPVS
6al6FbulvgCsyu40AQAAAEAERn75tEUC5MHXKxf6zTYJICXbi1XiQJxqap9FijZw
AeqNrvcfwmbKcZ9F8H1Nt8wI9VLpqXoVu6W+AKzK7jQBAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`

const CLIENT_PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOqNrvcfwmbKcZ9F8H1Nt8wI9VLpqXoVu6W+AKzK7jQB'

/** 校验写死的公钥能解析且 blob 是 51 字节（不是每次现生成，所以只校验一次） */
export function makeClientKeyPair(): { privateKey: string; publicKey: string } {
  const parsed = utils.parseKey(CLIENT_PRIVATE_KEY)
  const single = Array.isArray(parsed) ? parsed[0] : parsed
  if (single instanceof Error) {
    throw new Error(`[e2e-ssh] 写死的 client 私钥无法解析：${single.message}`)
  }
  if ((single as ParsedKey).getPublicSSH().length !== 51) {
    throw new Error('[e2e-ssh] 写死的 client 公钥 blob 不是 51 字节')
  }
  return { privateKey: CLIENT_PRIVATE_KEY, publicKey: CLIENT_PUBLIC_KEY }
}

function fingerprintOf(publicBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`
}

function hostKeyPublicBlob(privateKey: string): Buffer {
  const parsed = utils.parseKey(privateKey)
  const single = Array.isArray(parsed) ? parsed[0] : parsed
  if (single instanceof Error) throw new Error(`[e2e-ssh] host key 解析失败：${single.message}`)
  return (single as ParsedKey).getPublicSSH()
}

/** 认证成功/失败都记一笔：`authAttempts` 是「公钥不在白名单必须被拒」这类断言的唯一真相 */
function verifyAuthentication(
  attempts: E2eSshServer['authAttempts'],
  authorized: Set<string>,
  ctx: {
    method: string
    username: string
    password?: string
    key?: { algo: string; data: Buffer }
    /** 探测包（公钥检查）没有签名；带签名的才是真正的认证请求 */
    signature?: Buffer

    accept: () => void
    reject: () => void
  }
): void {
  if (ctx.method === 'password') {
    const ok = ctx.username === E2E_SSH_USERNAME && ctx.password === E2E_SSH_PASSWORD
    attempts.push({ method: 'password', username: ctx.username, accepted: ok })
    if (ok) ctx.accept()
    else ctx.reject()
    return
  }
  if (ctx.method === 'publickey') {
    const key = ctx.key
    /*
     * 三个坑（都真踩过，症状都是「拿的就是测试 key 却恒 reject」）：
     * ① 白名单要比公钥 blob（`key.data`，ed25519 51 字节），不能比 `parseKey().getPublicSSH()` 之外的东西；
     * ② Buffer 放进 `Set` 再 `has()` 恒为 false —— Set 对对象是引用相等，统一转 hex；
     * ③ 「是不是探测包」看 **`ctx.signature`**，不是 `ctx.key.signature`（key 上永远没有这个字段），
     *    否则每包都被当成探测包、`accepted` 恒 false。
     */
    const blob = key?.data
    const authorizedHit = blob !== undefined && authorized.has(blob.toString('hex'))
    const probe = ctx.signature === undefined
    const accepted = authorizedHit && !probe
    attempts.push({
      method: 'publickey',
      username: ctx.username,
      accepted,
      keyFingerprint: blob === undefined ? undefined : fingerprintOf(blob)
    })
    if (authorizedHit) ctx.accept()
    else ctx.reject()
    return
  }
  attempts.push({ method: ctx.method, username: ctx.username, accepted: false })
  ctx.reject()
}

/**
 * 极简 shell：回显 + exit；其余命令回 `command not found`（够验证「输入上行 + 回显下行」）。
 *
 * 换行必须同时认 `\r` 与 `\n`：xterm 的 Enter 发的是 **CR（0x0d）**，只按 `\n` 切分会一条都收不到，
 * 症状是「终端连上了、敲键盘没反应」——这个坑在探针里真实踩过一次（shellLines 恒为空）。
 */
function attachShell(stream: ServerChannel, server: E2eSshServer): void {
  stream.write('termans-e2e ready\r\n')
  let pending = ''
  stream.on('data', (chunk: Buffer) => {
    pending += chunk.toString('utf8')
    for (;;) {
      const cr = pending.indexOf('\r')
      const lf = pending.indexOf('\n')
      const index = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf)
      if (index < 0) break
      const line = pending.slice(0, index)
      // 吃掉 CRLF 里的第二个字符
      pending = pending.slice(index + (pending[index] === '\r' && pending[index + 1] === '\n' ? 2 : 1))
      server.shellLines.push(line)
      if (line.trim() === 'exit') {
        stream.write('bye\r\n')
        stream.exit(0)
        stream.end()
        return
      }
      stream.write(`${line}\r\n`)
    }
  })
  stream.on('error', () => undefined)
}

function attachExec(stream: ServerChannel, command: string, server: E2eSshServer): void {
  const trimmed = command.trim()
  let output = ''
  let code = 0
  if (trimmed.startsWith('echo ')) output = `${trimmed.slice(5)}\n`
  else if (trimmed === 'whoami') output = `${E2E_SSH_USERNAME}\n`
  else if (trimmed === 'pwd') output = `/home/${E2E_SSH_USERNAME}\n`
  else if (trimmed === 'uname' || trimmed === 'uname -a') output = 'Linux termans-e2e 6.0.0 x86_64 GNU/Linux\n'
  else if (trimmed.startsWith('cat ')) output = ''
  else {
    output = `bash: ${trimmed}: command not found\n`
    code = 127
  }
  server.execs.push({ command: trimmed, exitCode: code })
  stream.end(output)
  stream.exit(code)
}

export async function startE2eSshServer(
  options: { echoInput?: boolean } = {}
): Promise<E2eSshServer> {
  const attempts: E2eSshServer['authAttempts'] = []
  const shellLines: string[] = []
  const execs: E2eSshServer['execs'] = []
  const clientKey = makeClientKeyPair()

  const clientParsed = utils.parseKey(clientKey.publicKey)
  const clientSingle = Array.isArray(clientParsed) ? clientParsed[0] : clientParsed
  if (clientSingle instanceof Error) throw new Error('[e2e-ssh] client key 解析失败')
  // 白名单用 51 字节公钥 blob（与 ctx.blob 同一形态）
  const authorized = new Set<string>([(clientSingle as ParsedKey).getPublicSSH().toString('hex')])

  const server: E2eSshServer = {
    host: '127.0.0.1',
    port: 0,
    username: E2E_SSH_USERNAME,
    password: E2E_SSH_PASSWORD,
    hostKeyFingerprint: fingerprintOf(hostKeyPublicBlob(HOST_KEY_SEED)),
    clientKey,
    authAttempts: attempts,
    shellLines,
    execs,
    stop: async () => undefined
  }

  const ssh = new Server({ hostKeys: [HOST_KEY_SEED] }, (client: Connection) => {
    client.on('authentication', (ctx) => verifyAuthentication(attempts, authorized, ctx as never))
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        let tty = false
        session.on('pty', (acceptPty: () => void) => {
          tty = true
          acceptPty()
        })
        session.on('window-change', () => undefined)
        session.on('shell', (acceptShell: () => ServerChannel) => {
          const stream = acceptShell()
          void tty
          attachShell(stream, server)
        })
        session.on('exec', (acceptExec: () => ServerChannel, _reject: unknown, info: { command: string }) => {
          const stream = acceptExec()
          attachExec(stream, info.command, server)
        })
      })
    })
    client.on('error', () => undefined)
  })

  await new Promise<void>((resolve, reject) => {
    ssh.once('error', reject)
    ssh.listen(0, '127.0.0.1', () => resolve())
  })
  const address = ssh.address()
  server.port = typeof address === 'object' && address !== null ? address.port : 0

  server.stop = async () => {
    await new Promise<void>((resolve) => ssh.close(() => resolve()))
  }

  void options.echoInput
  return server
}
