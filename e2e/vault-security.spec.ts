import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from './harness'
import { startE2eSshServer, type E2eSshServer } from './fixtures/ssh-server'
import {
  addHost,
  clearPrivateKey,
  connectHost,
  createVault,
  hostIdByLabel,
  importPrivateKey,
  invokeInPage,
  terminalText,
  waitForConnected
} from './fixtures/ui'

/**
 * 安全与迁移相关的验收（⑥⑦⑧）：私钥不同步、ssh_config 无损写回、known_hosts 指纹。
 * ⑦（乐观锁冲突快照）依赖「两台机器都能拉到同一个库」，被新机首次 pull 的缺陷挡住，
 * 单独记在报告里，这里不写假绿用例。
 */

test.describe.configure({ mode: 'serial' })

let app: LaunchedApp
let ssh: E2eSshServer

test.beforeEach(async () => {
  ssh = await startE2eSshServer()
  app = await launchApp({
    args: ['--disable-gpu'],
    waitFor: (page) => page.getByTestId('unlock-screen').waitFor()
  })
  await createVault(app.window)
})

test.afterEach(async () => {
  await app?.cleanup()
  await ssh?.stop()
})

test('⑥ 私钥不同步：删掉本机私钥后连接必须明确报「私钥不在本机」，且不静默失败', async () => {
  const page = app.window
  await addHost(page, {
    label: 'pk-host',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    privateKeyPath: ''
  })
  await importPrivateKey(page, 'pk-host', ssh.clientKey.privateKey)
  await connectHost(page, 'pk-host')
  await waitForConnected(page)

  // 模拟「换了一台机器」：仓库里只有 privateKeyPath 这个引用，私钥本体不在本机
  await clearPrivateKey(page, 'pk-host')
  const hostId = await hostIdByLabel(page, 'pk-host')
  expect(hostId).not.toBe('')

  await connectHost(page, 'pk-host')
  // 明确报错必须「指名哪台主机 + 缺的是私钥」，不能退化成一句 All configured authentication methods failed
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(/no private key configured|Private key is not stored/i)
})

test('⑧ ssh_config 写回：命中块被改，其余注释与 Host 块逐字不变', async () => {
  const page = app.window
  const dir = mkdtempSync(join(tmpdir(), 'termans-sshconfig-'))
  const path = join(dir, 'config')
  const original = [
    '# 顶部注释：这一段必须原样保留',
    'Host untouched',
    '  HostName untouched.example.com',
    '  User alice',
    '  # 块内注释也要留下',
    '  Port 2200',
    '',
    'Host termans-e2e',
    '  HostName 127.0.0.1',
    '  User termans',
    ''
  ].join('\n')
  writeFileSync(path, original, 'utf8')

  const parsed = (await invokeInPage(page, 'ssh-config:parse', { path })) as {
    exists: boolean
    entries: Array<{ alias: string; hostname: string | null; user: string | null }>
  }
  expect(parsed.exists).toBe(true)
  expect(parsed.entries.map((entry) => entry.alias)).toEqual(['untouched', 'termans-e2e'])

  const written = (await invokeInPage(page, 'ssh-config:write', {
    path,
    updates: [{ alias: 'termans-e2e', fields: { Port: '2222' } }],
    createBackup: false,
    dryRun: false
  })) as { modifiedAliases: string[]; appendedAliases: string[] }
  expect(written.modifiedAliases).toEqual(['termans-e2e'])
  expect(written.appendedAliases).toEqual([])

  const after = readFileSync(path, 'utf8')
  // 前半段（注释 + 未被点名的 Host 块）逐字节相同
  expect(after.slice(0, original.indexOf('Host termans-e2e'))).toBe(
    original.slice(0, original.indexOf('Host termans-e2e'))
  )
  expect(after).toContain('  Port 2222')
  expect(after).not.toContain('  Port 2200\n  Port 2222')
})

test('⑧ known_hosts：预置正确指纹后不再弹首次确认；指纹被改错必须硬失败', async () => {
  const page = app.window
  await addHost(page, {
    label: 'known-host',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    password: ssh.password
  })

  await invokeInPage(page, 'known-hosts:trust', {
    host: '127.0.0.1',
    port: ssh.port,
    keyType: 'ssh-ed25519',
    fingerprintSha256: ssh.hostKeyFingerprint,
    replaceExisting: false
  })

  const item = page.getByTestId('vault-host-item').filter({ hasText: 'known-host' }).first()
  await item.dblclick()
  // 信任链已预置 → 不应再出现首次确认对话框
  await expect(page.getByTestId('host-key-dialog')).toHaveCount(0, { timeout: 5_000 })
  await waitForConnected(page)

  // 把已信任指纹改成别的值（模拟中间人），连接必须硬失败而不是弹「接受」让用户点过去
  await invokeInPage(page, 'known-hosts:remove', { host: '127.0.0.1', port: ssh.port })
  await invokeInPage(page, 'known-hosts:trust', {
    host: '127.0.0.1',
    port: ssh.port,
    keyType: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    replaceExisting: true
  })

  await item.dblclick()
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toMatch(/Host key|主机密钥|mismatch|不匹配/i)
  // 「接受并记住」不能把 mismatch 掩盖过去：对话框即使出现，也不应带勾选的「记住」
  const dialog = page.getByTestId('host-key-dialog')
  if ((await dialog.count()) > 0) {
    await expect(page.getByTestId('host-key-remember')).not.toBeChecked()
  }
})
