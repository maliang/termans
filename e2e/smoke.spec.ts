import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

/**
 * 启动冒烟：唯一一个由 architect 维护的 e2e 用例，qa 只在其下扩写。
 *
 * 关键点：
 * - 直接启动 `out/main/index.js`（构建产物），**不经过 Vite dev server**：这样测的是打包路径，
 *   而不是「开发时能跑」。所以必须先 `pnpm build`（`pnpm test:e2e` 已包含）。
 * - `TERMANS_E2E=1` 让主进程跳过单实例锁（否则并行/残留实例会让启动静默退出），
 *   并把 userData 指到临时目录，测试之间不会互相污染 `settings.json`。
 * - 断言窗口标题而不只是 DOM 标题：标题是「主进程窗口真的起来了」的信号。
 */

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } }
type BridgeWindow = {
  termans?: {
    platform: string
    versions: { electron: string; chrome: string; node: string }
    invoke: (channel: string, payload?: unknown) => Promise<Envelope>
  }
}

const repoRoot = resolve(__dirname, '..')

let app: ElectronApplication
let page: Page
let userDataDir: string

/**
 * 环境坑（本机实测）：某些 shell / 工具链会导出 `ELECTRON_RUN_AS_NODE=1`，
 * 此时 Electron 二进制按 Node 运行，Playwright 传的 `--remote-debugging-port=0`
 * 会被当成 Node 的非法参数，报 `bad option: --remote-debugging-port=0`、进程直接退出。
 * 启动前必须显式删掉这个变量，否则所有 e2e 都是「Process failed to launch」。
 */
function electronEnv(): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  delete env['ELECTRON_ENABLE_LOGGING']
  return {
    ...(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>),
    NODE_ENV: 'production',
    TERMANS_E2E: '1',
    TERMANS_E2E_USER_DATA: userDataDir
  }
}

test.beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'termans-e2e-'))
  app = await electron.launch({
    args: [join(repoRoot, 'out/main/index.js')],
    cwd: repoRoot,
    env: electronEnv()
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  rmSync(userDataDir, { recursive: true, force: true })
})

test('窗口标题为 Termans，外壳四区渲染完成', async () => {
  await expect(page).toHaveTitle('Termans')

  const nativeTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle())
  expect(nativeTitle).toBe('Termans')

  // 左侧主机库 / 顶部页签条 / 主终端区 / 状态条（AI 面板默认收起）
  await expect(page.getByTestId('host-sidebar')).toBeVisible()
  await expect(page.getByTestId('tab-strip')).toBeVisible()
  await expect(page.getByTestId('terminal-area')).toBeVisible()
  await expect(page.getByTestId('status-bar')).toBeVisible()
  await expect(page.getByTestId('lock-screen')).toHaveCount(0)

  await page.screenshot({ path: 'docs/assets/shell.png' })
})

test('preload 桥可用，并拦截未登记通道', async () => {
  const info = await page.evaluate(async () => {
    const bridge = (globalThis as BridgeWindow).termans
    if (!bridge) throw new Error('window.termans missing — preload did not run')
    const result = await bridge.invoke('app:info')
    return { platform: bridge.platform, electron: bridge.versions.electron, result }
  })

  expect(info.result.ok).toBe(true)
  expect(info.platform).toMatch(/darwin|win32|linux/)
  expect(info.result.data).toMatchObject({ name: 'Termans' })

  // 白名单是安全边界：不在 IPC_CHANNELS 里的通道必须在 preload 就被拒
  const blocked = await page.evaluate(async () => {
    const bridge = (globalThis as BridgeWindow).termans
    try {
      await bridge?.invoke('app:definitely-not-registered')
      return 'resolved'
    } catch (error) {
      return String(error)
    }
  })
  expect(blocked).toContain('Blocked IPC channel')
})

test('设置持久化到临时 userData，主题变量已生效', async () => {
  const before = await page.evaluate(async () => {
    const bridge = (globalThis as BridgeWindow).termans
    return bridge?.invoke('settings:get')
  })
  expect(before?.ok).toBe(true)

  // tsconfig.node 不含 DOM lib（主进程里不该出现 document），
  // 所以 e2e 的浏览器侧代码用结构化全局对象取，而不是直接写 document/getComputedStyle。
  const themeState = await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { documentElement: { dataset: Record<string, string | undefined> } }
      getComputedStyle: (element: unknown) => { getPropertyValue: (name: string) => string }
    }
    const root = g.document.documentElement
    return {
      theme: root.dataset['theme'],
      accent: g.getComputedStyle(root).getPropertyValue('--ts-accent').trim()
    }
  })
  expect(themeState.accent.length).toBeGreaterThan(0)
  expect(themeState.theme).toBe('dark')
})
