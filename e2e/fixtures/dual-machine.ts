import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 双机同步夹具 —— 一台本机、两份完全独立的 userData（A/B）+ 一个本地 bare git 仓库当远端。
 *
 * 为什么是「本地 bare 仓库」而不是 GitHub/HTTP：
 * - 用例必须离线可跑、不依赖凭证与网络，失败原因才唯一；
 * - bare 仓库是**真的 git 仓库**（`git init --bare`），`isomorphic-git` 走的是和真实远端同一套
 *   object/pack 格式，能测出「push 后 B 能不能真的读到同一份密文」；
 * - 用 `file://`/目录路径当 remote，不需要起 HTTP 服务，也就没有端口冲突与进程清理问题。
 *
 * 为什么是两份 userData 而不是两个进程：
 * 「双机」在 e2e 里的本质是**两套互不相干的本地数据目录**。用同一个 Electron 可执行文件、
 * 两次 `launchApp({ userDataDir: dirA / dirB })` 串行启动，就等价于两台机器；反过来同时开两个
 * 进程会让 Playwright 的 window 归属和 userData 锁都变复杂（S-07 是串行的 A→B 迁移，不需要并发）。
 *
 * 清理必须**断言目录真的删掉了**：`rmSync` 不会因为 `EBUSY`/权限问题就抛到让人看见（force 会吞掉一部分），
 * 而残留在 `os.tmpdir()` 里的 userData 会被下一次运行复用，症状是「上一次的设置还在」——假绿。
 */

export interface DualMachineContext {
  /** 本次用例的根目录；`dirA`/`dirB`/`bareRepo` 都在它下面，退出时整体删除 */
  root: string
  /** 机器 A 的 userData 目录（交给 `launchApp({ userDataDir: ctx.dirA })`） */
  dirA: string
  /** 机器 B 的 userData 目录 */
  dirB: string
  /** 本地 bare git 仓库的**路径**（当远端用；isomorphic-git 可直接用目录路径） */
  bareRepo: string
  /** 同一个 bare 仓库的 `file://` URL 形式（需要 URL 的接口用这个） */
  bareRepoUrl: string
}

function runGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`[dual-machine] git ${args.join(' ')} 失败（cwd=${cwd}）：${detail}`)
  }
}

/** 提前把「没有 git」变成一条明确的错误，而不是在用例里看见 `spawnSync git ENOENT` */
function assertGitAvailable(): void {
  try {
    execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    throw new Error('[dual-machine] 找不到 git 可执行文件：双机夹具需要系统 git 初始化 bare 仓库')
  }
}

function createDualMachine(): DualMachineContext {
  assertGitAvailable()
  const root = mkdtempSync(join(tmpdir(), 'termans-dual-'))
  const dirA = join(root, 'machine-a', 'userData')
  const dirB = join(root, 'machine-b', 'userData')
  const bareRepo = join(root, 'vault-remote.git')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })

  // --initial-branch=main：默认分支写死，别让宿主机的 init.defaultBranch 决定
  // （有些机器配了 master，A push 到 main、B clone 到 master 会让「同步成功但看不到数据」变成环境问题）
  runGit(['init', '--bare', '--initial-branch=main', bareRepo], root)

  return { root, dirA, dirB, bareRepo, bareRepoUrl: `file://${bareRepo}` }
}

function cleanupDualMachine(ctx: DualMachineContext): void {
  rmSync(ctx.root, { recursive: true, force: true })
  const leftovers = [ctx.root, ctx.dirA, ctx.dirB, ctx.bareRepo].filter((path) => existsSync(path))
  if (leftovers.length > 0) {
    throw new Error(`[dual-machine] 清理后仍有残留：${leftovers.join(', ')}`)
  }
}

/**
 * 用法：
 * ```ts
 * await withDualMachine(async ({ dirA, dirB, bareRepo }) => {
 *   const a = await launchApp({ userDataDir: dirA })
 *   // …A 改数据、push 到 bareRepo…
 *   await a.close()            // 注意：close 而不是 cleanup，userData 要留给 B 之前的那次运行
 *   const b = await launchApp({ userDataDir: dirB })
 *   // …B 从 bareRepo clone，断言看到同一份数据…
 *   await b.cleanup()
 * })
 * ```
 * 回调抛错时原始错误优先抛出（清理失败作为 `AggregateError` 的第二个成员保留），
 * 免得「清理失败」把真正的断言失败盖掉。
 */
export async function withDualMachine<T>(fn: (ctx: DualMachineContext) => Promise<T>): Promise<T> {
  const ctx = createDualMachine()
  let result: T | undefined
  let failure: unknown
  let failed = false

  try {
    result = await fn(ctx)
  } catch (error) {
    failed = true
    failure = error
  }

  try {
    cleanupDualMachine(ctx)
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError([failure, cleanupError], '[dual-machine] 用例失败，且临时目录清理也失败')
    }
    throw cleanupError
  }

  if (failed) throw failure
  return result as T
}
