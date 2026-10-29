import { afterEach, describe, expect, it } from 'vitest'
import type { SshSession } from '../session'
import { FakeSshServer } from './helpers/fake-server'
import { createHarness, dataText, waitFor, type Harness } from './helpers/harness'

/**
 * 凭据副本的生命周期（t27 / t10-F2）。
 *
 * 威胁模型：用户口令/口令短语在连接期会进 `SshSession.secrets`（用于日志打码）。
 * 如果库锁了而这份明文还留在主进程里，那么「锁屏 = 看不到主机」就只是界面上的说法，
 * 进程内存里照样能捞到别人的口令。
 *
 * 产品口径（captain 2026-10-29 裁定）：**上锁只清副本，不断开已建立的连接**——
 * 空闲 15 分钟自动锁不该把用户正在跑的长任务踢掉；已建连的通道用的是 ssh2 内部
 * 协商出的密钥，与这里缓存的明文无关。
 */

const harnesses: Harness[] = []
const servers: FakeSshServer[] = []

function harness(options: Parameters<typeof createHarness>[0]): Harness {
  const value = createHarness(options)
  harnesses.push(value)
  return value
}

async function server(options: ConstructorParameters<typeof FakeSshServer>[0] = {}): Promise<FakeSshServer> {
  const value = await new FakeSshServer(options).start()
  servers.push(value)
  return value
}

afterEach(async () => {
  while (harnesses.length > 0) harnesses.pop()?.dispose()
  while (servers.length > 0) await servers.pop()?.stop()
})

function sessionOf(h: Harness, sessionId: string): SshSession {
  const session = h.manager.getSession(sessionId)
  if (!session) throw new Error(`session ${sessionId} is missing`)
  return session
}

describe('凭据副本：上锁清理 / 收尾清理 / 不断连', () => {
  it('连接后缓存里有凭据副本；releaseCredentials() 清空它但会话仍然连着', async () => {
    const fake = await server({ shellBanner: 'banner\r\n', password: 'secret-pw-42' })
    const h = harness({ server: fake, password: 'secret-pw-42' })
    const { sessionId } = await h.connect()
    const session = sessionOf(h, sessionId)
    await waitFor(() => dataText(h.events).includes('banner'), { label: 'shell banner' })

    // 连接期必须持有副本（否则日志里出现口令时没法打码）
    expect(session.cachedSecretCount).toBeGreaterThan(0)

    const cleared = h.manager.releaseCredentials()

    expect(cleared).toBe(1)
    expect(session.cachedSecretCount).toBe(0)
    // 关键：不断开。会话还在 manager 的活会话列表里，且 PTY 仍可写读。
    expect(h.manager.getSession(sessionId)).toBe(session)
    expect(h.manager.listSessions().sessions.map((info) => info.sessionId)).toContain(sessionId)
    expect(session.phase).toBe('connected')

    session.write('echo after-lock\n')
    await waitFor(() => dataText(h.events).includes('echo after-lock'), { label: 'PTY still writable after lock' })
  })

  it('releaseCredentials() 对没有会话的引擎返回 0（幂等，锁两次不报错）', () => {
    const h = harness({ server: { port: 1, host: '127.0.0.1' } })
    expect(h.manager.releaseCredentials()).toBe(0)
    expect(h.manager.releaseCredentials()).toBe(0)
  })

  it('断开/收尾（teardownTransport）也会清掉副本，不依赖调用方记得清', async () => {
    const fake = await server({ shellBanner: '', password: 'secret-pw-43' })
    const h = harness({ server: fake, password: 'secret-pw-43' })
    const { sessionId } = await h.connect()
    const session = sessionOf(h, sessionId)
    await waitFor(() => session.phase === 'connected', { label: 'connected' })
    expect(session.cachedSecretCount).toBeGreaterThan(0)

    await h.manager.disconnect(sessionId)

    expect(session.cachedSecretCount).toBe(0)
  })
})
