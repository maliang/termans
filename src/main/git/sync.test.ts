import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import { SCRYPT_TEST } from '../crypto'
import { VaultManager } from '../vault/manager'
import { createFileSecretBox, type SecretBox } from '../vault/secret-box'
import { FIXTURE_HOSTNAMES, FIXTURE_PASSWORD, hostInput } from '../vault/test-fixtures'
import { SyncCoordinator } from './sync'
import { gitCli, startTestGitServer, type TestGitServer } from './test-git-server'

const PASSPHRASE = 'correct horse battery staple'

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
