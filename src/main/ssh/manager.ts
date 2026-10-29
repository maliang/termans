import { randomUUID } from 'node:crypto'
import type {
  HostKeyChallenge,
  HostKeyDecision,
  SshConnectRequest,
  SshConnectResult,
  SshSession as SshSessionInfo,
  TerminalSize
} from '@shared'
import { SshError, asSshError } from './errors'
import { resolveJumpTarget } from './jump'
import { SshSession } from './session'
import { toSshTarget, type SshEngineDeps } from './types'

/**
 * 会话管理器 —— IPC 层唯一能看到的对象。
 *
 * 职责边界：
 * - 一条 `ConnectionId`（sessionId）对应一个 `SshSession`；同一主机允许并存多条（C-14 五窗口并发）；
 * - 主机密钥确认是**跨进程往返**的（主进程发挑战 → 渲染层弹窗 → answerHostKey 回来），
 *   manager 用 pending map 把这条异步链路接起来，并带超时兜底，避免会话永久卡在 verifying；
 * - 关闭会话时同时取消未决挑战，否则用户点「拒绝/断开」后 promise 永远悬着。
 */
export interface SshManagerOptions {
  deps: SshEngineDeps
}

interface PendingChallenge {
  challenge: HostKeyChallenge
  resolve: (decision: HostKeyDecision) => void
  cancelTimer: () => void
}

/** 用户不回答对话框时的兜底时长（默认 2 分钟；点关闭窗口也不能把主进程卡住） */
const DEFAULT_HOST_KEY_DECISION_TIMEOUT_MS = 120_000

export class SshManager {
  private readonly deps: SshEngineDeps
  private readonly sessions = new Map<string, SshSession>()
  private readonly pendingChallenges = new Map<string, PendingChallenge>()

  constructor(options: SshManagerOptions) {
    this.deps = options.deps
  }

  /**
   * 建立新会话。`reuseExisting` 只复用**已连上**的同主机会话（页签恢复场景），
   * 不会去复用正在连接/重连中的实例——那种复用在 UI 上表现为「点了没反应」。
   */
  async connect(request: SshConnectRequest): Promise<SshConnectResult> {
    const host = await this.deps.resolveHost(request.hostId)
    const target = toSshTarget(host)
    // 跳板机在连接前解析并校验（已删除 / 多级 / 同一台机器都在这里拒绝）。
    // jumpHostId 为 null 时这里返回 null，后续流程与加跳板前完全一致。
    const jump = await resolveJumpTarget(this.deps, host)

    if (request.reuseExisting) {
      const existing = this.findReadySessionByHost(target.hostId)
      if (existing) {
        existing.resize(request.size)
        return {
          sessionId: existing.sessionId,
          hostKeyFingerprint: existing.hostKeyFingerprint,
          hostKeyDecision: existing.hostKeyDecision
        }
      }
    }

    const sessionId = randomUUID()
    const session = new SshSession({
      sessionId,
      target,
      jump,
      size: request.size,
      startupCommand: request.startupCommand ?? null,
      deps: this.deps,
      requestHostKeyDecision: (challenge) => this.awaitHostKeyDecision(challenge),
      // 终态（远端退出 / 重连放弃 / 用户断开）后从列表中摘除：listSessions 必须是「活着的会话」，
      // 否则 UI 页签关闭后 SSH 列表里还挂着一个点不动的死会话。
      onClosed: (closedId) => {
        this.sessions.delete(closedId)
        this.cancelChallenge(closedId, true)
      }
    })
    this.sessions.set(sessionId, session)

    try {
      await session.open()
    } catch (error) {
      this.sessions.delete(sessionId)
      this.cancelChallenge(sessionId)
      throw asSshError(error)
    }

    return {
      sessionId,
      hostKeyFingerprint: session.hostKeyFingerprint,
      hostKeyDecision: session.hostKeyDecision
    }
  }

  write(sessionId: string, data: string): void {
    this.requireSession(sessionId).write(data)
  }

  resize(sessionId: string, size: TerminalSize): void {
    this.requireSession(sessionId).resize(size)
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return // 幂等：断开已关闭的会话不算错误
    this.cancelChallenge(sessionId)
    await session.close()
    session.dispose()
    this.sessions.delete(sessionId)
  }

  listSessions(): { sessions: SshSessionInfo[] } {
    const sessions = [...this.sessions.values()]
      .filter((session) => session.phase !== 'closed' && session.phase !== 'idle')
      .map((session) => session.toInfo())
    return { sessions }
  }

  /** 渲染层回传用户决定。没有待决挑战 = 用户点了过期弹窗（或渲染层重放），幂等忽略 */
  answerHostKey(decision: HostKeyDecision): void {
    const pending = this.pendingChallenges.get(decision.sessionId)
    if (!pending) {
      throw new SshError('session-not-found', `No pending host key challenge for session ${decision.sessionId}`, {
        details: { sessionId: decision.sessionId }
      })
    }
    this.pendingChallenges.delete(decision.sessionId)
    pending.cancelTimer()
    pending.resolve(decision)
  }

  /** 供 AI / 一键命令等内部调用方取会话（不经 IPC）；不存在时返回 undefined 而不是抛 */
  getSession(sessionId: string): SshSession | undefined {
    return this.sessions.get(sessionId)
  }

  get sessionCount(): number {
    return this.sessions.size
  }

  hasPendingChallenge(sessionId: string): boolean {
    return this.pendingChallenges.has(sessionId)
  }

  /**
   * 清掉所有存活会话里缓存的凭据副本（组合根在 vault 上锁时调用）。
   *
   * **不断开任何连接**：这是 captain 在 2026-10-29 的产品裁定——锁屏可能由 15 分钟空闲
   * 自动触发，而用户可能正在跑长任务；已建连的通道用的是 ssh2 内部协商的密钥，
   * 与本处的明文副本无关。真正要防的是「锁屏后内存里还留着别人的口令」。
   *
   * 返回被清理的会话数（只用于日志，不涉及任何凭据内容）。
   */
  releaseCredentials(): number {
    let cleared = 0
    for (const session of this.sessions.values()) {
      session.clearCachedSecrets()
      cleared += 1
    }
    return cleared
  }

  disposeAll(): void {
    for (const sessionId of [...this.pendingChallenges.keys()]) this.cancelChallenge(sessionId, true)
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }

  /* --------------------------------------------------------------- 内部 */

  private requireSession(sessionId: string): SshSession {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new SshError('session-not-found', `Unknown SSH session: ${sessionId}`, {
        details: { sessionId }
      })
    }
    return session
  }

  private findReadySessionByHost(hostId: string): SshSession | null {
    for (const session of this.sessions.values()) {
      if (session.target.hostId === hostId && session.isReady) return session
    }
    return null
  }

  /**
   * 发挑战事件并等待 answerHostKey。超时/断开都走 reject，
   * 让 `applyHostKeyPolicy` 得到明确的「未确认」而不是永远 pending。
   */
  private awaitHostKeyDecision(challenge: HostKeyChallenge): Promise<HostKeyDecision> {
    const existing = this.pendingChallenges.get(challenge.sessionId)
    if (existing) {
      // 重连时同一会话可能再次挑战（例如上一轮用户没答），以最新挑战为准
      existing.cancelTimer()
      this.pendingChallenges.delete(challenge.sessionId)
    }

    return new Promise<HostKeyDecision>((resolve, reject) => {
      const timeoutMs = this.deps.hostKeyDecisionTimeoutMs ?? DEFAULT_HOST_KEY_DECISION_TIMEOUT_MS
      const timer = this.deps.timers?.after(timeoutMs, () => onTimeout()) ?? defaultAfter(timeoutMs, () => onTimeout())

      const finish = (): void => {
        timer()
        this.pendingChallenges.delete(challenge.sessionId)
      }

      const onTimeout = (): void => {
        finish()
        reject(
          new SshError(
            'host-key-unverified',
            `Timed out after ${timeoutMs}ms waiting for host key confirmation`,
            {
              details: {
                host: challenge.host,
                port: challenge.port,
                keyType: challenge.keyType,
                fingerprintSha256: challenge.fingerprintSha256,
                reason: 'timeout'
              }
            }
          )
        )
      }

      this.pendingChallenges.set(challenge.sessionId, {
        challenge,
        resolve: (decision) => {
          timer()
          resolve(decision)
        },
        cancelTimer: () => {
          timer()
        }
      })

      this.deps.emit('ssh:host-key-challenge', challenge)
    })
  }

  /** 会话被关闭/拒绝时清掉挑战，防止 promise 悬挂 */
  private cancelChallenge(sessionId: string, silent = false): void {
    const pending = this.pendingChallenges.get(sessionId)
    if (!pending) return
    this.pendingChallenges.delete(sessionId)
    pending.cancelTimer()
    if (!silent) {
      pending.resolve({ sessionId, decision: 'reject', remember: false })
    }
  }
}

function defaultAfter(ms: number, fn: () => void): () => void {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}
