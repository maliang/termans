import { expect, test } from '@playwright/test'
import { startE2eSshServer, type E2eSshServer } from './fixtures/ssh-server'
import { launchApp } from './harness'
import { addHost, createVault, invokeInPage, terminalText, waitForConnected } from './fixtures/ui'

/**
 * S-12 跳板机（t23 产出）：主机「填了 jumpHostId 就真的经跳板机连」，而不是静默退化成直连。
 *
 * 关键设计（否则用例是假绿）：
 * - **目标机的主机条目写 `127.0.0.1:1`**，直连必然被拒；真实 SSH 服务器监听随机端口，
 *   由「跳板机夹具」的 direct-tcpip 把它接出来。于是「跳板逻辑没生效」时用例必然红，
 *   而不是「不走跳板恰好也能连上」。
 * - 目标机的 shell banner 设成 `termans-e2e target ready`，跳板机保持默认 —— 终端里出现的那行字
 *   就是「这条会话确实落在目标机上」的证据。
 * - 跳板机的 `tcpips` 记录里能看到客户端请求的 dest 是 `127.0.0.1:1`（主机条目里写的那个地址），
 *   说明隧道是按主机条目的 host:port 请求的。
 *
 * 为什么用 `known-hosts:trust` 预置指纹，而不是去点 host-key 确认框：
 * 经跳板机的一次连接会连弹两个确认框（跳板机 + 目标机），而两台夹具共用同一把固定 host key，
 * 指纹一模一样 —— 「点掉框再数点了几次」在机器繁忙时两个框会重叠重渲染，`toHaveCount(0)` 会稳定地
 * 假失败（实测 3 连跑里红过 1 次）。指纹的接受/拒绝语义另有专门用例（本文件反面用例 +
 * `vault-security.spec.ts` 的 ⑧），这里只关心「隧道真的被用上」，所以把已知指纹直接预置进 known_hosts。
 */

// 经跳板机要连两台服务器（跳板机 + 目标机各一次 SSH 握手），默认 60s 在满载机器上偏紧；
// 用例本身仍会在断言处尽快失败，放宽的只是兜底超时。
test.describe.configure({ timeout: 120_000 })

let jump: E2eSshServer
let target: E2eSshServer

/** 目标机在主机库里写的端口：1 号端口没人监听，直连必 ECONNREFUSED */
const DIRECT_BLACKHOLE_PORT = 1

test.beforeAll(async () => {
  target = await startE2eSshServer({ banner: 'termans-e2e target ready' })
  jump = await startE2eSshServer({ forwardTo: { host: '127.0.0.1', port: target.port } })
})

test.afterAll(async () => {
  await jump?.stop()
  await target?.stop()
})

/** 把两台夹具的 host key 都预置成已信任（按主机条目里的 host:port 索引） */
async function trustBoth(page: Parameters<typeof invokeInPage>[0]): Promise<void> {
  await invokeInPage(page, 'known-hosts:trust', {
    host: '127.0.0.1',
    port: jump.port,
    keyType: 'ssh-ed25519',
    fingerprintSha256: jump.hostKeyFingerprint,
    replaceExisting: true
  })
  await invokeInPage(page, 'known-hosts:trust', {
    host: '127.0.0.1',
    port: DIRECT_BLACKHOLE_PORT,
    keyType: 'ssh-ed25519',
    fingerprintSha256: target.hostKeyFingerprint,
    replaceExisting: true
  })
}

test('S-12 跳板机：目标机只能经跳板机连上，终端内容来自目标机', async () => {
  const app = await launchApp({ args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
  try {
    const page = app.window
    await createVault(page)
    await trustBoth(page)

    // 先建跳板机（下拉里只列已存在的主机），再建目标机并指向它
    await addHost(page, {
      label: 'jump-host',
      hostname: '127.0.0.1',
      port: jump.port,
      username: jump.username,
      password: jump.password
    })
    await addHost(page, {
      label: 'behind-jump',
      hostname: '127.0.0.1',
      port: DIRECT_BLACKHOLE_PORT,
      username: target.username,
      password: target.password,
      jumpHostLabel: 'jump-host'
    })

    const item = page.getByTestId('vault-host-item').filter({ hasText: 'behind-jump' }).first()
    await item.dblclick()

    // 指纹已预置 → 不该弹确认框；隧道里的目标机会话把 target 的 banner 打到终端上
    await expect(page.getByTestId('host-key-dialog')).toHaveCount(0, { timeout: 5_000 })
    await waitForConnected(page, 'termans-e2e target ready', 60_000)

    // 隧道证据：跳板机收到过 dest = 主机条目里的 127.0.0.1:1
    expect(jump.tcpips.length).toBeGreaterThanOrEqual(1)
    expect(jump.tcpips[0]).toEqual({ destIP: '127.0.0.1', destPort: DIRECT_BLACKHOLE_PORT })
    // 目标机自己也被连了；跳板机上不该出现交互 shell（banner 不是跳板机打的）
    expect(target.authAttempts.some((attempt) => attempt.accepted && attempt.method === 'password')).toBe(true)
    expect(jump.shellLines.length, '跳板机上不该有交互 shell').toBe(0)

    // 再敲一条命令：目标机收到，且回显出现在终端里（「能执行命令」）
    await page.locator('.xterm-helper-textarea').first().click()
    await page.keyboard.type('echo hi', { delay: 20 })
    await page.keyboard.press('Enter')
    await expect.poll(() => terminalText(page), { timeout: 20_000 }).toContain('hi')
    expect(target.shellLines).toContain('echo hi')
  } finally {
    await app.cleanup()
  }
})

test('S-12 跳板机之反面：跳板机 host key 被改成错指纹时必须硬失败，目标机一次都不该被连', async () => {
  const app = await launchApp({ args: ['--disable-gpu'], waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
  try {
    const page = app.window
    await createVault(page)
    await trustBoth(page)

    await addHost(page, {
      label: 'jump-host',
      hostname: '127.0.0.1',
      port: jump.port,
      username: jump.username,
      password: jump.password
    })
    await addHost(page, {
      label: 'behind-jump-fail',
      hostname: '127.0.0.1',
      port: DIRECT_BLACKHOLE_PORT,
      username: target.username,
      password: target.password,
      jumpHostLabel: 'jump-host'
    })

    // 把一个错的指纹预置给跳板机（模拟中间人）：连接必须硬失败，不能弹「接受」让人点过去
    await invokeInPage(page, 'known-hosts:trust', {
      host: '127.0.0.1',
      port: jump.port,
      keyType: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      replaceExisting: true
    })

    const targetAttemptsBefore = target.authAttempts.length
    const tcpipsBefore = jump.tcpips.length

    const item = page.getByTestId('vault-host-item').filter({ hasText: 'behind-jump-fail' }).first()
    await item.dblclick()

    // 失败信息必须点名「跳板机」，而不是笼统的连接失败（t23 的 withJumpContext 就是干这个的）
    await expect
      .poll(() => terminalText(page), { timeout: 40_000 })
      .toMatch(/Jump host|跳板机|Host key|主机密钥|mismatch|不匹配/i)

    // 指纹不符时不能用「接受」把它糊过去
    await expect(page.getByTestId('host-key-dialog')).toHaveCount(0)

    // 关键：跳板机没过，目标机不该被连过任何一次、也不该开过隧道
    expect(target.authAttempts.length, '跳板机验签失败时目标机不该被连').toBe(targetAttemptsBefore)
    expect(jump.tcpips.length, '跳板机验签失败时不该开隧道').toBe(tcpipsBefore)
  } finally {
    await app.cleanup()
  }
})
