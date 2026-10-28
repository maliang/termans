import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import type { Terminal } from '@xterm/xterm'
import type {
  SshClosedEvent,
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshStateEvent,
  TerminalSize
} from '@shared'

/**
 * 终端层的对外类型。
 *
 * 这里全是 `import type`：本文件被单测（node 环境）引用，运行时不能把 @xterm/* 拖进来
 * ——xterm 的模块体在 import 阶段就会摸 `document`，node 下直接抛错。真正的 xterm 运行时
 * 只出现在 `xterm-factory.ts` 一个文件里。
 */

export type RendererKind = 'webgl' | 'dom'

/**
 * 与主进程通信的唯一出口。
 *
 * 生产实现走 preload 白名单 IPC（`transport.ts`）；开发/UI 测试用 `dev/mock-transport.ts`
 * 换掉它，不必架 SSH 服务器。终端组件只认这个接口，不认识 IPC 通道名。
 */
export interface TerminalTransport {
  readonly kind: 'ipc' | 'mock'
  connect(request: SshConnectRequest): Promise<SshConnectResult>
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, size: TerminalSize): Promise<void>
  disconnect(sessionId: string): Promise<void>
  /** 返回取消订阅函数 */
  onData(listener: (event: SshDataEvent) => void): () => void
  onState(listener: (event: SshStateEvent) => void): () => void
  onClosed(listener: (event: SshClosedEvent) => void): () => void
}

/** 一个页签对应的终端实例（xterm + 三个 addon）；`dispose` 必须可重复调用 */
export interface TerminalHandle {
  tabId: string
  terminal: Terminal
  fit: FitAddon
  search: SearchAddon
  renderer: RendererKind
  readonly disposed: boolean
  /** 当前可用的行列（fit 还没跑过时是 xterm 的初始值） */
  size(): TerminalSize
  /** 已经 fit 过之后建议的行列；未挂载/尺寸为 0 时返回 null */
  propose(): TerminalSize | null
  dispose(): void
}

/** 注入给 pool 的「造终端」工厂（单测用假的替换，避免 import xterm） */
export type TerminalFactory = (options: { tabId: string; element: HTMLElement | null }) => TerminalHandle
