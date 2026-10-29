import { connect as connectTcp, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net'
import { posix as pathPosix } from 'node:path'
import {
  Server as SshServer,
  utils,
  type Attributes,
  type AuthContext,
  type Connection,
  type ExecInfo,
  type FileEntry,
  type PseudoTtyInfo,
  type ServerChannel,
  type Session,
  type TcpipRequestInfo,
  type SetEnvInfo,
  type SFTPWrapper,
  type WindowChangeInfo
} from 'ssh2'
import { fingerprintSha256FromKey } from '../../known-hosts'
import { FIXTURE_HOST_KEY } from './keys'

/**
 * 进程内假 SSH 服务器（基于 ssh2 自己的 Server 实现）。
 *
 * 为什么不用真 sshd：CI/本机都不一定有 sshd、需要 root、端口冲突、且「主机密钥变更」
 * 这种场景要反复重启守护进程。用 ssh2.Server 可以在随机端口起一个真正的 SSH 协议对端，
 * 认证/PTY/exec/SFTP 全走真实协议路径——被测代码里的 ssh2.Client 并不知道对面是假的。
 */

const STATUS = utils.sftp.STATUS_CODE
const OPEN_MODE = utils.sftp.OPEN_MODE

/** 快照：一次测试里可以断言服务器端到底收到了什么 */
export interface FakeServerRecords {
  authAttempts: { method: string; username: string }[]
  ptys: PseudoTtyInfo[]
  windowChanges: WindowChangeInfo[]
  envs: SetEnvInfo[]
  shells: number
  execCommands: string[]
  keyboardResponses: string[][]
  /** direct-tcpip 请求（跳板机专用）：断言「确实经跳板机开过隧道」 */
  tcpip: TcpipRequestInfo[]
  sftp: {
    opens: { path: string; mode: number | null }[]
    mkdirs: { path: string; mode: number | null }[]
    renames: { from: string; to: string }[]
    removes: string[]
    readdirs: string[]
    reads: number
    writes: number
  }
}

interface FsNode {
  type: 'file' | 'dir'
  data: Buffer
  mode: number
  mtime: number
  uid: number
  gid: number
}

class SftpFailure extends Error {
  constructor(readonly code: number) {
    super(`sftp failure ${code}`)
  }
}

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

function dirNode(mode = 0o755): FsNode {
  return { type: 'dir', data: Buffer.alloc(0), mode: S_IFDIR | mode, mtime: 1_700_000_000, uid: 1000, gid: 1000 }
}

function fileNode(data = Buffer.alloc(0), mode = 0o644): FsNode {
  return { type: 'file', data, mode: S_IFREG | mode, mtime: 1_700_000_000, uid: 1000, gid: 1000 }
}

/** 极简内存文件系统：只实现 SFTP 用到的那些操作，路径语义 emulate 一个 Linux 用户 */
export class MemoryFs {
  readonly home = '/home/test'
  private readonly nodes = new Map<string, FsNode>()

  constructor() {
    this.nodes.set('/', dirNode())
    this.nodes.set(this.home, dirNode())
  }

  normalize(input: string): string {
    if (!input || input === '.' || input === './') return this.home
    if (input === '~') return this.home
    if (input.startsWith('~/')) return pathPosix.normalize(pathPosix.join(this.home, input.slice(2)))
    if (input.startsWith('/')) return pathPosix.normalize(input)
    return pathPosix.normalize(pathPosix.join(this.home, input))
  }

  has(path: string): boolean {
    return this.nodes.has(this.normalize(path))
  }

  read(path: string): Buffer {
    return this.require(path, S_IFREG).data
  }

  /** 直接摆一个文件（测试预置数据用） */
  seedFile(path: string, content: string | Buffer, mode = 0o644): string {
    const target = this.normalize(path)
    const parent = pathPosix.dirname(target)
    if (!this.nodes.has(parent)) throw new Error(`parent dir missing: ${parent}`)
    this.nodes.set(target, fileNode(Buffer.from(content), mode))
    return target
  }

  seedDir(path: string, mode = 0o755): string {
    const target = this.normalize(path)
    this.nodes.set(target, dirNode(mode))
    return target
  }

  attrs(path: string): Attributes {
    const node = this.require(path)
    return {
      mode: node.mode,
      uid: node.uid,
      gid: node.gid,
      size: node.type === 'file' ? node.data.length : 4096,
      atime: node.mtime,
      mtime: node.mtime
    }
  }

  open(path: string, flags: number, attrs: Attributes): void {
    const target = this.normalize(path)
    const mode = typeof attrs.mode === 'number' ? attrs.mode : 0o644
    const exists = this.nodes.has(target)
    const wantsWrite = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND)) !== 0
    const wantsRead = (flags & OPEN_MODE.READ) !== 0

    if (exists) {
      const node = this.require(target)
      if (node.type === 'dir') throw new SftpFailure(STATUS.FAILURE)
      if (wantsWrite && (flags & OPEN_MODE.EXCL) !== 0) throw new SftpFailure(STATUS.FAILURE)
      if (flags & OPEN_MODE.TRUNC) node.data = Buffer.alloc(0)
      return
    }
    if (!exists) {
      if ((flags & OPEN_MODE.CREAT) === 0) throw new SftpFailure(STATUS.NO_SUCH_FILE)
      if (!wantsWrite && !wantsRead) throw new SftpFailure(STATUS.FAILURE)
      const parent = pathPosix.dirname(target)
      const parentNode = this.nodes.get(parent)
      if (!parentNode || parentNode.type !== 'dir') throw new SftpFailure(STATUS.NO_SUCH_FILE)
      this.nodes.set(target, fileNode(Buffer.alloc(0), mode & 0o777))
    }
  }

  readChunk(path: string, offset: number, len: number): Buffer {
    const node = this.require(path, S_IFREG)
    if (offset >= node.data.length) throw new SftpFailure(STATUS.EOF)
    return node.data.subarray(offset, Math.min(offset + len, node.data.length))
  }

  writeChunk(path: string, offset: number, data: Buffer): void {
    const node = this.require(path, S_IFREG)
    const end = offset + data.length
    if (end <= node.data.length) {
      data.copy(node.data, offset)
      return
    }
    const next = Buffer.alloc(end)
    node.data.copy(next, 0)
    data.copy(next, offset)
    node.data = next
  }

  list(path: string): { name: string; attrs: Attributes }[] {
    const dir = this.normalize(path)
    const node = this.require(dir)
    if (node.type !== 'dir') throw new SftpFailure(STATUS.FAILURE)
    const prefix = dir === '/' ? '/' : `${dir}/`
    const entries: { name: string; attrs: Attributes }[] = []
    for (const [key, value] of this.nodes) {
      if (key === dir || !key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest.includes('/')) continue // 只看直接子项
      entries.push({
        name: rest,
        attrs: {
          mode: value.mode,
          uid: value.uid,
          gid: value.gid,
          size: value.type === 'file' ? value.data.length : 4096,
          atime: value.mtime,
          mtime: value.mtime
        }
      })
    }
    return entries
  }

  mkdir(path: string, attrs: Attributes): void {
    const target = this.normalize(path)
    if (this.nodes.has(target)) throw new SftpFailure(STATUS.FAILURE)
    const parent = this.nodes.get(pathPosix.dirname(target))
    if (!parent || parent.type !== 'dir') throw new SftpFailure(STATUS.NO_SUCH_FILE)
    const mode = typeof attrs.mode === 'number' ? attrs.mode & 0o777 : 0o755
    this.nodes.set(target, dirNode(mode))
  }

  rmdir(path: string): void {
    const target = this.normalize(path)
    const node = this.require(target)
    if (node.type !== 'dir') throw new SftpFailure(STATUS.FAILURE)
    const hasChild = [...this.nodes.keys()].some((key) => key !== target && key.startsWith(`${target}/`))
    if (hasChild) throw new SftpFailure(STATUS.FAILURE)
    this.nodes.delete(target)
  }

  unlink(path: string): void {
    const target = this.normalize(path)
    const node = this.require(target)
    if (node.type === 'dir') throw new SftpFailure(STATUS.FAILURE)
    this.nodes.delete(target)
  }

  rename(from: string, to: string): void {
    const source = this.normalize(from)
    const dest = this.normalize(to)
    const node = this.require(source)
    if (this.nodes.has(dest)) throw new SftpFailure(STATUS.FAILURE)
    this.nodes.delete(source)
    this.nodes.set(dest, node)
  }

  setstat(path: string, attrs: Attributes): void {
    const node = this.require(path)
    if (typeof attrs.mode === 'number') node.mode = (node.mode & 0o170000) | (attrs.mode & 0o7777)
    if (typeof attrs.size === 'number' && node.type === 'file') {
      const next = Buffer.alloc(attrs.size)
      node.data.copy(next, 0, 0, Math.min(node.data.length, attrs.size))
      node.data = next
    }
    if (typeof attrs.mtime === 'number') node.mtime = attrs.mtime
  }

  private require(path: string, type?: number): FsNode {
    const target = this.normalize(path)
    const node = this.nodes.get(target)
    if (!node) throw new SftpFailure(STATUS.NO_SUCH_FILE)
    if (type && (node.mode & 0o170000) !== type) throw new SftpFailure(STATUS.FAILURE)
    return node
  }
}

export interface FakeServerOptions {
  username?: string
  password?: string
  acceptPublicKey?: boolean
  /** 提供则启用 keyboard-interactive（prompts 可含 echo 标记） */
  keyboardInteractive?: { prompts: { prompt: string; echo?: boolean }[]; expected?: string[] }
  shellBanner?: string
  shellStderr?: string
  execOutput?: (command: string) => { stdout?: string; stderr?: string; code?: number }
  hostKey?: string
  /** 关掉 SFTP 子系统（用于断言「服务器禁用 sftp」时的报错） */
  disableSftp?: boolean
  /**
   * direct-tcpip 目标重写：返回 null 表示拒绝这条隧道（模拟 allowtcpforwarding no）。
   *
   * 测试里用它把 `目标机主机名:端口` 映射到回环上的真实端口，从而**制造一个直连必然失败、
   * 只有经跳板机才通**的目标机——这样「去掉跳板逻辑」的变异一定会红，而不是恰好也能连上。
   */
  tcpipMap?: (info: TcpipRequestInfo) => { host: string; port: number } | null
}

export class FakeSshServer {
  readonly fs = new MemoryFs()
  readonly records: FakeServerRecords = {
    authAttempts: [],
    ptys: [],
    windowChanges: [],
    envs: [],
    shells: 0,
    execCommands: [],
    keyboardResponses: [],
    tcpip: [],
    sftp: { opens: [], mkdirs: [], renames: [], removes: [], readdirs: [], reads: 0, writes: 0 }
  }

  /** 打开的 shell 通道：测试可以往里直接写数据（模拟远端输出/背压） */
  readonly shellStreams: ServerChannel[] = []

  private readonly options: FakeServerOptions
  private readonly hostKey: string
  private server: SshServer | null = null
  private readonly sockets = new Set<Socket>()
  private readonly connections = new Set<Connection>()
  /** 当前仍然打开的隧道通道（断言「目标会话关闭后跳板机上没有悬挂隧道」） */
  private readonly tunnels = new Set<ServerChannel>()
  port = 0

  constructor(options: FakeServerOptions = {}) {
    this.options = options
    // 默认用**钉死的**宿主密钥，而不是 `utils.generateKeyPairSync('ed25519').private`：
    // 后者在 ssh2 1.17 上约每 256 次产出 1 把连 parseKey 都解析不了的私钥（首字节 0x00 被吞，
    // 内嵌 pub 串少 1 字节），而每个实例掷一次骰子 ⇒ 全量跑约 1/3 概率红。详见 helpers/keys.ts 顶部注释。
    // 需要「另一把密钥」（造 host key 变化的中间人）时，调用方传 options.hostKey，用 generateValidKeyPair() 生成。
    this.hostKey = options.hostKey ?? FIXTURE_HOST_KEY
  }

  get host(): string {
    return '127.0.0.1'
  }

  /** 服务器实际使用的 host key 指纹（与被测代码算出来的必须一致） */
  get hostKeyFingerprint(): string {
    const parsed = utils.parseKey(this.hostKey)
    if (parsed instanceof Error) throw parsed
    return fingerprintSha256FromKey(parsed.getPublicSSH())
  }

  /** 当前存活的 SSH 连接数（关闭后必须归零，用来验证「不留悬挂连接」） */
  get connectionCount(): number {
    return this.connections.size
  }

  /** 当前仍然打开的 direct-tcpip 隧道数 */
  get openTunnelCount(): number {
    return this.tunnels.size
  }

  async start(): Promise<this> {
    const server = new SshServer({ hostKeys: [this.hostKey] }, (client: Connection) => this.handleConnection(client))
    this.server = server
    // ssh2 的 Server 不是 net.Server：'connection' 事件给的是 Connection，底层 socket 在 _sock 上
    server.on('connection', (client: Connection) => {
      const socket = (client as unknown as { _sock?: Socket })._sock
      if (!socket) return
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    server.on('error', () => {
      /* 测试里连接被强杀会走到这里，忽略 */
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fake ssh server failed to bind')
    this.port = address.port
    return this
  }

  /** 模拟链路中断：直接 destroy TCP socket（不给对端 FIN 的机会，最接近拔网线） */
  killConnections(): void {
    for (const socket of this.sockets) socket.destroy()
  }

  /** 优雅停机：先断所有连接再关监听（否则 server.close 会等连接结束） */
  async stop(): Promise<void> {
    this.killConnections()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** 模拟远端 shell 退出（发 exit-status 再关通道） */
  exitShell(code = 0): void {
    for (const stream of this.shellStreams) {
      try {
        stream.exit(code)
        stream.end()
      } catch {
        /* 通道已关 */
      }
    }
    this.shellStreams.length = 0
  }

  /* -------------------------------------------------------------- 内部实现 */

  private handleConnection(client: Connection): void {
    this.connections.add(client)
    client.on('close', () => this.connections.delete(client))
    client.on('error', () => {
      /* 客户端强杀 */
    })

    client.on('authentication', (ctx: AuthContext) => this.handleAuth(ctx))
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session: Session = accept()
        this.handleSession(session)
      })
      client.on('tcpip', (accept, reject, info: TcpipRequestInfo) => {
        this.records.tcpip.push(info)
        const mapped = this.options.tcpipMap ? this.options.tcpipMap(info) : { host: info.destIP, port: info.destPort }
        if (!mapped) {
          reject?.()
          return
        }
        const stream = accept()
        this.tunnels.add(stream)
        const forget = (): void => {
          this.tunnels.delete(stream)
        }
        stream.on('close', forget)
        stream.on('error', forget)
        const socket = connectTcp({ host: mapped.host, port: mapped.port })
        socket.on('connect', () => {
          stream.pipe(socket)
          socket.pipe(stream)
        })
        socket.on('error', () => {
          try {
            stream.close()
          } catch {
            /* 已关闭 */
          }
        })
        stream.on('close', () => socket.destroy())
      })
    })
  }

  private handleAuth(ctx: AuthContext): void {
    this.records.authAttempts.push({ method: ctx.method, username: ctx.username })

    if (ctx.method === 'password') {
      if (ctx.username === (this.options.username ?? 'tester') && ctx.password === (this.options.password ?? 'secret')) {
        ctx.accept()
      } else {
        ctx.reject()
      }
      return
    }

    if (ctx.method === 'publickey') {
      if (this.options.acceptPublicKey === false) {
        ctx.reject(['password'])
        return
      }
      // 第一次不带签名 = 客户端在问「这把钥匙行不行」，accept 即要求它签名
      if (!ctx.signature) {
        ctx.accept()
        return
      }
      ctx.accept()
      return
    }

    if (ctx.method === 'keyboard-interactive') {
      const config = this.options.keyboardInteractive
      if (!config) {
        ctx.reject(['password'])
        return
      }
      ctx.prompt(config.prompts, (responses: string[]) => {
        this.records.keyboardResponses.push(responses)
        const expected = config.expected ?? config.prompts.map(() => '')
        const ok = responses.length === expected.length && responses.every((value, index) => value === expected[index])
        if (ok) ctx.accept()
        else ctx.reject(['keyboard-interactive'])
      })
      return
    }

    ctx.reject(['password', 'publickey'])
  }

  private handleSession(session: Session): void {
    let pty: PseudoTtyInfo | null = null

    session.on('pty', (accept, _reject, info: PseudoTtyInfo) => {
      pty = info
      this.records.ptys.push(info)
      accept?.()
    })
    session.on('window-change', (accept, _reject, info: WindowChangeInfo) => {
      this.records.windowChanges.push(info)
      accept?.()
    })
    session.on('env', (accept, _reject, info: SetEnvInfo) => {
      this.records.envs.push(info)
      accept?.()
    })

    session.on('shell', (accept) => {
      const stream = accept()
      this.records.shells += 1
      this.shellStreams.push(stream)
      if (pty && this.options.shellBanner) stream.write(this.options.shellBanner)
      if (this.options.shellStderr) stream.stderr.write(this.options.shellStderr)
      // 回显：真实终端的本地回显在客户端；这里模拟「远端把收到的字节原样打回来」，
      // 用来验证 stdin 真的经 PTY 到了远端、且 stdout 真的回到了我们手里。
      stream.on('data', (chunk: Buffer) => stream.write(chunk))
      stream.on('close', () => {
        const index = this.shellStreams.indexOf(stream)
        if (index >= 0) this.shellStreams.splice(index, 1)
      })
      stream.on('error', () => {
        /* 客户端断开 */
      })
    })

    session.on('exec', (accept, _reject, info: ExecInfo) => {
      this.records.execCommands.push(info.command)
      const stream = accept()
      const output = this.options.execOutput?.(info.command) ?? { stdout: '', stderr: '', code: 0 }
      if (output.stdout) stream.write(output.stdout)
      if (output.stderr) stream.stderr.write(output.stderr)
      stream.exit(output.code ?? 0)
      stream.end()
    })

    session.on('sftp', (accept, reject) => {
      if (this.options.disableSftp) {
        // 必须显式 reject：不响应会让客户端 sftp() 永远挂起（真实 sshd 关掉子系统时也是失败应答）
        reject()
        return
      }
      this.handleSftp(accept())
    })
  }

  private handleSftp(sftp: SFTPWrapper): void {
    const handles = new Map<number, { path: string; dir?: boolean }>()
    const dirHandlesPendingEof = new Set<number>()
    let nextHandle = 1

    const reply = (reqId: number, action: () => void): void => {
      try {
        action()
      } catch (error) {
        if (error instanceof SftpFailure) sftp.status(reqId, error.code)
        else sftp.status(reqId, STATUS.FAILURE)
      }
    }

    sftp.on('OPEN', (reqId, filename, flags, attrs) => {
      reply(reqId, () => {
        const flagsText = utils.sftp.flagsToString(flags)
        this.records.sftp.opens.push({ path: filename, mode: typeof attrs.mode === 'number' ? attrs.mode : null })
        this.fs.open(filename, flags, attrs)
        const id = nextHandle++
        handles.set(id, { path: this.fs.normalize(filename) })
        sftp.handle(reqId, bufferFromHandle(id))
        void flagsText
      })
    })

    sftp.on('READ', (reqId, handle, offset, len) => {
      reply(reqId, () => {
        const entry = requireHandle(handles, handle)
        this.records.sftp.reads += 1
        sftp.data(reqId, this.fs.readChunk(entry.path, offset, len))
      })
    })

    sftp.on('WRITE', (reqId, handle, offset, data) => {
      reply(reqId, () => {
        const entry = requireHandle(handles, handle)
        this.records.sftp.writes += 1
        this.fs.writeChunk(entry.path, offset, data)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('CLOSE', (reqId, handle) => {
      reply(reqId, () => {
        handles.delete(readHandle(handle))
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('FSTAT', (reqId, handle) => {
      reply(reqId, () => sftp.attrs(reqId, this.fs.attrs(requireHandle(handles, handle).path)))
    })

    sftp.on('STAT', (reqId, path) => {
      reply(reqId, () => sftp.attrs(reqId, this.fs.attrs(path)))
    })

    sftp.on('LSTAT', (reqId, path) => {
      reply(reqId, () => sftp.attrs(reqId, this.fs.attrs(path)))
    })

    sftp.on('SETSTAT', (reqId, path, attrs) => {
      reply(reqId, () => {
        this.fs.setstat(path, attrs)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('FSETSTAT', (reqId, handle, attrs) => {
      reply(reqId, () => {
        this.fs.setstat(requireHandle(handles, handle).path, attrs)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('OPENDIR', (reqId, path) => {
      reply(reqId, () => {
        this.records.sftp.readdirs.push(path)
        // 先确认目录存在，否则 OPENDIR 就该报错（readdir 的 NO_SUCH_FILE 语义）
        this.fs.attrs(path)
        const id = nextHandle++
        handles.set(id, { path: this.fs.normalize(path), dir: true })
        sftp.handle(reqId, bufferFromHandle(id))
      })
    })

    // READDIR 的 EOF 语义：ssh2 client 会反复 READDIR 直到 EOF。我们一次性返回全部名字，
    // 再让下一次 READDIR 回 EOF——顺序错了客户端会把目录读成空（或永远读不完）。
    sftp.on('READDIR', (reqId, handle) => {
      const id = readHandle(handle)
      if (dirHandlesPendingEof.has(id)) {
        dirHandlesPendingEof.delete(id)
        sftp.status(reqId, STATUS.EOF)
        return
      }
      reply(reqId, () => {
        const entry = requireHandle(handles, handle)
        if (!entry.dir) throw new SftpFailure(STATUS.FAILURE)
        const children = this.fs.list(entry.path)
        if (children.length === 0) {
          sftp.status(reqId, STATUS.EOF)
          return
        }
        const names: FileEntry[] = children.map((child) => ({
          filename: child.name,
          longname: longnameOf(child.attrs, child.name),
          attrs: child.attrs
        }))
        sftp.name(reqId, names)
        dirHandlesPendingEof.add(id)
      })
    })

    sftp.on('REMOVE', (reqId, path) => {
      reply(reqId, () => {
        this.records.sftp.removes.push(path)
        this.fs.unlink(path)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('MKDIR', (reqId, path, attrs) => {
      reply(reqId, () => {
        this.records.sftp.mkdirs.push({ path, mode: typeof attrs.mode === 'number' ? attrs.mode : null })
        this.fs.mkdir(path, attrs)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('RMDIR', (reqId, path) => {
      reply(reqId, () => {
        this.fs.rmdir(path)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('RENAME', (reqId, oldPath, newPath) => {
      reply(reqId, () => {
        this.records.sftp.renames.push({ from: oldPath, to: newPath })
        this.fs.rename(oldPath, newPath)
        sftp.status(reqId, STATUS.OK)
      })
    })

    sftp.on('REALPATH', (reqId, path) => {
      reply(reqId, () => {
        const resolved = this.fs.normalize(path)
        sftp.name(reqId, [
          {
            filename: resolved,
            longname: resolved,
            attrs: this.fs.has(resolved) ? this.fs.attrs(resolved) : { mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 4096, atime: 0, mtime: 0 }
          }
        ])
      })
    })

    sftp.on('READLINK', (reqId) => sftp.status(reqId, STATUS.OP_UNSUPPORTED))
    sftp.on('SYMLINK', (reqId) => sftp.status(reqId, STATUS.OP_UNSUPPORTED))

  }
}

function bufferFromHandle(id: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(id, 0)
  return buffer
}

function readHandle(handle: Buffer): number {
  return handle.readUInt32BE(0)
}

function requireHandle(handles: Map<number, { path: string; dir?: boolean }>, handle: Buffer): { path: string; dir?: boolean } {
  const entry = handles.get(readHandle(handle))
  if (!entry) throw new SftpFailure(STATUS.FAILURE)
  return entry
}

function longnameOf(attrs: Attributes, name: string): string {
  const isDir = (attrs.mode & 0o170000) === S_IFDIR
  const perm = (attrs.mode & 0o777).toString(8).padStart(3, '0')
  return `${isDir ? 'd' : '-'}rw-r--r-- 1 test test ${attrs.size} Jan 1 00:00 ${name} ${perm}`
}

/** 一个只接受 TCP 连接、永远不说 SSH 的服务器：用于确定性超时用例 */
export async function startSilentTcpServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('silent server failed to bind')
  return {
    port: address.port,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
