import type {
  SshClosedEvent,
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshStateEvent,
  TerminalSize
} from '@shared'
import type { TerminalTransport } from '../types'

/**
 * 本地假终端（**只给 dev / e2e / 无 SSH 服务时演示**用，生产路径不会 import 它）。
 *
 * 为什么值得写：终端渲染最难查的问题（首帧尺寸、resize 传播、scrollback、未读标记、
 * 中文宽字符、清屏）全都不依赖真 SSH。有一个能跑命令的假后端，Playwright 就能断言
 * 「输入 echo hi → 屏幕出现 hi」，而不是只能断言「有一个黑框」。
 *
 * 支持：回车执行、Backspace、Ctrl+C、help / echo / date / clear / exit。
 * 回显由本模块负责（真实 SSH 是远端 tty 回显），否则用户看不到自己打的字。
 */

export interface MockTransportOptions {
  /** 连接耗时，用来验证「连接中」状态点 */
  connectDelayMs?: number
  hostLabel?: string
  username?: string
  /**
   * 每 N 毫秒给所有在线会话推一行输出（模拟「后台有东西在打印」）。
   * 用来验证未读标记：非激活页签收到输出才会累加 unread，靠人手在 htop 里等太不稳定。
   */
  heartbeatMs?: number
}

interface MockSession {
  sessionId: string
  hostLabel: string
  username: string
  buffer: string
  closed: boolean
}

const crlf = (text: string): string => text.replace(/\n/g, '\r\n')

export function createMockTransport(options: MockTransportOptions = {}): TerminalTransport {
  const connectDelayMs = options.connectDelayMs ?? 120
  const sessions = new Map<string, MockSession>()
  const dataListeners = new Set<(event: SshDataEvent) => void>()
  const stateListeners = new Set<(event: SshStateEvent) => void>()
  const closedListeners = new Set<(event: SshClosedEvent) => void>()
  let seq = 0

  if (options.heartbeatMs && options.heartbeatMs > 0) {
    let tick = 0
    setInterval(() => {
      tick += 1
      for (const session of sessions.values()) {
        if (session.closed) continue
        emitData(session.sessionId, crlf(`[heartbeat ${tick}]\n`))
      }
    }, options.heartbeatMs)
  }

  const emitData = (sessionId: string, data: string): void => {
    if (!data) return
    for (const listener of dataListeners) listener({ sessionId, data })
  }
  const emitState = (sessionId: string, phase: SshStateEvent['phase'], message: string | null = null): void => {
    for (const listener of stateListeners) listener({ sessionId, phase, message })
  }
  const emitClosed = (event: SshClosedEvent): void => {
    for (const listener of closedListeners) listener(event)
  }

  const prompt = (session: MockSession): string =>
    `\x1b[32m${session.username}@${session.hostLabel}\x1b[0m:\x1b[34m~\x1b[0m$ `

  const runCommand = (session: MockSession, rawLine: string): void => {
    const command = rawLine.trim()
    if (session.closed) return
    if (!command) {
      emitData(session.sessionId, prompt(session))
      return
    }
    const [name, ...rest] = command.split(/\s+/)
    switch (name) {
      case 'help':
        emitData(
          session.sessionId,
          crlf('mock shell（未连接真实 SSH）\n可用命令：help / echo <文本> / date / clear / exit\n')
        )
        break
      case 'echo':
        emitData(session.sessionId, crlf(`${rest.join(' ')}\n`))
        break
      case 'date':
        emitData(session.sessionId, crlf(`${new Date().toISOString()}\n`))
        break
      case 'clear':
        emitData(session.sessionId, '\x1b[2J\x1b[H')
        break
      case 'exit':
        session.closed = true
        emitState(session.sessionId, 'closed')
        emitClosed({ sessionId: session.sessionId, exitCode: 0, signal: null, reason: 'exit' })
        return
      default:
        emitData(session.sessionId, crlf(`${name}: command not found（mock shell，试试 help）\n`))
        break
    }
    emitData(session.sessionId, prompt(session))
  }

  return {
    kind: 'mock',

    connect: (request: SshConnectRequest): Promise<SshConnectResult> => {
      seq += 1
      const sessionId = `mock-${seq}`
      const session: MockSession = {
        sessionId,
        hostLabel: options.hostLabel ?? 'mock-host',
        username: options.username ?? 'mock',
        buffer: '',
        closed: false
      }
      sessions.set(sessionId, session)
      emitState(sessionId, 'connecting')
      return new Promise<SshConnectResult>((resolve) => {
        setTimeout(() => {
          emitState(sessionId, 'connected')
          emitData(
            sessionId,
            crlf(
              `Welcome to Termans mock shell (${request.size.cols}x${request.size.rows})\n` +
                '输入 help 查看可用命令；这里不会连接真实 SSH。\n'
            )
          )
          emitData(sessionId, prompt(session))
          resolve({ sessionId, hostKeyFingerprint: 'SHA256:mock-fingerprint', hostKeyDecision: 'trusted' })
        }, connectDelayMs)
      })
    },

    write: (sessionId, data) => {
      const session = sessions.get(sessionId)
      if (!session || session.closed) return Promise.resolve()
      for (const char of data) {
        if (char === '\r' || char === '\n') {
          const line = session.buffer
          session.buffer = ''
          emitData(sessionId, '\r\n')
          runCommand(session, line)
          continue
        }
        if (char === '\x7f') {
          if (session.buffer.length > 0) {
            session.buffer = session.buffer.slice(0, -1)
            emitData(sessionId, '\b \b')
          }
          continue
        }
        if (char === '\x03') {
          emitData(sessionId, '^C\r\n')
          session.buffer = ''
          emitData(sessionId, prompt(session))
          continue
        }
        session.buffer += char
        emitData(sessionId, char)
      }
      return Promise.resolve()
    },

    resize: (_sessionId: string, _size: TerminalSize) => Promise.resolve(),

    disconnect: (sessionId) => {
      const session = sessions.get(sessionId)
      if (!session || session.closed) return Promise.resolve()
      session.closed = true
      emitClosed({ sessionId, exitCode: null, signal: null, reason: 'user' })
      return Promise.resolve()
    },

    onData: (listener) => {
      dataListeners.add(listener)
      return () => dataListeners.delete(listener)
    },
    onState: (listener) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    onClosed: (listener) => {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    }
  }
}
