import type { SshClosedEvent, SshConnectRequest, SshConnectResult, SshDataEvent, SshStateEvent, TerminalSize } from '@shared'
import { call, subscribe } from '@renderer/platform/ipc'
import type { TerminalTransport } from './types'

/**
 * 终端与主进程之间的**唯一出口**。
 *
 * 只走 shared 契约里登记的通道（`ssh:connect` / `ssh:input` / `ssh:resize` / `ssh:disconnect`
 * 与三个事件），所以 preload 白名单永远放行、也不会出现某个 feature 自己拼通道名。
 *
 * 第二层意义：这个对象可替换（`setTerminalTransport`）。dev/qa 在没有 SSH 服务时注入
 * `dev/mock-transport.ts` 的假传输，就能把整条 UI 链路跑起来——UI 代码完全不知道背后真假。
 */

export const ipcTerminalTransport: TerminalTransport = {
  kind: 'ipc',
  connect: (request: SshConnectRequest): Promise<SshConnectResult> => call('ssh:connect', request),
  write: (sessionId, data) => call('ssh:input', { sessionId, data }),
  resize: (sessionId, size: TerminalSize) => call('ssh:resize', { sessionId, size }),
  disconnect: (sessionId) => call('ssh:disconnect', { sessionId }),
  onData: (listener) => subscribe('ssh:data', (payload: SshDataEvent) => listener(payload)),
  onState: (listener) => subscribe('ssh:state-changed', (payload: SshStateEvent) => listener(payload)),
  onClosed: (listener) => subscribe('ssh:closed', (payload: SshClosedEvent) => listener(payload))
}

let current: TerminalTransport | null = null

/** 解析顺序：注入的 mock > 真实 IPC */
export function getTerminalTransport(): TerminalTransport {
  return current ?? ipcTerminalTransport
}

export function setTerminalTransport(transport: TerminalTransport | null): void {
  current = transport
}

export function resetTerminalTransport(): void {
  current = null
}
