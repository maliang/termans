import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

/**
 * Electron e2e 启动器 —— 所有 e2e 用例都从这里 `launchApp()`，不要各自写 `_electron.launch`。
 *
 * 统一了四件容易写错、写错以后表现为「莫名超时/莫名失败」的事：
 *
 * 1. **独立 userData**：每个启动一个临时目录，用例之间不共享 `settings.json` / `known_hosts.json`。
 *    实现走两条同源通道、指向**同一个**目录（见 `resolveUserDataDir` 的注释）：
 *    - 启动参数 `--user-data-dir=<dir>`（Chromium 层开关，进程 init 阶段就生效）；
 *    - 环境变量 `TERMANS_E2E=1` + `TERMANS_E2E_USER_DATA=<dir>`（主进程 `app.setPath('userData')` 钩子，
 *      见 `src/main/index.ts` 的 whenReady）。
 * 2. **`ELECTRON_RUN_AS_NODE` 必须删掉**（本机 shell 导出了它，值 `1`）。不删的话 Electron 二进制按 Node 跑，
 *    Playwright 传的 `--remote-debugging-port=0` 会被当成 Node 的非法参数，报
 *    `bad option: --remote-debugging-port=0`，所有用例都是 "Process failed to launch"。
 *    Playwright 的 `env` 选项是**整体替换**（不是追加），所以在进程内拼 env 时 `delete`，等价于 `env -u ELECTRON_RUN_AS_NODE`。
 * 3. **固定窗口尺寸**：默认 1320×860（与 `src/main/index.ts` 的 createWindow 一致）。
 *    窗口尺寸不固定会让 xterm 的列数随宿主窗口变化，截图对比与「一行多少列」类断言全部不稳定。
 * 4. **稳定的就绪信号**：`firstWindow()` 只保证窗口对象存在，不保证页面加载完。
 *    这里等三件事都成立：webContents 的 `did-finish-load`、`load` 状态、`document.readyState === 'complete'`。
 *    只等 `domcontentloaded` 会在 React 首次渲染前就断言（找不到 testid，报的是「元素不存在」而不是「还没渲染」）。
 */

/** 与主进程 createWindow 保持一致，改一处要改两处 */
export const DEFAULT_WINDOW_SIZE = { width: 1320, height: 860 } as const

export interface WindowSize {
  width: number
  height: number
}

export interface LaunchAppOptions {
  /** 复用现成目录（双机迁移用例的 A/B）；缺省新建临时目录 */
  userDataDir?: string
  /** 主进程入口，缺省 `<repo>/out/main/index.js`（构建产物，所以要先 `pnpm build`） */
  mainEntry?: string
  /** 追加的 Electron 命令行开关（放在入口之后，避免被误当作 app path） */
  args?: string[]
  /** 追加/覆盖环境变量；`ELECTRON_RUN_AS_NODE` 等危险变量仍会被剔掉 */
  env?: Record<string, string>
  windowSize?: WindowSize
  /** 额外的就绪条件（例如等某个 testid 可见）。抛错即视为启动失败 */
  waitFor?: (page: Page) => Promise<void>
}

export interface LaunchedApp {
  app: ElectronApplication
  /** 主窗口页面（Playwright 视角） */
  window: Page
  /** 本次运行使用的 userData 目录（绝对路径） */
  userDataDir: string
  /** `<userData>/settings.json`，检查落盘内容时直接用 */
  settingsFile: string
  windowSize: WindowSize
  /**
   * 关掉应用但**保留** userData 目录 —— 双机迁移/二次启动要复用同一份数据。
   * 用完记得 `cleanup()`。
   */
  close: () => Promise<void>
  /** 关掉应用并删掉 userData 目录；删完**断言目录真的不在了**（不是 try/catch 吞掉） */
  cleanup: () => Promise<void>
  /** `capture(win, path)` 的绑定版 */
  capture: (target: string) => Promise<void>
}

const repoRoot = resolve(__dirname, '..')
const defaultMainEntry = join(repoRoot, 'out/main/index.js')

/**
 * 会破坏 e2e 的宿主环境变量。共同点：它们都让 Electron 不再以「应用」身份启动或让渲染层行为漂移。
 */
const HOSTILE_ENV_KEYS = [
  'ELECTRON_RUN_AS_NODE', // 让 Electron 退化成 Node，Playwright 注入的调试开关直接非法
  'ELECTRON_ENABLE_LOGGING', // 会把主进程 stdout 灌满日志，Playwright 的启动握手偶发超时
  'ELECTRON_RENDERER_URL' // 残留的 dev server 地址会让 prod 构建去连别人的 Vite
] as const

function buildEnv(userDataDir: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if ((HOSTILE_ENV_KEYS as readonly string[]).includes(key)) continue
    env[key] = value
  }
  Object.assign(env, extra ?? {})
  for (const key of HOSTILE_ENV_KEYS) delete env[key]
  env['NODE_ENV'] = 'production'
  env['TERMANS_E2E'] = '1'
  env['TERMANS_E2E_USER_DATA'] = userDataDir
  // 静默模式：窗口在屏幕外创建、Dock 图标收起，跑测试不在主人眼前弹窗也不抢焦点
  env['TERMANS_E2E_QUIET'] = process.env['TERMANS_E2E_VISIBLE'] === '1' ? '0' : '1'
  return env
}

/**
 * 就绪信号：三件事都成立才算「可以断言了」。
 * 先等 webContents 的 `did-finish-load`（主进程视角），再等渲染层的 `readyState === 'complete'`。
 */
async function waitForStableLoad(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('[e2e] 没有 BrowserWindow，主进程可能没走到 createWindow')
    if (!win.webContents.isLoadingMainFrame()) return
    await new Promise<void>((resolveLoad) => {
      win.webContents.once('did-finish-load', () => resolveLoad())
    })
  })
  await page.waitForLoadState('load')
  // tsconfig.node 没有 DOM lib（主进程代码里不该出现 document），所以这里用结构化全局对象取
  await page.waitForFunction(() => {
    const g = globalThis as unknown as { document?: { readyState?: string } }
    return g.document?.readyState === 'complete'
  })
}

async function applyWindowSize(app: ElectronApplication, size: WindowSize): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('[e2e] 没有 BrowserWindow，无法固定窗口尺寸')
    win.setContentSize(target.width, target.height)
  }, size)
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'termans-e2e-'))
  mkdirSync(userDataDir, { recursive: true })

  const mainEntry = options.mainEntry ?? defaultMainEntry
  if (!existsSync(mainEntry)) {
    throw new Error(`[e2e] 找不到构建产物 ${mainEntry}：先跑 \`pnpm build\`（或 \`pnpm test:e2e\`）`)
  }

  const windowSize: WindowSize = options.windowSize ?? { ...DEFAULT_WINDOW_SIZE }

  const app = await electron.launch({
    // 入口放第一个参数：Electron 用第一个非开关参数确定 app path，开关放它后面最稳
    args: [mainEntry, `--user-data-dir=${userDataDir}`, ...(options.args ?? [])],
    cwd: repoRoot,
    env: buildEnv(userDataDir, options.env)
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await app.close().catch(() => undefined)
  }

  try {
    const window = await app.firstWindow()
    await applyWindowSize(app, windowSize)
    await waitForStableLoad(app, window)
    if (options.waitFor) await options.waitFor(window)

    const cleanup = async (): Promise<void> => {
      await close()
      rmSync(userDataDir, { recursive: true, force: true })
      if (existsSync(userDataDir)) {
        throw new Error(`[e2e] userData 目录没有删掉：${userDataDir}`)
      }
    }

    return {
      app,
      window,
      userDataDir,
      settingsFile: join(userDataDir, 'settings.json'),
      windowSize,
      close,
      cleanup,
      capture: (target: string) => capture(app, target)
    }
  } catch (error) {
    // 启动阶段失败不要留下跑着的 Electron 进程（会把后续用例的 userData 锁住）
    await close()
    rmSync(userDataDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * 截图到文件。用 `webContents.capturePage()`（应用自己渲染栅格），**不用系统截屏**：
 * 后者在 macOS 需要「屏幕录制」权限，CI 上没有，本机第一次跑会弹权限框卡住用例。
 *
 * 返回落盘字节数，方便断言「不是一张空图」。
 */
export async function capture(app: ElectronApplication, target: string): Promise<void> {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) throw new Error('[e2e] 没有 BrowserWindow，无法截图')
    const image = await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  })

  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`[e2e] capturePage 返回的不是有效 PNG（${bytes.length} 字节）：${target}`)
  }
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
  if (statSync(target).size !== bytes.length) {
    throw new Error(`[e2e] 截图落盘字节数不一致：${target}`)
  }
}
