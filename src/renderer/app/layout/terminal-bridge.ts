import type { SshClosedEvent, SshDataEvent } from '@shared'
import type { TerminalSnapshot } from '@renderer/features/ai/store'
import type { TerminalTab } from '@renderer/features/tabs/tab-store'
import { useTabStore } from '@renderer/features/tabs/tab-store'
import { getTerminalTransport } from '@renderer/features/terminal/transport'
import type { TerminalTransport } from '@renderer/features/terminal/types'

/**
 * 终端 ↔ 应用外壳的桥（t7 接线）。
 *
 * 只做两件事，都贴着「不改 features/**」这条边界：
 *
 * 1. **抓最近输出**。AI 面板要「当前页签最近 N 行」当上下文（`AiPanelProps.getContext`），
 *    但 `features/terminal` 并没有对外暴露缓冲读取 API（`interface.ts` 里那句
 *    `terminalApi.snapshot(...)` 只是注释里的设想）。所以在 transport 这一层旁路记录：
 *    数据本身就流经 `onData`，抄一份尾部字符即可，不需要碰 xterm 实例。
 * 2. **把 AI 产出的命令写回终端**（`AiPanelProps.runCommand` → `ssh:input`）。
 *
 * 为什么不订阅主进程事件自己攒一份：`onData` 有且只有一份订阅者语义（`subscribe()` 返回取消
 * 函数），再订阅一次就等于同一条 `ssh:data` 被处理两遍；而且 mock transport（dev/qa）也要能
 * 被同样地记录下来。包装 `getTerminalTransport()` 让两条路径共用一份实现。
 */

/** 每个会话保留的最大字符数。40k 足够覆盖 600 行宽终端，也不会把内存吃穿 */
const MAX_CHARS_PER_SESSION = 40_000

/** 默认给 AI 的上下文长度（行数少时不补齐；主进程侧还会再按 settings.ai.contextLines 截断） */
const DEFAULT_SNAPSHOT_CHARS = 12_000

const buffers = new Map<string, string>()

function append(sessionId: string, data: string): void {
  const previous = buffers.get(sessionId) ?? ''
  const merged = previous + data
  buffers.set(
    sessionId,
    merged.length > MAX_CHARS_PER_SESSION ? merged.slice(merged.length - MAX_CHARS_PER_SESSION) : merged
  )
  // 断开的会话不必永久占内存：页签关闭/会话关闭都会走到 forget
  if (buffers.size > 32) {
    const oldest = buffers.keys().next()
    if (!oldest.done && oldest.value !== sessionId) buffers.delete(oldest.value)
  }
}

function forget(sessionId: string): void {
  buffers.delete(sessionId)
}

/** 某会话最近 `maxChars` 个字符（含 ANSI；主进程注入前会清洗） */
export function recentOutput(sessionId: string | null | undefined, maxChars = DEFAULT_SNAPSHOT_CHARS): string {
  if (!sessionId) return ''
  const buffer = buffers.get(sessionId)
  if (!buffer) return ''
  if (maxChars <= 0) return ''
  return maxChars >= buffer.length ? buffer : buffer.slice(buffer.length - maxChars)
}

/** 当前页签的终端快照；没有会话时返回 null（面板据此禁用「带上下文发送」） */
export function terminalSnapshot(
  tab: TerminalTab | null | undefined,
  maxChars = DEFAULT_SNAPSHOT_CHARS
): TerminalSnapshot | null {
  if (!tab?.sessionId) return null
  return {
    sessionId: tab.sessionId,
    hostLabel: tab.hostLabel ?? tab.title,
    cwd: null,
    os: null,
    recentOutput: recentOutput(tab.sessionId, maxChars)
  }
}

/** 取**当前激活页签**的快照（AI 面板每次发送时现取，不缓存过期上下文） */
export function activeTerminalSnapshot(maxChars = DEFAULT_SNAPSHOT_CHARS): TerminalSnapshot | null {
  const { tabs, activeTabId } = useTabStore.getState()
  return terminalSnapshot(tabs.find((tab) => tab.id === activeTabId) ?? null, maxChars)
}

/** 当前激活页签是否有活着的会话 */
export function hasActiveSession(): boolean {
  const { tabs, activeTabId } = useTabStore.getState()
  const tab = tabs.find((candidate) => candidate.id === activeTabId)
  return Boolean(tab?.sessionId) && tab?.status !== 'closed' && tab?.status !== 'error'
}

/** 把一行命令写进终端（AI 命令卡二次确认后才允许走到这里） */
export async function writeCommand(command: string, sessionId: string | null): Promise<void> {
  if (!sessionId) {
    const { tabs, activeTabId } = useTabStore.getState()
    const fallback = tabs.find((tab) => tab.id === activeTabId)?.sessionId
    if (!fallback) throw new Error('没有可写入的终端会话')
    sessionId = fallback
  }
  // 回车必须单独发：有些 SSH 服务器把「一整行 + \r」当粘贴而不是执行
  await getTerminalTransport().write(sessionId, command)
  await getTerminalTransport().write(sessionId, '\r')
}

let captureTransport: TerminalTransport | null = null

/**
 * 包一层 transport：`TerminalWorkspace` 用它，于是所有输出都会经过 `append()`。
 *
 * `kind` 固定写 `'ipc'`：mock transport 由 `setTerminalTransport()` 在**内层**替换，
 * 这里只是旁边多记一份，不参与真假判断。
 */
export function getCaptureTransport(): TerminalTransport {
  if (captureTransport) return captureTransport
  const transport: TerminalTransport = {
    kind: 'ipc',
    connect: (request) => getTerminalTransport().connect(request),
    write: (sessionId, data) => getTerminalTransport().write(sessionId, data),
    resize: (sessionId, size) => getTerminalTransport().resize(sessionId, size),
    disconnect: (sessionId) => getTerminalTransport().disconnect(sessionId),
    onData: (listener) =>
      getTerminalTransport().onData((event: SshDataEvent) => {
        append(event.sessionId, event.data)
        listener(event)
      }),
    onState: (listener) => getTerminalTransport().onState(listener),
    onClosed: (listener) =>
      getTerminalTransport().onClosed((event: SshClosedEvent) => {
        // 会话结束就丢缓冲：锁屏/断开之后不该还能从内存里捞出上次的输出
        forget(event.sessionId)
        listener(event)
      })
  }
  captureTransport = transport
  return transport
}
