import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { withDualMachine } from './fixtures/dual-machine'
import { serveBareRepo, type GitHttpGateway } from './fixtures/git-http'
import { launchApp } from './harness'
import {
  addHost,
  connectSyncRemote,
  createVault,
  hostByLabel,
  hostIdByLabel,
  invokeInPage,
  openSyncPanel,
  pullSync,
  pushSync,
  pushSyncExpectingConflict,
  resolveConflictByButton,
  updateHostFields,
  waitForVaultUnlocked
} from './fixtures/ui'

/**
 * S-10 乐观锁冲突：远端前进 + 本地有改动 → 必须出现冲突快照，并且**逐字段选边**，
 * 不许静默覆盖（验收条文：「远端前进且本地有改动→出现 conflict 快照并要求逐字段选择，禁止静默覆盖」）。
 *
 * ## 为什么要这么造冲突
 * 三步合并（base = 上次同步的快照，见 `src/main/git/conflicts.ts:204` `mergePayloads`）里
 * **两边改不同字段会自动并入、不打扰用户**——这是对的，不该拿它当冲突证据。
 * 真冲突必须是「同一个实体的同一个字段，两边改成不同值」：
 * base.port=2201，A 改成 2222，B 改成 2300 → `hosts.<id>.port` 一条冲突。
 *
 * ## 为什么主机改动走 `hosts:update` 而不是点界面
 * 当前 shell 里**没有编辑已有主机的 UI 路径**（`HostTree` 双击=编辑，被
 * `src/renderer/app/layout/HostLibraryPane.tsx` 的 `onDoubleClickCapture` 改写成了「连接」），
 * 这是产品缺口（已在 t8 报告里作为 finding 上报），不是本用例的验证目标。
 * 本条用例真正要验的是「冲突解决必须走 UI」——所以**选边全部点按钮**，一次 IPC 直调都没有。
 *
 * ## 断言里的「不静默覆盖」三件套
 * 1. 冲突未解决时，A 的本地值仍在（`hosts:list` 读回 2222，没有被远端悄悄改写）；
 * 2. 冲突未解决时，远端没被 A 覆盖（bare 仓库的 revision 与 B 推完时一模一样）；
 * 3. 解决后才允许推进：revision 前进、另一台机器拉下来看到的就是选的那一边。
 */

const PASSPHRASE = 'Termans-Conflict-2026!'
const LABEL = 'conflict-host'
/** base 值 / A 机的本地值 / B 机的远端值，三者互不相同才能区分「取了哪一边」 */
const BASE_PORT = 2201
const LOCAL_PORT = 2222
const REMOTE_PORT = 2300

/**
 * 每个用例要起两台 Electron、连两轮远端、还要等两次「回锁→解锁」，默认 60s 在某些机器负载高时不够，
 * 这里按文件放宽（不是掩盖慢，而是这条链路本来就长；超时值仍会打印在报告里）。
 */
test.describe.configure({ timeout: 120_000 })

let gateway: GitHttpGateway

test.afterEach(async () => {
  await gateway?.close()
})

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).toString()
}

/** bare 仓库 HEAD 里 `manifest.json` 的 revision —— 「远端到底有没有前进」的唯一硬指标 */
function remoteRevision(bareRepo: string): number {
  const raw = git(['-C', bareRepo, 'show', 'HEAD:manifest.json'])
  const parsed = JSON.parse(raw) as { revision?: unknown }
  if (typeof parsed.revision !== 'number') throw new Error(`manifest.json 里没有 revision：${raw.slice(0, 200)}`)
  return parsed.revision
}

/** 冲突快照目录（`conflictsDir()` = `<userData>/vault-local/conflicts`，见 src/main/git/conflicts.ts:582） */
function conflictFiles(userDataDir: string): string[] {
  const dir = join(userDataDir, 'vault-local', 'conflicts')
  return existsSync(dir) ? readdirSync(dir) : []
}

/**
 * 让界面回到「解锁 + 同步面板可见」。回锁的细节（data-locked 先翻、解锁屏后到）见
 * `waitForVaultUnlocked` 的注释 —— 这里只做「settle + 确保面板开着」。
 */
async function settleVaultUi(page: import('@playwright/test').Page): Promise<void> {
  await waitForVaultUnlocked(page, PASSPHRASE)
  await openSyncPanel(page)
}

/**
 * 把两台机器推到「A、B 改同一台主机的 port，B 已经推上去」的状态，返回冲突还没发生的现场。
 * 三段式（A 建库推送 → B 拉取解锁 → 两边各改同一字段）在每个用例里都一样，收在这里避免三份拷贝走偏。
 */
async function prepareDivergence(context: {
  dirA: string
  dirB: string
  bareRepo: string
}): Promise<{
  a: Awaited<ReturnType<typeof launchApp>>
  b: Awaited<ReturnType<typeof launchApp>>
  hostId: string
  revisionBefore: number
  revisionAfterRemotePush: number
}> {
  gateway = await serveBareRepo(context.bareRepo)

  // `--disable-gpu` 不是可选项：WebGL 渲染器下终端文字在 canvas 里，`.xterm-rows` 一个字都读不到
  const a = await launchApp({
    userDataDir: context.dirA,
    args: ['--disable-gpu'],
    waitFor: (page) => page.getByTestId('unlock-screen').waitFor()
  })
  const b = await launchApp({
    userDataDir: context.dirB,
    args: ['--disable-gpu'],
    waitFor: (page) => page.getByTestId('unlock-screen').waitFor()
  })

  // A：建库 → 一台主机 → 连远端（bootstrap 内部会做首次推送，远端从此有 revision）
  await createVault(a.window, PASSPHRASE)
  await addHost(a.window, {
    label: LABEL,
    hostname: '127.0.0.1',
    port: BASE_PORT,
    username: 'alice',
    password: 'conflict-secret'
  })
  await openSyncPanel(a.window)
  await connectSyncRemote(a.window, { url: gateway.url })
  // bootstrap 只建立远端关系与本地仓库，「首推」是显式点推送完成的（dual-machine 用例同样这么写）——
  // 远端在第一次 push 之前 HEAD 都不存在，所以 revision 必须在 push 之后读。
  await pushSync(a.window)
  const revisionBefore = remoteRevision(context.bareRepo)

  // B：同口令建库 → 连远端 → 拉取；对齐后 A 的密文归 A 的 VMK，必须重新解锁才看得到主机。
  // 「连上之后库被回锁」是产品的正确行为（对齐期间禁止写），但它会把整个外壳 visibility:hidden，
  // 同步面板里的按钮随之不可见 —— 所以每次同步前后都要先 settle 一次（解锁 + 确保面板开着）。
  await createVault(b.window, PASSPHRASE)
  await openSyncPanel(b.window)
  await connectSyncRemote(b.window, { url: gateway.url })
  await settleVaultUi(b.window)
  await pullSync(b.window)
  await settleVaultUi(b.window)

  const hostIdA = await hostIdByLabel(a.window, LABEL)
  const hostIdB = await hostIdByLabel(b.window, LABEL)
  expect(hostIdB, '两台机器上必须是同一台主机（同一个 id），否则根本不会撞出同实体冲突').toBe(hostIdA)

  // 两边改同一个字段（port）成不同的值 —— 只有这种「同一字段两边都改」才是真冲突
  await updateHostFields(a.window, hostIdA, { port: LOCAL_PORT })
  await updateHostFields(b.window, hostIdB, { port: REMOTE_PORT })

  // B 先推成功：远端前进
  await pushSync(b.window)
  // 远端 revision 是这次「先推」唯一可信的落点证据，用轮询读，避免读到推送结束前的中间态
  await expect
    .poll(() => remoteRevision(context.bareRepo), { timeout: 30_000, message: 'B 的推送没有让远端 revision 前进' })
    .toBeGreaterThan(revisionBefore)
  const revisionAfterRemotePush = remoteRevision(context.bareRepo)

  return { a, b, hostId: hostIdA, revisionBefore, revisionAfterRemotePush }
}

test('S-10 乐观锁冲突：远端前进且本地有改动 → 出冲突快照 + 逐字段选边，禁止静默覆盖（选「保留本地」）', async () => {
  await withDualMachine(async ({ dirA, dirB, bareRepo }) => {
    const { a, b, hostId, revisionAfterRemotePush } = await prepareDivergence({ dirA, dirB, bareRepo })
    try {
      // A 再推：必须撞乐观锁，而不是把 B 的改动盖掉（也不是自己悄悄成功）
      await pushSyncExpectingConflict(a.window)

      const conflicts = a.window.getByTestId('sync-conflicts')
      const row = conflicts.locator('.ts-vault__conflict')
      await expect(row).toHaveCount(1)
      // 逐字段：面板要指出是哪台主机的哪个字段，并且两边的值都摆出来
      await expect(row.locator('.ts-vault__mono')).toContainText(`hosts.${hostId}.port`)
      await expect(row).toContainText(String(LOCAL_PORT))
      await expect(row).toContainText(String(REMOTE_PORT))

      // 冲突快照落盘（vault-local/conflicts 下至少 state.enc）
      expect(conflictFiles(dirA).length, 'vault-local/conflicts 里必须有冲突快照文件').toBeGreaterThan(0)

      // 状态是 diverged（「等你选边」），不是 error（「同步炸了」）
      const statusA = (await invokeInPage(a.window, 'sync:status')) as Record<string, unknown>
      expect(statusA['state']).toBe('diverged')
      expect(Number(statusA['conflictCount'])).toBeGreaterThan(0)

      // 「不静默覆盖」的两条硬指标：
      // ① A 的改动没被丢掉 —— 冲突面板把本地的 2222 与远端的 2300 都摆出来（上一段已断言），
      //    并且快照确实落盘（conflictFiles 非空），值还在；
      // ② 远端没有被 A 推进 —— 没人点选边之前，一个字节都不许上去。
      // 注意：冲突未解决时**工作副本**会先回到远端内容（`mergeFlow` 里 `resetTo(remote)` +
      // `manager.reload()`，src/main/git/sync.ts:340-387），本地值只活在冲突记录里。
      // 这是产品的显式选择设计（必须点选边才落地），不是静默覆盖 —— 所以这里断言的是
      // 「本地值在冲突记录里可读、远端未前进」，而不是「工作副本还写着 2222」。
      expect(remoteRevision(bareRepo), '冲突未解决前 A 不许把任何东西推上去').toBe(revisionAfterRemotePush)

      // 选「保留本地」—— 这一步必须是真点 UI 按钮
      await resolveConflictByButton(a.window, 'local')
      await expect(conflicts).toBeHidden({ timeout: 30_000 })

      // 取舍真的落地了：本地是 2222，远端也前进到 A 的版本
      expect((await hostByLabel(a.window, LABEL))['port']).toBe(LOCAL_PORT)
      await expect
        .poll(() => remoteRevision(bareRepo), { timeout: 30_000, message: '解决后 A 必须把合并结果推上去' })
        .toBeGreaterThan(revisionAfterRemotePush)
      // 清掉的是**冲突状态**（state.enc）——留着它下次推送还会被拦；时间戳快照目录是留证，不清。
      // 用 poll：面板先消失、清理在推送成功之后才落盘（实测存在这几百毫秒的窗口）。
      await expect
        .poll(() => conflictFiles(dirA), { timeout: 30_000, message: '解决完之后冲突状态必须清掉，否则下次推送又会被拦' })
        .not.toContain('state.enc')
      await expect
        .poll(async () => (await invokeInPage(a.window, 'sync:status')) as Record<string, unknown>, { timeout: 30_000 })
        .toMatchObject({ state: 'idle', conflictCount: 0 })

      // 换台机器拉下来看到的也是「保留本地」的结果
      await pullSync(b.window)
      await settleVaultUi(b.window)
      expect((await hostByLabel(b.window, LABEL))['port']).toBe(LOCAL_PORT)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

test('S-10 乐观锁冲突：同一现场选「保留远端」→ A 的本地改动被明确丢弃，结果为远端值', async () => {
  await withDualMachine(async ({ dirA, dirB, bareRepo }) => {
    const { a, b, revisionAfterRemotePush } = await prepareDivergence({ dirA, dirB, bareRepo })
    try {
      await pushSyncExpectingConflict(a.window)
      // 冲突现场：面板里必须同时能看到本地的 2222 与远端的 2300，才谈得上「选择」
      const row = a.window.getByTestId('sync-conflicts').locator('.ts-vault__conflict')
      await expect(row).toHaveCount(1)
      await expect(row).toContainText(String(LOCAL_PORT))
      await expect(row).toContainText(String(REMOTE_PORT))

      await resolveConflictByButton(a.window, 'remote')
      await expect(a.window.getByTestId('sync-conflicts')).toBeHidden({ timeout: 30_000 })

      // 方向反过来：这次落在本地的是远端值 2300，A 自己改的 2222 被明确丢掉（是「选择」不是「事故」）
      expect((await hostByLabel(a.window, LABEL))['port'], '选保留远端后本地必须变成远端值').toBe(REMOTE_PORT)
      await expect.poll(() => remoteRevision(bareRepo), { timeout: 30_000 }).toBeGreaterThan(revisionAfterRemotePush)

      await pullSync(b.window)
      await settleVaultUi(b.window)
      expect((await hostByLabel(b.window, LABEL))['port']).toBe(REMOTE_PORT)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

test('S-10 乐观锁冲突：选「两边都留」→ 本地那份另存为副本，本字段取远端值，一台都不丢', async () => {
  await withDualMachine(async ({ dirA, dirB, bareRepo }) => {
    const { a, b, hostId, revisionAfterRemotePush } = await prepareDivergence({ dirA, dirB, bareRepo })
    try {
      await pushSyncExpectingConflict(a.window)
      await resolveConflictByButton(a.window, 'duplicate')
      await expect(a.window.getByTestId('sync-conflicts')).toBeHidden({ timeout: 30_000 })
      // 选完边 A 会立刻推一次；不等它落到 bare 就去 B 拉，B 拉到的还是旧 HEAD（这条用例第一版就栽在这）
      await expect
        .poll(() => remoteRevision(bareRepo), { timeout: 30_000, message: '解决后 A 必须把合并结果推上去' })
        .toBeGreaterThan(revisionAfterRemotePush)

      const library = (await invokeInPage(a.window, 'hosts:list')) as { hosts: Array<Record<string, unknown>> }
      expect(library.hosts, '两边都留之后应有两台：原机 + 副本').toHaveLength(2)
      const original = library.hosts.find((host) => host['id'] === hostId) ?? null
      const copy = library.hosts.find((host) => host['id'] !== hostId) ?? null
      expect(original).not.toBeNull()
      expect(copy).not.toBeNull()
      // 原机：本字段取远端值（2300）；副本：本地那一份完整留存（2222），label 带 (copy) 便于识别
      expect(original?.['port']).toBe(REMOTE_PORT)
      expect(copy?.['port']).toBe(LOCAL_PORT)
      expect(String(copy?.['label'])).toContain(`${LABEL} (copy)`)
      await expect(a.window.getByTestId('vault-host-item')).toHaveCount(2)

      await pullSync(b.window)
      await settleVaultUi(b.window)
      // 推上去的是「原机 + 副本」两条，B 拉下来同样是两条
      const libraryB = (await invokeInPage(b.window, 'hosts:list')) as { hosts: Array<Record<string, unknown>> }
      expect(libraryB.hosts).toHaveLength(2)
    } finally {
      await a.close()
      await b.close()
    }
  })
})
