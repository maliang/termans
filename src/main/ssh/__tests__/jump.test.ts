import { randomUUID } from 'node:crypto'
import type { SshSettings } from '@shared'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKnownHostsGateway } from '../known-hosts'
import { FakeSshServer, type FakeServerOptions } from './helpers/fake-server'
import { createHarness, expectReject, waitFor, type Harness } from './helpers/harness'

/**
 * 单层 ProxyJump（跳板机）用例。
 *
 * 造「只有经跳板机才通」的目标机：目标机的**主机条目**写 `127.0.0.1:1`（本机回环 1 端口永远
 * 没人监听，直连立即 ECONNREFUSED），真实目标服务器监听在随机端口；跳板机上的 `tcpipMap`
 * 把 `127.0.0.1:1` 映射到那个随机端口。于是：
 *   - 走跳板 → 连得上；
 *   - 跳板逻辑被删掉/改成直连 → ECONNREFUSED 立即失败。
 * 这是「变异必红」的关键——如果目标机在回环上直接可达，把跳板逻辑删掉测试照样绿。
 */

/** 目标机条目里写的「内网地址」：回环 1 端口，直连必被拒 */
const INTERNAL_PORT = 1

const SETTINGS: Partial<SshSettings> = { knownHostsPolicy: 'accept-new', connectTimeoutMs: 5_000 }

interface Pair {
  h: Harness
  target: FakeSshServer
  jump: FakeSshServer
}

const cleanups: (() => Promise<void>)[] = []

function track(harness: Harness, ...servers: FakeSshServer[]): void {
  cleanups.push(async () => {
    harness.dispose()
    for (const server of servers) await server.stop()
  })
}

async function createPair(
  options: { target?: FakeServerOptions; jump?: FakeServerOptions; harness?: Parameters<typeof createHarness>[0] } = {}
): Promise<Pair> {
  const target = await new FakeSshServer(options.target).start()
  const jump = await new FakeSshServer({
    tcpipMap: () => ({ host: '127.0.0.1', port: target.port }),
    ...options.jump
  }).start()

  const h = createHarness({
    // 主机条目指向「内网地址」，只有跳板机的 tcpipMap 知道怎么到真实目标
    server: { host: '127.0.0.1', port: INTERNAL_PORT },
    jump: { server: jump },
    settings: SETTINGS,
    ...options.harness
  })
  track(h, target, jump)
  return { h, target, jump }
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

describe('单层跳板机（ProxyJump）', () => {
  it('经跳板机执行命令：输出来自目标机，且跳板机上真的开过隧道', async () => {
    const { h, target, jump } = await createPair({
      target: { execOutput: (command) => ({ stdout: `TARGET:${command}\n`, code: 0 }) },
      jump: { execOutput: (command) => ({ stdout: `JUMP:${command}\n`, code: 0 }) }
    })

    const { sessionId } = await h.connect()
    await h.waitForConnect()
    const session = h.manager.getSession(sessionId)
    expect(session).toBeDefined()

    const result = await session!.exec('whoami')
    // 若真的连到了跳板机，这里会是 JUMP:whoami
    expect(result.stdout).toBe('TARGET:whoami\n')
    expect(result.code).toBe(0)

    // 隧道证据：destIP/destPort 就是主机条目里写的内网地址（不是被跳板机改写后的地址）
    expect(jump.records.tcpip.length).toBeGreaterThanOrEqual(1)
    expect(jump.records.tcpip[0]).toMatchObject({ destIP: '127.0.0.1', destPort: INTERNAL_PORT })

    // 命令在目标机上执行，跳板机上既没有 exec 也没有 shell
    expect(target.records.execCommands).toEqual(['whoami'])
    expect(jump.records.execCommands).toEqual([])
    expect(jump.records.shells).toBe(0)
    // 两台机器各自完成了一次密码认证
    expect(jump.records.authAttempts.some((attempt) => attempt.method === 'password')).toBe(true)
    expect(target.connectionCount).toBe(1)
    expect(h.manager.listSessions().sessions).toHaveLength(1)
  })

  it('跳板机 host key 变化 → 硬失败并报跳板机的新旧指纹，目标机一次都没连', async () => {
    const target = await new FakeSshServer().start()
    const jump = await new FakeSshServer().start()
    const gateway = new MemoryKnownHostsGateway()
    const stale = `SHA256:${'A'.repeat(43)}`
    gateway.trust({
      host: '127.0.0.1',
      port: jump.port,
      keyType: 'ssh-ed25519',
      fingerprintSha256: stale,
      replaceExisting: false
    })

    const h = createHarness({
      server: { host: '127.0.0.1', port: INTERNAL_PORT },
      jump: { server: jump },
      settings: SETTINGS,
      knownHosts: gateway
    })
    track(h, target, jump)

    const failure = await expectReject(h.connect(), 'host-key-mismatch')

    // 消息必须点名跳板机，否则用户会去查目标机的 known_hosts
    expect(failure.message).toMatch(/Jump host "jump-host"/)
    expect(failure.message).toMatch(/Host key/i)
    expect(failure.details).toMatchObject({
      previousFingerprintSha256: stale,
      fingerprintSha256: jump.hostKeyFingerprint,
      jumpLabel: 'jump-host',
      jumpHostId: h.jumpHost?.id
    })
    expect(failure.ipc).toBe('E_HOST_KEY_UNVERIFIED')

    // 不弹「首次连接」确认框：变化必须硬失败，而不是把选择权交给用户
    expect(h.events.challenges).toHaveLength(0)
    // 没走到目标机
    expect(target.connectionCount).toBe(0)
    // known_hosts 里的旧指纹不能被覆盖
    expect(gateway.find('127.0.0.1', jump.port)[0]?.fingerprintSha256).toBe(stale)
    // 跳板机连接已收尾
    await waitFor(() => jump.connectionCount === 0, { label: 'jump connection cleaned up' })
  })

  it('跳板机凭据缺失 → 错误消息点名跳板机，而不是让人以为目标机凭据没存', async () => {
    const target = await new FakeSshServer().start()
    const jump = await new FakeSshServer().start()

    const h = createHarness({
      server: { host: '127.0.0.1', port: INTERNAL_PORT },
      jump: { server: jump },
      settings: SETTINGS,
      // 只给目标机的凭据；跳板机的 jump-cred 解析不到
      secrets: { 'cred-1': 'secret' }
    })
    track(h, target, jump)

    const failure = await expectReject(h.connect(), 'auth-no-method')

    expect(failure.message).toMatch(/Jump host "jump-host"/)
    expect(failure.message).toMatch(/password/i)
    expect(failure.details).toMatchObject({ jumpLabel: 'jump-host', jumpHostId: h.jumpHost?.id })
    expect(target.connectionCount).toBe(0)
  })

  it('目标 session 关闭后，跳板机连接与隧道一起断开（不留悬挂）', async () => {
    const { h, target, jump } = await createPair()

    const { sessionId } = await h.connect()
    await h.waitForConnect()
    await waitFor(() => jump.openTunnelCount >= 1, { label: 'tunnel opened' })
    expect(jump.connectionCount).toBe(1)
    expect(target.connectionCount).toBe(1)

    await h.manager.disconnect(sessionId)

    await waitFor(() => jump.openTunnelCount === 0, { label: 'tunnel closed' })
    await waitFor(() => jump.connectionCount === 0, { label: 'jump connection closed' })
    await waitFor(() => target.connectionCount === 0, { label: 'target connection closed' })
    // 会话已从列表里摘除
    expect(h.manager.listSessions().sessions).toHaveLength(0)
  })

  it('跳板机自己也配了跳板 → 明确拒绝多级跳板（不静默只跳一层）', async () => {
    const jump = await new FakeSshServer().start()
    const h = createHarness({
      server: { host: '127.0.0.1', port: INTERNAL_PORT },
      jump: { server: jump, jumpHostId: randomUUID() },
      settings: SETTINGS
    })
    track(h, jump)

    const failure = await expectReject(h.connect(), 'jump-unsupported')
    expect(failure.message).toMatch(/Multi-level jump is not supported/)
    expect(failure.hint).toMatch(/one jump level/i)
    // 连接前就拒绝：跳板机一次都没被拨号
    expect(jump.records.authAttempts).toHaveLength(0)
    expect(jump.connectionCount).toBe(0)
  })

  it('jumpHostId 指向已删除的主机 → 明确报错（不是连不上目标机的怪现象）', async () => {
    const jump = await new FakeSshServer().start()
    const h = createHarness({
      server: { host: '127.0.0.1', port: INTERNAL_PORT },
      jump: { server: jump, deleted: true },
      settings: SETTINGS
    })
    track(h, jump)

    const failure = await expectReject(h.connect(), 'jump-not-found')
    expect(failure.message).toMatch(/no longer exists/)
    expect(failure.ipc).toBe('E_NOT_FOUND')
    expect(failure.details).toMatchObject({ jumpHostId: h.host.jumpHostId })
    expect(jump.connectionCount).toBe(0)
  })

  it('跳板机与目标机是同一台机器 → 明确拒绝（否则自己连自己只会超时）', async () => {
    const h = createHarness({
      server: { host: '127.0.0.1', port: INTERNAL_PORT },
      jump: { server: { host: '127.0.0.1', port: INTERNAL_PORT } },
      settings: SETTINGS
    })
    track(h)

    const failure = await expectReject(h.connect(), 'jump-invalid')
    expect(failure.message).toMatch(/same machine as/)
    expect(failure.ipc).toBe('E_INVALID_ARGUMENT')
  })

  it('未配置跳板时是纯直连：不建隧道、不产生 tcpip 记录（新逻辑是加法）', async () => {
    const target = await new FakeSshServer({ execOutput: (command) => ({ stdout: `${command}\n`, code: 0 }) }).start()
    const h = createHarness({ server: target, settings: SETTINGS })
    track(h, target)

    const { sessionId } = await h.connect()
    await h.waitForConnect()
    const session = h.manager.getSession(sessionId)
    const result = await session!.exec('echo direct')

    expect(result.stdout).toBe('echo direct\n')
    expect(target.records.tcpip).toEqual([])
    expect(h.manager.listSessions().sessions).toHaveLength(1)
  })
})
