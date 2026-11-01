import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import { SCRYPT_TEST, openVault, resealPassphraseSlot, resealPayload, slotFingerprint } from '../crypto'
import { passphraseVariants } from '../crypto/passphrase'
import { VaultManager } from './manager'
import { createFileSecretBox } from './secret-box'
import * as modelModule from './model'
import { listRepoFiles, listThemeFiles, readRepo, writeRepo } from './repo'
import { parseSshConfigText } from './ssh-config-text'
import {
  FIXTURE_HOSTNAMES,
  FIXTURE_PASSPHRASE,
  FIXTURE_PASSWORD,
  PRIVATE_KEY_MARKER,
  groupInput,
  hostInput
} from './test-fixtures'

const PASSPHRASE = 'correct horse battery staple'
const NEW_PASSPHRASE = 'a slightly different long passphrase'

let root = ''
let repoDir = ''
let localDir = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'termans-vault-'))
  repoDir = join(root, 'vault')
  localDir = join(root, 'vault-local')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface ManagerOptions {
  clock?: () => number
  autoLockMinutes?: number
  requirePassphraseOnLaunch?: boolean
  passphraseVariants?: boolean
  onKekDerived?: () => void
}

function makeManager(options: ManagerOptions = {}): VaultManager {
  return new VaultManager({
    repoDir,
    localDir,
    box: createFileSecretBox(localDir),
    cost: SCRYPT_TEST,
    autoLockMinutes: options.autoLockMinutes ?? 0,
    requirePassphraseOnLaunch: options.requirePassphraseOnLaunch ?? true,
    clock: options.clock,
    passphraseVariants: options.passphraseVariants,
    onKekDerived: options.onKekDerived
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

/** 把仓库工作区里所有文件（不含 .git）读成文本，用于「grep 不到明文」的断言 */
function repoText(): string {
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else chunks.push(readFileSync(path, 'utf8'))
    }
  }
  if (existsSync(repoDir)) walk(repoDir)
  return chunks.join('\n')
}

describe('VaultManager：创建与锁定', () => {
  it('创建后：解锁态、仓库里只有 manifest.json + vault.enc、恢复码一次性下发', () => {
    const manager = makeManager()
    const result = manager.create(PASSPHRASE)
    expect(result.recoveryCode).toHaveLength(39)
    expect(result.status.state).toBe('unlocked')
    expect(result.status.cipher).toBe('aes-256-gcm')
    expect(result.status.kdf).toMatchObject({ name: 'scrypt', N: SCRYPT_TEST.N, r: 8, p: 1 })
    expect(result.status.recoveryAvailable).toBe(true)
    expect(result.status.policy).toEqual({
      secretsExcluded: true,
      privateKeysExcluded: true,
      plaintextHostnamesInRepo: false
    })
    expect(result.status.itemCounts).toMatchObject({ hosts: 0, groups: 0, knownHosts: 0, themes: 0 })

    // 验收用的 ls -R 等价物
    expect(listRepoFiles(repoDir)).toEqual(['manifest.json', 'vault.enc'])
    // 本机私有文件必须落在 vault-local，不能进仓库
    expect(existsSync(join(localDir, 'local.json'))).toBe(true)
    expect(existsSync(join(repoDir, 'local.json'))).toBe(false)
  })

  it('锁定时不返回任何主机信息：hosts:list 抛 E_VAULT_LOCKED、itemCounts 为 null', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.createHost(hostInput({ credentialRef: 'ref-1' }))
    manager.setSecret('ref-1', { password: FIXTURE_PASSWORD })
    const locked = manager.lock()
    expect(locked.state).toBe('locked')
    expect(locked.itemCounts).toBeNull()
    expect(locked.keychainBacked).toBe(false)
    expectIpc(() => manager.listLibrary(), 'E_VAULT_LOCKED', 'locked')
    expectIpc(() => manager.getSecret('ref-1'), 'E_VAULT_LOCKED', 'locked')
    // 锁定态不允许任何读操作泄漏（包括 AI key）
    expectIpc(() => manager.getAiApiKey('openai'), 'E_VAULT_LOCKED', 'locked')
  })

  it('未初始化时的状态是 uninitialized，且不会因为读盘失败而崩', () => {
    const manager = makeManager()
    const status = manager.init()
    expect(status.state).toBe('uninitialized')
    expectIpc(() => manager.listLibrary(), 'E_VAULT_LOCKED', 'locked')
  })

  it('仓库损坏时 init 不抛（窗口要能起来），状态里体现 lastSyncedAt/createdAt 仍可用', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    // 把 vault.enc 改坏
    const encPath = join(repoDir, 'vault.enc')
    const bytes = readFileSync(encPath)
    bytes[10] = bytes[10] === 0x41 ? 0x42 : 0x41
    readFileSync(encPath)
    require('node:fs').writeFileSync(encPath, bytes)

    const reopened = makeManager()
    const status = reopened.init()
    expect(status.state).toBe('locked')
  })
})

describe('VaultManager：上锁回调（清凭据副本的接线点）', () => {
  it('lock() 触发 onLock，且重复 lock 不再触发（幂等）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    let fired = 0
    manager.onLock = () => {
      fired += 1
    }
    manager.lock()
    expect(fired).toBe(1)
    manager.lock() // 已经锁着：不该再通知（否则组合根会反复扫会话）
    expect(fired).toBe(1)
  })

  it('被动回锁（仓库读失败 → forceLock）也触发 onLock', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.createHost(hostInput({ credentialRef: 'ref-1' }))
    let fired = 0
    manager.onLock = () => {
      fired += 1
    }
    // 把 vault.enc 改坏，再 reload —— 走的是 forceLock('read-failed')
    const encPath = join(repoDir, 'vault.enc')
    const bytes = readFileSync(encPath)
    bytes[10] = bytes[10] === 0x41 ? 0x42 : 0x41
    require('node:fs').writeFileSync(encPath, bytes)
    const status = manager.reload()
    expect(status.state).toBe('locked')
    expect(manager.lastLockReason).toBe('read-failed')
    expect(fired).toBe(1)
  })

  it('onLock 抛错不能把上锁流程带崩（凭据清理是尽力而为）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.onLock = () => {
      throw new Error('cleanup blew up')
    }
    const status = manager.lock()
    expect(status.state).toBe('locked')
    // VMK 与 payload 必须真的没了（否则「以为锁上了」比没锁更糟）
    manager.assertStateConsistent()
    expectIpc(() => manager.listLibrary(), 'E_VAULT_LOCKED', 'locked')
  })
})

describe('VaultManager：口令与恢复码', () => {
  it('口令太短直接拒绝；弱口令需要「同口令二次提交」确认', () => {
    const manager = makeManager()
    expectIpc(() => manager.create('short'), 'E_INVALID_ARGUMENT', 'too-short')

    const first = expectIpc(() => manager.create('aaaaaaaaaaaa'), 'E_INVALID_ARGUMENT', 'weak-passphrase')
    expect((first.details as { requiresConfirmation?: boolean }).requiresConfirmation).toBe(true)
    expect(manager.status().state).toBe('uninitialized')

    // 同一个弱口令再提交一次 = 用户确认
    const result = manager.create('aaaaaaaaaaaa')
    expect(result.status.state).toBe('unlocked')
  })

  it('口令错 → E_UNAUTHORIZED bad-passphrase；连续失败后进入节流', () => {
    let now = 1_700_000_000_000
    const manager = makeManager({ clock: () => now })
    manager.create(PASSPHRASE)
    manager.lock()

    // 前 3 次：正常报口令错（不带 retryAfterMs）
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const error = expectIpc(() => manager.unlock('wrong but long enough', false), 'E_UNAUTHORIZED', 'bad-passphrase')
      expect((error.details as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
    }
    // 第 4 次开始节流：即使口令正确也被拦（挡在线爆破）
    const throttled = expectIpc(() => manager.unlock(PASSPHRASE, false), 'E_UNAUTHORIZED', 'throttled')
    expect((throttled.details as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0)

    now += 5_000
    expect(manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
  })

  it('「记住本机 7 天」：写过会话后新进程直接解锁；要求每次输口令时仍然锁定', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const unlocked = manager.unlock(PASSPHRASE, true)
    expect(unlocked.keychainBacked).toBe(true)
    expect(existsSync(join(localDir, 'session.json'))).toBe(true)

    const remembered = makeManager({ requirePassphraseOnLaunch: false })
    expect(remembered.init().state).toBe('unlocked')
    expect(remembered.listLibrary().hosts).toHaveLength(0)

    const strict = makeManager({ requirePassphraseOnLaunch: true })
    expect(strict.init().state).toBe('locked')
  })

  it('轮换口令：旧口令失效、新口令可用、恢复码同时换新', () => {
    const manager = makeManager()
    const created = manager.create(PASSPHRASE)
    expectIpc(
      () => manager.rotate({ currentPassphrase: 'not-the-current-one', newPassphrase: NEW_PASSPHRASE }),
      'E_UNAUTHORIZED',
      'bad-passphrase'
    )
    const rotated = manager.rotate({ currentPassphrase: PASSPHRASE, newPassphrase: NEW_PASSPHRASE })
    expect(rotated.recoveryCode).not.toBe(created.recoveryCode)
    expectIpc(() => manager.rotate({ currentPassphrase: NEW_PASSPHRASE, newPassphrase: 'short' }), 'E_INVALID_ARGUMENT', 'too-short')

    manager.lock()
    expectIpc(() => manager.unlock(PASSPHRASE, false), 'E_UNAUTHORIZED', 'bad-passphrase')
    expect(manager.unlock(NEW_PASSPHRASE, false).state).toBe('unlocked')
  })

  it('恢复码恢复：换口令、旧口令失效、同一恢复码仍可用（与 SPEC S-08 的偏差已在文档写明）', () => {
    const manager = makeManager()
    const created = manager.create(PASSPHRASE)
    manager.lock()
    expectIpc(
      () => manager.recover({ recoveryCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ', newPassphrase: NEW_PASSPHRASE }),
      'E_UNAUTHORIZED',
      'bad-recovery-code'
    )
    expectIpc(() => manager.recover({ recoveryCode: 'nope', newPassphrase: NEW_PASSPHRASE }), 'E_INVALID_ARGUMENT', 'bad-recovery-code')

    const recovered = manager.recover({ recoveryCode: created.recoveryCode, newPassphrase: NEW_PASSPHRASE })
    expect(recovered.state).toBe('unlocked')
    manager.lock()
    expectIpc(() => manager.unlock(PASSPHRASE, false), 'E_UNAUTHORIZED', 'bad-passphrase')
    expect(manager.unlock(NEW_PASSPHRASE, false).state).toBe('unlocked')

    // 偏差：契约没有字段把新恢复码带回前端，所以恢复流程保留原恢复码
    manager.lock()
    expect(manager.recover({ recoveryCode: created.recoveryCode, newPassphrase: 'yet another long passphrase' }).state).toBe(
      'unlocked'
    )
  })
})

describe('VaultManager：主机、凭据与「仓库里没有明文」', () => {
  it('主机 + 密码写进密文包；仓库文件里 grep 不到 IP / 主机名 / 密码 / 私钥标记', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const group = manager.createGroup(groupInput({ name: 'Production' }))
    hostInput()
    const hosts = FIXTURE_HOSTNAMES.map((hostname, index) => {
      const record = manager.createHost(
        hostInput({
          label: `prod-${index}`,
          hostname,
          groupId: index === 0 ? null : group.id,
          credentialRef: `ref-${index}`,
          username: 'deploy',
          authMethod: 'password'
        })
      )
      manager.setSecret(`ref-${index}`, { password: `${FIXTURE_PASSWORD}-${index}` })
      return record
    })
    manager.importPrivateKey(hosts[0]!.id, `${PRIVATE_KEY_MARKER}\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----`)

    const text = repoText()
    for (const needle of [...FIXTURE_HOSTNAMES, 'prod-0', FIXTURE_PASSWORD, FIXTURE_PASSPHRASE, 'PRIVATE KEY', 'deploy']) {
      expect(text).not.toContain(needle)
    }
    // manifest 是明文，但它连 hosts 字段都不该有
    const manifest = readFileSync(join(repoDir, 'manifest.json'), 'utf8')
    expect(manifest).not.toContain('hosts')
    expect(manifest).toContain('"format": "termans-vault"')
    // 私钥进了本机 credentials.json（密文），而不是仓库
    expect(readFileSync(join(localDir, 'credentials.json'), 'utf8')).not.toContain('PRIVATE KEY')
  })

  it('写操作会重新加密整份 payload 并推进 revision（远端据此判断「有没有真改动」）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const first = manager.manifestForSync()!
    manager.createHost(hostInput())
    const second = manager.manifestForSync()!
    expect(second.revision).toBe(first.revision + 1)
    expect(second.payload_sha256).not.toBe(first.payload_sha256)
    expect(readFileSync(join(repoDir, 'vault.enc'), 'utf8')).not.toBe('')
  })

  it('重新解锁后数据仍在（密文→明文往返）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const host = manager.createHost(hostInput({ credentialRef: 'ref-x' }))
    manager.setSecret('ref-x', { password: FIXTURE_PASSWORD })
    manager.lock()

    const reopened = makeManager()
    reopened.init()
    reopened.unlock(PASSPHRASE, false)
    const library = reopened.listLibrary()
    expect(library.hosts.map((item) => item.id)).toEqual([host.id])
    expect(reopened.getSecret('ref-x')?.password).toBe(FIXTURE_PASSWORD)
    expect(reopened.resolveHostAuth(host.id)).toMatchObject({ password: FIXTURE_PASSWORD, privateKeyStatus: 'not-required' })
  })

  it('私钥引导：缺文件时 privateKeyStatus=missing；导入后 present；路径存在也算 present', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const host = manager.createHost(hostInput({ authMethod: 'publickey', privateKeyPath: '/nonexistent/id_ed25519' }))
    expect(manager.resolveHostAuth(host.id).privateKeyStatus).toBe('missing')

    expectIpc(
      () => manager.importPrivateKey(host.id, 'not a key at all'),
      'E_INVALID_ARGUMENT',
      'invalid-payload'
    )
    manager.importPrivateKey(host.id, `${PRIVATE_KEY_MARKER}\nAAAA\n-----END OPENSSH PRIVATE KEY-----`)
    expect(manager.resolveHostAuth(host.id).privateKeyStatus).toBe('present')
    expect(manager.hasPrivateKey(host.id)).toBe(true)

    manager.clearPrivateKey(host.id)
    expect(manager.resolveHostAuth(host.id).privateKeyStatus).toBe('missing')
  })

  it('known_hosts 指纹走密文包（仓库里只剩密文）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.trustKnownHost({
      host: '10.20.30.40',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      replaceExisting: false
    })
    expect(manager.listKnownHosts()).toHaveLength(1)
    expect(repoText()).not.toContain('10.20.30.40')
  })
})

describe('VaultManager：AI 供应商配置（t5 写入）', () => {
  it('API key 往返：写入后重新解锁仍读得回，仓库里 grep 不到明文', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.setAiApiKey('openai', 'sk-live-0123456789abcdef')
    expect(manager.getAiApiKey('openai')).toBe('sk-live-0123456789abcdef')
    expect(manager.getAiApiKey('missing-provider')).toBeNull()
    expect(repoText()).not.toContain('sk-live-0123456789abcdef')

    manager.lock()
    const reopened = makeManager()
    reopened.init()
    reopened.unlock(PASSPHRASE, false)
    expect(reopened.getAiApiKey('openai')).toBe('sk-live-0123456789abcdef')

    reopened.clearAiApiKey('openai')
    expect(reopened.getAiApiKey('openai')).toBeNull()
    // 清除不存在的 key 是幂等操作
    expect(() => reopened.clearAiApiKey('openai')).not.toThrow()
    expectIpc(() => reopened.setAiApiKey('  ', 'x'), 'E_INVALID_ARGUMENT', 'invalid-payload')
  })

  it('providers.json 全文进密文包；非法 JSON 拒绝', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    expect(manager.getAiProvidersConfig()).toBeNull()
    const json = JSON.stringify({ version: 1, providers: [{ id: 'openai', model: 'gpt-5-codex' }] })
    manager.setAiProvidersConfig(json)
    expect(manager.getAiProvidersConfig()).toBe(json)
    expect(repoText()).not.toContain('gpt-5-codex')
    expectIpc(() => manager.setAiProvidersConfig('{not json'), 'E_INVALID_ARGUMENT', 'invalid-payload')
    manager.setAiProvidersConfig(null)
    expect(manager.getAiProvidersConfig()).toBeNull()
  })

  it('锁定态读 AI key 抛 E_VAULT_LOCKED（不能返回 null 让调用方误判「没配 key」）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.setAiApiKey('anthropic', 'sk-ant-xxx')
    manager.lock()
    expectIpc(() => manager.getAiApiKey('anthropic'), 'E_VAULT_LOCKED', 'locked')
    expectIpc(() => manager.getAiProvidersConfig(), 'E_VAULT_LOCKED', 'locked')
    expectIpc(() => manager.setAiApiKey('anthropic', 'y'), 'E_VAULT_LOCKED', 'locked')
  })

  it('旧 payload（integrations 里没有 aiProvidersConfig 字段）能正常解密加载，默认 null', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.createHost(hostInput({ label: 'legacy-host' }))
    const snapshot = readRepo(repoDir)
    expect(snapshot).not.toBeNull()

    // 造一份「加字段之前」的密文：解密旧 payload → 删掉新字段 → 原 salt/密钥重新封装
    const opened = openVault({
      manifest: snapshot!.manifest,
      encBytes: snapshot!.encBytes,
      credential: { passphrase: PASSPHRASE },
      envelope: snapshot!.envelope
    })
    const legacyPayload = JSON.parse(opened.payload) as { integrations: Record<string, unknown> }
    delete legacyPayload.integrations.aiProvidersConfig
    const resealed = resealPayload({
      manifest: snapshot!.manifest,
      envelope: snapshot!.envelope,
      expectedKdfSalt: snapshot!.envelope.kdf.salt,
      vaultKey: opened.vaultKey,
      payload: JSON.stringify(legacyPayload),
      revision: snapshot!.manifest.revision + 1
    })
    writeRepo(repoDir, { manifest: resealed.manifest, envelope: resealed.envelope, encBytes: resealed.encBytes, themes: [] }, localDir)

    const reopened = makeManager()
    reopened.init()
    expect(reopened.unlock(PASSPHRASE, false).state).toBe('unlocked')
    expect(reopened.getAiProvidersConfig()).toBeNull()
    expect(reopened.getAiApiKey('openai')).toBeNull()
    expect(reopened.listLibrary().hosts.map((host) => host.label)).toEqual(['legacy-host'])

    // 反例：真正的脏数据（settings 被写成空对象）必须被拒绝，而不是静默丢字段
    const { migratePayload: migrate } = modelModule
    expect(() => migrate({ ...JSON.parse(opened.payload), settings: {} })).toThrow(IpcCallError)
  })

  it('AI 供应商槽位空写入（null）后 unlock 重新读回仍是 null，不会变成 {}', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.setAiProvidersConfig(null)
    manager.lock()
    const reopened = makeManager()
    reopened.init()
    reopened.unlock(PASSPHRASE, false)
    expect(reopened.getAiProvidersConfig()).toBeNull()
  })
})

describe('VaultManager：ssh_config 与 themes', () => {
  const configText = [
    '# 手工维护的注释，导入导出必须逐字保留',
    'Host prod-web',
    '  HostName 10.20.30.40',
    '  User deploy',
    '  IdentityFile ~/.ssh/id_ed25519',
    '  ProxyJump bastion',
    '  Sendenv LANG=en_US.UTF-8',
    '',
    'Host bastion',
    '    HostName 10.20.30.1',
    '    User admin',
    ''
  ].join('\n')

  it('密文里保留 ssh_config 全文（注释/未知指令逐字保留），改主机时双向写回', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.setSshConfigText(configText, '/home/u/.ssh/config')
    expect(manager.sshConfigText().text).toBe(configText)

    const host = manager.createHost(
      hostInput({ label: 'prod-web', hostname: '10.20.30.40', sshConfigOrigin: { file: '/home/u/.ssh/config', alias: 'prod-web' } })
    )
    manager.updateHost(host.id, { ...hostInput({ label: 'prod-web', hostname: '10.20.30.99' }), sshConfigOrigin: { file: '/home/u/.ssh/config', alias: 'prod-web' } })

    const text = manager.sshConfigText().text
    expect(text).toContain('HostName 10.20.30.99')
    expect(text).toContain('# 手工维护的注释，导入导出必须逐字保留')
    expect(text).toContain('  Sendenv LANG=en_US.UTF-8')
    expect(repoText()).not.toContain('10.20.30.40')
  })

  it('从解析结果导入：wildcard/无 HostName/重复 跳过，其余建主机并记溯源', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.createHost(hostInput({ label: 'dup', sshConfigOrigin: { file: 'x', alias: 'dup' } }))
    const parsed = parseSshConfigText(
      ['Host ok', '  HostName 10.0.0.1', '  User u', 'Host *', '  ServerAliveInterval 30', 'Host nocfg', 'Host dup', '  HostName 10.0.0.2', ''].join(
        '\n'
      ),
      '/tmp/config'
    )
    const result = manager.importSshConfig(parsed, false, null)
    expect(result.importedAliases).toEqual(['ok'])
    expect(result.skipped.map((item) => item.reason)).toEqual(expect.arrayContaining(['wildcard', 'no-hostname', 'duplicate']))
    const imported = manager.listLibrary().hosts.find((host) => host.label === 'ok')
    expect(imported?.sshConfigOrigin).toEqual({ file: '/tmp/config', alias: 'ok' })
  })

  it('themes 落成明文 themes/*.json（保留 git diff 可读性），其余仍在密文里', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.setThemes([
      {
        id: 'my-theme',
        name: 'My Theme',
        appearance: 'dark',
        builtin: false,
        extends: 'termans-dark',
        tokens: { '--ts-accent': '#ff0000' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    expect(listThemeFiles(repoDir)).toEqual(['my-theme.json'])
    expect(listRepoFiles(repoDir)).toEqual(['manifest.json', 'vault.enc'])
    expect(readFileSync(join(repoDir, 'themes', 'my-theme.json'), 'utf8')).toContain('#ff0000')
    expect(statSync(join(repoDir, 'vault.enc')).mode & 0o777).toBe(0o600)
  })
})

const FULLWIDTH_PASSPHRASE = PASSPHRASE.replace(/[a-z]/g, (char) =>
  String.fromCharCode(char.charCodeAt(0) + 0xfee0)
)

function makeManagerAt(repo: string, local: string): VaultManager {
  return new VaultManager({
    repoDir: repo,
    localDir: local,
    box: createFileSecretBox(local),
    cost: SCRYPT_TEST,
    autoLockMinutes: 0,
    requirePassphraseOnLaunch: true
  })
}

describe('本机权威槽、变体解锁与归因（r3 · AC-1/2/7/8/9/18/21/22/24）', () => {
  it('创建后把口令槽连同盐一起落到 local.json，锁定时仍能自证（回退点：manager.ts rememberSlot()），删掉槽写入即 state.slotFingerprint 回 null', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const slot = manager.localSlot()
    expect(slot).not.toBeNull()
    expect(slot!.fingerprint).toMatch(/^[0-9a-f]{8}$/)
    expect(slot!.salt.length).toBeGreaterThan(15)
    expect(manager.status().slotFingerprint).toBe(slot!.fingerprint)
    manager.lock()
    expect(manager.status().slotFingerprint).toBe(slot!.fingerprint)
    const local = JSON.parse(readFileSync(join(localDir, 'local.json'), 'utf8')) as {
      version: number
      slot: { salt: string; fingerprint: string } | null
    }
    expect(local.version).toBe(2)
    expect(local.slot?.salt).toBe(slot!.salt)
  })

  it('仓库被另一台机器的整份仓库覆盖后，解锁归因为 slot-record-mismatch（回退点：manager.ts recordUnlockFailure() 传入的 recordedFingerprint），且本机槽不被覆盖', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const recorded = manager.localSlot()!.fingerprint
    manager.lock()
    const otherRepo = join(root, 'vault-other')
    const otherLocal = join(root, 'vault-local-other')
    const other = makeManagerAt(otherRepo, otherLocal)
    other.create(NEW_PASSPHRASE)
    copyFileSync(join(otherRepo, 'manifest.json'), join(repoDir, 'manifest.json'))
    copyFileSync(join(otherRepo, 'vault.enc'), join(repoDir, 'vault.enc'))
    expect(slotFingerprint(readRepo(repoDir, localDir)!.manifest)).not.toBe(recorded)
    expect(() => manager.unlock(PASSPHRASE, false)).toThrow()
    expect(manager.status().unlockFailure?.class).toBe('slot-record-mismatch')
    expect(manager.localSlot()!.fingerprint).toBe(recorded)
  })

  it('仓储字节坏了（payload 摘要对不上）→ 归因为 corrupt，且启动即可见（AC-1；回退点：manager.ts init()/unlock() 里读仓储失败的两处 recordUnlockFailure）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.lock()
    const encPath = join(repoDir, 'vault.enc')
    const bytes = readFileSync(encPath)
    bytes[bytes.length - 1] ^= 0xff
    writeFileSync(encPath, bytes)

    // 读仓储就失败 ⇒ 启动时（还没输过口令）status 里就该带归因，用户不必先白输一次
    const booted = makeManager().init()
    expect(booted.state).toBe('locked')
    expect(booted.unlockFailure?.class).toBe('corrupt')

    // 真去解锁也必须仍是 corrupt，绝不能被 GCM 失败糊成 bad-passphrase
    expect(() => manager.unlock(PASSPHRASE, false)).toThrow()
    expect(manager.status().unlockFailure?.class).toBe('corrupt')
  })

  it('本机槽盐与仓库信封盐不一致时拒绝重封、盘上零写入（AC-22；回退点：manager.ts afterMutation() 里 envelope.kdf.salt !== slot.salt 那段守卫）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const slot = manager.localSlot()!
    const beforeEnc = readFileSync(join(repoDir, 'vault.enc'))
    const beforeManifest = readFileSync(join(repoDir, 'manifest.json'))
    // 直接把这个「任何写路径都产生不了」的状态注入内存：信封盐换成另一只
    const internals = manager as unknown as { local: { slot: { salt: string } } }
    internals.local.slot = { ...slot, salt: Buffer.alloc(16, 0).toString('base64') }
    expectIpc(() => manager.setThemes([]), 'E_IO', 'slot-record-mismatch')
    expect(readFileSync(join(repoDir, 'vault.enc')).equals(beforeEnc)).toBe(true)
    expect(readFileSync(join(repoDir, 'manifest.json')).equals(beforeManifest)).toBe(true)
  })

  it('变体命中后换成规范形槽并留一次性告知（AC-7/AC-8；回退点：manager.ts unlock() 的 candidates 循环与 resealToCanonical()）；全角口令因 deriveKek 自带 NFKC 归一而在 identity 即命中，属已知边界', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.createHost(hostInput({ label: 'survives-variant' }))
    const before = manager.localSlot()!
    manager.lock()
    // deriveKek() 内部 secret.normalize('NFKC')（envelope.ts:314，r3 之前既有行为）⇒ 全角输入
    // 与原样输入派生出同一只 KEK，identity 直接命中、不会进入变体分支、也不弹告知条。
    const fullwidth = manager.unlock(FULLWIDTH_PASSPHRASE, false)
    expect(fullwidth.state).toBe('unlocked')
    expect(fullwidth.variantNotice).toBeNull()
    expect(manager.localSlot()!.fingerprint).toBe(before.fingerprint)
    manager.lock()
    // 能真正命中变体的是「首尾空格」这类不被 NFKC 归一的输入
    const status = manager.unlock(` ${PASSPHRASE} `, false)
    expect(status.state).toBe('unlocked')
    expect(status.variantNotice?.variant).toBe('trim')
    expect(manager.listLibrary().hosts.map((host) => host.label)).toEqual(['survives-variant'])
    const after = manager.localSlot()!
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.salt).not.toBe(before.salt)
    manager.lock()
    expect(manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
    expect(manager.dismissVariantNotice().variantNotice).toBeNull()
    const local = JSON.parse(readFileSync(join(localDir, 'local.json'), 'utf8')) as { variantNotice: unknown }
    expect(local.variantNotice).toBeNull()
  })

  it('告知条是一次性提示：首次投递后持久记录即作废，重启不再复发（AC-7；回退点：manager.ts status() 里首次投递即清 local.variantNotice 的那三行）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.lock()
    expect(manager.unlock(` ${PASSPHRASE} `, false).variantNotice?.variant).toBe('trim')
    // 同一次运行内再查状态也必须仍看得到（否则界面上的条会在下一次状态推送时闪没）
    expect(manager.status().variantNotice?.variant).toBe('trim')
    // 「一次性」的判据在盘上：投递过一次后 local.json 就不许再留着这条过期事实
    const persisted = JSON.parse(readFileSync(join(localDir, 'local.json'), 'utf8')) as { variantNotice: unknown }
    expect(persisted.variantNotice).toBeNull()
    // 重启（同一 localDir 新建 manager）：不得再冒出「已按…修正输入编码差异」
    const restarted = makeManager()
    expect(restarted.unlock(PASSPHRASE, false).state).toBe('unlocked')
    expect(restarted.status().variantNotice).toBeNull()
  })

  it('变体循环：identity 命中只派生 1 次，trim 命中派生 N+1 次（命中位置+重封自证），全变体失败只计 1 次失败（AC-9；回退点：manager.ts unlock() 循环外的那一次 registerFailure）', () => {
    const counter = { derived: 0 }
    const manager = makeManager({ onKekDerived: () => (counter.derived += 1) })
    manager.create(PASSPHRASE)
    manager.lock()
    counter.derived = 0
    expect(manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
    expect(counter.derived).toBe(1)
    manager.lock()
    counter.derived = 0
    const trimmed = ` ${PASSPHRASE} `
    const trimIndex = passphraseVariants(trimmed).findIndex((candidate) => candidate.variant === 'trim')
    expect(manager.unlock(trimmed, false).state).toBe('unlocked')
    // 前 trimIndex 个候选各失败一次 + 命中一次 + 重封后用规范形自证一次
    expect(counter.derived).toBe(trimIndex + 2)
    manager.lock()
    const wrong = `${PASSPHRASE.replace('correct', 'wrong')} `
    counter.derived = 0
    expect(() => manager.unlock(wrong, false)).toThrow()
    expect(counter.derived).toBe(passphraseVariants(wrong).length)
    expect(manager.status().unlockFailure?.class).toBe('bad-passphrase')
    // 一次错口令尝试 = 一次失败计数：再两次才进节流
    expectIpc(() => manager.unlock(wrong, false), 'E_UNAUTHORIZED', 'bad-passphrase')
    expectIpc(() => manager.unlock(wrong, false), 'E_UNAUTHORIZED', 'bad-passphrase')
    // 第 4 次在入口就被限流拒掉，且归因随之翻成 throttled（带剩余秒数）
    const throttledIpc = expectIpc(() => manager.unlock(wrong, false), 'E_UNAUTHORIZED', 'throttled')
    expect((throttledIpc.details as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0)
    const throttled = manager.status().unlockFailure
    expect(throttled?.class).toBe('throttled')
    expect(throttled?.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('同步后 reload 保住本机槽：远端换过的槽被本机覆盖回写，本机口令仍可解锁（AC-21；回退点：manager.ts reload() 里 slotNeedsRebase() 分支）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    manager.createHost(hostInput({ label: 'keep-me' }))
    const before = manager.localSlot()!
    const snapshot = readRepo(repoDir, localDir)!
    const opened = openVault({
      manifest: snapshot.manifest,
      encBytes: snapshot.encBytes,
      credential: { passphrase: PASSPHRASE },
      envelope: snapshot.envelope
    })
    const remote = resealPassphraseSlot({
      manifest: snapshot.manifest,
      envelope: snapshot.envelope,
      vaultKey: opened.vaultKey,
      passphrase: NEW_PASSPHRASE,
      revision: snapshot.manifest.revision + 1
    })
    writeRepo(
      repoDir,
      { manifest: remote.manifest, envelope: remote.envelope, encBytes: remote.encBytes, themes: [] },
      localDir
    )
    expect(slotFingerprint(remote.manifest)).not.toBe(before.fingerprint)
    const status = manager.reload('sync-fast-forward')
    expect(status.state).toBe('unlocked')
    expect(manager.localSlot()!.fingerprint).toBe(before.fingerprint)
    const after = readRepo(repoDir, localDir)!
    expect(slotFingerprint(after.manifest)).toBe(before.fingerprint)
    expect(after.envelope.kdf.salt).toBe(before.salt)
    manager.lock()
    expect(manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
    expect(manager.listLibrary().hosts.map((host) => host.label)).toEqual(['keep-me'])
  })

  it('锁定态同步：只记 slotDrift 绝不写盘，随后的解锁失败归因为 slot-record-mismatch（AC-2/AC-3；回退点：manager.ts reload() 的锁定态分支）', () => {
    const manager = makeManager()
    manager.create(PASSPHRASE)
    const recorded = manager.localSlot()!.fingerprint
    manager.lock()
    const otherRepo = join(root, 'vault-other2')
    const otherLocal = join(root, 'vault-local-other2')
    makeManagerAt(otherRepo, otherLocal).create(NEW_PASSPHRASE)
    copyFileSync(join(otherRepo, 'manifest.json'), join(repoDir, 'manifest.json'))
    copyFileSync(join(otherRepo, 'vault.enc'), join(repoDir, 'vault.enc'))
    const remoteManifest = readFileSync(join(repoDir, 'manifest.json'))
    manager.reload('sync-merge')
    expect(readFileSync(join(repoDir, 'manifest.json')).equals(remoteManifest)).toBe(true)
    const local = JSON.parse(readFileSync(join(localDir, 'local.json'), 'utf8')) as {
      slotDrift: { source: string; remoteFingerprint: string; recordedFingerprint: string | null } | null
    }
    expect(local.slotDrift?.source).toBe('sync-merge')
    expect(local.slotDrift?.recordedFingerprint).toBe(recorded)
    expect(local.slotDrift?.remoteFingerprint).not.toBe(recorded)
    expect(() => manager.unlock(PASSPHRASE, false)).toThrow()
    expect(manager.status().unlockFailure?.class).toBe('slot-record-mismatch')
  })

  it('记住本机后的会话恢复不写仓库（AC-24；回退点：manager.ts tryRestoreSession() 里只调 rememberSlot 不调 writeRepo）', () => {
    const writer = makeManager()
    writer.create(PASSPHRASE)
    writer.createHost(hostInput({ label: 'restored' }))
    writer.lock()
    writer.unlock(PASSPHRASE, true)
    const watched = ['manifest.json', 'vault.enc'].map((name) => ({
      name,
      bytes: readFileSync(join(repoDir, name)),
      mtime: statSync(join(repoDir, name)).mtimeMs
    }))
    const restored = makeManager({ requirePassphraseOnLaunch: false })
    restored.init()
    expect(restored.status().state).toBe('unlocked')
    expect(restored.listLibrary().hosts.map((host) => host.label)).toEqual(['restored'])
    expect(restored.localSlot()).not.toBeNull()
    for (const item of watched) {
      expect(readFileSync(join(repoDir, item.name)).equals(item.bytes)).toBe(true)
      expect(statSync(join(repoDir, item.name)).mtimeMs).toBe(item.mtime)
    }
  })

  it('老安装的 local.json v1 就地升级到 v2：不隔离成 .corrupt，既有字段不变，解锁后补上本机槽（AC-18；回退点：manager.ts loadLocal() 里的 v1→v2 默认值补齐）', () => {
    const seed = makeManager()
    seed.create(PASSPHRASE)
    const seededFingerprint = seed.localSlot()!.fingerprint
    const createdAt = '2026-01-01T00:00:00.000Z'
    rmSync(join(localDir, 'local.json'))
    writeFileSync(
      join(localDir, 'local.json'),
      `${JSON.stringify({
        version: 1,
        createdAt,
        lastUnlockedAt: null,
        lastSyncedAt: null,
        lastSyncedRevision: null,
        lastSyncedPayloadSha: null,
        repo: null,
        rememberedUntil: null
      })}\n`
    )
    const manager = makeManager()
    manager.init()
    expect(readdirSync(localDir).filter((name) => name.includes('.corrupt-'))).toEqual([])
    expect(manager.status().state).toBe('locked')
    expect(manager.status().slotFingerprint).toBeNull()
    expect(manager.unlock(PASSPHRASE, false).state).toBe('unlocked')
    const local = JSON.parse(readFileSync(join(localDir, 'local.json'), 'utf8')) as {
      version: number
      createdAt: string | null
      slot: { fingerprint: string } | null
    }
    expect(local.version).toBe(2)
    expect(local.createdAt).toBe(createdAt)
    expect(local.slot?.fingerprint).toBe(seededFingerprint)
  })
})
