import type { Client, ClientChannel } from 'ssh2'
import type { HostRecord } from '@shared'
import { SshError, asSshError } from './errors'
import { toSshTarget, type SshEngineDeps, type SshTarget } from './types'

/**
 * 单层 ProxyJump（跳板机）。
 *
 * 为什么需要这一层：HostRecord 早就有 `jumpHostId`，UI 也给了输入框，ssh_config 导入导出
 * 都会经过它——但连接时若没人读这个字段，用户填了跳板机、连上去仍是直连，属于「静默无操作」，
 * 比不提供字段更糟：用户以为自己在走跳板，实际在裸连目标机（或被防火墙挡住后反复重试）。
 *
 * 本期只实现**一层**：
 *   客户端 ──SSH──> 跳板机 ──direct-tcpip──> 目标机
 *
 * 实现要点：
 * 1. 跳板机本身也是一个正常的 SSH 目标（有自己的 host key、凭据、keepalive），
 *    所以它复用 `SshSession` 的探测/校验/认证三件套，而不是另写一套 socket 握手；
 * 2. 目标机的 TCP 流来自跳板机上的 `forwardOut()`，后续用 `new Client().connect({ sock })`，
 *    PTY / pacer / 重连 / keepalive 全部沿用直连路径——直连时 sock 为 undefined，代码路径不分裂；
 * 3. 多级跳板、同一台机器、已被删除的跳板机，都必须在**连接前**明确拒绝：
 *    静默降级成直连或只跳一层却当成功，都会把「连不上」变成难以定位的怪现象。
 */

/** 引擎内部的端点描述。错误消息里点名角色，用户才分得清是哪一跳出了问题 */
export interface SshEndpoint {
  /** 消息主语：`host "prod-db"` / `jump host "bastion"` */
  role: string
  hostname: string
  port: number
  /** 这一跳的登录名（探测连接也要用对应用户名，否则部分 sshd 会在握手前就拒绝） */
  username: string
}

export function targetEndpoint(target: SshTarget): SshEndpoint {
  return { role: `host "${target.label}"`, hostname: target.hostname, port: target.port, username: target.username }
}

export function jumpEndpoint(jump: SshTarget): SshEndpoint {
  return { role: `jump host "${jump.label}"`, hostname: jump.hostname, port: jump.port, username: jump.username }
}

/** known_hosts 按 host:port 定位；同一会话里「只信任一次」也要按端点分开记 */
export function endpointKey(endpoint: SshEndpoint): string {
  return `${endpoint.hostname}:${endpoint.port}`
}

/**
 * 给任意错误补上「这是跳板机的问题」这层语义。
 *
 * 不做这一步的话，跳板机凭据缺失会报成 `No password stored for host bastion`（看着还行），
 * 但私钥缺失/认证失败/超时这些消息里只有 host:port —— 用户会去改目标机的设置。
 * 错误码保持不变（渲染层仍按 code 分支），只是把 message 与 details 点名到跳板机。
 */
export function withJumpContext(error: unknown, jump: SshTarget): SshError {
  const sshError = asSshError(error)
  const prefix = `Jump host "${jump.label}" (${jump.hostname}:${jump.port}): `
  if (sshError.message.startsWith(prefix)) return sshError
  return new SshError(sshError.code, `${prefix}${sshError.message}`, {
    hint: sshError.hint,
    details: { ...sshError.details, jumpHostId: jump.hostId, jumpLabel: jump.label },
    cause: (sshError as { cause?: unknown }).cause
  })
}

/**
 * 连接前解析跳板机。返回 null 表示这台主机就是直连。
 *
 * 三条拒绝路径都在这里收敛成明确的 SshError，绝不放行：
 * - jumpHostId 指向已删除的主机 → jump-not-found（点名目标主机，告诉用户去改设置）；
 * - 跳板机自己也配了跳板 → jump-unsupported（本期只支持一层，不静默忽略第二层）；
 * - 跳板机与目标机是同一台 → jump-invalid（否则等于自己连自己，只会超时）。
 */
export async function resolveJumpTarget(
  deps: Pick<SshEngineDeps, 'resolveHost'>,
  host: HostRecord
): Promise<SshTarget | null> {
  const jumpHostId = host.jumpHostId
  if (!jumpHostId) return null

  if (jumpHostId === host.id) {
    throw new SshError('jump-invalid', `Host "${host.label}" cannot use itself as its jump host`, {
      details: { hostId: host.id, hostLabel: host.label, jumpHostId }
    })
  }

  let jumpRecord: HostRecord
  try {
    jumpRecord = await deps.resolveHost(jumpHostId)
  } catch (error) {
    throw new SshError('jump-not-found', `The jump host of "${host.label}" no longer exists (id ${jumpHostId})`, {
      details: { hostId: host.id, hostLabel: host.label, jumpHostId },
      cause: error
    })
  }

  if (jumpRecord.id === host.id) {
    throw new SshError('jump-invalid', `Host "${host.label}" cannot use itself as its jump host`, {
      details: { hostId: host.id, hostLabel: host.label, jumpHostId: jumpRecord.id }
    })
  }

  if (jumpRecord.hostname === host.hostname && jumpRecord.port === host.port) {
    throw new SshError(
      'jump-invalid',
      `Jump host "${jumpRecord.label}" is the same machine as "${host.label}" (${host.hostname}:${host.port})`,
      {
        details: {
          hostId: host.id,
          hostLabel: host.label,
          jumpHostId: jumpRecord.id,
          jumpLabel: jumpRecord.label,
          hostname: host.hostname,
          port: host.port
        }
      }
    )
  }

  if (jumpRecord.jumpHostId !== null) {
    throw new SshError(
      'jump-unsupported',
      `Multi-level jump is not supported yet: "${host.label}" → "${jumpRecord.label}" → one more hop`,
      {
        details: {
          hostId: host.id,
          hostLabel: host.label,
          jumpHostId: jumpRecord.id,
          jumpLabel: jumpRecord.label,
          secondJumpHostId: jumpRecord.jumpHostId
        }
      }
    )
  }

  return toSshTarget(jumpRecord)
}

export interface OpenTunnelOptions {
  timeoutMs: number
  /** 定时器注入（测试用假定时器）；缺省 setTimeout */
  after?: (ms: number, fn: () => void) => () => void
}

/**
 * 在跳板机上开一条 direct-tcpip 通道，直通目标机的 sshd。
 *
 * `srcIP/srcPort` 用 127.0.0.1/0（「不关心来源」的通行写法）：真实客户端不会伪造源地址，
 * 用 0 让服务端自己填，避免某些 sshd 因为源地址不在本机网段而拒绝。
 */
export function openJumpTunnel(
  jumpClient: Client,
  jump: SshTarget,
  target: SshTarget,
  options: OpenTunnelOptions
): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    let settled = false
    const cancel = (options.after ?? defaultAfter)(options.timeoutMs, () => {
      if (settled) return
      settled = true
      reject(
        new SshError(
          'jump-failed',
          `Timed out after ${options.timeoutMs}ms opening a tunnel on jump host "${jump.label}" to ${target.hostname}:${target.port}`,
          {
            details: {
              jumpHostId: jump.hostId,
              jumpLabel: jump.label,
              host: target.hostname,
              port: target.port,
              timeoutMs: options.timeoutMs
            }
          }
        )
      )
    })

    jumpClient.forwardOut('127.0.0.1', 0, target.hostname, target.port, (error, channel) => {
      if (settled) {
        // 超时之后到达的通道要主动关掉，否则跳板机上挂着一条没人用的通道
        try {
          channel?.close()
        } catch {
          /* 已关闭 */
        }
        return
      }
      settled = true
      cancel()
      if (error) {
        reject(
          new SshError(
            'jump-failed',
            `Jump host "${jump.label}" could not open a tunnel to ${target.hostname}:${target.port}: ${error.message}`,
            {
              details: {
                jumpHostId: jump.hostId,
                jumpLabel: jump.label,
                host: target.hostname,
                port: target.port
              },
              cause: error
            }
          )
        )
        return
      }
      resolve(channel)
    })
  })
}

function defaultAfter(ms: number, fn: () => void): () => void {
  const handle = setTimeout(fn, ms)
  return () => clearTimeout(handle)
}
