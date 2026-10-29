import * as fs from 'node:fs'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import git from 'isomorphic-git'
import httpClient from 'isomorphic-git/http/node'
import { vaultFail } from '../vault/errors'
import { Mutex } from './mutex'

/**
 * Git 管道层（isomorphic-git，纯 JS，不依赖系统 git）。
 *
 * 为什么不 shell 出去调 `git`：应用要覆盖 Windows/macOS/Linux，用户机器上不一定有 git，
 * 而且我们要能对「单文件密文仓库」做精细的乐观锁判断 —— 自己拿 ref/oid 更直接。
 *
 * 这里只做「怎么和远端说话」，不做任何业务判断（revision 比较、冲突合并都在 sync.ts）。
 */

export interface GitAuthor {
  name: string
  email: string
}

export interface GitEngineOptions {
  dir: string
  author?: GitAuthor
  timeoutMs?: number
  /** 允许注入 http 客户端（测试里可换成包装过的，便于统计请求） */
  http?: typeof httpClient
}

export interface RepoStatus {
  branch: string | null
  head: string | null
  clean: boolean
  changedFiles: string[]
}

export interface RemoteAuth {
  /** 明文 token（只在本机内存里短暂存在，来自 SecretBox 或密文包） */
  token: string | null
  username?: string | null
}

const DEFAULT_AUTHOR: GitAuthor = { name: 'Termans', email: 'vault@termans.local' }

export class GitEngine {
  private readonly dir: string
  private readonly author: GitAuthor
  private readonly timeoutMs: number
  private readonly http: typeof httpClient
  private readonly fsModule = fs
  private readonly mutex = new Mutex()

  constructor(options: GitEngineOptions) {
    this.dir = options.dir
    this.author = options.author ?? DEFAULT_AUTHOR
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.http = options.http ?? httpClient
  }

  /**
   * 所有对仓库目录的 git 操作都必须经此排队。
   *
   * 队列放在 engine 上（而不是各个调用方各拿一把锁），因为「同一目录」才是唯一需要互斥的资源：
   * clone / align 会 `rmSync` 整个工作树，与任何并发的 commit / checkout / push 撞上就会丢文件。
   */
  async withLock<T>(task: () => Promise<T> | T): Promise<T> {
    return this.mutex.run(task)
  }

  /** 排队中的任务数（诊断/测试用） */
  get lockQueueSize(): number {
    return this.mutex.size
  }

  isRepo(): boolean {
    return existsSync(join(this.dir, '.git'))
  }

  async ensureRepo(defaultBranch: string): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    if (this.isRepo()) return
    await git.init({ fs: this.fsModule, dir: this.dir, defaultBranch })
  }

  async status(): Promise<RepoStatus> {
    if (!this.isRepo()) return { branch: null, head: null, clean: true, changedFiles: [] }
    const branch = await git.currentBranch({ fs: this.fsModule, dir: this.dir, fullname: false })
    const head = await this.head()
    const matrix = await git.statusMatrix({ fs: this.fsModule, dir: this.dir })
    const changedFiles: string[] = []
    for (const [filepath, headStatus, workdirStatus, stageStatus] of matrix) {
      if (headStatus === 1 && workdirStatus === 1 && stageStatus === 1) continue
      changedFiles.push(filepath)
    }
    return { branch: branch ?? null, head, clean: changedFiles.length === 0, changedFiles: changedFiles.sort() }
  }

  async head(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fsModule, dir: this.dir, ref: 'HEAD' })
    } catch {
      return null
    }
  }

  /** 提交工作区全部改动；没有改动时返回 null（不产生空提交） */
  async commitAll(message: string, branch?: string): Promise<string | null> {
    await this.ensureRepo(branch ?? 'main')
    const matrix = await git.statusMatrix({ fs: this.fsModule, dir: this.dir })
    const dirty: [string, number, number, number][] = []
    for (const row of matrix) {
      const [filepath, headStatus, workdirStatus, stageStatus] = row
      if (headStatus === 1 && workdirStatus === 1 && stageStatus === 1) continue
      dirty.push([filepath, headStatus, workdirStatus, stageStatus])
    }
    if (dirty.length === 0) return null
    for (const [filepath, headStatus, workdirStatus] of dirty) {
      if (workdirStatus === 0) {
        if (headStatus !== 0) await git.remove({ fs: this.fsModule, dir: this.dir, filepath })
        continue
      }
      await git.add({ fs: this.fsModule, dir: this.dir, filepath })
    }
    return git.commit({ fs: this.fsModule, dir: this.dir, message, author: this.author })
  }

  async setRemote(url: string): Promise<void> {
    const existing = await git.listRemotes({ fs: this.fsModule, dir: this.dir })
    if (existing.some((remote) => remote.remote === 'origin')) {
      await git.deleteRemote({ fs: this.fsModule, dir: this.dir, remote: 'origin' })
    }
    await git.addRemote({ fs: this.fsModule, dir: this.dir, remote: 'origin', url })
  }

  async getRemoteUrl(): Promise<string | null> {
    if (!this.isRepo()) return null
    const remotes = await git.listRemotes({ fs: this.fsModule, dir: this.dir })
    return remotes.find((remote) => remote.remote === 'origin')?.url ?? null
  }

  /**
   * clone 到 `dir`。
   *
   * `noCheckout: true` 是刻意的：isomorphic-git 的 clone 收尾会自己做一次**非 force** 的 checkout，
   * 于是「目录里已经有 manifest.json / vault.enc（用户刚建的空库）」时会抛
   * `CheckoutConflictError: Your local changes to the following files would be overwritten by checkout`
   * ——这正是 S-07「双机迁移」在新机上 100% 失败的原因（见 sync.ts 的首次对齐）。
   * 改成「只拉对象与 ref，工作区由我们 force checkout 决定」，语义更可控。
   */
  async clone(url: string, branch: string, auth: RemoteAuth): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    try {
      await this.guard(
        git.clone({
          fs: this.fsModule,
          http: this.http,
          dir: this.dir,
          url,
          ref: branch,
          singleBranch: true,
          noCheckout: true,
          onAuth: makeOnAuth(auth)
        }),
        'clone'
      )
      await this.checkout(branch)
    } catch (error) {
      throw toGitError(error, 'clone failed')
    }
  }

  /** 拉取远端分支到 `refs/remotes/origin/<branch>`，返回远端 head sha（远端为空时 null） */
  async fetch(url: string, branch: string, auth: RemoteAuth): Promise<string | null> {
    try {
      await this.guard(
        git.fetch({
          fs: this.fsModule,
          http: this.http,
          dir: this.dir,
          url,
          ref: branch,
          remote: 'origin',
          remoteRef: branch,
          singleBranch: true,
          onAuth: makeOnAuth(auth)
        }),
        'fetch'
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 远端还是空仓库（连一个 ref 都没有）时，isomorphic-git 会报 NotFoundError
      if (/could not find|not found|NotFound|no such ref/i.test(message)) return null
      throw toGitError(error, 'fetch failed')
    }
    return this.resolveRefQuiet(`refs/remotes/origin/${branch}`)
  }

  async push(url: string, branch: string, auth: RemoteAuth): Promise<void> {
    try {
      await this.guard(
        git.push({
          fs: this.fsModule,
          http: this.http,
          dir: this.dir,
          url,
          ref: branch,
          remoteRef: branch,
          onAuth: makeOnAuth(auth)
        }),
        'push'
      )
    } catch (error) {
      throw toGitError(error, 'push failed')
    }
  }

  async resolveRefQuiet(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fsModule, dir: this.dir, ref })
    } catch {
      return null
    }
  }

  /** 快进到远端（要求 local head 是远端祖先，否则 isomorphic-git 会拒绝） */
  async fastForward(branch: string): Promise<void> {
    await git.merge({
      fs: this.fsModule,
      dir: this.dir,
      ours: `refs/heads/${branch}`,
      theirs: `refs/remotes/origin/${branch}`,
      fastForwardOnly: true,
      author: this.author
    })
    await this.checkout(branch)
  }

  /** 把本地分支硬指到某个 oid 并刷新工作区（冲突合并后「rebase 到远端之上」用） */
  async resetTo(branch: string, oid: string): Promise<void> {
    await git.writeRef({ fs: this.fsModule, dir: this.dir, ref: `refs/heads/${branch}`, value: oid, force: true })
    await this.checkout(branch)
  }

  async checkout(branch: string): Promise<void> {
    await git.checkout({ fs: this.fsModule, dir: this.dir, ref: branch, force: true })
  }

  async currentBranch(): Promise<string | null> {
    if (!this.isRepo()) return null
    const branch = await git.currentBranch({ fs: this.fsModule, dir: this.dir, fullname: false })
    return branch ?? null
  }

  /** 读取某个提交上的文件内容（乐观锁判断用：不 checkout 也能看远端 manifest） */
  async readFileAt(oid: string, filepath: string): Promise<Buffer | null> {
    try {
      const result = await git.readBlob({ fs: this.fsModule, dir: this.dir, oid, filepath })
      return Buffer.from(result.blob)
    } catch {
      return null
    }
  }

  async log(depth = 10): Promise<{ oid: string; message: string; timestamp: number }[]> {
    if (!this.isRepo()) return []
    try {
      const commits = await git.log({ fs: this.fsModule, dir: this.dir, depth })
      return commits.map((commit) => ({
        oid: commit.oid,
        message: commit.commit.message.trim(),
        timestamp: commit.commit.author.timestamp * 1000
      }))
    } catch {
      return []
    }
  }

  private async guard<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(vaultFail('E_NETWORK', `git ${label} timed out after ${this.timeoutMs}ms`, { reason: 'git', label }))
      }, this.timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

function makeOnAuth(auth: RemoteAuth): (() => { username: string; password?: string }) | undefined {
  if (auth.token === null || auth.token.trim() === '') return undefined
  const token = auth.token.trim()
  return () => ({ username: auth.username ?? 'termans', password: token })
}

/**
 * 远端 ref 锁冲突：并发推送时 bare 仓库对同一 ref 短暂加锁，isomorphic-git 会报
 * `One or more branches were not updated: refs/heads/main: reference already exists`
 * ——但提交其实已经落到远端。这类错误是**可重试**的，交给 sync.ts 做有限次退避重试。
 */
export function isRefLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const detail = (error as { details?: { detail?: unknown } } | null)?.details?.detail
  const combined = `${message} ${typeof detail === 'string' ? detail : ''}`
  return /reference already exists|were not updated|cannot lock ref|failed to lock|ref .{0,80}is locked|lock ref/i.test(combined)
}

/** 网络/认证/冲突错误统一成 E_GIT（details 保留原始 message 供排查，但绝不带 token） */
function toGitError(error: unknown, label: string): Error {
  if (error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return error
  }
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.replace(/(https?:\/\/)[^@\s]+@/g, '$1***@')
  if (/401|403|authentication|unauthorized|invalid credentials/i.test(message)) {
    return vaultFail('E_UNAUTHORIZED', `${label}: authentication failed`, { reason: 'git', detail: message })
  }
  if (/rejected|non-fast-forward|not fast-forward|cannot push/i.test(message)) {
    return vaultFail('E_CONFLICT', `${label}: remote rejected the push (non-fast-forward)`, { reason: 'conflict', detail: message })
  }
  return vaultFail('E_GIT', `${label}: ${message}`, { reason: 'git', detail: message })
}
