import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp } from './harness'
import { VAULT_PASSPHRASE, addHost, createVault, invokeInPage } from './fixtures/ui'

/**
 * r3 · 口令判错自救（四类归因）与新建本地库的端到端契约。
 *
 * 这一份 spec 覆盖 AC-1/2/3（归因与脱敏）、AC-10..AC-16（多库）与 AC-18 的负面（旧 testid 不消失），
 * 每个断言都对着 PRD/DESIGN 里可以判定的那句话写，不写「大概长这样」的软断言。
 *
 * 三条自我约束：
 * 1. **不按文案定位**：本机系统语言是中文，归因分类一律走 `unlock-attribution[data-class]`，
 *    文案只用于「不允许出现」这类反向断言（DESIGN §4.4 已把四类焊在 data-class 上）。
 * 2. **不拿 timers 当同步手段**：失败提交的结束信号是「口令框被清空」（DESIGN 3.2 的复位要求）
 *    或「限流倒计时出现」，不是 `waitForTimeout`。
 * 3. **构造真实故障**，不手改摘要：`manifest.json` 的 keywrap_sha256 覆盖了槽位本身，
 *    手改一个字节只会得到 corrupt；要造「槽属于另一只口令」必须整体换上一份**自洽**的外来仓储
 *    （另起 userData 用第二只口令建库后覆盖），这正是 PRD F1 的形态。
 */

/** 默认库仓储文件（AC-11 的比对对象）：manifest.json + vault.enc 必须成对不变 */
const REPO_FILES = ['manifest.json', 'vault.enc'] as const
const SECOND_PASSPHRASE = 'Termans-E2E-Second-Library!2026'
const WRONG_PASSPHRASE = 'Termans-E2E-Wrong-Passphrase!2026'
const NEW_LIBRARY_NAME = 'e2e-second'

interface LibraryMeta {
  id: string
  name: string | null
  createdAt: string | null
  lastUnlockedAt: string | null
  isCurrent: boolean
}

interface UnlockFailure {
  class: string
  retryAfterSeconds?: number
}

interface VaultStatusLite {
  state: string
  revision: number
  slotFingerprint: string | null
  libraries: LibraryMeta[]
  unlockFailure: UnlockFailure | null
}

// 刻意**不用** `mode: 'serial'`：本 spec 每条用例都自造 userData 临时目录与自己的应用实例，
// 彼此不共享状态；serial 会让第一条红把后面五条变成「did not run」，等于把归因证据一起吞掉。
// 全局 workers=1（playwright.config.ts），所以仍然是顺序执行、不会互相抢 userData。

test.describe('r3 · 锁定自救与新建本地库', () => {
  // 每个用例自造 userData 临时目录、自开应用：这些都由 helpers 登记，这里统一回收。
  // 不用 harness.cleanup() 是因为「两次启动共用同一个 userData」是本 spec 构造故障的主要手法，
  // cleanup 一走就把中间态删掉了。
  test.afterEach(async () => {
    for (const app of openedApps.splice(0).reverse()) {
      await app.close().catch(() => undefined)
    }
    for (const dir of temporaryDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // ---------------------------------------------------------------- 归因四类

  test('AC-1/AC-3 · 口令错误归因为 bad-passphrase，诊断区不带任何秘密', async () => {
    const userDataDir = temporaryUserData('bad-passphrase')
    const app = await boot(userDataDir)
    const page = app.window

    await createVault(page)
    await lockVault(page)

    // 「以预览模式继续」已删除：它只把 previewLocked 置真，而锁定态本来就是 hidden，
    // 点了没有任何可见变化（主人实测「点击没效果」）。锁定态要看界面/换主题走齿轮兜底入口。
    await expect(page.getByTestId('preview-mode'), '已删除的死按钮不得复活').toHaveCount(0)
    await expect(page.getByTestId('lock-tools'), '锁定态必须有设置兜底入口').toBeVisible()

    const outcome = await attemptUnlock(page, WRONG_PASSPHRASE)
    expect(outcome, '错口令不允许解锁成功').toEqual({ kind: 'failed', cls: 'bad-passphrase' })

    // AC-1：四类互斥 —— 口令错的那一刻不能同时长得像限流
    await expect(page.getByTestId('unlock-throttle-countdown'), 'AC-1：bad-passphrase 不得带限流倒计时').toHaveCount(0)
    // 失败后口令框必须复位，且屏幕仍停在解锁卡（不误进外壳）
    await expect(page.getByTestId('passphrase-input')).toHaveValue('')
    await expect(page.getByTestId('host-sidebar')).not.toBeVisible()

    // AC-3：诊断区是证据区，任何一项都不能把口令/用户名/主机名带出来
    await page.getByTestId('unlock-diag-toggle').click()
    const diag = page.getByTestId('unlock-diag')
    await expect(diag).toBeVisible()
    const diagText = await diag.innerText()
    expect(diagText, 'AC-3：诊断区不得出现提交过的口令').not.toContain(WRONG_PASSPHRASE)
    expect(diagText, 'AC-3：诊断区不得出现正确口令').not.toContain(VAULT_PASSPHRASE)
    expect(diagText, 'AC-3：诊断区不得出现文件路径（路径里含用户名）').not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)/)
    expect(diagText, 'AC-3：诊断区不得出现 IP').not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)
    for (const id of [
      'diag-created-at',
      'diag-last-unlocked',
      'diag-last-synced',
      'diag-revision',
      'diag-kdf',
      'diag-fingerprint'
    ]) {
      await expect(page.getByTestId(id), `AC-3：诊断区缺证据项 ${id}`).toBeVisible()
    }
  })

  test('AC-1/AC-9 · 连续失败进入 throttled，并显示剩余秒数', async () => {
    const userDataDir = temporaryUserData('throttled')
    const app = await boot(userDataDir)
    const page = app.window

    await createVault(page)
    await lockVault(page)

    // 每次换一只错口令：证明限流来自「失败次数」，不是同一串被判缓存
    let cls: string | null = null
    let attempts = 0
    for (let round = 1; round <= 9; round += 1) {
      attempts = round
      const outcome = await attemptUnlock(page, `${WRONG_PASSPHRASE}#${round}`)
      expect(outcome, '错口令不允许解锁成功').toMatchObject({ kind: 'failed' })
      if (outcome.kind !== 'failed') break
      cls = outcome.cls
      if (cls === 'throttled') break
      expect(cls, '限流之前的失败必须归因为 bad-passphrase').toBe('bad-passphrase')
    }
    expect(cls, `连续 ${attempts} 次错口令仍未进入 throttled`).toBe('throttled')

    // AC-1：throttled 必须自证「还要等多久」，否则用户只会反复重试
    const countdown = page.getByTestId('unlock-throttle-countdown')
    await expect(countdown, 'AC-1：throttled 必须显示倒计时').toBeVisible()
    expect((await countdown.innerText()).trim(), 'AC-1：倒计时不得是空壳').toMatch(/\d/)
    // 四类互斥的另一半：进入限流后不得再显示「口令错误」
    expect(cls).not.toBe('bad-passphrase')
  })

  test('AC-2 · 远端换来的口令槽与本机记录不符 → slot-record-mismatch（不是 bad-passphrase）', async () => {
    const userDataDir = temporaryUserData('slot-a')
    const foreignDir = temporaryUserData('slot-b')

    // 机器 A：本机记录的槽来自 A 的口令
    const first = await boot(userDataDir)
    await createVault(first.window)
    await first.close()

    // 机器 B：另一只口令、自洽的另一份仓储（摘要全部自洽，无法靠摘要识别）
    const second = await boot(foreignDir)
    await createVault(second.window, SECOND_PASSPHRASE)
    await second.close()

    // 模拟「远端把仓储快进过来了」：整目录换成 B 的产物，本机 local.json 仍是 A 的槽记录
    copyRepo(vaultDir(foreignDir), vaultDir(userDataDir))
    const before = digestRepo(vaultDir(userDataDir))

    const third = await boot(userDataDir)
    const page = third.window
    const outcome = await attemptUnlock(page, VAULT_PASSPHRASE)
    expect(outcome, 'AC-2：槽指纹与本机记录不符必须单独归因，不能混成 bad-passphrase').toEqual({
      kind: 'failed',
      cls: 'slot-record-mismatch'
    })

    // AC-2：失败只是读取，不许顺手改写仓储
    expect(digestRepo(vaultDir(userDataDir)), 'AC-2：归因失败时不得改动仓储文件').toEqual(before)
  })

  test('AC-1 · 仓储被改动 → corrupt（红色归因，不冒充口令错误）', async () => {
    const userDataDir = temporaryUserData('corrupt')
    const first = await boot(userDataDir)
    await createVault(first.window)
    await first.close()

    // 翻转 vault.enc 末字节：GCM tag 与 payload_sha256 必然对不上（不需要换密钥）
    const encPath = join(vaultDir(userDataDir), 'vault.enc')
    const tampered = readFileSync(encPath)
    tampered[tampered.length - 1] ^= 0xff
    writeFileSync(encPath, tampered)

    const second = await boot(userDataDir)
    const page = second.window

    // 有的实现会在 init 时就把 repoError 归因出来；两种时序都要接受，但分类必须一致
    let cls = await attributionClass(page)
    if (cls === null) {
      const outcome = await attemptUnlock(page, VAULT_PASSPHRASE)
      expect(outcome, '损坏的仓储不允许解锁').toMatchObject({ kind: 'failed' })
      cls = outcome.kind === 'failed' ? outcome.cls : null
    }
    expect(cls, 'AC-1：损坏必须单独归因为 corrupt').toBe('corrupt')
    expect(cls, 'AC-1：corrupt 不得退化成 bad-passphrase').not.toBe('bad-passphrase')
    await expect(page.getByTestId('host-sidebar')).not.toBeVisible()
  })

  // ---------------------------------------------------------------- 多库

  test('AC-10..AC-16 · 新建本地库：三句确认 + 恢复码强制 + 旧库零改动 + 切回旧库', async () => {
    const userDataDir = temporaryUserData('new-library')
    const app = await boot(userDataDir)
    const page = app.window

    await createVault(page)
    await addHost(page, { label: 'legacy-host', hostname: '10.0.0.9', port: 22, username: 'legacy' })
    const legacy = digestRepo(vaultDir(userDataDir))
    expect(legacy.files, '默认库仓储应含 manifest.json 与 vault.enc').toEqual(expect.arrayContaining([...REPO_FILES]))

    await lockVault(page)

    // ---- M1：locked 且库存在时才有这个次级入口（AC-10 正向）
    const entry = page.getByTestId('create-library-entry')
    await expect(entry, 'AC-10：锁定的旧库上必须给出「新建一个本地库」入口').toBeVisible()
    await expect(page.getByTestId('unlock-vault'), 'AC-10：新建库是次级入口，不得顶掉解锁按钮').toBeVisible()
    await entry.click()

    // ---- M2：三句话（AC-15）
    await expect(page.getByTestId('create-library-confirm')).toBeVisible()
    const points = page.getByTestId('create-library-confirm-points').locator('li')
    await expect(points, 'AC-15：二次确认必须写三句话（旧库不动 / 看不到旧库凭据 / 原口令可切回）').toHaveCount(3)
    const lines = (await points.allInnerTexts()).map((line) => line.trim())
    for (const line of lines) expect(line.length, 'AC-15：三句话不得是空占位').toBeGreaterThan(3)
    expect(new Set(lines).size, 'AC-15：三句话不得重复').toBe(3)

    // 取消必须是「什么都没发生」，不能留下半成品库
    await page.getByTestId('new-library-cancel').click()
    await expect(page.getByTestId('create-library-confirm')).toHaveCount(0)
    expect((await libraries(page)).length, 'AC-15：取消后库数量不得变化').toBe(1)

    // ---- M3：命名（默认名不得取自旧库路径/可见库名，否则读成「把旧库改名」）
    await page.getByTestId('create-library-entry').click()
    await page.getByTestId('new-library-continue').click()
    const nameInput = page.getByTestId('new-library-name')
    await expect(nameInput).toBeVisible()
    const defaultName = (await nameInput.inputValue()).trim()
    expect(defaultName.length, '新建库必须有默认名').toBeGreaterThan(0)
    expect(defaultName, 'AC-15：默认名不得取自旧库路径').not.toContain('/')
    await nameInput.fill(NEW_LIBRARY_NAME)
    await page.getByTestId('new-library-submit').click()

    // 新库是空壳 → 自动进入既有建库表单；此处不得再出现第二个「新建库」入口（AC-10）
    await expect(page.getByTestId('passphrase-input'), 'AC-10：新库建好后应直接进入设置口令').toBeVisible({
      timeout: 30_000
    })
    await expect(page.getByTestId('create-library-entry'), 'AC-10：uninitialized 下不得出现第二个建库入口').toHaveCount(
      0
    )
    await submitPassphraseForm(page, SECOND_PASSPHRASE)

    // ---- AC-16：恢复码强制确认
    const recovery = page.getByTestId('unlock-recovery-code')
    await expect(recovery, 'AC-16：新建库必须先展示恢复码').toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('preview-mode'), 'AC-16：恢复码页不得保留 footer 逃逸出口').toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(recovery, 'AC-16：Esc 不得离开恢复码页').toBeVisible()
    // AC-16 的「未确认不得进入下一步」用「仍停在解锁流程内」证明：恢复码是解锁卡的
    // recovery-saved 态（DESIGN §4.5），确认之前 App 不得把它卸载、换成外壳。
    await expect(page.getByTestId('unlock-screen'), 'AC-16：未确认恢复码前不得离开解锁流程').toBeVisible()
    expect(await recovery.innerText(), 'AC-16：恢复码页必须真的给出恢复码').toMatch(/[A-Za-z0-9]{4}-[A-Za-z0-9]{4}/)
    await recovery.getByRole('button', { name: /saved|保存好了/i }).click()
    await expect(page.getByTestId('unlock-screen')).toHaveCount(0, { timeout: 30_000 })
    await expect(page.getByTestId('host-sidebar')).toBeVisible()

    // ---- AC-11：新库的建立不得动旧库一个字节
    const legacyAfter = digestRepo(vaultDir(userDataDir))
    expect(legacyAfter.manifest, 'AC-11：新建库不得改动旧库 manifest.json').toBe(legacy.manifest)
    expect(legacyAfter.enc, 'AC-11：新建库不得改动旧库 vault.enc').toBe(legacy.enc)
    expect(legacyAfter.files, 'AC-11：旧库仓储文件集合不得变化（新增/删除都算改动）').toEqual(legacy.files)

    // AC-12：新库里看不到旧库的主机
    await expect(page.getByTestId('vault-host-item').filter({ hasText: 'legacy-host' })).toHaveCount(0)

    // ---- AC-13：库列表（无需重启即可见到两只库）
    const both = await libraries(page)
    expect(both.length, 'AC-13：新建后库列表必须是 2 只').toBe(2)
    const currentLib = both.find((lib) => lib.isCurrent)
    expect(currentLib?.name, 'AC-13：当前库必须指向新建的那只').toBe(NEW_LIBRARY_NAME)
    const legacyLib = both.find((lib) => !lib.isCurrent)
    expect(legacyLib, 'AC-11：旧库必须仍以独立记录存在').toBeTruthy()

    // ---- AC-12/AC-13：切回旧库，旧库要求重新输口令（两库互不自动解锁）
    await lockVault(page)
    await expect(page.getByTestId('library-switcher'), 'AC-13：≥2 只库时必须给出切换入口').toBeVisible()
    const rows = page.getByTestId('library-row')
    await expect(rows, 'AC-13：列表必须列出两只库').toHaveCount(2)
    const markedRows = await rows.evaluateAll((nodes) =>
      nodes.filter((node) => node.getAttribute('data-current') === 'true').length
    )
    expect(markedRows, 'AC-13：当前库必须且只能有一行 data-current="true"').toBe(1)
    await switchLibrary(page, legacyLib!.id)

    await expect(page.getByTestId('unlock-screen')).toBeVisible()
    const switched = await vaultStatus(page)
    expect(switched.libraries.find((lib) => lib.isCurrent)?.id, 'AC-13：切换后 status 必须归属新当前库').toBe(
      legacyLib!.id
    )
    expect(switched.state, 'AC-12：切到未勾「记住本机」的库必须要求口令').toBe('locked')
    await expect(page.getByTestId('passphrase-input')).toHaveValue('')
    await expect(page.getByTestId('host-sidebar'), 'AC-12：口令未输入前不得看到旧库主机').not.toBeVisible()

    // ---- AC-13 / anti-goal 2：切回旧库后原口令必须照旧可用
    const unlocked = await attemptUnlock(page, VAULT_PASSPHRASE)
    expect(unlocked, 'AC-13：切回旧库后原口令必须仍能解锁').toEqual({ kind: 'unlocked' })
    await expect(page.getByTestId('host-sidebar')).toBeVisible()
    await expect(page.getByTestId('vault-host-item').filter({ hasText: 'legacy-host' })).toBeVisible()
  })

  test('AC-10 反向 · uninitialized 下不得出现第二个建库入口', async () => {
    const userDataDir = temporaryUserData('uninitialized')
    const app = await boot(userDataDir)
    const page = app.window

    const status = await vaultStatus(page)
    expect(status.state, '全新安装必须是 uninitialized').toBe('uninitialized')
    await expect(page.getByTestId('create-vault'), 'AC-10：全新安装必须保留唯一的建库按钮').toBeVisible()
    await expect(
      page.getByTestId('create-library-entry'),
      'AC-10：uninitialized 下不得出现「新建一个本地库」（会变成两个创建入口）'
    ).toHaveCount(0)
    await expect(page.getByTestId('library-switcher'), '只有 0 只库时不得渲染切换器').toHaveCount(0)

    // 既有入口本身仍要可用（别为了不重复而把它一起藏了）
    await createVault(page)
    await expect(page.getByTestId('host-sidebar')).toBeVisible()
  })
})

// -------------------------------------------------------------------- helpers

function temporaryUserData(tag: string): string {
  const dir = join(tmpdir(), `termans-t12-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  temporaryDirs.push(dir)
  return dir
}

/** 本用例造过的临时 userData 目录，afterEach 统一删除 */
const temporaryDirs: string[] = []
/** 本用例开过的应用实例，afterEach 统一关掉（含中途 close 过的，close 幂等由 catch 兜住） */
const openedApps: LaunchedApp[] = []

async function boot(userDataDir: string): Promise<LaunchedApp> {
  const app = await launchApp({
    userDataDir,
    args: ['--disable-gpu'],
    waitFor: (page) => page.getByTestId('unlock-screen').waitFor({ timeout: 30_000 })
  })
  openedApps.push(app)
  return app
}

function vaultDir(userDataDir: string): string {
  // 与 src/main/ipc/index.ts:62-64 逐字同源：默认库仓储 = <userData>/vault
  return join(userDataDir, 'vault')
}

function sha256(file: string): string {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : ''
}

interface RepoDigest {
  manifest: string
  enc: string
  files: string[]
}

function digestRepo(dir: string): RepoDigest {
  const files = existsSync(dir) ? readdirSync(dir).sort() : []
  return {
    manifest: sha256(join(dir, 'manifest.json')),
    enc: sha256(join(dir, 'vault.enc')),
    files
  }
}

function copyRepo(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  cpSync(join(from, 'manifest.json'), join(to, 'manifest.json'))
  cpSync(join(from, 'vault.enc'), join(to, 'vault.enc'))
  expect(existsSync(join(to, 'manifest.json')), '覆盖失败：外来仓储缺少 manifest.json').toBe(true)
}

async function vaultStatus(page: Page): Promise<VaultStatusLite> {
  return (await invokeInPage(page, 'vault:status')) as VaultStatusLite
}

async function libraries(page: Page): Promise<LibraryMeta[]> {
  const result = (await invokeInPage(page, 'vault:libraries')) as { libraries: LibraryMeta[] }
  return result.libraries
}

async function lockVault(page: Page): Promise<void> {
  await invokeInPage(page, 'vault:lock')
  await expect(page.getByTestId('unlock-screen'), '锁库后必须回到解锁卡').toBeVisible()
  await expect(page.getByTestId('host-sidebar'), '锁库后不得还看得见主机库').not.toBeVisible()
}

/** 读当前归因分类；没有归因块时返回 null（= 这一屏还没失败过） */
async function attributionClass(page: Page): Promise<string | null> {
  const block = page.getByTestId('unlock-attribution')
  if ((await block.count()) === 0) return null
  if (!(await block.isVisible().catch(() => false))) return null
  return await block.getAttribute('data-class')
}

type AttemptOutcome = { kind: 'unlocked' } | { kind: 'failed'; cls: string | null }

/**
 * 提交一次口令并等到「这一次」真的结束：
 *  - 成功 → 解锁屏卸载（返回 unlocked）
 *  - 失败 → 口令框被清空（DESIGN 3.2 的复位要求）或限流倒计时出现，再读 data-class
 * 用「口令框被清空」当失败信号，是为了避开「上一次的归因块还挂在页面上」造成的陈旧读取。
 */
async function attemptUnlock(page: Page, passphrase: string): Promise<AttemptOutcome> {
  const input = page.getByTestId('passphrase-input')
  const button = page.getByTestId('unlock-vault')
  await expect(input).toBeVisible()
  await input.fill(passphrase)
  await expect(button, '解锁按钮必须可点（可能是上一轮请求还没结束）').toBeEnabled({ timeout: 30_000 })
  await button.click()

  const settled = await Promise.race([
    page
      .getByTestId('unlock-screen')
      .waitFor({ state: 'detached', timeout: 25_000 })
      .then(() => 'unlocked' as const)
      .catch(() => null),
    expect(input)
      .toHaveValue('', { timeout: 25_000 })
      .then(() => 'failed' as const)
      .catch(() => null),
    page
      .getByTestId('unlock-throttle-countdown')
      .waitFor({ state: 'visible', timeout: 25_000 })
      .then(() => 'failed' as const)
      .catch(() => null)
  ])
  if (settled === null) {
    throw new Error(
      '[e2e] 提交口令后 25s 内既没有解锁、也没有清空口令框、也没有出现限流倒计时：' +
        '失败路径缺复位/缺归因块（DESIGN §3.2 与 §4.4 的 unlock-attribution）'
    )
  }
  if (settled === 'unlocked') return { kind: 'unlocked' }

  const block = page.getByTestId('unlock-attribution')
  await expect(block, '失败后必须出现归因块（四类归因是本次需求的核心）').toBeVisible({ timeout: 20_000 })
  // 上面等到的是「本次提交结束」的状态信号；这里再给 React 一次提交的余量，
  // 避免读到上一次失败留下的 data-class（连续两次 bad-passphrase 时文本是一样的，
  // 所以不能靠「值变了」来判新旧，只能靠状态信号 + 极短沉降）。
  await page.waitForTimeout(150)
  return { kind: 'failed', cls: await block.getAttribute('data-class') }
}

/** 填口令表单并创建（沿用 fixtures/ui.createVault 的「弱口令二次提交」协议） */
async function submitPassphraseForm(page: Page, passphrase: string): Promise<void> {
  await page.getByTestId('passphrase-input').fill(passphrase)
  await page.getByTestId('passphrase-repeat').fill(passphrase)
  await page.getByTestId('create-vault').click()

  const weak = page.getByTestId('weak-passphrase-warning')
  const recovery = page.getByTestId('unlock-recovery-code')
  const first = await Promise.race([
    recovery.waitFor({ timeout: 20_000 }).then(() => 'recovery' as const).catch(() => null),
    weak.waitFor({ timeout: 20_000 }).then(() => 'weak' as const).catch(() => null)
  ])
  if (first === 'weak') {
    // 同口令再提交一次才被接受（冻结契约里没有 confirm 字段）
    await page.getByTestId('create-vault').click()
  }
}

/** 切库：DESIGN 4.4 允许「原生 select」或「列表行」两种落法，两种都要能切 */
async function switchLibrary(page: Page, libraryId: string): Promise<void> {
  const select = page.getByTestId('library-switcher').locator('select')
  if ((await select.count()) > 0) {
    await select.selectOption(libraryId)
    return
  }
  const list = page.getByTestId('library-list')
  if ((await list.count()) > 0) {
    const expanded = await list.evaluate((node) => (node as HTMLDetailsElement).open === true)
    if (!expanded) await list.locator('summary').first().click()
  }
  const row = page.locator(`[data-testid="library-row"]:not([data-current="true"])`).first()
  await expect(row, '列表里必须有一行不是当前库').toBeVisible()
  await row.click()
}
