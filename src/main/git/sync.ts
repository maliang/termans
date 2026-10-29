import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import gitClient from 'isomorphic-git'
import { join } from 'node:path'
import {
  type ConflictStrategy,
  type SyncBootstrapRequest,
  type SyncConflict,
  type SyncRepo,
  type SyncResolveRequest,
  type SyncState,
  type SyncStatus
} from '@shared'
import { openVault, sha256Hex, vaultManifestSchema, type VaultManifest } from '../crypto'
import { vaultFail, lockedError } from '../vault/errors'
import { parsePayload, type VaultPayload } from '../vault/model'
import type { VaultManager } from '../vault/manager'
import { ENVELOPE_FILE, MANIFEST_FILE, THEMES_DIR, readRepo } from '../vault/repo'
import { writePrivateFile, type SecretBox } from '../vault/secret-box'
import { GitEngine, type RemoteAuth } from './engine'
import {
  applyStrategy,
  clearConflictState,
  loadConflictState,
  mergePayloads,
  saveConflictState,
  writeConflictSnapshots,
  type ConflictState
} from './conflicts'

/**
 * 同步协调器：WebDAV 式的「乐观锁」同步。
 *
 * 为什么不能靠 git 合并：`vault.enc` 是整份密文，两个人都改过之后 git 只能二选一（或整份冲突）。
 * 所以：
 * 1. 用 `manifest.json`（明文）里的 `revision` + `payload_sha256` 判断「远端到底有没有前进」；
 * 2. 本地干净 → 直接快进（fast-forward）；
 * 3. 本地有改动且远端前进 → **先解密再三方合并**（base 是上次同步时存下的密文副本），
 *    逐字段产出冲突；绝不静默覆盖；
 * 4. 合并结果以「rebase 到远端之上 + 一次提交」的形式推回去，保证远端是快进而不是强推。
 */
export interface SyncCoordinatorOptions {
  repoDir: string
  localDir: string
  manager: VaultManager
  box: SecretBox
  engine?: GitEngine
  clock?: () => number
  onStatus?: (status: SyncStatus) => void
  commitMessage?: (revision: number) => string
}

const DEFAULT_BRANCH = 'main'

const { isDescendent } = gitClient

export class SyncCoordinator {
  private readonly options: SyncCoordinatorOptions
  private readonly engine: GitEngine
  private readonly manager: VaultManager
  private readonly box: SecretBox

  private state: SyncState = 'off'
  private error: string | null = null
  private localCommit: string | null = null
  private remoteCommit: string | null = null
  private pendingLocalChanges = 0
  private pending: ConflictState | null = null
  private lastSyncedAt: string | null = null

  constructor(options: SyncCoordinatorOptions) {
    this.options = options
    this.manager = options.manager
    this.box = options.box
    mkdirSync(options.localDir, { recursive: true, mode: 0o700 })
    this.engine =
      options.engine ??
      new GitEngine({
        dir: options.repoDir,
        author: { name: 'Termans', email: 'vault@termans.local' }
      })
    this.pending = loadConflictState(options.localDir, options.box)
    const repo = this.repo()
    this.state = repo === null ? 'off' : this.pending === null ? 'idle' : 'diverged'
    this.lastSyncedAt = this.manager.status().lastSyncedAt
  }

  /* ------------------------------------------------------------------ */
  /* 状态                                                                */
  /* ------------------------------------------------------------------ */

  status(): SyncStatus {
    const repo = this.repo()
    return {
      state: this.state,
      repo,
      localCommit: this.localCommit,
      remoteCommit: this.remoteCommit,
      pendingLocalChanges: this.pendingLocalChanges,
      conflictCount: this.pending?.conflicts.length ?? 0,
      lastSyncedAt: this.lastSyncedAt,
      error: this.error
    }
  }

  /** 读一次真实 git 状态（`sync:status` 用；不要在 status() 里做 IO） */
  async refresh(): Promise<SyncStatus> {
    const repo = this.repo()
    if (repo === null) {
      this.state = 'off'
      return this.status()
    }
    try {
      const st = await this.engine.status()
      this.localCommit = st.head
      this.pendingLocalChanges = st.changedFiles.length
      this.remoteCommit = await this.engine.resolveRefQuiet(`refs/remotes/origin/${repo.branch}`)
      if (this.pending !== null) this.state = 'diverged'
      else if (this.pendingLocalChanges > 0) this.state = 'ahead'
      else if (this.state !== 'error' && this.state !== 'syncing') this.state = 'idle'
    } catch (error) {
      this.fail(error)
    }
    return this.status()
  }

  conflicts(): SyncConflict[] {
    return (this.pending?.conflicts ?? []).map((conflict) => ({
      id: conflict.id,
      kind: conflict.kind,
      entityId: conflict.entityId,
      label: conflict.label,
      path: conflict.path,
      localUpdatedAt: conflict.localUpdatedAt,
      remoteUpdatedAt: conflict.remoteUpdatedAt,
      localSummary: conflict.localSummary,
      remoteSummary: conflict.remoteSummary
    }))
  }

  /* ------------------------------------------------------------------ */
  /* 仓库配置 / 首次接入                                                  */
  /* ------------------------------------------------------------------ */

  private repo(): SyncRepo | null {
    return this.manager.status().repo
  }

  private requireRepo(): SyncRepo {
    const repo = this.repo()
    if (repo === null) {
      throw vaultFail('E_INVALID_ARGUMENT', 'sync repository is not configured', { reason: 'git', field: 'remoteUrl' })
    }
    return repo
  }

  private async auth(repo: SyncRepo): Promise<RemoteAuth> {
    if (repo.auth === 'none') return { token: null }
    const fromVault = this.manager.isUnlocked() ? this.manager.payloadForSync().integrations.gitToken : null
    const token = fromVault ?? this.readLocalToken()
    return { token }
  }

  private readLocalToken(): string | null {
    // Git token 正常应该进密文包（随 vault 同步）；本机兜底读 credentials.json，
    // 由 feature 层通过 credentials:set('git:token') 写入。
    try {
      const path = join(this.options.localDir, 'credentials.json')
      if (!existsSync(path)) return null
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Record<string, string> }
      const sealed = raw.entries?.['git:token']
      if (sealed === undefined) return null
      return this.box.decrypt(sealed)
    } catch {
      return null
    }
  }

  /**
   * 首次接入：
   * - 远端空 → 把本地密文提交并推上去；
   * - 本地空 → clone 远端（B 机拿到的是密文，仍需要主口令解锁）；
   * - 两边都有 → 走 pull 的乐观锁流程。
   */
  async bootstrap(request: SyncBootstrapRequest): Promise<SyncStatus> {
    if (request.auth === 'ssh-agent') {
      throw vaultFail('E_INVALID_ARGUMENT', 'ssh-agent transport is not supported yet; use a token or a plain http remote', {
        reason: 'git',
        field: 'auth'
      })
    }
    const repo: SyncRepo = { remoteUrl: request.remoteUrl, branch: request.branch || DEFAULT_BRANCH, auth: request.auth }
    this.manager.setRepo(repo)

    this.state = 'syncing'
    this.emit()
    try {
      await this.engine.ensureRepo(repo.branch)
      await this.engine.setRemote(repo.remoteUrl)
      const auth = await this.auth(repo)
      const remoteHead = await this.engine.fetch(repo.remoteUrl, repo.branch, auth)
      const localHead = await this.engine.head()

      if (remoteHead === null) {
        // 远端还是空的：本地必须已经有 vault，否则用户其实还没创建
        if (!existsSync(join(this.options.repoDir, MANIFEST_FILE))) {
          throw vaultFail('E_INVALID_ARGUMENT', 'vault must be created before the first push', { reason: 'uninitialized' })
        }
        const oid = await this.engine.commitAll('termans: publish vault', repo.branch)
        await this.engine.push(repo.remoteUrl, repo.branch, auth)
        this.localCommit = oid ?? (await this.engine.head())
        await this.finishSync('idle')
        return this.status()
      }

      if (localHead === null) {
        // 本地还没有任何提交：B 机迁移路径（详见 alignFreshFromRemote 的安全前提）
        return await this.alignFreshFromRemote(repo, remoteHead, auth)
      }

      return await this.pull()
    } catch (error) {
      this.fail(error)
      throw this.errorOr(error)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 提交 / 拉取 / 推送                                                   */
  /* ------------------------------------------------------------------ */

  /** 只提交本地改动（网络离线也能提交；推送由 push() 负责） */
  async commitLocal(message = 'termans: update vault'): Promise<string | null> {
    const repo = this.repo()
    if (repo === null) return null
    await this.engine.ensureRepo(repo.branch)
    const oid = await this.engine.commitAll(message, repo.branch)
    if (oid !== null) {
      this.localCommit = oid
      this.pendingLocalChanges = 0
      this.emit()
    }
    return oid
  }

  async pull(): Promise<SyncStatus> {
    const repo = this.requireRepo()
    this.state = 'syncing'
    this.error = null
    this.emit()
    try {
      const auth = await this.auth(repo)
      const remoteHead = await this.engine.fetch(repo.remoteUrl, repo.branch, auth)
      const localHead = await this.engine.head()
      this.localCommit = localHead
      this.remoteCommit = remoteHead

      if (remoteHead === null) {
        // 远端还什么都没有：本地有内容就推上去，没有就保持 idle
        if (localHead !== null) await this.engine.push(repo.remoteUrl, repo.branch, auth)
        await this.finishSync('idle')
        return this.status()
      }
      if (remoteHead === localHead) {
        await this.finishSync('idle')
        return this.status()
      }
      if (localHead === null) {
        // 本机还没有任何提交（典型：新建了空库就点同步）。此时没有「本地历史」可以合并，
        // 唯一合法动作是把工作区对齐到远端 —— 但必须先确认本地没有值得保留的数据。
        return await this.alignFreshFromRemote(repo, remoteHead, auth)
      }

      const st = await this.engine.status()
      this.pendingLocalChanges = st.changedFiles.length

      const remote = await this.readRemoteVault(remoteHead)
      const localRepo = readRepo(this.options.repoDir)

      if (st.clean && localRepo !== null && remote.manifest.revision <= localRepo.manifest.revision && (await this.canFastForward(localHead, remoteHead))) {
        await this.fastForward(repo.branch)
        await this.finishSync('idle')
        return this.status()
      }

      if (st.clean && localHead !== null && (await this.canFastForward(localHead, remoteHead))) {
        await this.fastForward(repo.branch)
        await this.manager.reload()
        await this.finishSync('idle')
        return this.status()
      }

      return await this.mergeFlow(repo, remoteHead, auth)
    } catch (error) {
      this.fail(error)
      throw this.errorOr(error)
    }
  }

  async push(): Promise<SyncStatus> {
    const repo = this.requireRepo()
    if (this.pending !== null && this.pending.conflicts.length > 0) {
      throw vaultFail('E_CONFLICT', 'unresolved sync conflicts must be resolved before pushing', {
        reason: 'conflict',
        conflictCount: this.pending.conflicts.length
      })
    }
    this.state = 'syncing'
    this.error = null
    this.emit()
    try {
      const auth = await this.auth(repo)
      const headBeforeCommit = await this.engine.head()
      const remoteHead = await this.engine.fetch(repo.remoteUrl, repo.branch, auth)
      if (headBeforeCommit === null && remoteHead !== null) {
        // 本地空库 + 远端有内容：推只会造出一个无关历史的提交（随后必然冲突）。先对齐再谈推送。
        return await this.alignFreshFromRemote(repo, remoteHead, auth)
      }
      const committed = await this.engine.commitAll(this.options.commitMessage?.(this.revision()) ?? 'termans: update vault', repo.branch)
      const localHead = (await this.engine.head()) ?? committed
      this.localCommit = localHead
      this.remoteCommit = remoteHead

      if (remoteHead !== null && remoteHead !== localHead) {
        if (await this.canFastForward(localHead, remoteHead)) {
          await this.fastForward(repo.branch)
          await this.manager.reload()
        } else {
          const merged = await this.mergeFlow(repo, remoteHead, auth)
          if (merged.state === 'diverged') {
            throw vaultFail('E_CONFLICT', 'remote has conflicting changes', {
              reason: 'conflict',
              conflictCount: merged.conflictCount
            })
          }
          return merged
        }
      }

      await this.engine.push(repo.remoteUrl, repo.branch, auth)
      await this.finishSync('idle')
      return this.status()
    } catch (error) {
      this.fail(error)
      throw this.errorOr(error)
    }
  }

  /* ------------------------------------------------------------------ */
  /* 冲突解决                                                            */
  /* ------------------------------------------------------------------ */

  async resolve(request: SyncResolveRequest): Promise<SyncStatus> {
    if (this.pending === null) {
      this.pending = loadConflictState(this.options.localDir, this.box)
    }
    if (this.pending === null) {
      throw vaultFail('E_NOT_FOUND', 'no pending sync conflict', { reason: 'not-found', conflictId: request.conflictId })
    }
    const conflict = this.pending.conflicts.find((item) => item.id === request.conflictId)
    if (conflict === undefined) {
      throw vaultFail('E_NOT_FOUND', `unknown conflict: ${request.conflictId}`, {
        reason: 'not-found',
        conflictId: request.conflictId
      })
    }
    if (!this.manager.isUnlocked()) throw lockedError()

    applyStrategy(this.pending.merged, conflict, request.strategy as ConflictStrategy)
    this.pending.conflicts = this.pending.conflicts.filter((item) => item.id !== request.conflictId)

    if (this.pending.conflicts.length > 0) {
      saveConflictState(this.options.localDir, this.box, this.pending)
      this.state = 'diverged'
      this.emit()
      return this.status()
    }

    // 全部解决完：写回密文、提交、推到远端（rebase 过远端，所以是快进）
    const repo = this.requireRepo()
    const merged = this.pending.merged
    this.manager.applyMergedPayload(merged)
    await this.engine.commitAll('termans: resolve sync conflicts', repo.branch)
    const auth = await this.auth(repo)
    try {
      await this.engine.push(repo.remoteUrl, repo.branch, auth)
    } catch (error) {
      this.fail(error)
      throw vaultFail('E_GIT', 'failed to push the merged vault; the remote may have moved again', {
        reason: 'git',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
    this.pending = null
    clearConflictState(this.options.localDir)
    await this.finishSync('idle')
    return this.status()
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  private revision(): number {
    return this.manager.manifestForSync()?.revision ?? 0
  }

  /**
   * 「本机空库 + 远端有内容」的首次对齐（S-07 双机迁移的唯一合法入口）。
   *
   * 为什么需要它：App 要求先建库解锁才能进主界面，而新机又要从远端拉库 —— 这两件事本来是互斥的。
   * 建库会写出 `manifest.json` / `vault.enc`（未提交），随后的 clone 内部 checkout 会以
   * `CheckoutConflictError: Your local changes … would be overwritten by checkout` 整条失败。
   *
   * 安全前提（绝不静默覆盖用户数据）：
   * 1. 只有在 `localHead === null`（本机从未提交过）时才允许走这里；
   * 2. 未初始化（还没建库）→ 放行；
   * 3. 已解锁 → 逐项数本地条数（主机/分组/known_hosts/片段/主题/ssh_config 文本），有任意一条就拒；
   * 4. 锁定 → 拒绝并要求先解锁（否则无法确认「本地没东西可丢」）。
   *
   * 对齐后本地陈列的就是远端那份密文，因此会**锁上**并要求用同一主口令解锁 —— 这是刻意的：
   * 内存里那把 VMK 属于刚建的空库，解不开远端的 payload。
   */
  private async alignFreshFromRemote(repo: SyncRepo, remoteHead: string, auth: RemoteAuth): Promise<SyncStatus> {
    this.assertNothingLocalToLose()

    // 丢掉刚建的空库留下的未提交文件（远端树里也就这三样），否则 force checkout 会覆盖/报错
    rmSync(join(this.options.repoDir, MANIFEST_FILE), { force: true })
    rmSync(join(this.options.repoDir, ENVELOPE_FILE), { force: true })
    rmSync(join(this.options.repoDir, THEMES_DIR), { recursive: true, force: true })
    rmSync(join(this.options.repoDir, '.git'), { recursive: true, force: true })

    await this.engine.clone(repo.remoteUrl, repo.branch, auth)
    this.manager.reload()
    this.localCommit = await this.engine.head()
    this.remoteCommit = remoteHead
    this.pendingLocalChanges = 0
    await this.finishSync('idle')
    return this.status()
  }

  /** 首次对齐前的「本地无可丢失数据」断言；有数据一律 E_CONFLICT，绝不覆盖 */
  private assertNothingLocalToLose(): void {
    const state = this.manager.status().state
    if (state === 'uninitialized') return
    if (!this.manager.isUnlocked()) {
      throw vaultFail('E_VAULT_LOCKED', 'unlock the vault first: the local library must be checked before aligning with the remote', {
        reason: 'locked'
      })
    }
    const payload = this.manager.payloadForSync()
    const localItems =
      payload.hosts.length +
      payload.groups.length +
      payload.knownHosts.length +
      payload.snippets.length +
      payload.themes.length +
      (payload.sshConfig.text.trim() === '' ? 0 : 1)
    if (localItems > 0) {
      throw vaultFail(
        'E_CONFLICT',
        `this machine already holds ${localItems} local item(s); push them to the remote first, or import them elsewhere before pulling`,
        { reason: 'conflict', localItems }
      )
    }
  }

  private async canFastForward(localHead: string | null, remoteHead: string): Promise<boolean> {
    if (localHead === null) return true
    try {
      return await isDescendent({
        fs: nodeFs,
        dir: this.options.repoDir,
        oid: remoteHead,
        ancestor: localHead
      })
    } catch {
      return false
    }
  }

  private async fastForward(branch: string): Promise<void> {
    await this.engine.fastForward(branch)
    await this.manager.reload()
  }

  private async readRemoteVault(oid: string): Promise<{ manifest: VaultManifest; encBytes: Buffer }> {
    const manifestBytes = await this.engine.readFileAt(oid, MANIFEST_FILE)
    const encBytes = await this.engine.readFileAt(oid, ENVELOPE_FILE)
    if (manifestBytes === null || encBytes === null) {
      throw vaultFail('E_GIT', 'remote commit does not contain a termans vault', { reason: 'git', commit: oid })
    }
    const parsed = vaultManifestSchema.safeParse(JSON.parse(manifestBytes.toString('utf8')))
    if (!parsed.success) {
      throw vaultFail('E_CONFLICT', 'remote manifest is not a supported termans vault', {
        reason: 'unsupported-format',
        commit: oid
      })
    }
    return { manifest: parsed.data, encBytes }
  }

  /**
   * 「远端前进 + 本地有改动」的核心：
   * 三方合并 → 有冲突就落快照等用户逐字段裁决（工作区先对齐远端，保证最后能快进推送）；
   * 没冲突就直接写出合并结果并推回去。
   */
  private async mergeFlow(repo: SyncRepo, remoteHead: string, auth: RemoteAuth): Promise<SyncStatus> {
    if (!this.manager.isUnlocked()) throw lockedError()
    const remote = await this.readRemoteVault(remoteHead)
    const remotePayload = this.decryptPayload(remote.encBytes, remote.manifest)
    const localPayload = this.manager.payloadForSync()
    const basePayload = this.readBasePayload()
    const { merged, conflicts, autoApplied } = mergePayloads(basePayload, localPayload, remotePayload)

    if (conflicts.length > 0) {
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
      writeConflictSnapshots(
        this.options.localDir,
        this.manager.currentEncryptedSnapshot().encBytes,
        remote.encBytes,
        stamp
      )
      const state: ConflictState = {
        version: 1,
        createdAt: new Date(this.now()).toISOString(),
        localCommit: this.localCommit,
        remoteCommit: remoteHead,
        baseAvailable: basePayload !== null,
        merged,
        conflicts
      }
      saveConflictState(this.options.localDir, this.box, state)
      // 工作区对齐远端（本地那份已在快照里），这样解决完后推送一定是快进
      await this.engine.resetTo(repo.branch, remoteHead)
      await this.manager.reload()
      this.pending = state
      this.state = 'diverged'
      this.error = null
      this.emit()
      return this.status()
    }

    // 无冲突：rebase 到远端之上，再把合并结果写成一个新提交
    await this.engine.resetTo(repo.branch, remoteHead)
    await this.manager.reload()
    this.manager.applyMergedPayload(merged)
    await this.engine.commitAll(`termans: merge remote revision ${remote.manifest.revision}`, repo.branch)
    await this.engine.push(repo.remoteUrl, repo.branch, auth)
    void autoApplied
    await this.finishSync('idle')
    return this.status()
  }

  private decryptPayload(encBytes: Buffer, manifest: VaultManifest): VaultPayload {
    try {
      const opened = openVault({
        manifest,
        encBytes,
        credential: { vaultKey: this.manager.vaultKeyForSync() }
      })
      return parsePayload(opened.payload)
    } catch (error) {
      throw vaultFail('E_CONFLICT', 'remote vault cannot be decrypted with the current session key', {
        reason: 'conflict',
        detail:
          'the remote vault was re-keyed elsewhere (different master data key); unlock it with the remote passphrase first',
        original: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /* 基线（上次同步成功的密文副本）：三方合并的 base */

  private basePaths(): { enc: string; manifest: string } {
    const dir = join(this.options.localDir, 'conflicts')
    return { enc: join(dir, 'base.vault.enc'), manifest: join(dir, 'base.manifest.json') }
  }

  private writeBase(): void {
    const snapshot = this.manager.currentEncryptedSnapshot()
    if (snapshot.encBytes === null || snapshot.manifest === null) return
    const paths = this.basePaths()
    mkdirSync(join(this.options.localDir, 'conflicts'), { recursive: true, mode: 0o700 })
    writeRepoFile(paths.enc, snapshot.encBytes.toString('utf8'))
    writeRepoFile(paths.manifest, `${JSON.stringify(snapshot.manifest, null, 2)}\n`)
  }

  private readBasePayload(): VaultPayload | null {
    const paths = this.basePaths()
    if (!existsSync(paths.enc) || !existsSync(paths.manifest)) return null
    try {
      const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as VaultManifest
      const encBytes = readFileSync(paths.enc)
      const opened = openVault({ manifest, encBytes, credential: { vaultKey: this.manager.vaultKeyForSync() } })
      return parsePayload(opened.payload)
    } catch {
      return null
    }
  }

  private async finishSync(state: SyncState): Promise<void> {
    const repo = this.repo()
    this.localCommit = await this.engine.head()
    this.remoteCommit = repo === null ? null : await this.engine.resolveRefQuiet(`refs/remotes/origin/${repo.branch}`)
    this.pendingLocalChanges = 0
    this.state = state
    this.error = null
    const snapshot = this.manager.currentEncryptedSnapshot()
    if (snapshot.manifest !== null) {
      this.manager.markSynced(snapshot.manifest.revision, sha256Hex(snapshot.encBytes ?? Buffer.alloc(0)))
    }
    this.lastSyncedAt = this.manager.status().lastSyncedAt
    this.writeBase()
    this.emit()
  }

  private fail(error: unknown): void {
    // 有未解决冲突时状态必须是 diverged（UI 要显示「逐字段选边」，不是「同步出错」）；
    // 否则面板会把「等你做选择」渲染成一个吓人的错误。
    this.state = this.pending !== null && this.pending.conflicts.length > 0 ? 'diverged' : 'error'
    this.error = error instanceof Error ? error.message : String(error)
    this.emit()
  }

  private errorOr(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
  }

  private now(): number {
    return this.options.clock ? this.options.clock() : Date.now()
  }

  private emit(): void {
    this.options.onStatus?.(this.status())
  }
}

function writeRepoFile(path: string, content: string): void {
  // 0600 + 原子写（与 vault 目录里的文件同一套规矩）
  writePrivateFile(path, content)
}
