import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from './harness'
import { startE2eSshServer, type E2eSshServer } from './fixtures/ssh-server'
import {
  addHost,
  connectHost,
  createVault,
  expectTerminalContains,
  importPrivateKey,
  terminalText,
  typeCommand,
  waitForConnected
} from './fixtures/ui'

/**
 * 连接 + 回显 + 多页签（SPEC 验收矩阵里终端/连接那一组的前半段）。
 *
 * 为什么整个文件都用 `--disable-gpu`：xterm 在 GPU 可用时会挂 WebGL 渲染器，终端文字画在 canvas 上，
 * DOM 里 `.xterm-rows` 数量为 0（实测），回显断言只能靠截图比对——既脆又没法定位。
 * 关掉 GPU 后 xterm 回退 DOM 渲染器，`.xterm-rows` 里就是真实文本（与应用在无 GPU 机器上的行为一致）。
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

test('密码登录：首连弹主机密钥 → 接受后 banner 与回显可见，连接稳定超过 5 秒', async () => {
  const page = app.window
  await addHost(page, {
    label: 'e2e-password',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    password: ssh.password
  })

  const item = page.getByTestId('vault-host-item').filter({ hasText: 'e2e-password' }).first()
  await item.dblclick()

  // 首连必须弹指纹确认，且指纹就是服务端的指纹（known_hosts 的第一半）
  const dialog = page.getByTestId('host-key-dialog')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('host-key-fingerprint')).toHaveText(ssh.hostKeyFingerprint)
  await page.getByTestId('host-key-accept').click()
  await expect(dialog).toBeHidden({ timeout: 10_000 })

  await waitForConnected(page)

  // 输入走真实键盘事件：xterm onData → ssh:input → 服务端读到整行
  await typeCommand(page, 'echo E2E-MARKER-PWD')
  await expect.poll(() => ssh.shellLines, { timeout: 15_000 }).toContain('echo E2E-MARKER-PWD')
  await expectTerminalContains(page, 'echo E2E-MARKER-PWD')

  // 「稳定超过 5 秒」：等 5s 后再敲一次，服务端仍能收到、终端仍能回显（对应 t18 那条 1s 被 FIN 的坑）
  await page.waitForTimeout(5_000)
  await typeCommand(page, 'echo E2E-STILL-ALIVE')
  await expect.poll(() => ssh.shellLines, { timeout: 15_000 }).toContain('echo E2E-STILL-ALIVE')
  await expectTerminalContains(page, 'echo E2E-STILL-ALIVE')

  const authPassword = ssh.authAttempts.filter((entry) => entry.method === 'password' && entry.accepted)
  expect(authPassword.length).toBeGreaterThan(0)
  expect(authPassword[0]?.username).toBe(ssh.username)
})

test('公钥登录：私钥导入 vault 后可连上（夹具侧记录 publickey accepted，且从不降级到密码）', async () => {
  const page = app.window
  await addHost(page, {
    label: 'e2e-publickey',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    // 认证方式选 publickey，但不填 IdentityFile：私钥走 vault（产品设计的「导入」路径）
    privateKeyPath: ''
  })
  await importPrivateKey(page, 'e2e-publickey', ssh.clientKey.privateKey)

  await connectHost(page, 'e2e-publickey')
  await waitForConnected(page)

  await typeCommand(page, 'echo E2E-MARKER-KEY')
  await expect.poll(() => ssh.shellLines, { timeout: 15_000 }).toContain('echo E2E-MARKER-KEY')

  const publickey = ssh.authAttempts.filter((entry) => entry.method === 'publickey' && entry.accepted)
  expect(publickey.length).toBeGreaterThan(0)
  // 密码路径一次都不该走（走了说明引擎在降级，安全问题而不是便利问题）
  expect(ssh.authAttempts.some((entry) => entry.method === 'password')).toBe(false)
})

test('多页签：新开第二个页签、切回保留 scrollback、关闭需二次确认', async () => {
  const page = app.window
  await addHost(page, {
    label: 'e2e-tabs',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    password: ssh.password
  })
  await connectHost(page, 'e2e-tabs')
  await waitForConnected(page)
  await typeCommand(page, 'echo SCROLLBACK-KEEP')
  await expectTerminalContains(page, 'SCROLLBACK-KEEP')

  // 第二个页签：走「新建页签 → 选主机」的 picker（不是双击主机库）
  await page.getByTestId('tab-new').click()
  await expect(page.getByTestId('new-tab-picker')).toBeVisible()
  await page.getByTestId('picker-mode-hosts').click()
  await page.getByTestId(`picker-host-127.0.0.1`).first().click()

  // 首连已经记住指纹，第二次连接**不应**再弹主机密钥对话框
  const dialog = page.getByTestId('host-key-dialog')
  await expect(dialog).toHaveCount(0, { timeout: 5_000 })
  await expect(page.getByTestId('tab-2')).toBeVisible({ timeout: 20_000 })
  await expect.poll(async () => (await page.locator('.xterm-rows').count()), { timeout: 20_000 }).toBeGreaterThan(1)

  // 切回第一个页签：它的 scrollback 必须还在（不同页签 = 不同 xterm 实例，销毁了就会丢）
  await page.getByTestId('tab-1').click()
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('SCROLLBACK-KEEP')

  // 关闭第二个页签：必须先弹确认
  await page.getByTestId('tab-2').hover()
  await page.getByTestId('tab-close-2').click()
  const closeDialog = page.getByTestId('close-tab-dialog')
  await expect(closeDialog).toBeVisible()
  await page.getByTestId('close-tab-cancel').click()
  await expect(closeDialog).toBeHidden()
  await expect(page.getByTestId('tab-2')).toBeVisible()

  await page.getByTestId('tab-2').hover()
  await page.getByTestId('tab-close-2').click()
  await expect(closeDialog).toBeVisible()
  await page.getByTestId('close-tab-confirm').click()
  await expect(page.getByTestId('tab-2')).toHaveCount(0, { timeout: 10_000 })
  await expect(page.getByTestId('tab-1')).toBeVisible()
})
