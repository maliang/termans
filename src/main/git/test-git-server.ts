import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 测试用的最小 smart-HTTP Git 服务（只被 `*.test.ts` 引用，不进打包产物）。
 *
 * 为什么要这个：`isomorphic-git` 的传输层只认 http/https（`file://` 会抛
 * `UnknownTransportError: ... unrecognized transport protocol: "file"`），
 * 所以「临时 bare 仓库」的 A→B 迁移测试必须真的走一次 HTTP。
 * 这里不自己实现 pack 协议，而是把请求转给系统 `git upload-pack / receive-pack --stateless-rpc`，
 * 于是被测代码用的是**真实的** http 客户端路径。
 */
export interface TestGitServer {
  root: string
  bareDir: string
  url: string
  close(): Promise<void>
}

function runGit(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
    child.stdin?.end(input ?? Buffer.alloc(0))
  })
}

/** 同步跑一条 git 命令（验收/断言用，例如 `ls-tree`、`show`） */
export function gitCli(args: string[]): string {
  const result = spawnSync('git', args, { maxBuffer: 128 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr)}`)
  return result.stdout?.toString('utf8') ?? ''
}

function pktLine(text: string): Buffer {
  const length = Buffer.byteLength(text) + 4
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), Buffer.from(text)])
}

function serviceFor(method: string, url: URL): { service: string; repoDir: string } {
  // GET 用 ?service=...，POST 用路径后缀；写反会得到 "expected old/new/ref, got 'want ...'"
  const service =
    url.searchParams.get('service') ?? (url.pathname.includes('git-upload-pack') ? 'git-upload-pack' : 'git-receive-pack')
  const clean = decodeURIComponent(url.pathname.replace(/\/(info\/refs|git-receive-pack|git-upload-pack)$/, ''))
  void method
  return { service, repoDir: clean }
}

export async function startTestGitServer(): Promise<TestGitServer> {
  const root = mkdtempSync(join(tmpdir(), 'termans-git-'))
  const bareDir = join(root, 'remote.git')
  await runGit(['init', '--bare', '-b', 'main', bareDir])

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const { service, repoDir } = serviceFor(request.method ?? 'GET', url)
    const subcommand = service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'
    const target = join(root, repoDir)
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const isAdvertisement = request.method === 'GET'
      const args = isAdvertisement ? [subcommand, '--stateless-rpc', '--advertise-refs', target] : [subcommand, '--stateless-rpc', target]
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
    root,
    bareDir,
    url: `http://127.0.0.1:${port}/remote.git`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
