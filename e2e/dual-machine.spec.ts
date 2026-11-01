import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { withDualMachine } from './fixtures/dual-machine'
import { serveBareRepo, type GitHttpGateway } from './fixtures/git-http'
import { startE2eSshServer, type E2eSshServer } from './fixtures/ssh-server'
import { launchApp } from './harness'
import {
  addHost,
  closeSyncPanel,
  connectHost,
  connectSyncRemote,
  createVault,
  invokeInPage,
  invokeInPageRaw,
  openSyncPanel,
  pullSync,
  pushSync,
  unlockVault,
  waitForConnected,
  waitForVaultUnlocked
} from './fixtures/ui'

/**
 * 双机迁移 S-11（验收 ④⑤）：A 机建库推送 → B 机换台机器拉下来照常登录；
 * B 机拿错口令必须失败且看不到主机；bare 仓库里只允许出现密文。
 *
 * 为什么用 `withDualMachine()`：真机迁移的全部难点都在「两个完全独立的 userData」，
 * 共用一个目录会把「凭据存在本机、不在仓库里」这类问题全遮住。
 *
 * 历史阻塞（已修）：B 机「建空库 → 连远端 → 拉取」曾必然失败，报
 *   "Your local changes to the following files would be overwritten by checkout: manifest.json, vault.enc"
 * 根因是 bootstrap 走 clone 时 isomorphic-git 收尾做非 force checkout，撞上刚建库写出的未提交文件。
 * 现在改为 `noCheckout` + 显式 force checkout，且只在 `localHead === null` 放行（本地已有主机时报 E_CONFLICT，
 * 不静默覆盖）。对齐后 A 的密文归 A 的 VMK，B 必须用**同一主口令**重新解锁才能看到主机。
 *
 * 本文件两条 B 机用例曾因 F-1/F-2/F-3 挂 `test.fixme`；vault-sync 修完
 * （4d12ee5 锁定态派生 + 回锁必 emit、b3fa893 git 互斥队列、f410f88 对齐窗口内提前回锁）后解回 `test`。
 */

const PASSPHRASE = 'Termans-Dual-Machine-2026!'
/** 三台主机：第一台真连（夹具），另外两台只验「拉下来之后字段还在」 */
const HOSTS = [
  { label: 'real-host', hostname: '127.0.0.1', username: 'termans', password: 'termans-test' },
  { label: 'db-host', hostname: '10.20.30.40', username: 'dba', password: 'db-secret-42' },
  { label: 'web-host', hostname: '192.0.2.77', username: 'deploy', password: 'web-secret-43' }
] as const

/** 期望**绝不能**出现在 bare 仓库里的明文（密码/口令/IP/私钥头/API key 前缀） */
const SECRETS = ['db-secret-42', 'web-secret-43', 'termans-test', '10.20.30.40', '192.0.2.77', 'PRIVATE KEY', PASSPHRASE]

function git(args: string[]): string {
  // stderr 丢掉：gitOrEmpty 会先撞上「还没有任何提交」这种合法中间态，让它把 fatal 打到报告里会像出错
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString()
}

/** 跑 git，失败返回空串（用于「还没提交」这种合法中间态，别让 execFileSync 直接抛） */
function gitOrEmpty(args: string[]): string {
  try {
    return git(args).trim()
  } catch {
    return ''
  }
}

/** 把 bare 仓库当前 HEAD 里所有文件的字节都读出来（仓库里只有若干小文件） */
function readRepoBlobs(bareRepo: string): { files: string[]; text: string } {
  const files = git(['-C', bareRepo, 'ls-tree', '-r', '--name-only', 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const text = files.map((file) => git(['-C', bareRepo, 'show', `HEAD:${file}`])).join('\n')
  return { files, text }
}

/**
 * 这里**不**用 `test.describe.configure({ mode: 'serial' })`：串行模式下前一条红、
 * 后面直接 "did not run"，而判定表要求每条用例都有独立的 passed/failed 结论。
 * playwright.config.ts 已固定 workers:1，每条用例用各自的临时目录与独立 bare 仓库，没有共享状态。
 */

let ssh: E2eSshServer
let gateway: GitHttpGateway

test.beforeAll(async () => {
  ssh = await startE2eSshServer()
})

test.afterAll(async () => {
  await ssh?.stop()
})

test.afterEach(async () => {
  await gateway?.close()
})

test('A 机推送成功，bare 仓库里只有密文（④前半 / ⑤）', async () => {
  await withDualMachine(async ({ dirA, bareRepo }) => {
    gateway = await serveBareRepo(bareRepo)

    const a = await launchApp({ userDataDir: dirA, args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
    try {
      await createVault(a.window, PASSPHRASE)
      for (const host of HOSTS) {
        await addHost(a.window, { ...host, port: host.label === 'real-host' ? ssh.port : 22 })
      }
      await openSyncPanel(a.window)
      await connectSyncRemote(a.window, { url: gateway.url })
      await pushSync(a.window)

      // sync:status 不是判据（pendingLocalChanges 的统计口径与「已推送」不冲突），只要求它别报 error；
      // 真正的证据是下面 bare 仓库的内容。
      const status = (await invokeInPage(a.window, 'sync:status')) as Record<string, unknown>
      expect(status['state']).not.toBe('error')
      await closeSyncPanel(a.window)
    } finally {
      await a.close()
    }

    // 推送真的落到了 bare 仓库：main 分支有提交、文件齐全、且只有密文
    expect(git(['-C', bareRepo, 'for-each-ref', '--format=%(refname)', 'refs/heads'])).toContain('refs/heads/main')
    const pushed = readRepoBlobs(bareRepo)
    expect(pushed.files).toContain('vault.enc')
    expect(pushed.files.some((file) => file === 'manifest.json')).toBe(true)
    for (const secret of SECRETS) {
      expect(pushed.text, `bare 仓库里出现了明文：${secret}`).not.toContain(secret)
    }
  })
})

test('S-11 双机迁移：A 推送 → B 同口令拉取 → 3 台主机都在，其中一台能真登夹具（④后半）', async () => {
  await withDualMachine(async ({ dirA, dirB, bareRepo }) => {
    gateway = await serveBareRepo(bareRepo)

    const a = await launchApp({ userDataDir: dirA, args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
    try {
      await createVault(a.window, PASSPHRASE)
      for (const host of HOSTS) {
        await addHost(a.window, { ...host, port: host.label === 'real-host' ? ssh.port : 22 })
      }
      await openSyncPanel(a.window)
      await connectSyncRemote(a.window, { url: gateway.url })
      await pushSync(a.window)
      await closeSyncPanel(a.window)
    } finally {
      await a.close()
    }

    const b = await launchApp({ userDataDir: dirB, args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
    try {
      await createVault(b.window, PASSPHRASE)
      await openSyncPanel(b.window)
      await connectSyncRemote(b.window, { url: gateway.url })
      // 连远端时的对齐会把 vault 回锁（`.ts-app` 的 data-locked 先翻、解锁屏后到），
      // 面板按钮此时仍在 DOM 但不可见 —— 先 settle 再点拉取，否则 click 30s 超时。
      await waitForVaultUnlocked(b.window, PASSPHRASE)
      await openSyncPanel(b.window)
      await pullSync(b.window)

      // 先断言「对齐没有毁掉工作区」：首次对齐会 rm 掉本机刚建的空库文件再 clone，
      // 若只留下 .git（远端没 checkout 回来），vault.enc 就会消失 —— 那属于数据丢失，
      // 必须在解锁之前拦下来，否则后面的断言只会报「连不上」而掩盖真实原因。
      // 对齐是异步收尾的（面板/状态先落定、checkout 随后），所以这几条用 poll 等，不要抢在它前面断言。
      await expect
        .poll(() => gitOrEmpty(['-C', join(dirB, 'vault'), 'log', '--oneline', '-1']), { timeout: 60_000 })
        .toContain('termans:')
      expect(existsSync(join(dirB, 'vault', 'vault.enc')), '首次对齐后 vault.enc 必须存在（否则是对齐把工作区清空了）').toBe(true)
      expect(existsSync(join(dirB, 'vault', 'manifest.json')), '首次对齐后 manifest.json 必须存在').toBe(true)
      expect(git(['-C', join(dirB, 'vault'), 'status', '--porcelain']), '对齐后工作区必须是干净的').toBe('')

      // 对齐后 A 的密文归 A 的 VMK：B 用同主口令重新解锁，主机库才是远端那 3 台
      // （F-1 修完后回锁会 emit，解锁屏真的会出现）
      await waitForVaultUnlocked(b.window, PASSPHRASE)
      await expect(b.window.getByTestId('host-sidebar')).toBeVisible({ timeout: 20_000 })

      // 同步面板的模态遮罩会吃掉 dblclick（实测 `<div class="ts-modal">…</div> intercepts pointer events`），
      // 连线之前必须把它关掉。
      await closeSyncPanel(b.window)

      const items = b.window.getByTestId('vault-host-item')
      await expect(items).toHaveCount(HOSTS.length, { timeout: 20_000 })
      for (const host of HOSTS) {
        const row = b.window.getByTestId('vault-host-item').filter({ hasText: host.label })
        await expect(row).toBeVisible()
        await expect(row).toContainText(`${host.hostname}:${host.label === 'real-host' ? ssh.port : 22}`)
      }

      // 真登一次：B 机换台机器，用 vault 里同步过来的密码连到夹具，能拿到服务端 banner
      await connectHost(b.window, 'real-host')
      await waitForConnected(b.window)
    } finally {
      await b.close()
    }
  })
})

test('S-11 双机迁移：拿错主口令的新机必须看不到任何主机（⑤的反面）', async () => {
  await withDualMachine(async ({ root, dirA, bareRepo }) => {
    gateway = await serveBareRepo(bareRepo)

    const a = await launchApp({ userDataDir: dirA, args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
    try {
      await createVault(a.window, PASSPHRASE)
      await addHost(a.window, { label: 'secret-host', hostname: '10.20.30.40', port: 22, username: 'dba', password: 'db-secret-42' })
      await openSyncPanel(a.window)
      await connectSyncRemote(a.window, { url: gateway.url })
      await pushSync(a.window)
      await closeSyncPanel(a.window)
    } finally {
      await a.close()
    }

    const dirC = join(root, 'machine-c-wrong-passphrase')
    mkdirSync(dirC, { recursive: true })
    const c = await launchApp({ userDataDir: dirC, args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
    try {
      await createVault(c.window, `${PASSPHRASE}-wrong`)
      await openSyncPanel(c.window)
      // 连远端的对齐本身就会 fetch + checkout（同 B 机），所以这里不需要再点一次拉取：
      // C 机口令是错的，回锁之后根本解锁不了，面板也就点不动。
      await connectSyncRemote(c.window, { url: gateway.url })

      // 远端密文属于 A 的 VMK：错口令的机器即使把仓库拉下来也解不开 → 必须回锁。
      // 对齐（fetch + checkout）是异步完成的，解锁屏会比它先出现，所以先等仓库里真的有 A 的提交，
      // 再看「回锁」—— 顺序反了会在 clone 还没落地时就断言，读到 'no commits yet' 的假红。
      await expect
        .poll(() => gitOrEmpty(['-C', join(dirC, 'vault'), 'log', '--oneline', '-1']), {
          timeout: 60_000,
          message: 'C 机的仓库应当已被对齐到 A 推上去的那次提交'
        })
        .toContain('termans:')
      expect(existsSync(join(dirC, 'vault', 'vault.enc'))).toBe(true)
      await expect(c.window.getByTestId('unlock-screen')).toBeVisible({ timeout: 60_000 })

      // 用错口令再解锁：必须明确报错，而不是「解开了但空库」。
      // r3 起「明确报错」的载体是四类归因块（`unlock-attribution`，DESIGN §4.5）；旧版的
      // 一行 `.ts-unlock__error` 在归因块存在时**不再叠加渲染**（两套词表同屏会让人猜哪个是结论），
      // 所以这里两种形态都接受 —— 断言的是「有明确失败提示」，不是「某个 class 名还在」。
      await unlockVault(c.window, `${PASSPHRASE}-wrong`)
      await expect(
        c.window.locator('.ts-unlock__error, [data-testid="unlock-attribution"]').first()
      ).toBeVisible({ timeout: 20_000 })

      // 无论界面停在哪，主机数据都必须读不到。
      // 这里用 invokeInPageRaw：期望失败的调用若走 invokeInPage，helper 会把「断言通过」抛成「测试红」。
      const hosts = await invokeInPageRaw(c.window, 'hosts:list')
      expect(hosts.ok, '错口令的机器绝不能读到主机').toBe(false)
      expect(hosts.error?.code).toBe('E_VAULT_LOCKED')
      await expect(c.window.getByTestId('vault-host-item')).toHaveCount(0)
    } finally {
      await c.close()
    }
  })
})
