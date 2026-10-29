import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer as netCreateServer, type Socket } from 'node:net'
import { Server, utils } from 'ssh2'
import type { Connection, ParsedKey, ServerChannel, Session } from 'ssh2'

/**
 * 进程内 SSH 夹具 —— 用 ssh2 的 `Server` 在**当前进程**里起一个真 SSH 服务。
 *
 * 为什么不用系统 sshd：
 * - 不需要 sudo / 不需要改 `/etc/ssh/sshd_config`，CI 与开发机都能跑；
 * - host key 由夹具自己生成，**指纹可靠地传回给用例**（known_hosts 的首连/不匹配断言都靠它）；
 * - 失败路径可控：错误密码、未授权公钥、错 host key 都能稳定复现，而真 sshd 只能靠改配置碰运气；
 * - 每个用例独立起停、端口交给系统分配（`listen(0)`），并行跑不会因为 2222 被占而假失败。
 *
 * 只实现断言需要的最小行为（shell / exec / 认证），**不做 SFTP**：
 * SPEC 的验收矩阵（S-01..S-09、H-*）里没有 SFTP 项，而 SFTP 子系统要手写协议处理，
 * 属于「为了夹具而写一个文件系统」。真需要时按 `node_modules/ssh2/examples/sftp-server-download-only.js` 在同处扩写。
 *
 * 用法：
 * ```ts
 * const ssh = await startSshFixture()
 * try {
 *   const conn = await new Client().connect({ host: ssh.host, port: ssh.port, username: ssh.username, password: ssh.password })
 *   ...
 * } finally { await ssh.stop() }
 * ```
 */

/**
 * 固定 host key（ed25519，**仅测试用，绝不要用它连真实主机**）。
 *
 * 为什么写死、而不是每次启动都 `generateKeyPairSync`：
 * known_hosts 用例必须对着一个**跨运行、跨进程稳定**的指纹断言——
 * 首连写入指纹、之后「指纹被换成别的值必须硬失败」，如果每次指纹都变，
 * 「校验到底生效没有」就测不出来（期望值本来就是随机的，改错也能过）。
 * 双机迁移用例（B 要认得 A 信任的同一台主机）同理需要同一个 host key。
 */
export const FIXTURE_HOST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACBYbwLrysHu/8EVp94iqgJ+tLt+hNWRmOwB0MLdYP5pKgAA
AIgCSUAwAklAMAAAAAtzc2gtZWQyNTUxOQAAACBYbwLrysHu/8EVp94iqgJ+tLt+
hNWRmOwB0MLdYP5pKgAAAEDJ9jfp9bbSBqrkybtGaYVeBdYEpfXhrDlcVM0e3YPI
mlhvAuvKwe7/wRWn3iKqAn60u36E1ZGY7AHQwt1g/mkqAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`

/**
 * `FIXTURE_HOST_KEY` 的指纹，**写死**。
 * 有人误换密钥时这条会立刻红（而不是让所有 known_hosts 用例「随机地绿」）。
 */
export const FIXTURE_HOST_KEY_FINGERPRINT = 'SHA256:JFBdXZUT972M8J3vCxY7vjCbanHm8qQYb7UI28O4dLk'

/** 测试密钥对。`privateKey` 直接给 ssh2 `Client` 的 `privateKey` 选项（OpenSSH 格式）。 */
export interface SshFixtureKeyPair {
  privateKey: string
  publicKey: string
  /** `SHA256:<base64>`，与 `ssh-keygen -lf` 一致（去掉尾部 `=`） */
  fingerprintSha256: string
}

/** 一次认证尝试。用来断言「密码登录真的被拒了」「用的是 publickey 而不是密码」。 */
export interface SshAuthAttempt {
  username: string
  method: string
  accepted: boolean
  /** 拒绝原因；`accepted: true` 时不存在 */
  reason?: string
}

/** 一次 exec 请求（记录命令与退出码，便于断言客户端到底发了什么）。 */
export interface SshExecRecord {
  command: string
  stdout: string
  stderr: string
  code: number
}

export interface SshFixtureOptions {
  /** 唯一允许的用户名，缺省 `termans` */
  username?: string
  /** 密码认证的密码，缺省 `termans-test` */
  password?: string
  /**
   * 覆盖 host key（OpenSSH/PEM 私钥串）。缺省用 `FIXTURE_HOST_KEY`（固定的测试密钥）。
   * 灌一段别的 key 就能造「主机密钥变了」：known_hosts 里已信任旧指纹时必须硬失败。
   */
  hostKey?: string
  /** 额外允许登录的客户端公钥（`ssh-ed25519 AAAA...` 单行格式） */
  authorizedKeys?: string[]
  /**
   * shell 通道是否回显客户端输入（真实 tty 行为）。
   * 缺省 **false**：断言确定性强——发 `echo hi\r` 只回 `hi\r\n`，不会先多出一行回显的 `echo hi`。
   */
  echoInput?: boolean
  /** shell 的初始工作目录，缺省 `/home/<username>` */
  cwd?: string
  /** `cat` 能读到的假文件；缺省 `{ '/etc/hostname': 'termans-fixture' }` */
  files?: Record<string, string>
  /** `uname -a` 的输出，缺省 `Linux termans-fixture 6.1.0-fixture #1 SMP x86_64 GNU/Linux` */
  uname?: string
}

export interface SshFixture {
  /** 固定 `127.0.0.1`（不用 localhost：避免解析到 ::1 让 host/known_hosts 断言分成两份） */
  host: string
  /** 系统分配的随机端口（listen(0)），同一进程里多个夹具互不冲突 */
  port: number
  username: string
  password: string
  /** 夹具自带的客户端密钥对（publickey 认证用例直接用） */
  clientKey: SshFixtureKeyPair
  /** host 私钥（OpenSSH 格式），需要自己起第二个 server 或写盘时用 */
  hostKey: string
  /** host key 公钥（OpenSSH 单行格式） */
  hostPublicKey: string
  /** `SHA256:...`，与 `ssh-keygen -lf` 逐字一致 */
  hostKeyFingerprint: string
  /** 夹具接受的所有公钥（自带 clientKey + `authorizedKeys`） */
  authorizedPublicKeys: string[]
  /** 认证尝试流水，按发生顺序 */
  authAttempts: SshAuthAttempt[]
  /** exec 请求流水 */
  execs: SshExecRecord[]
  /** shell 通道收到并执行过的命令行（不含换行） */
  shellLines: string[]
  /**
   * 客户端发来的 `window-change`（resize）流水。
   *
   * 存在的理由：resize 是**没有应答**的请求，处理错了不会抛给调用方，只会让连接安静地断掉
   * （见 `handleWindowChange` 的注释）。t18 的回归用例靠这条断言「resize 真的到达服务端」，
   * 而不是只断言「客户端还连着」——后者在 resize 被丢弃时同样成立。
   */
  windowChanges: SshWindowChange[]
  /**
   * 服务端侧捕获到的所有错误（ssh2 server Client 的 'error' + 请求处理函数抛出的异常）。
   *
   * 空数组 = 连接全程没有服务端异常。非空即「夹具自己出问题了」：ssh2 的 server 端在处理
   * 请求的 handler 抛异常时会 `client.destroy()`，客户端只看到一条 FIN、拿不到任何原因，
   * 排查成本极高（t18 就是 `acceptWindow is not a function` 这样被丢掉的）。所以夹具**必须**
   * 把它记下来供断言，不允许静默吞掉。
   */
  errors: string[]
  /** 关掉监听并断开所有连接；幂等 */
  stop: () => Promise<void>
}

/** 一次 `window-change` 请求的载荷（与 RFC 4254 §6.7 字段一致） */
export interface SshWindowChange {
  cols: number
  rows: number
  width: number
  height: number
}

interface ResolvedOptions {
  username: string
  password: string
  echoInput: boolean
  cwd: string
  files: Record<string, string>
  uname: string
}

interface CommandOutcome {
  stdout: string
  stderr: string
  code: number
  /** true = 关闭通道（`exit`） */
  exit: boolean
}

/**
 * `SHA256:<base64>` 指纹。**必须对 SSH 线格式的公钥 blob 求 hash**（含类型前缀），
 * 不是对 base64 解码后的裸密钥求 hash —— 这是最容易搞错的一处，
 * 与 `src/main/ssh/known-hosts.ts` 的 `fingerprintSha256FromKey` 保持同一算法。
 */
function fingerprintSha256(publicKeyBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')}`
}

function parseKeyOrThrow(key: string, what: string): ParsedKey {
  // 运行时可返回三种东西：`ParsedKey`（正常）、`Error`（口令错/格式错）、`ParsedKey[]`
  // （一个字符串里塞了多把 key）。@types 只声明了前两者，这里按运行时实际情况窄化。
  const parsed: ParsedKey | ParsedKey[] | Error = utils.parseKey(key)
  if (parsed instanceof Error) {
    throw new Error(`[ssh-fixture] ${what} 无法解析（需要 OpenSSH/PEM 私钥或公钥串）：${parsed.message}`)
  }
  if (Array.isArray(parsed)) {
    // 静默取第一把会让「传错 key 也通过」变成假绿，直接拒绝，让调用方明确写一次一把
    throw new Error(`[ssh-fixture] ${what} 含 ${parsed.length} 把 key：夹具要求单个 key`)
  }
  return parsed
}

/** 正常 ed25519 公钥的线格式（wire format）长度：`0000000b "ssh-ed25519" 00000020 <32 字节>` */
const ED25519_PUBLIC_KEY_BLOB_BYTES = 51

function tryParseKey(key: string): ParsedKey | undefined {
  const parsed: ParsedKey | ParsedKey[] | Error = utils.parseKey(key)
  if (parsed instanceof Error || Array.isArray(parsed)) return undefined
  return parsed
}

/**
 * 生成一把 ssh2 **真的能用**的 ed25519 密钥对：生成 → 自校验 → 坏了重掷。
 *
 * 为什么要这个函数（**别简写回 `utils.generateKeyPairSync('ed25519')`，会偶发假红**）：
 * ssh2 1.17.0 的 `generateKeyPairSync('ed25519')` 有约 **1/256** 的概率产出它自己 `parseKey` 都解析不了的密钥——
 * 它把 ed25519 公钥按 mpint 序列化，当公钥首字节恰好是 `0x00` 时会被当成「符号填充」吞掉：
 * 正常公钥 blob 是 51 字节（`0000000b` + `ssh-ed25519` + `00000020` + 32 字节公钥），
 * 坏样本只剩 50 字节、内层长度字段变成 `0000001f`（少了一位），于是
 * `utils.parseKey(privateKey)` 报 `Error: Malformed OpenSSH private key`，`utils.parseKey(publicKey)` 同样 Error。
 * 实测本机 3000 次生成出现 10 次（0.33%，与 1/256 的量级一致），表现为「十次里错一次、无法复现」的
 * 夹具假红/CI 偶发红——排查成本极高，因此在生成处就掐死。
 *
 * 为什么不直接钉死一把固定 key（`FIXTURE_HOST_KEY` 那种）：
 * 「主机密钥变了必须硬失败」的用例需要一把**与已信任指纹不同**的新钥匙，随机是这个用例的语义组成部分；
 * 所以这里保留随机，只加自校验 + 重掷（第一次就成功的概率 255/256，8 次余量已远超需要）。
 */
export function makeValidEd25519KeyPair(): SshFixtureKeyPair {
  const maxAttempts = 8
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519')
    const privateParsed = tryParseKey(pair.private)
    const publicParsed = tryParseKey(pair.public)
    // 双份校验：私钥要能解析（Server 构造时就卡这一步），公钥 blob 长度要正好 51（坏样本 50）
    if (privateParsed === undefined || publicParsed === undefined) continue
    const blob = privateParsed.getPublicSSH()
    if (blob.length !== ED25519_PUBLIC_KEY_BLOB_BYTES) continue
    if (publicParsed.getPublicSSH().length !== ED25519_PUBLIC_KEY_BLOB_BYTES) continue
    return {
      privateKey: pair.private,
      publicKey: pair.public,
      fingerprintSha256: fingerprintSha256(blob)
    }
  }
  throw new Error(
    `[ssh-fixture] 连续 ${maxAttempts} 次都拿到 malformed ed25519 密钥（ssh2 缺陷，正常概率 (1/256)^${maxAttempts}）`
  )
}

function generateClientKeyPair(): SshFixtureKeyPair {
  // 客户端密钥同样要走自校验版本：坏 key 会让 startSshFixture 在 parseKeyOrThrow 处偶发抛错
  return makeValidEd25519KeyPair()
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // 长度不同时也走 timingSafeEqual（拿 b 顶替），避免用长度差异当比较结果泄露信息
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 极简分词：够处理 `echo "hello world"` 这种带引号的命令即可。 */
function splitWords(line: string): string[] {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let touched = false
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      touched = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (touched || current.length > 0) {
        words.push(current)
        current = ''
        touched = false
      }
      continue
    }
    current += ch
  }
  if (touched || current.length > 0) words.push(current)
  return words
}

/**
 * 夹具的「假 shell」：只认几条命令，其余一律 `command not found`。
 *
 * 注意 eol：shell 通道（pty）用 `\r\n`（终端需要回车复位列），exec 通道用 `\n`（非 tty）。
 */
function runCommand(line: string, opts: ResolvedOptions, eol: string): CommandOutcome {
  const trimmed = line.trim()
  const idle: CommandOutcome = { stdout: '', stderr: '', code: 0, exit: false }
  if (trimmed === '') return idle

  const words = splitWords(trimmed)
  const command = words[0] ?? ''
  const args = words.slice(1)

  switch (command) {
    case 'echo': {
      let rest = args
      let noNewline = false
      if (rest[0] === '-n') {
        noNewline = true
        rest = rest.slice(1)
      }
      return { stdout: rest.join(' ') + (noNewline ? '' : eol), stderr: '', code: 0, exit: false }
    }
    case 'pwd':
      return { stdout: opts.cwd + eol, stderr: '', code: 0, exit: false }
    case 'whoami':
      return { stdout: opts.username + eol, stderr: '', code: 0, exit: false }
    case 'uname': {
      const text = args.includes('-a') ? opts.uname : (opts.uname.split(' ')[0] ?? 'Linux')
      return { stdout: text + eol, stderr: '', code: 0, exit: false }
    }
    case 'cat': {
      if (args.length === 0) {
        return { stdout: '', stderr: `cat: stdin 未实现（夹具只支持读假文件）${eol}`, code: 1, exit: false }
      }
      let stdout = ''
      let stderr = ''
      let code = 0
      for (const file of args) {
        const content = opts.files[file]
        if (content === undefined) {
          stderr += `cat: ${file}: No such file or directory${eol}`
          code = 1
          continue
        }
        stdout += content.replace(/\r?\n/g, eol) + (content.endsWith('\n') ? '' : eol)
      }
      return { stdout, stderr, code, exit: false }
    }
    case 'true':
      return idle
    case 'false':
      return { stdout: '', stderr: '', code: 1, exit: false }
    case 'clear':
      return { stdout: '\u001b[H\u001b[2J', stderr: '', code: 0, exit: false }
    case 'exit': {
      const raw = args[0]
      const parsedCode = raw === undefined ? 0 : Number.parseInt(raw, 10)
      return { stdout: '', stderr: '', code: Number.isNaN(parsedCode) ? 0 : parsedCode, exit: true }
    }
    default:
      return { stdout: '', stderr: `bash: ${command}: command not found${eol}`, code: 127, exit: false }
  }
}

/** shell 通道：按行解释，`exit`/Ctrl-D 关通道，Ctrl-C 丢弃当前行。 */
function attachShell(stream: ServerChannel, opts: ResolvedOptions, shellLines: string[]): void {
  const eol = '\r\n'
  let pending = ''
  let pendingCR = false
  let closed = false

  const finish = (code: number): void => {
    if (closed) return
    closed = true
    stream.exit(code)
    stream.end()
  }

  stream.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (opts.echoInput) stream.write(text)
    for (const ch of text) {
      if (ch === '\u0004') {
        // Ctrl-D：EOF
        finish(0)
        return
      }
      if (ch === '\u0003') {
        // Ctrl-C：丢弃当前行，跟真终端一样回一个 ^C
        pending = ''
        pendingCR = false
        stream.write(`^C${eol}`)
        continue
      }
      if (ch === '\r' || ch === '\n') {
        // `\r\n` 只算一次回车（客户端发 \r、某些客户端发 \r\n，都要能吃）
        if (ch === '\n' && pendingCR) {
          pendingCR = false
          continue
        }
        pendingCR = ch === '\r'
        const line = pending
        pending = ''
        shellLines.push(line)
        const out = runCommand(line, opts, eol)
        // PTY 下 stderr 与 stdout 合流到终端：错误也写 stdout，否则只读 stdout 的终端看不见
        if (out.stdout) stream.write(out.stdout)
        if (out.stderr) stream.write(out.stderr)
        if (out.exit) {
          finish(out.code)
          return
        }
        continue
      }
      pending += ch
    }
  })

  stream.on('error', () => undefined)
}

export async function startSshFixture(options: SshFixtureOptions = {}): Promise<SshFixture> {
  const username = options.username ?? 'termans'
  const password = options.password ?? 'termans-test'
  const opts: ResolvedOptions = {
    username,
    password,
    echoInput: options.echoInput ?? false,
    cwd: options.cwd ?? `/home/${username}`,
    files: options.files ?? { '/etc/hostname': 'termans-fixture\n' },
    uname: options.uname ?? 'Linux termans-fixture 6.1.0-fixture #1 SMP x86_64 GNU/Linux'
  }

  const clientKey = generateClientKeyPair()
  const hostKey = options.hostKey ?? FIXTURE_HOST_KEY
  const hostParsed = parseKeyOrThrow(hostKey, 'hostKey')
  // 公钥从私钥派生，避免「传了 hostKey 却回一个占位字符串」——known_hosts 用例需要真的公钥
  const hostPublicKey = `${hostParsed.type} ${hostParsed.getPublicSSH().toString('base64')}`

  const authorizedPublicKeys = [clientKey.publicKey, ...(options.authorizedKeys ?? [])]
  const authorizedBlobs = authorizedPublicKeys.map((key) => {
    const parsed = parseKeyOrThrow(key, 'authorizedKeys')
    return parsed.getPublicSSH()
  })

  const authAttempts: SshAuthAttempt[] = []
  const execs: SshExecRecord[] = []
  const shellLines: string[] = []
  const windowChanges: SshWindowChange[] = []
  const errors: string[] = []
  const sockets = new Set<Socket>()

  /** 包一层请求处理器：抛错记进 errors（而不是让 ssh2 销毁 socket 后无人知晓） */
  const guard = (label: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    /**
     * 只记录**认证成功之后**的错误。原因：引擎（和任何谨慎的客户端）会先为 hostVerifier 建一条
     * 「只做握手、拿到 host key 就主动断开」的探测连接，那条连接必然在断开时留下
     * `KEY_EXCHANGE_FAILED` —— 那是**预期**行为，混进 errors 会让「夹具没炸」这条断言永远不成立。
     */
    let authenticated = false
    client.on('error', (error: Error & { level?: string }) => {
      if (!authenticated) return
      errors.push(`client error (${error.level ?? 'unknown'}): ${error.message}`)
    })

    client.on('authentication', (ctx) => {
      const rejectAll = (reason: string): void => {
        authAttempts.push({ username: ctx.username, method: ctx.method, accepted: false, reason })
        ctx.reject(['password', 'publickey'])
      }

      // 先走 'none' 探询，告诉客户端有哪些方法可用（真 sshd 同样如此）
      if (ctx.method === 'none') return rejectAll('none-method-not-allowed')
      if (ctx.username !== opts.username) return rejectAll('unknown-user')

      if (ctx.method === 'password') {
        const ok = safeEqual(ctx.password, opts.password)
        authAttempts.push({
          username: ctx.username,
          method: 'password',
          accepted: ok,
          ...(ok ? {} : { reason: 'bad-password' })
        })
        return ok ? ctx.accept() : ctx.reject(['password', 'publickey'])
      }

      if (ctx.method === 'publickey') {
        const blob = ctx.key.data
        const ok = authorizedBlobs.some((allowed) => allowed.length === blob.length && timingSafeEqual(allowed, blob))
        authAttempts.push({
          username: ctx.username,
          method: 'publickey',
          accepted: ok,
          ...(ok ? {} : { reason: 'unauthorized-key' })
        })
        // 无 signature 的是探测请求，accept() 会回 PK_OK（ssh2 内部处理），客户端随后发带签名的请求
        return ok ? ctx.accept() : ctx.reject(['password', 'publickey'])
      }

      return rejectAll('method-not-supported')
    })

    client.on('ready', () => {
      authenticated = true
      client.on('session', (accept) => {
        const session: Session = accept()

        /**
         * ⚠️ 三种会话请求的应答契约**不一样**，抄错一个就会让夹具静默断连（t18 的根因）：
         *
         * - `pty-req` / `env` 带 `want_reply`，ssh2 才会给 `accept`/`reject`，可以调；
         * - `window-change` / `signal` 在 RFC 4254 里**没有应答**（客户端不置 want_reply），
         *   ssh2 传给监听器的 `accept` 与 `reject` 都是 `undefined`（见
         *   `node_modules/ssh2/lib/server.js:847-856`：只有 wantReply 为真时才构造这两个回调）。
         *
         * 原来写成 `session.on('window-change', (acceptWindow) => acceptWindow())`，
         * 于是**客户端第一次 resize（xterm 挂载后 fit 出来 131x40）就抛**
         * `TypeError: acceptWindow is not a function`；ssh2 的 server 端 Client 捕获 handler
         * 异常后直接销毁 socket，客户端只看到一条 FIN ——表现为「连上约 1s 被对端 FIN」，
         * 且 vitest 里没有触发 resize 的用例，所以长期没暴露（t18）。
         */
        guard('pty', () => session.on('pty', (acceptPty) => acceptPty()))
        guard('window-change', () =>
          session.on('window-change', (_accept, _reject, info) => {
            // 不调 accept：这个请求没有应答可发；只记录，供回归断言「resize 真的到了服务端」
            windowChanges.push({ cols: info.cols, rows: info.rows, width: info.width, height: info.height })
          })
        )
        guard('env', () => session.on('env', (acceptEnv) => acceptEnv()))
        // signal 同样没有应答（RFC 4254 §6.9），收到即忽略，不要试着 accept
        guard('signal', () => session.on('signal', () => undefined))
        session.on('auth-agent', (_accept, rejectAgent) => rejectAgent())
        // 夹具不实现 SFTP / 任意子系统：明确拒绝，别让客户端一直等
        session.on('sftp', (_accept, rejectSftp) => rejectSftp())
        session.on('subsystem', (_accept, rejectSubsystem) => rejectSubsystem())

        session.on('shell', (acceptShell) => {
          attachShell(acceptShell(), opts, shellLines)
        })

        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          const out = runCommand(info.command, opts, '\n')
          execs.push({ command: info.command, stdout: out.stdout, stderr: out.stderr, code: out.code })
          if (out.stdout) stream.write(out.stdout)
          if (out.stderr) stream.stderr.write(out.stderr)
          stream.exit(out.code)
          stream.end()
        })
      })
    })
  })

  /**
   * 自己持有 net.Server 与原始 socket，再用 ssh2 的公开入口 `injectSocket` 交给它。
   *
   * 为什么不直接 `server.listen()` + `server.on('connection')`：ssh2 的 `Server` 把每条连接包装成
   * 自己的 `Client` 再 `emit('connection', client, info)`，监听器拿到的是**包装对象**而不是 socket
   * （按 Socket 用会得到 `socket.destroy is not a function`）。而 `stop()` 必须能强制断开还活着的连接，
   * 否则 `server.close()` 的回调要等客户端自己走，用例失败时会挂住整个 vitest 进程。
   */
  const netServer = netCreateServer((socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    server.injectSocket(socket)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    netServer.once('error', onError)
    // 只听 127.0.0.1：不暴露到局域网；端口 0 = 让系统分配（本机 2222 可能被占）
    netServer.listen(0, '127.0.0.1', () => {
      netServer.removeListener('error', onError)
      resolve()
    })
  })

  const address = netServer.address()
  if (address === null || typeof address === 'string') {
    netServer.close()
    throw new Error('[ssh-fixture] listen(0) 没有拿到端口')
  }

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((resolve) => netServer.close(() => resolve()))
  }

  return {
    host: '127.0.0.1',
    port: address.port,
    username,
    password,
    clientKey,
    hostKey,
    hostPublicKey,
    hostKeyFingerprint: fingerprintSha256(hostParsed.getPublicSSH()),
    authorizedPublicKeys,
    authAttempts,
    execs,
    shellLines,
    windowChanges,
    errors,
    stop
  }
}
