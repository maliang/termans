import { expect, test } from '@playwright/test'
import { startSshFixture } from '../tests/fixtures/ssh-server'
import { launchApp } from './harness'

/**
 * t18 回归：`tests/fixtures/ssh-server.ts` 在 **Electron** 里必须扛得住一次 resize。
 *
 * 背景（这条用例守的就是它）：夹具当年把 `window-change` 当成「带应答的请求」处理
 * （`(acceptWindow) => acceptWindow()`）。RFC 4254 里 window-change 没有应答，ssh2 传给
 * 监听器的 accept 是 `undefined`，于是客户端一 resize 服务端就抛 TypeError、ssh2 直接
 * 销毁 socket，客户端只看到一条 FIN —— 现象是「连上约 1s 被对端 FIN」，而 vitest 里
 * 没有触发 resize 的用例，所以长期没暴露。
 *
 * 为什么必须是 **Electron** 里的用例：应用一挂载 xterm 就会 fit 出真实尺寸并发 resize，
 * 这是触发条件；纯 Node 侧的 ssh2 客户端要手工 setWindow 才走同一路径（那条覆盖在
 * `tests/fixtures/ssh-server.test.ts` 的 vitest 用例里）。
 *
 * 归属：本文件与 `tests/fixtures/**` 同属 engine（t18），qa 的 e2e 用例请用
 * `e2e/fixtures/ssh-server.ts`（标准 `server.listen()` 版），两者互不影响。
 */
test('tests/fixtures 夹具在 Electron 里保持连接 ≥5s，且 resize 不断连、shell 可交互', async () => {
  test.setTimeout(120_000)
  const ssh = await startSshFixture()
  const app = await launchApp({ waitFor: (page) => page.getByTestId('unlock-screen').waitFor() })
  const page = app.window

  try {
    // 1) 建库 → 建主机（密码走 host-password，引擎按 credentialRef 取明文）
    const passphrase = 'Termans-E2E-Passw0rd!2026'
    await page.getByTestId('passphrase-input').fill(passphrase)
    await page.getByTestId('passphrase-repeat').fill(passphrase)
    await page.getByTestId('create-vault').click()
    await page.waitForTimeout(800)
    if (await page.getByTestId('weak-passphrase-warning').isVisible().catch(() => false)) {
      await page.getByTestId('create-vault').click()
    }
    // AC-16（r3）：建库成功后先展示恢复码，没点「我已保存」不离开解锁卡。
    // 这段是本 spec 自带的建库流程（刻意不调 `createVault` 夹具：它要证明的是 raw 夹具能在
    // Electron 里跑起来），所以恢复码闸门要在这里单独处理一次。
    const recovery = page.getByTestId('unlock-recovery-code')
    const recoveryShown = await recovery.waitFor({ timeout: 20_000 }).then(
      () => true,
      () => false
    )
    if (recoveryShown) await page.getByTestId('unlock-recovery-done').click()
    await expect(page.getByTestId('unlock-screen')).toHaveCount(0, { timeout: 20_000 })

    await page.getByTestId('host-new').click()
    await page.getByTestId('host-label').fill('e2e-fixture-host')
    await page.getByTestId('host-hostname').fill('127.0.0.1')
    await page.getByLabel(/端口|Port/).fill(String(ssh.port))
    await page.getByLabel(/用户名|Username/).fill(ssh.username)
    await page.getByTestId('host-password').fill(ssh.password)
    await page.getByTestId('host-save').click()
    await expect(page.getByTestId('vault-host-item').first()).toBeVisible({ timeout: 15_000 })

    // 2) 双击连接；strict 策略下首连要接受主机指纹
    await page.getByTestId('vault-host-item').first().dblclick()
    const prompt = page.getByTestId('host-key-dialog')
    await prompt.waitFor({ timeout: 20_000 })
    await page.getByTestId('host-key-accept').click()

    // 3) xterm 挂载后 fit 出来的尺寸会触发 window-change：它必须真的到达服务端
    //    （resize 处理错了不会报错，只会断连，所以这里同时断言「到达」+「没断」）
    await expect.poll(() => ssh.windowChanges.length, { timeout: 20_000 }).toBeGreaterThan(0)
    const [resize] = ssh.windowChanges
    expect(resize?.cols).toBeGreaterThan(1)
    expect(resize?.rows).toBeGreaterThan(1)

    // 4) ≥5s 存活：修复前这里必然已经是空列表（FIN → phase closed）
    await page.waitForTimeout(5_500)
    const sessions = await page.evaluate(async () => {
      const bridge = (globalThis as unknown as { termans: { invoke: (channel: string) => Promise<unknown> } }).termans
      const result = (await bridge.invoke('ssh:list-sessions')) as {
        ok: boolean
        data?: { sessions: { sessionId: string; phase: string }[] }
      }
      return result.data?.sessions ?? []
    })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.phase).toBe('connected')

    // 5) shell 可交互：写入一条命令，服务端记录 + 渲染层收到回显（两端都验，防「只发不收」）
    //    终端 DOM 结构随 xterm 渲染器而变（canvas/DOM 渲染不一定有 .xterm-rows），
    //    这里断言 IPC 数据面：`ssh:data` 是把字节交给 xterm 的唯一入口。
    const sessionId = sessions[0]!.sessionId
    await page.evaluate(() => {
      const w = window as unknown as { __t18Data: string; termans: { on: (e: string, l: (p: unknown) => void) => () => void } }
      w.__t18Data = ''
      w.termans.on('ssh:data', (payload) => {
        w.__t18Data += (payload as { data: string }).data
      })
    })
    await page.evaluate(async (id) => {
      const bridge = (globalThis as unknown as { termans: { invoke: (c: string, p?: unknown) => Promise<unknown> } }).termans
      await bridge.invoke('ssh:input', { sessionId: id, data: 'echo T18-ALIVE\r' })
    }, sessionId)
    await expect.poll(() => ssh.shellLines, { timeout: 15_000 }).toContain('echo T18-ALIVE')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __t18Data: string }).__t18Data), { timeout: 15_000 })
      .toContain('T18-ALIVE')

    // 6) 夹具自己全程没有异常（resize 处理错时这里会是 acceptWindow is not a function）
    expect(ssh.errors).toEqual([])
  } finally {
    await app.cleanup()
    await ssh.stop()
  }
})
