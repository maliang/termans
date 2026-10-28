import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKnownHostsGateway } from '../known-hosts'
import { FakeSshServer } from './helpers/fake-server'
import { createHarness, delay, waitFor, type Harness } from './helpers/harness'

/**
 * 断线自动重连。
 *
 * 这里的断言都刻意选「改错就必红」的量：
 * - 重连延迟直接断言退避公式的数值（第 1 次 10ms、第 2 次 20ms），指数退避写错立刻暴露；
 * - 重连成功后断言窗口尺寸被重放（远端 shell 是新的，尺寸不重放就变成 80x24）；
 * - 断开重连期间 alter known_hosts → 断言「不再重试」，防止把指纹变化当成网络抖动吞掉。
 */

const harnesses: Harness[] = []
const servers: FakeSshServer[] = []

async function server(options: ConstructorParameters<typeof FakeSshServer>[0] = {}): Promise<FakeSshServer> {
  const value = await new FakeSshServer({ shellBanner: '', ...options }).start()
  servers.push(value)
  return value
}

function harness(options: Parameters<typeof createHarness>[0]): Harness {
  const value = createHarness(options)
  harnesses.push(value)
  return value
}

afterEach(async () => {
  while (harnesses.length > 0) harnesses.pop()?.dispose()
  while (servers.length > 0) await servers.pop()?.stop()
})

describe('自动重连', () => {
  it('断线后按指数退避重连：第 1 次 10ms、第 2 次 20ms，成功后回到 connected', async () => {
    const fake = await server()
    const h = harness({
      server: fake,
      settings: { autoReconnectAttempts: 3 },
      reconnect: { baseDelayMs: 10, factor: 2, maxDelayMs: 1_000 }
    })
    await h.connect()

    fake.killConnections()

    await waitFor(() => h.events.states.some((state) => state.phase === 'reconnecting'), { label: 'reconnecting' })
    await waitFor(() => {
      const phases = h.events.states.map((state) => state.phase)
      return phases.lastIndexOf('connected') > phases.indexOf('reconnecting')
    }, { label: 'reconnected' })

    const messages = h.events.states.filter((state) => state.phase === 'reconnecting').map((state) => state.message)
    // 退避公式写错（比如忘了 factor、或从 attempt 0 开始）这两条一定挂
    expect(messages[0]).toContain('reconnect 1/3 in 10ms')
    expect(h.events.states.at(-1)?.message).toContain('reconnected (attempt 1)')
    // 远端 shell 是新建的：服务器上应该看到第 2 个 shell
    expect(fake.records.shells).toBeGreaterThanOrEqual(2)
  })

  it('重连成功后重放最后的窗口尺寸（否则新 shell 回到默认 80x24）', async () => {
    const fake = await server()
    const h = harness({
      server: fake,
      settings: { autoReconnectAttempts: 2 },
      reconnect: { baseDelayMs: 5, maxDelayMs: 20 }
    })
    const result = await h.connect()

    h.manager.resize(result.sessionId, { cols: 100, rows: 30 })
    await waitFor(() => fake.records.windowChanges.length >= 1, { label: 'resize recorded' })

    fake.killConnections()
    await waitFor(() => h.events.states.some((state) => state.phase === 'reconnecting'), { label: 'reconnecting' })
    await waitFor(() => {
      const phases = h.events.states.map((state) => state.phase)
      return phases.lastIndexOf('connected') > phases.indexOf('reconnecting')
    }, { label: 'reconnected' })

    // 重连后服务器必须收到 100x30 的 window-change（两次：用户那次 + 重放那次）。
    // 注意：setWindow 是「客户端发出」即刻返回，服务器端记录要等包到达，所以这里必须 waitFor 而不是立刻断言。
    const sizes = (): number =>
      fake.records.windowChanges.filter((change) => change.cols === 100 && change.rows === 30).length
    await waitFor(() => sizes() >= 2, { label: 'resize replay' })
    expect(sizes()).toBeGreaterThanOrEqual(2)
    const replayMessage = h.events.states.at(-1)?.message
    expect(replayMessage).toContain('terminal size replayed 100x30')
  })

  it('重试次数耗尽：phase=error + closed reason=error（不是静默变 closed）', async () => {
    const fake = await server()
    const h = harness({
      server: fake,
      settings: { autoReconnectAttempts: 2 },
      reconnect: { baseDelayMs: 5, maxDelayMs: 10 }
    })
    await h.connect()

    // 杀掉现有连接，并且让后续重连一律失败（端口关闭 → ECONNREFUSED → network）
    fake.killConnections()
    await waitFor(() => h.events.states.some((state) => state.phase === 'reconnecting'), { label: 'reconnecting' })
    await fake.stop()

    await waitFor(() => h.events.closed.length === 1, { label: 'closed event' })
    expect(h.events.closed[0].reason).toBe('error')
    expect(h.events.states.at(-1)?.phase).toBe('error')
    // 恰好重试 autoReconnectAttempts 次（多一次或少一次都算 bug）
    expect(h.events.states.filter((state) => state.phase === 'reconnecting')).toHaveLength(2)
  })

  it('autoReconnectAttempts=0：断线直接 closed/disconnected，不进入 reconnecting', async () => {
    const fake = await server()
    const h = harness({ server: fake, settings: { autoReconnectAttempts: 0 } })
    await h.connect()

    fake.killConnections()
    await waitFor(() => h.events.closed.length === 1, { label: 'closed' })

    expect(h.events.closed[0].reason).toBe('disconnected')
    expect(h.events.states.map((state) => state.phase)).not.toContain('reconnecting')
    expect(h.manager.listSessions().sessions).toHaveLength(0)
  })

  it('用户手动断开可取消重试：不会在退避结束前又连上', async () => {
    const fake = await server()
    const h = harness({
      server: fake,
      settings: { autoReconnectAttempts: 5 },
      reconnect: { baseDelayMs: 200, maxDelayMs: 500 }
    })
    const result = await h.connect()

    fake.killConnections()
    await waitFor(() => h.events.states.some((state) => state.phase === 'reconnecting'), { label: 'reconnecting' })
    const shellsBefore = fake.records.shells

    await h.manager.disconnect(result.sessionId)
    await delay(400) // 远大于退避时间：若取消没生效，这里就会重连成功

    expect(fake.records.shells).toBe(shellsBefore)
    expect(h.events.closed.map((event) => event.reason)).toEqual(['user'])
    expect(h.events.states.at(-1)?.phase).toBe('closed')
  })

  it('重连时主机密钥变化：立即停止重试并 hard-fail，且不覆盖 known_hosts', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const h = harness({
      server: fake,
      knownHosts: gateway,
      settings: { autoReconnectAttempts: 5 },
      reconnect: { baseDelayMs: 5, maxDelayMs: 20 }
    })
    const result = await h.connect()
    expect(gateway.find(fake.host, fake.port)).toHaveLength(1)

    // 模拟「中间人/服务器被换掉」：known_hosts 被改成另一个指纹
    gateway.remove({ host: fake.host, port: fake.port })
    const otherFingerprint = `SHA256:${'C'.repeat(43)}`
    gateway.trust({
      host: fake.host,
      port: fake.port,
      keyType: 'ssh-ed25519',
      fingerprintSha256: otherFingerprint,
      replaceExisting: false
    })

    fake.killConnections()
    await waitFor(() => h.events.closed.length === 1, { label: 'closed' })

    expect(h.events.closed[0].reason).toBe('error')
    expect(h.events.states.at(-1)?.phase).toBe('error')
    expect(h.events.states.at(-1)?.message).toMatch(/host key/i)
    // 一次就停：不能把指纹变化当网络抖动重试 5 次
    expect(h.events.states.filter((state) => state.phase === 'reconnecting')).toHaveLength(1)
    // 不覆盖：抗 MITM 的最后一道保险
    expect(gateway.find(fake.host, fake.port)[0].fingerprintSha256).toBe(otherFingerprint)
    expect(h.manager.listSessions().sessions).toHaveLength(0)
    void result
  })
})
