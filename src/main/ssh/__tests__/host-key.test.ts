import type { HostKeyChallenge, HostKeyDecision } from '@shared'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKnownHostsGateway } from '../known-hosts'
import { FakeSshServer } from './helpers/fake-server'
import { createHarness, expectReject, waitFor, type Harness } from './helpers/harness'

/**
 * known_hosts / 主机密钥策略。
 *
 * 这是整个 SSH 客户端里最不能出错的一条链：
 * - 首次连接必须**让用户看到指纹再决定**（不能悄悄 trust）；
 * - 用户选「记住」才落盘，选「只这一次」不能落盘；
 * - 指纹变了必须**硬失败**，且不能覆盖已有记录（否则下次就被洗白了）。
 */

const harnesses: Harness[] = []
const servers: FakeSshServer[] = []

async function server(): Promise<FakeSshServer> {
  const value = await new FakeSshServer({ shellBanner: '' }).start()
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

function seed(gateway: MemoryKnownHostsGateway, fake: FakeSshServer, fingerprint: string): void {
  gateway.trust({
    host: fake.host,
    port: fake.port,
    keyType: 'ssh-ed25519',
    fingerprintSha256: fingerprint,
    replaceExisting: false
  })
}

describe('主机密钥校验（strict 默认策略）', () => {
  it('首次连接发挑战：指纹与服务器真实密钥一致，previous 为 null，reason=unknown', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    let challenge: HostKeyChallenge | null = null

    const h = harness({
      server: fake,
      knownHosts: gateway,
      answerHostKey: (value) => {
        challenge = value
        return { sessionId: value.sessionId, decision: 'accept', remember: true }
      }
    })

    const result = await h.connect()

    expect(challenge).not.toBeNull()
    expect(challenge!.fingerprintSha256).toBe(fake.hostKeyFingerprint)
    expect(challenge!.keyType).toBe('ssh-ed25519')
    expect(challenge!.previousFingerprintSha256).toBeNull()
    expect(challenge!.reason).toBe('unknown')
    expect(result.hostKeyDecision).toBe('accepted-now')
    expect(result.hostKeyFingerprint).toBe(fake.hostKeyFingerprint)

    // 用户选「记住」→ 落盘
    const [entry] = gateway.find(fake.host, fake.port)
    expect(entry?.fingerprintSha256).toBe(fake.hostKeyFingerprint)
    expect(entry?.keyType).toBe('ssh-ed25519')
  })

  it('用户选「只这一次」：本次能连，但不写入 known_hosts（下次还要问）', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const h = harness({
      server: fake,
      knownHosts: gateway,
      answerHostKey: (value) => ({ sessionId: value.sessionId, decision: 'accept', remember: false })
    })

    await h.connect()
    expect(gateway.find(fake.host, fake.port)).toHaveLength(0)

    // 第二次仍然挑战（没有升级成静默信任）
    await h.connect()
    expect(h.events.challenges).toHaveLength(2)
  })

  it('已信任的主机不再打扰用户（trusted）', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    seed(gateway, fake, fake.hostKeyFingerprint)

    const h = harness({ server: fake, knownHosts: gateway })
    const result = await h.connect()

    expect(h.events.challenges).toHaveLength(0)
    expect(result.hostKeyDecision).toBe('trusted')
    expect(h.events.states.map((state) => state.phase)).not.toContain('host-key-verification')
  })

  it('用户拒绝：host-key-unverified（reason=rejected），且不写入 known_hosts', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const h = harness({
      server: fake,
      knownHosts: gateway,
      answerHostKey: (value) => ({ sessionId: value.sessionId, decision: 'reject', remember: true })
    })

    const error = await expectReject(h.connect(), 'host-key-unverified')
    expect(error.ipc).toBe('E_HOST_KEY_UNVERIFIED')
    expect(error.details.reason).toBe('rejected')
    expect(gateway.find(fake.host, fake.port)).toHaveLength(0)
    expect(h.events.states.at(-1)?.phase).toBe('error')
  })

  it('指纹变化：硬失败 host-key-mismatch，同时带旧/新指纹，且不覆盖旧记录、不问用户', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const staleFingerprint = `SHA256:${'A'.repeat(43)}`
    seed(gateway, fake, staleFingerprint)

    const h = harness({ server: fake, knownHosts: gateway })
    const error = await expectReject(h.connect(), 'host-key-mismatch')

    expect(error.ipc).toBe('E_HOST_KEY_UNVERIFIED')
    expect(error.details.previousFingerprintSha256).toBe(staleFingerprint)
    expect(error.details.fingerprintSha256).toBe(fake.hostKeyFingerprint)
    expect(error.details.keyType).toBe('ssh-ed25519')

    // 不问用户：指纹变了必须是硬失败，不能给「点一下接受」的机会
    expect(h.events.challenges).toHaveLength(0)
    // 旧记录不被洗白
    expect(gateway.find(fake.host, fake.port)[0]?.fingerprintSha256).toBe(staleFingerprint)
    expect(gateway.list()).toHaveLength(1)
  })

  it('用户长时间不回答：超时后以 host-key-unverified（reason=timeout）收尾，不悬挂', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    // 永不 resolve：模拟对话框挂着没人点
    const h = harness({
      server: fake,
      knownHosts: gateway,
      hostKeyDecisionTimeoutMs: 150,
      answerHostKey: () => new Promise<HostKeyDecision>(() => {})
    })

    const error = await expectReject(h.connect(), 'host-key-unverified')
    expect(error.details.reason).toBe('timeout')
    expect(gateway.find(fake.host, fake.port)).toHaveLength(0)
  })

  it('knownHostsPolicy=accept-new：未知主机静默记录（TOFU），不发挑战', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const h = harness({ server: fake, knownHosts: gateway, settings: { knownHostsPolicy: 'accept-new' } })

    const result = await h.connect()
    expect(h.events.challenges).toHaveLength(0)
    expect(result.hostKeyDecision).toBe('accepted-now')
    expect(gateway.find(fake.host, fake.port)[0]?.fingerprintSha256).toBe(fake.hostKeyFingerprint)
  })

  it('knownHostsPolicy=accept-new 下指纹变化依然硬失败（策略只放宽首次）', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    seed(gateway, fake, `SHA256:${'B'.repeat(43)}`)
    const h = harness({ server: fake, knownHosts: gateway, settings: { knownHostsPolicy: 'accept-new' } })

    await expectReject(h.connect(), 'host-key-mismatch')
  })

  it('knownHostsPolicy=ask：已信任的主机也要再确认一次', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    seed(gateway, fake, fake.hostKeyFingerprint)
    const h = harness({
      server: fake,
      knownHosts: gateway,
      settings: { knownHostsPolicy: 'ask' },
      answerHostKey: (value) => ({ sessionId: value.sessionId, decision: 'accept', remember: false })
    })

    await h.connect()
    expect(h.events.challenges).toHaveLength(1)
    expect(h.events.challenges[0].fingerprintSha256).toBe(fake.hostKeyFingerprint)
    // previous 指向已信任的那条，用户能对比
    expect(h.events.challenges[0].previousFingerprintSha256).toBe(fake.hostKeyFingerprint)
  })

  it('没有待决挑战时回答 answerHostKey：session-not-found（过期弹窗不崩溃、不误解）', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const h = harness({ server: fake, knownHosts: gateway, answerHostKey: (value) => ({ sessionId: value.sessionId, decision: 'accept', remember: true }) })
    expect(() => h.manager.answerHostKey({ sessionId: 'not-pending', decision: 'accept', remember: false })).toThrowError(
      /No pending host key challenge/
    )
  })

  it('用户接受后 known_hosts 记录的指纹与后续连接看到的一致（不会存成别的值）', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const first = harness({ server: fake, knownHosts: gateway })
    const result = await first.connect()
    const [stored] = gateway.find(fake.host, fake.port)
    expect(stored?.fingerprintSha256).toBe(result.hostKeyFingerprint)

    const second = harness({ server: fake, knownHosts: gateway })
    await second.connect()
    expect(second.events.challenges).toHaveLength(0)
  })
})

describe('挑战与重连的交互', () => {
  it('挑战未回答期间 session 处于 host-key-verification，不会进入 authenticating', async () => {
    const fake = await server()
    const gateway = new MemoryKnownHostsGateway()
    const h = harness({
      server: fake,
      knownHosts: gateway,
      answerHostKey: () => new Promise<HostKeyDecision>(() => {})
    })

    const promise = h.connect().catch((error: unknown) => error)
    await waitFor(() => h.events.states.some((state) => state.phase === 'host-key-verification'), {
      label: 'host-key-verification phase'
    })
    // 卡在验证阶段：不应该出现 authenticating
    expect(h.events.states.map((state) => state.phase)).not.toContain('authenticating')
    await h.manager.disconnect(h.events.challenges[0].sessionId)
    await promise
  })
})
