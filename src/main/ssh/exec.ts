import type { Client, ClientChannel } from 'ssh2'
import { SshError, normalizeSshError } from './errors'
import type { SshTimers } from './types'

/**
 * 一次性命令（exec 通道）。
 *
 * 谁在用它：AI 面板的「建议命令」执行、一键操作（重启服务、看磁盘、docker ps）、
 * 以及任何不需要交互式 PTY 的场景。刻意**不复用** shell 通道：
 * exec 的 stdout/stderr 是分离的（PTY 会把 stderr 合并进 stdout），
 * 而且 exec 有明确的 exit code，AI 才能判断「这条命令成功了没有」。
 *
 * 边界：输出有硬上限（默认 1MiB/流）。`cat 1GB.log` 经 AI 通道跑一次就能让主进程 OOM，
 * 这里必须截断并显式告诉调用方 `truncated`，绝不能悄悄只给一半。
 */

export interface ExecOptions {
  env?: Record<string, string>
  /** 超时后关闭通道并返回已收到的部分输出（timedOut=true），不抛错——调用方要能上报「超时」 */
  timeoutMs?: number
  /** 单流保留上限 */
  maxBytes?: number
  timers?: SshTimers
}

export interface ExecResult {
  command: string
  stdout: string
  stderr: string
  code: number | null
  signal: string | null
  /** 任一流被截断 */
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

const DEFAULT_MAX_BYTES = 1024 * 1024

interface Collector {
  chunks: Buffer[]
  bytes: number
  truncated: boolean
}

function createCollector(): Collector {
  return { chunks: [], bytes: 0, truncated: false }
}

function collect(collector: Collector, chunk: Buffer, maxBytes: number): void {
  if (collector.bytes >= maxBytes) {
    collector.truncated = true
    return
  }
  const room = maxBytes - collector.bytes
  const slice = chunk.length <= room ? chunk : chunk.subarray(0, room)
  collector.chunks.push(slice)
  collector.bytes += slice.length
  if (slice.length < chunk.length) collector.truncated = true
}

export function runCommand(
  client: Client,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const startedAt = Date.now()
  const stdout = createCollector()
  const stderr = createCollector()

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false
    let code: number | null = null
    let signal: string | null = null
    let timedOut = false
    let cancelTimer: (() => void) | null = null

    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      cancelTimer?.()
      if (error) {
        reject(error instanceof SshError ? error : normalizeSshError(error, { phase: 'exec' }, 'exec-failed'))
        return
      }
      resolve({
        command,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'),
        stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        code,
        signal,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    }

    client.exec(command, options.env ? { env: options.env } : {}, (error, channel: ClientChannel) => {
      if (error) {
        finish(error)
        return
      }
      channel.on('data', (chunk: Buffer) => collect(stdout, chunk, maxBytes))
      // stderr 是 channel 上的可读流（扩展数据），不是 'stderr' 事件
      channel.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, maxBytes))
      channel.on('exit', (exitCode: number | null, exitSignal: string | null) => {
        code = exitCode
        signal = exitSignal
      })
      channel.on('close', () => finish())
      channel.on('error', (streamError: Error) => finish(streamError))
      channel.stderr?.on('error', () => {
        /* stderr 流的错误不改变结果：真正的失败由 exit code 表达 */
      })

      if (options.timeoutMs && options.timeoutMs > 0) {
        const timer = options.timers ?? undefined
        const fire = (): void => {
          timedOut = true
          // 先触发关闭再 finish：让远端进程真的被终止，而不是只把本地 Promise 结束掉
          try {
            channel.close()
          } catch {
            /* 通道可能已经关了 */
          }
          finish()
        }
        if (timer) cancelTimer = timer.after(options.timeoutMs, fire)
        else {
          const handle = setTimeout(fire, options.timeoutMs)
          cancelTimer = () => clearTimeout(handle)
        }
      }
    })
  })
}
