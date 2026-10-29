import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from './harness'
import { startE2eSshServer, type E2eSshServer } from './fixtures/ssh-server'
import { addHost, connectHost, createVault, openSettings, terminalBackground, waitForConnected } from './fixtures/ui'

/**
 * 主题与语言（验收 ⑨）：切换后必须**在终端上生效**，不是只改了设置里的一个字段。
 *
 * 断言对象刻意选「终端背景的计算值」而不是 `--ts-*` 变量：变量写对了但没应用到 xterm，
 * 用户看到的仍然是旧主题；只有 getComputedStyle 拿到的实际背景色能证明「真的变了」。
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
  // 先开一个终端：主题要断言的正是 xterm 实例的背景
  await addHost(app.window, {
    label: 'theme-host',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    password: ssh.password
  })
  await connectHost(app.window, 'theme-host')
  await waitForConnected(app.window)
})

test.afterEach(async () => {
  await app?.cleanup()
  await ssh?.stop()
})

test('切主题：终端背景计算值随主题改变，data-theme-id 同步更新', async () => {
  const page = app.window
  const before = await terminalBackground(page)
  const beforeId = await page.evaluate(() => document.documentElement.dataset['themeId'] ?? '')

  await openSettings(page)
  // 选一张与当前不同的内置主题（不写死「下一个是谁」，避免主题顺序调整就把用例弄红）
  const options = page.locator('[data-testid^="theme-option-"]')
  const count = await options.count()
  expect(count).toBeGreaterThan(1)
  let picked = ''
  for (let index = 0; index < count; index += 1) {
    const testId = (await options.nth(index).getAttribute('data-testid')) ?? ''
    if (!testId.endsWith(beforeId)) {
      picked = testId
      await options.nth(index).click()
      break
    }
  }
  expect(picked).not.toBe('')

  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset['themeId'] ?? ''), { timeout: 10_000 })
    .not.toBe(beforeId)
  await expect.poll(() => terminalBackground(page), { timeout: 10_000 }).not.toBe(before)
})

test('切语言：已知标签从中文变英文再切回中文', async () => {
  const page = app.window
  // 侧栏标题：zh-CN「主机库」/ en「Host library」（src/locales/<lang>/hosts.json 的 sidebar.title）
  const heading = page.getByRole('heading', { level: 1 })
  await expect(heading).toHaveText('主机库')

  await openSettings(page)
  await page.getByTestId('locale-select').selectOption('en')
  await page.getByTestId('settings-close').click()
  await expect(heading).toHaveText('Host library', { timeout: 10_000 })

  // 切回中文：语言是可往返的，不是「切出去就回不来」
  await openSettings(page)
  await page.getByTestId('locale-select').selectOption('zh-CN')
  await page.getByTestId('settings-close').click()
  await expect(heading).toHaveText('主机库', { timeout: 10_000 })
})
