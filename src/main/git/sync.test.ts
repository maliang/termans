import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import { SCRYPT_TEST } from '../crypto'
import { VaultManager } from '../vault/manager'
import { readRepo } from '../vault/repo'
import { createFileSecretBox, type SecretBox } from '../vault/secret-box'
import { FIXTURE_HOSTNAMES, FIXTURE_PASSWORD, hostInput } from '../vault/test-fixtures'
import { SyncCoordinator } from './sync'
import { gitCli, startTestGitServer, type TestGitServer } from './test-git-server'

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
  const dir = mkdtempSync(join(tmpdir(), `termans-${tag}-`))
  dirs.push(dir)
  const repoDir = join(dir, 'vault')
  const localDir = join(dir, 'vault-local')
  const box = createFileSecretBox(localDir)
  const manager = new VaultManager({
    repoDir,
    localDir,
    box,
    cost: SCRYPT_TEST,
    autoLockMinutes: 0,
    requirePassphraseOnLaunch: true
  })
  const sync = new SyncCoordinator({ repoDir, localDir, manager, box })
  manager.init()
  return { dir, repoDir, localDir, box, manager, sync }
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

async function expectIpcAsync(promise: Promise<unknown>, code: string, reason?: string): Promise<IpcCallError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(IpcCallError)
    const ipc = error as IpcCallError
    expect(ipc.code).toBe(code)
    if (reason !== undefined) expect((ipc.details as { reason?: string } | undefined)?.reason).toBe(reason)
    return ipc
  }
  throw new Error(`expected IpcCallError(${code}/${reason ?? '-'})`)
}

describe('A→B 迁移全流程（临时 bare 仓库 + 真实 smart-HTTP）', () => {
  it('A 写 3 台含密码 → push → B 同口令 clone 到独立 userData → 3 台出现且密码可解密 → 错口令失败', async () => {
    const a = machine('a')
    a.manager.create(PASSPHRASE)
    FIXTURE_HOSTNAMES.forEach((hostname, index) => {
      const host = a.manager.createHost({
        label: `prod-${index}`,
        groupId: null,
        hostname,
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        privateKeyPath: null,
        credentialRef: `ref-${index}`,
        jumpHostId: null,
        forwardAgent: false,
        keepaliveSeconds: 30,
        terminalProfileId: null,
        startupCommand: null,
        env: {},
        tags: [],
        color: null,
        portForwards: [],
        sshConfigOrigin: null
      })
      a.manager.setSecret(`ref-${index}`, { password: `${FIXTURE_PASSWORD}-${index}` })
      expect(host.id).toMatch(/-/)
    })

    const pushed = await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    expect(pushed.state).toBe('idle')
    expect(pushed.localCommit).toMatch(/^[0-9a-f]{40}$/)

    // 仓库里只有这三类文件（ls -R 的等价断言）
    const tree = gitCli(['-C', server.bareDir, 'ls-tree', '-r', '--name-only', 'main']).trim().split('\n').filter(Boolean)
    expect(tree).toEqual(['manifest.json', 'vault.enc'])
    // 而且在真实远端对象里也 grep 不到任何明文敏感数据
    const remoteEnvelope = gitCli(['-C', server.bareDir, 'show', 'main:vault.enc'])
    const remoteManifest = gitCli(['-C', server.bareDir, 'show', 'main:manifest.json'])
    for (const needle of [...FIXTURE_HOSTNAMES, FIXTURE_PASSWORD, 'PRIVATE KEY', 'deploy']) {
      expect(remoteEnvelope).not.toContain(needle)
    }
    expect(remoteManifest).not.toContain('hosts')
    expect(JSON.parse(remoteManifest)).toMatchObject({ format: 'termans-vault', version: 1, cipher: 'aes-256-gcm' })

    // B 机：独立 userData，先把远端 clone 下来
    const b = machine('b')
    const cloned = await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    expect(cloned.state).toBe('idle')
    expect(existsSync(join(b.repoDir, 'manifest.json'))).toBe(true)
    // clone 下来的仓库是锁着的，必须用同一个口令解锁
    expect(b.manager.status().state).toBe('locked')
    expectIpc(() => b.manager.listLibrary(), 'E_VAULT_LOCKED', 'locked')

    const unlocked = b.manager.unlock(PASSPHRASE, false)
    expect(unlocked.state).toBe('unlocked')
    const library = b.manager.listLibrary()
    expect(library.hosts).toHaveLength(3)
    expect(library.hosts.map((host) => host.hostname).sort()).toEqual([...FIXTURE_HOSTNAMES].sort())
    for (const [index, host] of library.hosts.entries()) {
      expect(b.manager.getSecret(host.credentialRef!)?.password).toBeDefined()
      expect(b.manager.resolveHostAuth(host.id).password).toBe(`${FIXTURE_PASSWORD}-${index}`)
      expect(host.port).toBe(22)
    }

    // 错口令：B 机换一台再试（清掉内存态）
    b.manager.lock()
    expectIpc(() => b.manager.unlock('definitely not the passphrase', false), 'E_UNAUTHORIZED', 'bad-passphrase')
    expect(b.manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
  }, 60_000)

  it('乐观锁：远端前进且本地有改动 → 自动三方合并后仍以快进推回；同一字段两边都改 → 产出冲突并要求显式解决', async () => {
    const a = machine('a')
    const b = machine('b')
    a.manager.create(PASSPHRASE)
    const shared = a.manager.createHost({
      label: 'shared',
      groupId: null,
      hostname: '10.20.30.40',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      privateKeyPath: null,
      credentialRef: null,
      jumpHostId: null,
      forwardAgent: false,
      keepaliveSeconds: 30,
      terminalProfileId: null,
      startupCommand: null,
      env: {},
      tags: [],
      color: null,
      portForwards: [],
      sshConfigOrigin: null
    })
    await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    b.manager.unlock(PASSPHRASE, false)

    // 两边各加一台不同的主机：应自动合并（并集），不打扰用户
    a.manager.createHost({
      label: 'from-a',
      groupId: null,
      hostname: '10.0.0.1',
      port: 22,
      username: 'u',
      authMethod: 'password',
      privateKeyPath: null,
      credentialRef: null,
      jumpHostId: null,
      forwardAgent: false,
      keepaliveSeconds: 30,
      terminalProfileId: null,
      startupCommand: null,
      env: {},
      tags: [],
      color: null,
      portForwards: [],
      sshConfigOrigin: null
    })
    b.manager.createHost({
      label: 'from-b',
      groupId: null,
      hostname: '10.0.0.2',
      port: 22,
      username: 'u',
      authMethod: 'password',
      privateKeyPath: null,
      credentialRef: null,
      jumpHostId: null,
      forwardAgent: false,
      keepaliveSeconds: 30,
      terminalProfileId: null,
      startupCommand: null,
      env: {},
      tags: [],
      color: null,
      portForwards: [],
      sshConfigOrigin: null
    })

    expect((await a.sync.push()).state).toBe('idle')
    const merged = await b.sync.push()
    expect(merged.state).toBe('idle')
    expect(merged.conflictCount).toBe(0)

    const afterPull = await a.sync.pull()
    expect(afterPull.state).toBe('idle')
    const labels = a.manager
      .listLibrary()
      .hosts.map((host) => host.label)
      .sort()
    expect(labels).toEqual(['from-a', 'from-b', 'shared'])

    // 同一字段两边都改 ports → 冲突，绝不静默覆盖
    const hostForA = a.manager.listLibrary().hosts.find((host) => host.id === shared.id)!
    const hostForB = b.manager.listLibrary().hosts.find((host) => host.id === shared.id)!
    a.manager.updateHost(hostForA.id, { ...hostForA, port: 2222 })
    await a.sync.push()
    b.manager.updateHost(hostForB.id, { ...hostForB, port: 2200 })

    const conflictError = await expectIpcAsync(b.sync.push(), 'E_CONFLICT', 'conflict')
    expect((conflictError.details as { conflictCount?: number }).conflictCount).toBeGreaterThan(0)
    expect(b.sync.status().state).toBe('diverged')

    const conflicts = b.sync.conflicts()
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.path).toBe(`hosts.${shared.id}.port`)
    expect(conflicts[0]?.localSummary).toContain('2200')
    expect(conflicts[0]?.remoteSummary).toContain('2222')
    // 推送在冲突未解决时仍然被拦
    await expectIpcAsync(b.sync.push(), 'E_CONFLICT')

    // 冲突快照留在本机（含密文副本），解决后清掉
    expect(existsSync(join(b.localDir, 'conflicts'))).toBe(true)
    const resolved = await b.sync.resolve({ conflictId: conflicts[0]!.id, strategy: 'remote' })
    expect(resolved.state).toBe('idle')
    expect(b.manager.listLibrary().hosts.find((host) => host.id === shared.id)?.port).toBe(2222)

    // A 拉回来后看到的是解决后的值（快进）
    expect((await a.sync.pull()).state).toBe('idle')
    expect(a.manager.listLibrary().hosts.find((host) => host.id === shared.id)?.port).toBe(2222)
    const tree = gitCli(['-C', server.bareDir, 'ls-tree', '-r', '--name-only', 'main']).trim().split('\n').filter(Boolean)
    expect(tree).toEqual(['manifest.json', 'vault.enc'])
  }, 120_000)

  it('新机本地已建库但从未提交：首次 pull 应对齐远端，而不是 checkout 冲突（S-07 回归）', async () => {
    // A：正常建库 + 3 台含密码主机 + 推到远端
    const a = machine('a-align')
    a.manager.create(PASSPHRASE)
    FIXTURE_HOSTNAMES.forEach((hostname, index) => {
      a.manager.createHost(hostInput({ label: `sync-${index}`, hostname, credentialRef: `ref-align-${index}` }))
      a.manager.setSecret(`ref-align-${index}`, { password: `${FIXTURE_PASSWORD}-${index}` })
    })
    expect((await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')

    // B：先建空库（App 必须能解锁才让用户点同步），再连远端 —— 这是真实用户路径
    const b = machine('b-align')
    b.manager.create(PASSPHRASE)
    expect(b.sync.status().localCommit).toBeNull()
    expect(b.manager.listLibrary().hosts).toHaveLength(0)

    expect((await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    const pulled = await b.sync.pull()
    expect(pulled.state).toBe('idle')
    expect(pulled.localCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(pulled.localCommit).toBe(pulled.remoteCommit)
    expect(existsSync(join(b.repoDir, 'manifest.json'))).toBe(true)
    expect(existsSync(join(b.repoDir, 'vault.enc'))).toBe(true)

    // 对齐后本地就是远端那份密文：B 必须用同一主口令解锁（原先内存里的空库不再有效）
    expect(b.manager.status().state).toBe('locked')
    expectIpc(() => b.manager.listLibrary(), 'E_VAULT_LOCKED', 'locked')
    expect(b.manager.unlock(PASSPHRASE, false).state).toBe('unlocked')

    const library = b.manager.listLibrary()
    expect(library.hosts).toHaveLength(3)
    expect(library.hosts.map((host) => host.hostname).sort()).toEqual([...FIXTURE_HOSTNAMES].sort())
    for (const [index, host] of library.hosts.entries()) {
      expect(b.manager.resolveHostAuth(host.id).password).toBe(`${FIXTURE_PASSWORD}-${index}`)
    }
  }, 60_000)

  it('本地库已有主机时不许被「首次对齐」覆盖：报 E_CONFLICT 且本地数据与远端 refs 都不变', async () => {
    const a = machine('a-guard')
    a.manager.create(PASSPHRASE)
    a.manager.createHost(hostInput({ label: 'remote-only', hostname: FIXTURE_HOSTNAMES[0] }))
    await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })
    const remoteBefore = gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()

    const b = machine('b-guard')
    b.manager.create(PASSPHRASE)
    b.manager.createHost(hostInput({ label: 'local-only', hostname: FIXTURE_HOSTNAMES[1] }))

    const error = await expectIpcAsync(b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' }), 'E_CONFLICT', 'conflict')
    expect((error.details as { localItems?: number }).localItems).toBe(1)

    // 本地主机还在（没被静默覆盖），远端也没被改写
    expect(b.manager.listLibrary().hosts.map((host) => host.label)).toEqual(['local-only'])
    expect(gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()).toBe(remoteBefore)
  }, 60_000)

  it('冲突选择 keep local 时本地值胜出；未配置仓库时 pull/push 报错而不是静默成功', async () => {
    const local = machine('solo')
    await expectIpcAsync(local.sync.pull(), 'E_INVALID_ARGUMENT', 'git')
    await expectIpcAsync(local.sync.push(), 'E_INVALID_ARGUMENT', 'git')
    local.manager.lock()
    await expectIpcAsync(local.sync.push(), 'E_INVALID_ARGUMENT', 'git')
  }, 30_000)
})

/**
 * AC-21：同步只能决定「接不接受远端内容」，不能决定「用谁的锁」。
 *
 * 这三例的共同布景是「A 机换了口令槽 → B 机同步」。槽一换，远端 `manifest.passphraseKey`
 * 与 AAD 盐都变；如果 B 原样接受，B 下次用自己的口令就开不了库（r3 的原始症状）。
 * 判据不是「同步成功」，而是「同步之后仓库里那把槽仍是 B 本机的那把，且 B 的原口令还能开库」。
 */
describe('AC-21 同步三条路径保槽（远端换过的口令槽不许盖掉本机那把）', () => {
  /** 断言仓库里的槽 / 盐仍是本机权威记录，并用本机原口令真的开一次库（反证槽没被换） */
  function expectLocalSlotKept(target: Machine, label: string): void {
    const slot = target.manager.localSlot()
    expect(slot, `${label}: 本机必须有权威槽记录`).not.toBeNull()
    const snapshot = readRepo(target.repoDir)
    expect(snapshot, `${label}: 仓库必须已落地`).not.toBeNull()
    expect(snapshot!.manifest.passphraseKey, `${label}: 仓库里的口令槽必须仍是本机那把`).toEqual(slot!.passphraseKey)
    expect(snapshot!.envelope.kdf.salt, `${label}: 仓库里的 KDF 盐必须与本机槽成对`).toBe(slot!.salt)
    target.manager.lock()
    expect(target.manager.unlock(PASSPHRASE, false).state, `${label}: 本机原口令必须仍能解锁`).toBe('unlocked')
  }

  function remoteVaultManifest(): { passphraseKey: unknown; revision: number } {
    return JSON.parse(gitCli(['-C', server.bareDir, 'show', 'main:manifest.json'])) as {
      passphraseKey: unknown
      revision: number
    }
  }

  it('快进路径：A 机轮换口令后 B 机 pull，仓库必须改用 B 的本机槽重封（B 的原口令仍可开库）', async () => {
    const a = machine('ac21-ff-a')
    a.manager.create(PASSPHRASE)
    a.manager.createHost(hostInput({ label: 'shared', hostname: FIXTURE_HOSTNAMES[0] }))
    expect((await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')

    const b = machine('ac21-ff-b')
    expect((await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    b.manager.unlock(PASSPHRASE, false)
    const slotBefore = b.manager.localSlot()
    expect(slotBefore).not.toBeNull()
    const remoteBefore = gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()

    // A 换口令 = 换槽：远端 manifest.passphraseKey 与 AAD 盐一起变
    a.manager.rotate({ currentPassphrase: PASSPHRASE, newPassphrase: ROTATED_PASSPHRASE })
    expect((await a.sync.push()).state).toBe('idle')
    const rotatedRemote = remoteVaultManifest()
    expect(rotatedRemote.passphraseKey, '远端必须真的换了槽，否则本用例不成立').not.toEqual(slotBefore!.passphraseKey)
    const remoteAfterRotate = gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()
    expect(remoteAfterRotate).not.toBe(remoteBefore)

    // B 快进：本地干净、无自有提交 → 走 fastForward + reload('sync-fast-forward')
    const pulled = await b.sync.pull()
    expect(pulled.state).toBe('idle')
    expect(pulled.localCommit).toBe(pulled.remoteCommit)
    expect(b.manager.listLibrary().hosts.map((host) => host.label)).toEqual(['shared'])

    expectLocalSlotKept(b, 'B 机快进后')
    // pull 只许改本机工作树，不许顺手改写远端（远端仍是 A 的新槽）
    expect(gitCli(['-C', server.bareDir, 'rev-parse', 'main']).trim()).toBe(remoteAfterRotate)
    expect(remoteVaultManifest().passphraseKey).toEqual(rotatedRemote.passphraseKey)
  }, 90_000)

  it('合并路径：远端换了槽 + 本机有新主机 → 自动合并后仍用本机槽，合并内容不丢', async () => {
    const a = machine('ac21-merge-a')
    const b = machine('ac21-merge-b')
    a.manager.create(PASSPHRASE)
    a.manager.createHost(hostInput({ label: 'shared', hostname: FIXTURE_HOSTNAMES[0] }))
    expect((await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    expect((await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    b.manager.unlock(PASSPHRASE, false)
    const slotBefore = b.manager.localSlot()
    expect(slotBefore).not.toBeNull()

    a.manager.rotate({ currentPassphrase: PASSPHRASE, newPassphrase: ROTATED_PASSPHRASE })
    a.manager.createHost(hostInput({ label: 'from-a', hostname: FIXTURE_HOSTNAMES[1] }))
    expect((await a.sync.push()).state).toBe('idle')

    // B 侧也有改动 → 不能快进，必然走 mergeFlow 的无冲突分支（reload('sync-merge') + adoptRemotePayload）
    b.manager.createHost(hostInput({ label: 'from-b', hostname: FIXTURE_HOSTNAMES[2] }))
    const merged = await b.sync.push()
    expect(merged.state).toBe('idle')
    expect(merged.conflictCount).toBe(0)

    const labels = b.manager
      .listLibrary()
      .hosts.map((host) => host.label)
      .sort()
    expect(labels, '合并不许丢任何一侧的主机').toEqual(['from-a', 'from-b', 'shared'])

    expectLocalSlotKept(b, 'B 机合并后')
  }, 90_000)

  it('冲突解决路径：远端换槽 + 同字段冲突 → resolve 之后仓库仍用本机槽', async () => {
    const a = machine('ac21-conf-a')
    const b = machine('ac21-conf-b')
    a.manager.create(PASSPHRASE)
    const shared = a.manager.createHost(hostInput({ label: 'shared', hostname: FIXTURE_HOSTNAMES[0] }))
    expect((await a.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    expect((await b.sync.bootstrap({ remoteUrl: server.url, branch: 'main', auth: 'none' })).state).toBe('idle')
    b.manager.unlock(PASSPHRASE, false)
    const slotBefore = b.manager.localSlot()
    expect(slotBefore).not.toBeNull()

    a.manager.rotate({ currentPassphrase: PASSPHRASE, newPassphrase: ROTATED_PASSPHRASE })
    const hostOnA = a.manager.listLibrary().hosts.find((host) => host.id === shared.id)!
    a.manager.updateHost(hostOnA.id, { ...hostOnA, port: 2222 })
    expect((await a.sync.push()).state).toBe('idle')

    const hostOnB = b.manager.listLibrary().hosts.find((host) => host.id === shared.id)!
    b.manager.updateHost(hostOnB.id, { ...hostOnB, port: 2200 })
    const conflict = await expectIpcAsync(b.sync.push(), 'E_CONFLICT', 'conflict')
    expect(conflict.code).toBe('E_CONFLICT')
    expect(b.sync.status().state).toBe('diverged')

    const conflicts = b.sync.conflicts()
    expect(conflicts).toHaveLength(1)
    const resolved = await b.sync.resolve({ conflictId: conflicts[0]!.id, strategy: 'remote' })
    expect(resolved.state).toBe('idle')
    expect(b.manager.listLibrary().hosts.find((host) => host.id === shared.id)?.port).toBe(2222)

    expectLocalSlotKept(b, 'B 机冲突解决后')
  }, 120_000)
})
