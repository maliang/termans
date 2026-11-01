import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcCallError, type VaultState } from '@shared'
import { SCRYPT_TEST } from '../crypto'
import { VaultManager } from '../vault/manager'
import { ENVELOPE_FILE, MANIFEST_FILE, listRepoFiles, readRepo } from '../vault/repo'
import { createFileSecretBox, type SecretBox } from '../vault/secret-box'
import { FIXTURE_HOSTNAMES, hostInput } from '../vault/test-fixtures'
import { GitEngine, type RemoteAuth } from './engine'
import { SyncCoordinator } from './sync'
import { gitCli, startTestGitServer, type TestGitServer } from './test-git-server'

/**
 * t25 回归：F-1（状态单一真源）、F-2（同目录并发 + 「丢文件不许报 ok」）、F-3（ref 锁重试）。
 *
 * 这些用例的价值在「并发下也必须给出同一个真相」：单线程顺序跑绿只能说明代码能走通，
 * 说明不了两个 IPC 同时进来时不会互相踩。
 */

const PASSPHRASE = 'correct horse battery staple'
/** 另一台机器轮换出来的新口令（也是另一把槽） */
const ROTATED_PASSPHRASE = 'Zebra7Quantum-Lantern-Ferry'

interface Machine {
  dir: string
  repoDir: string
  localDir: string
  box: SecretBox
  manager: VaultManager
  sync: SyncCoordinator
  statuses: { state: VaultState; lastSyncedAt: string | null }[]
}

let server: TestGitServer
const dirs: string[] = []

beforeEach(async () => {
  server = await startTestGitServer()
})

afterEach(async () => {
  await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function machine(tag: string): Machine {
  const dir = mkdtempSync(join(tmpdir(), `termans-rob-${tag}-`))
  dirs.push(dir)
  const repoDir = join(dir, 'vault')
  const localDir = join(dir, 'vault-local')
  const box = createFileSecretBox(localDir)
  const statuses: { state: VaultState; lastSyncedAt: string | null }[] = []
  const manager = new VaultManager({
    repoDir,
    localDir,
    box,
    cost: SCRYPT_TEST,
    autoLockMinutes: 0,
    requirePassphraseOnLaunch: true,
    // 连 lastSyncedAt 一起记：用来区分「这次 locked 事件来自回锁」还是「来自 markSynced 的顺带广播」
    onStatus: (status) => statuses.push({ state: status.state, lastSyncedAt: status.lastSyncedAt })
  })
  const sync = new SyncCoordinator({ repoDir, localDir, manager, box })
  manager.init()
  return { dir, repoDir, localDir, box, manager, sync, statuses }
}

function seedHosts(target: Machine, count: number = FIXTURE_HOSTNAMES.length): void {
  FIXTURE_HOSTNAMES.slice(0, count).forEach((hostname, index) => {
    const record = target.manager.createHost(hostInput({ label: `rob-${index}`, hostname }))
    const reference = record.credentialRef ?? `ref-${record.id}`
    if (record.credentialRef === null) target.manager.updateHost(record.id, hostInput({ label: `rob-${index}`, hostname, credentialRef: reference }))
    target.manager.setSecret(reference, { password: `secret-${index}` })
  })
}

function expectIpc(fn: () => unknown, code: string, reason?: string): IpcCallError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(IpcCallError)
    const ipc = error as IpcCallError
    expect(ipc.code).toBe(code)
    if (reason !== undefined) expect((ipc.details as { reason?: string } | undefined)?.reason).toBe(reason)
    return ipc
  }
  throw new Error(`expected IpcCallError(${code}/${reason ?? '-'})`)
}

/** 仓库工作树必须「完整且干净」：两个文件在位非空、没有未提交改动、本地与远端同一提交 */
async function assertRepoIntact(target: Machine, label: string): Promise<void> {
  const files = listRepoFiles(target.repoDir)
  expect(files, `${label}: 仓库里应当只有 manifest.json 与 vault.enc`).toEqual([MANIFEST_FILE, ENVELOPE_FILE])
  for (const file of [MANIFEST_FILE, ENVELOPE_FILE]) {
    const path = join(target.repoDir, file)
    expect(existsSync(path), `${label}: ${file} 必须存在`).toBe(true)
    expect(statSync(path).size, `${label}: ${file} 不能是空文件`).toBeGreaterThan(0)
  }
  const status = await target.sync.status()
  const refreshed = await target.sync.refresh()
  expect(refreshed.localCommit, `${label}: 本地必须已有提交`).not.toBeNull()
  expect(refreshed.remoteCommit, `${label}: 远端必须有提交`).not.toBeNull()
  expect(refreshed.localCommit, `${label}: 本地与远端必须是同一提交`).toBe(refreshed.remoteCommit)
  const st = await target.sync['engine'].status()
  expect(st.clean, `${label}: 工作区必须干净（changedFiles=${st.changedFiles.join(',')}）`).toBe(true)
  void status
}

describe('F-2｜同一 vault 目录的并发 git 操作必须串行化，且不许「丢文件还报 ok」', () => {
  it('双机迁移流程循环 10 次：A 端 bootstrap/push/pull 并发 + B 端首次对齐与 push/pull 并发，仓库都必须完整', async () => {
    for (let round = 1; round <= 10; round += 1) {
      // 每轮一个全新的 bare 仓库：复用上一轮的远端会让「新机 + 远端已有内容」走进首次对齐，
      // 那是 S-07 的场景，不是这里要压的并发写。
      await server.close()
      server = await startTestGitServer()
      const request = { remoteUrl: server.url, branch: 'main', auth: 'none' as const }

      // ① A 端：三个入口同时进来（用户点「连接」后立刻点「推送」，IPC 不会帮我们排队）
      const a = machine(`loop-a-${round}`)
      a.manager.create(PASSPHRASE)
      seedHosts(a)
      const aSettled = await Promise.allSettled([a.sync.bootstrap(request), a.sync.pull(), a.sync.push()])
      const aRejected = aSettled.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
      expect(aRejected, `第 ${round} 轮 A 端有操作抛错：${aRejected.map((i) => (i.reason instanceof Error ? i.reason.message : String(i.reason))).join(' | ')}`).toHaveLength(0)
      await assertRepoIntact(a, `第 ${round} 轮 A 端`)

      // ② B 端（新机）：首次对齐会 `rmSync` 整个工作树再 clone —— 与并发的 push/pull 撞上就会丢文件
      const b = machine(`loop-b-${round}`)
      b.manager.create(PASSPHRASE)
      const bSettled = await Promise.allSettled([b.sync.bootstrap(request), b.sync.pull(), b.sync.push()])
      const bRejected = bSettled.filter((item) => item.status === 'rejected') as PromiseRejectedResult[]
      expect(bRejected, `第 ${round} 轮 B 端有操作抛错：${bRejected.map((i) => (i.reason instanceof Error ? i.reason.message : String(i.reason))).join(' | ')}`).toHaveLength(0)
      await assertRepoIntact(b, `第 ${round} 轮 B 端`)
      // 对齐后 B 必然是「锁定 + 数据在盘上」，不是「已解锁的空库」
      expect(b.manager.status().state, `第 ${round} 轮 B 端对齐后应当回到锁定态`).toBe('locked')
      b.manager.assertStateConsistent()
      b.manager.unlock(PASSPHRASE, false)
      expect(b.manager.listLibrary().hosts, `第 ${round} 轮 B 端应当拿到 A 的 3 台主机`).toHaveLength(FIXTURE_HOSTNAMES.length)
      expect(a.sync.status().state, `第 ${round} 轮 A 端同步状态应当是 idle`).toBe('idle')
    }
  }, 240_000)

  it('工作树缺 vault.enc 时同步必须先失败（E_IO）而不是把 ok 变绿', async () => {
    const a = machine('missing')
    a.manager.create(PASSPHRASE)
    seedHosts(a, 1)
    await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    await assertRepoIntact(a, '缺失前')

    rmSync(join(a.repoDir, ENVELOPE_FILE), { force: true })
    const ipc = await a.sync.pull().then(
      () => {
        throw new Error('pull 在 vault.enc 缺失时仍然返回了 ok')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(IpcCallError)
        return error as IpcCallError
      }
    )
    expect(ipc.code).toBe('E_IO')
    expect((ipc.details as { reason?: string } | undefined)?.reason).toBe('corrupt')
    expect(a.sync.status().state).toBe('error')
  }, 60_000)

  it('首次对齐窗口内并发的写操作必须拿 E_VAULT_LOCKED，不能写进正被 clone 覆盖的工作树（静默丢失）', async () => {
    const a = machine('align-a')
    a.manager.create(PASSPHRASE)
    seedHosts(a, 1)
    await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })

    let engine: GatedCloneEngine | null = null
    const b = machineWithEngine('align-b', (repoDir) => {
      engine = new GatedCloneEngine({ dir: repoDir })
      return engine
    })
    b.manager.create(PASSPHRASE)

    const pulling = b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    // 等对齐真的进到 clone 里（窗口最宽的时刻），再试着写一条主机
    await waitFor(() => engine!.cloneStarted, '对齐没有走到 clone')
    expect(b.manager.status().state, '对齐窗口内库必须是锁的').toBe('locked')
    expectIpc(() => b.manager.createHost(hostInput({ label: 'late', hostname: '10.1.2.3' })), 'E_VAULT_LOCKED', 'locked')

    engine!.openGate()
    const aligned = await pulling
    expect(aligned.state).toBe('idle')
    await assertRepoIntact(b, '对齐后')
    expect(b.manager.status().state).toBe('locked')
    b.manager.unlock(PASSPHRASE, false)
    expect(b.manager.listLibrary().hosts, '对齐后只应该有远端那一台，晚到的写入不该落进去').toHaveLength(1)
    expect(b.manager.listLibrary().hosts[0]?.hostname).toBe(FIXTURE_HOSTNAMES[0])
  }, 60_000)
})

/** clone 卡在一道闸门上的 engine：用来把「对齐窗口」拉宽到可断言 */
class GatedCloneEngine extends GitEngine {
  cloneStarted = false

  private release: (() => void) | null = null

  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })

  override async clone(url: string, branch: string, auth: RemoteAuth): Promise<void> {
    this.cloneStarted = true
    await this.gate
    return await super.clone(url, branch, auth)
  }

  openGate(): void {
    this.release?.()
  }
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

describe('F-1｜vault 状态与真实挂载必须收敛成单一真源', () => {
  it('B 机首次对齐触发回锁：status 报 locked、确实推送了 vault:state-changed、hosts:list 抛 E_VAULT_LOCKED', async () => {
    const a = machine('a')
    a.manager.create(PASSPHRASE)
    seedHosts(a)
    await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })

    const b = machine('b')
    b.manager.create(PASSPHRASE)
    expect(b.manager.status().state).toBe('unlocked')
    b.manager.assertStateConsistent()

    const statusesBefore = b.statuses.length
    // bootstrap 在「本机从未提交 + 远端有内容」时走的就是首次对齐（alignFreshFromRemote）
    const aligned = await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    expect(aligned.state).toBe('idle')

    // ① 状态必须立刻变成 locked，而不是「已解锁的空库」
    expect(b.manager.status().state).toBe('locked')
    expect(b.manager.status().itemCounts).toBeNull()
    expect(b.manager.isUnlocked()).toBe(false)
    // ② 这条回锁必须自己发过一次事件（否则渲染层只能靠主动拉取，窗口未就绪时会停在旧状态）。
    //    判据：存在一次 locked 事件，且它发生在 markSynced 之前（lastSyncedAt 仍为 null）——
    //    否则「同步收尾顺带广播一次 locked」会把这个断言掩盖成假绿。
    const lockedEmits = b.statuses.slice(statusesBefore).filter((item) => item.state === 'locked')
    expect(lockedEmits.length, '回锁必须走 emit()').toBeGreaterThan(0)
    expect(
      lockedEmits.some((item) => item.lastSyncedAt === null),
      '必须有一条 locked 事件来自回锁本身，而不是同步收尾的顺带广播'
    ).toBe(true)
    // ③ 同一时刻主机树也确实没挂载 —— 两者不允许互相矛盾
    expectIpc(() => b.manager.listLibrary(), 'E_VAULT_LOCKED', 'locked')
    expect(() => b.manager.assertStateConsistent()).not.toThrow()

    // 用同一主口令解锁后数据齐全，且仍然是「状态 = 挂载」的
    const unlocked = b.manager.unlock(PASSPHRASE, false)
    expect(unlocked.state).toBe('unlocked')
    expect(() => b.manager.assertStateConsistent()).not.toThrow()
    expect(b.manager.listLibrary().hosts).toHaveLength(FIXTURE_HOSTNAMES.length)
  }, 120_000)

  it('不变式：任何时刻 status().state === "unlocked" ⇔ 主机树已挂载（跨创建/锁定/解锁/对齐/坏密文）', async () => {
    const a = machine('inv')
    a.manager.assertStateConsistent()
    a.manager.create(PASSPHRASE)
    a.manager.assertStateConsistent()
    seedHosts(a, 2)
    a.manager.assertStateConsistent()
    a.manager.lock()
    a.manager.assertStateConsistent()
    expect(a.manager.status().state).toBe('locked')
    a.manager.unlock(PASSPHRASE, false)
    a.manager.assertStateConsistent()

    // 坏密文：reload 走「解不开 → 回锁」路径，也必须保持一致（并且必须 emit）
    await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    a.manager.assertStateConsistent()
    const before = a.statuses.length
    rmSync(join(a.repoDir, ENVELOPE_FILE), { force: true })
    const after = a.manager.reload()
    expect(after.state).toBe('locked')
    expect(() => a.manager.assertStateConsistent()).not.toThrow()
    expect(
      a.statuses.slice(before).some((item) => item.state === 'locked'),
      'reload 回锁也必须 emit'
    ).toBe(true)
  }, 60_000)
})

/** 只会前 N 次抛「ref 锁冲突」的 engine：用来证明 push 的重试与最终报错文案 */
class FlakyPushEngine extends GitEngine {
  attempts = 0

  constructor(options: ConstructorParameters<typeof GitEngine>[0], private readonly failures: number) {
    super(options)
  }

  override async push(url: string, branch: string, auth: RemoteAuth): Promise<void> {
    this.attempts += 1
    if (this.attempts <= this.failures) {
      throw new Error('One or more branches were not updated: refs/heads/main: reference already exists')
    }
    return await super.push(url, branch, auth)
  }
}

function machineWithEngine(tag: string, makeEngine: (repoDir: string) => GitEngine): Machine {
  const dir = mkdtempSync(join(tmpdir(), `termans-rob-${tag}-`))
  dirs.push(dir)
  const repoDir = join(dir, 'vault')
  const localDir = join(dir, 'vault-local')
  const box = createFileSecretBox(localDir)
  const statuses: { state: VaultState; lastSyncedAt: string | null }[] = []
  const manager = new VaultManager({
    repoDir,
    localDir,
    box,
    cost: SCRYPT_TEST,
    autoLockMinutes: 0,
    requirePassphraseOnLaunch: true,
    onStatus: (status) => statuses.push({ state: status.state, lastSyncedAt: status.lastSyncedAt })
  })
  const sync = new SyncCoordinator({ repoDir, localDir, manager, box, engine: makeEngine(repoDir) })
  manager.init()
  return { dir, repoDir, localDir, box, manager, sync, statuses }
}

describe('F-3｜并发推送撞上远端 ref 锁时必须有限次退避重试', () => {
  it('第一次推送抛「reference already exists」，重试后成功（且不把错误冒给用户）', async () => {
    let engine: FlakyPushEngine | null = null
    const a = machineWithEngine('f3', (repoDir) => {
      engine = new FlakyPushEngine({ dir: repoDir }, 1)
      return engine
    })
    a.manager.create(PASSPHRASE)
    seedHosts(a, 1)

    const status = await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    expect(status.state).toBe('idle')
    expect(engine!.attempts).toBe(2)
    await assertRepoIntact(a, 'F-3 重试后')
  }, 60_000)

  it('连续失败时最终报错必须带上尝试次数与原始错误，而不是含糊的 E_UNKNOWN', async () => {
    let engine: FlakyPushEngine | null = null
    const a = machineWithEngine('f3-dead', (repoDir) => {
      engine = new FlakyPushEngine({ dir: repoDir }, 99)
      return engine
    })
    a.manager.create(PASSPHRASE)
    seedHosts(a, 1)

    const error = await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' }).then(
      () => {
        throw new Error('推送连续失败时 bootstrap 仍然返回了成功')
      },
      (reason: unknown) => reason as IpcCallError
    )
    expect(error).toBeInstanceOf(IpcCallError)
    expect((error as IpcCallError).code).toBe('E_GIT')
    expect(error.message).toContain('after 3 attempt(s)')
    expect(error.message).toContain('reference already exists')
    expect((error.details as { attempts?: number }).attempts).toBe(3)
    expect((error.details as { retryable?: boolean }).retryable).toBe(true)
    expect(engine!.attempts).toBe(3)
  }, 60_000)
})

/**
 * AC-21 的另一半：能重读仓库 ≠ 能保槽。
 *
 * 锁定态没有 VMK，`reload()` 只会在 local.json 里记一条 `slotDrift`——远端换过的槽就留在仓库里了，
 * 用户下次用自己那把口令直接开不了库。所以同步必须在动手之前拒绝，并把原因如实报出来，
 * 而不是「同步成功 + 口令悄悄失效」。
 */
describe('AC-21｜锁定态同步不许静默接受远端的口令槽', () => {
  it('远端快进但本机已锁：pull 报 E_VAULT_LOCKED 且一个字节不落盘；解锁后同一 pull 成功且保槽', async () => {
    const a = machine('ac21-lock-a')
    a.manager.create(PASSPHRASE)
    seedHosts(a, 1)
    expect((await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')

    const b = machine('ac21-lock-b')
    expect((await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    b.manager.unlock(PASSPHRASE, false)
    const slotBefore = b.manager.localSlot()
    expect(slotBefore, 'B 机解锁后必须记下本机权威槽').not.toBeNull()
    b.manager.lock()

    // A 换口令 + 加一台主机并推送：远端既前进又换了槽，B 这一拉必定要重读仓库
    a.manager.rotate({ currentPassphrase: PASSPHRASE, newPassphrase: ROTATED_PASSPHRASE })
    a.manager.createHost(hostInput({ label: 'after-rotate', hostname: FIXTURE_HOSTNAMES[2] }))
    expect((await a.sync.push()).state).toBe('idle')
    const remoteHead = gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()

    const locked = await b.sync.pull().then(
      () => {
        throw new Error('锁定态的 pull 竟然成功了：远端换掉的槽会被静默留在本机')
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(IpcCallError)
        return error as IpcCallError
      }
    )
    expect(locked.code).toBe('E_VAULT_LOCKED')
    expect((locked.details as { reason?: string } | undefined)?.reason).toBe('locked')
    expect(b.manager.status().state, '被拒的 pull 不许把库偷偷解锁').toBe('locked')
    // 拒绝必须是「什么都没发生」：本机仓库仍是自己那份，远端也没被碰
    const untouched = readRepo(b.repoDir)
    expect(untouched!.manifest.passphraseKey, '锁定态的 pull 不许改本机槽').toEqual(slotBefore!.passphraseKey)
    expect(gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()).toBe(remoteHead)

    // 解锁后同一操作成功：远端新内容进来了，但仓库里那把槽仍是本机的
    expect(b.manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
    expect((await b.sync.pull()).state).toBe('idle')
    expect(b.manager.listLibrary().hosts.map((host) => host.label)).toContain('after-rotate')
    const kept = readRepo(b.repoDir)
    expect(kept!.manifest.passphraseKey, '解锁态 pull 必须保本机槽').toEqual(slotBefore!.passphraseKey)
    expect(kept!.envelope.kdf.salt, '槽与盐必须成对地回写').toBe(slotBefore!.salt)
    b.manager.lock()
    expect(b.manager.unlock(PASSPHRASE, false).state, 'pull 之后本机原口令必须仍能解锁').toBe('unlocked')
    // pull 绝不改写远端
    expect(gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()).toBe(remoteHead)
  }, 90_000)
})
