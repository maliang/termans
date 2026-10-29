import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { basename, dirname, join } from 'node:path'

/**
 * 把一个**已存在的** bare 仓库挂到 HTTP 上（smart HTTP 的最小实现）。
 *
 * 为什么必须走 HTTP：产品用 `isomorphic-git` 同步，它的传输层只认 http(s)
 * （`file://` 抛 `UnknownTransportError: unrecognized transport protocol: "file"`），
 * 所以「A 机 push → B 机 pull」只能真的过一次网络。这里不实现 pack 协议，
 * 而是把请求转给系统 `git upload-pack / receive-pack --stateless-rpc`，
 * 于是被测代码走的是**真实的** http 路径，我们只是提供了服务端。
 *
 * 与 `src/main/git/test-git-server.ts` 的区别：那个会自己 `git init --bare` 一个临时库，
 * 只服务于单元测试；e2e 需要的是「挂载 `withDualMachine()` 已经建好的那个库」，
 * 所以这里按同样的转发方式另写一个薄封装（`src/**` 不在 e2e 任务的可改范围内）。
 */
export interface GitHttpGateway {
  /** 形如 `http://127.0.0.1:53211/remote.git`，直接填进同步面板的远端地址 */
  url: string
  close(): Promise<void>
}

/**
 * 跑一条 git 子进程命令，安全地把 `input` 写进 stdin。
 *
 * 为什么要这么小心翼翼：git 常常**先退出**再轮到我们写 stdin（`receive-pack` 拒绝一个
 * 非快进 push、参数错误、仓库不存在……）。进程一退，写端 socket 就关了，`stdin.end()`
 * 会抛 `EPIPE`，而 `ChildProcess.stdin` 是 `Socket`——没人监听它的 `'error'` 时，这个
 * EPIPE 会升级成**进程级 uncaughtException**。vitest 的表现就是「Tests 622 passed
 * 全绿，但 Utilities 报 1 error，进程 exit code = 1」，而调用方什么都看不到。
 *
 * 三条纪律：
 * 1. `'error'` 监必须在写之前挂上，且 EPIPE / ECONNRESET / ERR_STREAM_DESTROYED 一律吞掉
 *    ——写失败不代表命令失败，命令的成败只由 `execFile` 的 callback 判定；
 * 2. 写之前判 `destroyed`，并且在 try/catch 里写（某些平台下 `end()` 会同步抛）；
 * 3. `resolve/reject` 用一次性闸门，避免「流 error 先 reject、callback 又 reject」双触发。
 */
function runGit(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      finish()
    }

    const child = execFile('git', args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
      if (error) settle(() => reject(error))
      else settle(() => resolve(stdout))
    })

    // 必须在 end()/write() 之前挂：晚挂一个 tick 都可能已经错过 error 事件。
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (isBrokenPipe(error)) return
      settle(() => reject(error))
    })

    const stdin = child.stdin
    if (stdin === null || stdin === undefined || stdin.destroyed) return
    try {
      stdin.end(input ?? Buffer.alloc(0))
    } catch (error) {
      if (!isBrokenPipe(error as NodeJS.ErrnoException)) settle(() => reject(error))
    }
  })
}

/** 写端已断的几种错误码：对夹具来说都只是「写不进去」，不是命令失败 */
function isBrokenPipe(error: NodeJS.ErrnoException | null | undefined): boolean {
  const code = error?.code
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ERR_STREAM_DESTROYED'
}

/** smart HTTP 的广告响应前面要带 `# service=…` 这行 pkt-line，少了它客户端会当成 dumb http */
function pktLine(text: string): Buffer {
  const length = Buffer.byteLength(text) + 4
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), Buffer.from(text)])
}

export async function serveBareRepo(bareDir: string): Promise<GitHttpGateway> {
  const root = dirname(bareDir)
  const name = basename(bareDir)

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const service =
      url.searchParams.get('service') ?? (url.pathname.includes('git-upload-pack') ? 'git-upload-pack' : 'git-receive-pack')
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end(`unsupported service: ${service}`)
      return
    }
    const subcommand = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'
    const repoDir = decodeURIComponent(url.pathname.replace(/\/(info\/refs|git-receive-pack|git-upload-pack)$/, ''))
    const target = join(root, repoDir)
    if (target !== bareDir) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end(`no such repo: ${repoDir}`)
      return
    }

    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const isAdvertisement = request.method === 'GET'
      const args = isAdvertisement
        ? [subcommand, '--stateless-rpc', '--advertise-refs', target]
        : [subcommand, '--stateless-rpc', target]
      runGit(args, isAdvertisement ? undefined : Buffer.concat(chunks))
        .then((output) => {
          if (isAdvertisement) {
            response.writeHead(200, { 'content-type': `application/x-${service}-advertisement` })
            response.end(Buffer.concat([pktLine(`# service=${service}\n`), Buffer.from('0000'), output]))
            return
          }
          response.writeHead(200, { 'content-type': `application/x-${service}-result` })
          response.end(output)
        })
        .catch((error: unknown) => {
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.end(error instanceof Error ? error.message : String(error))
        })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  return {
    url: `http://127.0.0.1:${port}/${name}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
