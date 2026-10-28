import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { DEFAULT_WINDOW_SIZE, launchApp } from './harness'
import { withDualMachine } from './fixtures/dual-machine'

/**
 * 夹源自检（不是业务用例）。
 *
 * 三件事各钉一次：
 * 1. `launchApp` 真的起来了，且 userData **确实**被隔离到临时目录（不是「我以为传了」）；
 * 2. `capture` 能从应用里拿到一张有效 PNG（不依赖系统屏幕录制权限）；
 * 3. `withDualMachine` 交出来的 bare 仓库是真的 git 仓库，退出后目录**真的**没了。
 *
 * 业务断言（连接、known_hosts、S-07 迁移）归 t8，这里只保证地基能用。
 */

const repoRoot = resolve(__dirname, '..')

test('launchApp：标题/窗口尺寸/userData 隔离/截图', async () => {
  const running = await launchApp()

  try {
    await expect(running.window).toHaveTitle('Termans')

    // 1) userData 隔离：主进程看到的目录必须就是本次传入的那个
    //    （macOS 的 os.tmpdir() 是 /var/folders/…，Chromium 会规范化成 /private/var/folders/…，
    //     所以两侧都要 realpath 再比，直接字符串比较会假失败）
    const actualUserData = await running.app.evaluate(({ app }) => app.getPath('userData'))
    expect(realpathSync(actualUserData)).toBe(realpathSync(running.userDataDir))

    // 2) 宿主环境变量里的 ELECTRON_RUN_AS_NODE 必须没有传进应用进程
    //    （传进去的话 Electron 会退化成 Node，Playwright 直接启动不了；这条同时守住「将来有人把它加回来」）
    const inherited = await running.app.evaluate((_electron) => process.env['ELECTRON_RUN_AS_NODE'] ?? null)
    expect(inherited).toBeNull()
    const e2eFlag = await running.app.evaluate((_electron) => process.env['TERMANS_E2E'] ?? null)
    expect(e2eFlag).toBe('1')

    // 3) 窗口尺寸固定（xterm 的列数依赖它，不定死截图对比会飘）
    const size = await running.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('没有窗口')
      const [width, height] = win.getContentSize()
      return { width, height }
    })
    expect(size).toEqual({ ...DEFAULT_WINDOW_SIZE })

    // 4) 截图走 capturePage，落盘的是有效 PNG
    const shot = join(repoRoot, 'artifacts', 'selfcheck', 'launch-app.png')
    await running.capture(shot)
    expect(statSync(shot).size).toBeGreaterThan(1024)
  } finally {
    await running.cleanup()
  }

  // cleanup 的语义：目录真删掉了（cleanup 内部已断言，这里再从用例侧确认一次）
  expect(existsSync(running.userDataDir)).toBe(false)
})

test('withDualMachine：A/B 目录 + 真 bare 仓库，退出后清理干净', async () => {
  let root: string | undefined
  let dirA: string | undefined
  let dirB: string | undefined

  await withDualMachine(async (ctx) => {
    root = ctx.root
    dirA = ctx.dirA
    dirB = ctx.dirB

    expect(existsSync(ctx.dirA)).toBe(true)
    expect(existsSync(ctx.dirB)).toBe(true)
    expect(realpathSync(ctx.dirA)).not.toBe(realpathSync(ctx.dirB))

    // bare 仓库不是「一个目录」，是真的 git 仓库：git 自己认不认才算数
    const bare = execFileSync('git', ['-C', ctx.bareRepo, 'rev-parse', '--is-bare-repository'], {
      encoding: 'utf8'
    }).trim()
    expect(bare).toBe('true')
    const head = execFileSync('git', ['-C', ctx.bareRepo, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(head).toBe('refs/heads/main')
    expect(ctx.bareRepoUrl).toBe(`file://${ctx.bareRepo}`)
  })

  expect(root).toBeDefined()
  expect(existsSync(root as string)).toBe(false)
  expect(existsSync(dirA as string)).toBe(false)
  expect(existsSync(dirB as string)).toBe(false)
})

test('双机地基：同一可执行文件、两份 userData，各自独立（S-07 的前置自检）', async () => {
  await withDualMachine(async ({ dirA, dirB }) => {
    const a = await launchApp({ userDataDir: dirA })
    const pathA = await a.app.evaluate(({ app }) => app.getPath('userData'))
    await a.close() // 不 cleanup：目录要留给 B 之前的最后一次 A 运行

    const b = await launchApp({ userDataDir: dirB })
    const pathB = await b.app.evaluate(({ app }) => app.getPath('userData'))
    await b.close()

    expect(realpathSync(pathA)).toBe(realpathSync(dirA))
    expect(realpathSync(pathB)).toBe(realpathSync(dirB))
    expect(realpathSync(pathA)).not.toBe(realpathSync(pathB))
  })
})
