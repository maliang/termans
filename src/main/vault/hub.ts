import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  VaultCreateResult,
  VaultLibraryCreateRequest,
  VaultLibraryMeta,
  VaultLibrarySwitchRequest,
  VaultStatus
} from '@shared'
import type { SyncCoordinator } from '../git/sync'
import { notFound, vaultFail } from './errors'
import {
  LIBRARIES_DIR,
  ensureLibraryDirFree,
  newLibraryEntry,
  newLibraryId,
  readLibraryIndex,
  resolveLibraryPaths,
  validateLibraryName,
  writeLibraryIndex,
  type LibraryEntry,
  type LibraryIndexFile,
  type LibraryPaths
} from './library-index'
import type { VaultManager } from './manager'

/**
 * 多库编排（r3 / AC-10..AC-14）。
 *
 * 设计口径（TECHNICAL §6.7）：
 * - **一次只活一个 manager/sync**。切库 = 先 `lock()` 旧库（清零 VMK 与明文 payload），
 *   再 `init()` 新库。这样「两库互不自动解锁」（AC-12）不是靠 UI 藏按钮，而是内存里
 *   压根没有第二个 VMK；也让「旧库的凭据在本机仍有可读副本」这类风险没有落点。
 * - **索引 `libraries.json` 是唯一提交点**：所有校验（库名/目录）与目录创建都在写索引之前，
 *   写失败 ⇒ 一个字节都没改；写成功 ⇒ 之后的内存切换只是让状态跟上磁盘。
 * - 默认库（老安装）不走索引迁移：`readLibraryIndex()` 惰性造出 `default` 记录，路径仍是
 *   `userData/vault` + `userData/vault-local`，与 r2 逐字相同（AC-18）。
 *
 * hub 只做编排，业务规则全在 manager / sync / index 三个纯层里；它自己不认识密文包长什么样。
 */

export interface VaultHubDeps {
  /** 库索引与本机目录的根（Electron `userData`） */
  userDataDir: string
  /** 造一个库的 manager（options 由接线方注入，hub 不碰 policy/settings） */
  createManager(paths: LibraryPaths, entry: LibraryEntry): VaultManager
  /** 造一个库的 sync coordinator（必须绑同一个 manager 实例） */
  createSync(paths: LibraryPaths, manager: VaultManager, entry: LibraryEntry): SyncCoordinator
  /**
   * 状态推送出口。切库/建库后 hub 主动推一次：新库 `init()` 在「本来就锁定」时不会自己 emit，
   * 只靠 invoke 的返回值会让其它窗口还停在旧库上。
   *
   * 契约：接线方负责补 `libraries`（见 `ipc/index.ts`），hub 传的是 manager 的原始状态。
   */
  onStatus(status: VaultStatus): void
}

export interface ActiveLibrary {
  entry: LibraryEntry
  manager: VaultManager
  sync: SyncCoordinator
}

export class VaultHub {
  private readonly deps: VaultHubDeps
  private index: LibraryIndexFile
  private active: ActiveLibrary | null = null

  constructor(deps: VaultHubDeps) {
    this.deps = deps
    this.index = readLibraryIndex(deps.userDataDir)
  }

  /**
   * 启动握手：打开索引里的当前库。
   *
   * 绝不在这里抛（与 `VaultManager.init()` 同一口径）：索引损坏由 `readLibraryIndex` 收敛成
   * 惰性默认库，manager 自己的损坏也内部降级成 locked —— 窗口必须能起来，用户才看得到解锁屏。
   */
  init(): void {
    const entry = this.index.libraries.find((candidate) => candidate.id === this.index.current) ?? this.index.libraries[0]
    this.activate(entry)
  }

  /** 当前库（handler 全部经这里取 manager/sync，避免切换后拿到旧实例） */
  current(): ActiveLibrary {
    if (this.active === null) throw new Error('VaultHub.init() must be called before use')
    return this.active
  }

  /**
   * 库列表（AC-13）。当前库的创建/上次解锁时间取活着的 manager（权威），其余取索引记录。
   * `isCurrent` 来源是索引的 `current`，不是「谁还开着」——锁定时列表也必须正确。
   */
  libraryMeta(): VaultLibraryMeta[] {
    const activeStatus = this.active === null ? null : this.active.manager.status()
    return this.index.libraries.map((entry) => {
      const live = entry.id === this.index.current ? activeStatus : null
      return {
        id: entry.id,
        name: entry.name,
        createdAt: live?.createdAt ?? entry.createdAt,
        lastUnlockedAt: live?.lastUnlockedAt ?? entry.lastUnlockedAt,
        isCurrent: entry.id === this.index.current
      }
    })
  }

  libraries(): { libraries: VaultLibraryMeta[] } {
    return { libraries: this.libraryMeta() }
  }

  /**
   * 新建本地库（AC-14 / AC-15 / AC-11）。只造「空壳库」：一条索引记录 + 一个空目录。
   *
   * 顺序是被 AC 钉死的（失败路径一个字节都不写）：
   *   validate(库名) → ensureDirFree(目录) → mkdir → 写索引（唯一提交点）→ lock 旧库 → init 新库。
   * 空壳库 `state=uninitialized`，所以渲染层随后必须走**既有**的建库表单去设口令 ——
   * 恢复码由那次 `vault:create` 产生，这里返回空串（AC-16 的强制展示落在那一步）。
   *
   * 旧库一个字节都不动（AC-11）：本方法只碰 `libraries.json` 与 `vaults/<新 id>/`。
   */
  createLibrary(input: VaultLibraryCreateRequest): VaultCreateResult {
    const nameCheck = validateLibraryName(input.name, this.index.libraries)
    if (!nameCheck.ok) {
      throw vaultFail('E_INVALID_ARGUMENT', `Library name is not usable: ${input.name}`, {
        reason: 'name-taken',
        field: 'name'
      })
    }
    const id = newLibraryId(this.index.libraries.map((entry) => entry.id))
    const dirCheck = ensureLibraryDirFree(this.deps.userDataDir, id)
    if (!dirCheck.ok) {
      throw vaultFail('E_INVALID_ARGUMENT', `Library directory is already in use: ${id}`, {
        reason: 'already-exists',
        field: 'dir'
      })
    }

    // 先建父目录再写索引：反过来的话，中途崩溃会留下「索引里有这只库、目录却不存在」的记录，
    // 用户下次启动就会看到一个点不进去的空库；现在最坏只是留下一个被 ensureLibraryDirFree 判红
    // 的空目录（不会被复用，也不会冒充成库）。
    mkdirSync(join(this.deps.userDataDir, LIBRARIES_DIR, id), { recursive: true, mode: 0o700 })

    const entry: LibraryEntry = { ...newLibraryEntry(id, nameCheck.name), createdAt: this.nowIso() }
    const next: LibraryIndexFile = {
      version: 1,
      current: id,
      libraries: this.captureActiveInto([...this.index.libraries, entry])
    }
    this.commitIndex(next)
    this.lockActive()
    this.activate(entry)

    // `input.rememberWithKeychain` 在空壳库上没有落点（还没有 VMK 可记）：
    // 它真正生效于随后 `vault:create` 里用户的勾选，这里只做形状校验（zod 已过）。
    this.emitActive()
    return { status: this.withLibraries(this.current().manager.status()), recoveryCode: '' }
  }

  /**
   * 切换当前库（AC-12 / AC-13）。
   *
   * 幂等：切到当前库直接回状态（渲染层可能重复触发，不该产生第二次 lock/init）。
   * 找不到 id ⇒ E_NOT_FOUND（索引是用户可手改的文件，不能假设它自洽）。
   */
  switchLibrary(input: VaultLibrarySwitchRequest): VaultStatus {
    const target = this.index.libraries.find((entry) => entry.id === input.id)
    if (target === undefined) throw notFound('library', input.id)
    if (this.active !== null && this.active.entry.id === target.id) {
      return this.withLibraries(this.active.manager.status())
    }

    const next: LibraryIndexFile = {
      version: 1,
      current: target.id,
      libraries: this.captureActiveInto(this.index.libraries)
    }
    this.commitIndex(next)
    this.lockActive()
    this.activate(target)
    this.emitActive()
    return this.withLibraries(this.current().manager.status())
  }

  /** 是否已经有一个**建过的主机库**（AC-10 的「已有库」判据：空壳库不算） */
  hasVault(): boolean {
    if (this.active === null) return false
    return this.active.manager.status().state !== 'uninitialized'
  }

  /* ------------------------------------------------------------------ */

  private activate(entry: LibraryEntry): void {
    const paths = resolveLibraryPaths(this.deps.userDataDir, entry)
    const manager = this.deps.createManager(paths, entry)
    const sync = this.deps.createSync(paths, manager, entry)
    this.active = { entry, manager, sync }
    // 启动握手（读仓库 + 尝试「记住本机」自动解锁）。绝不能抛：窗口起不来用户连解锁屏都看不到。
    manager.init()
  }

  /**
   * 先摘引用再锁：`lock()` 会推一次状态，那一刻「当前库」已经换人了，
   * 不能让这次推送读到旧 manager 的活状态（否则渲染层会把旧库的解锁态画在新库头上）。
   */
  private lockActive(): void {
    const active = this.active
    this.active = null
    if (active === null) return
    try {
      active.manager.lock()
    } catch (error) {
      // 锁失败不该阻断切库：新库 init 会重建整个状态，旧 VMK 也随引用丢弃被回收。
      console.warn(`[vault] locking previous library failed: ${(error as Error).message}`)
    }
  }

  /** 把活着的 manager 的「创建/上次解锁」快照进索引记录（切走之后列表仍要显示真实时间） */
  private captureActiveInto(libraries: LibraryEntry[]): LibraryEntry[] {
    const active = this.active
    if (active === null) return libraries
    const status = active.manager.status()
    return libraries.map((entry) =>
      entry.id === active.entry.id
        ? {
            ...entry,
            createdAt: status.createdAt ?? entry.createdAt,
            lastUnlockedAt: status.lastUnlockedAt ?? entry.lastUnlockedAt
          }
        : entry
    )
  }

  /** 切库/建库后主动推一次（新库锁定态不会自己 emit，见 `VaultHubDeps.onStatus`） */
  private emitActive(): void {
    if (this.active === null) return
    this.deps.onStatus(this.active.manager.status())
  }

  /** 索引写入即提交点：先落盘，再让内存跟上（写失败 ⇒ 内存与磁盘都还是旧的） */
  private commitIndex(next: LibraryIndexFile): void {
    writeLibraryIndex(this.deps.userDataDir, next)
    this.index = next
  }

  /** manager 不认识多库，`status().libraries` 恒为 `[]`，出口统一在这里补 */
  private withLibraries(status: VaultStatus): VaultStatus {
    return { ...status, libraries: this.libraryMeta() }
  }

  private nowIso(): string {
    return new Date().toISOString()
  }
}
