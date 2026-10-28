import type { TerminalSize } from '@shared'

/**
 * resize 传播器。
 *
 * 为什么需要它（而不是在 ResizeObserver 里直接发 ssh:resize）：
 * - ResizeObserver 会连发多次（拖窗口一帧一次），每次一个 IPC = 主进程pty 一直 ioctl；
 * - fit 出来的尺寸经常和上次一样，重复下发会让远端 shell 重画提示符（看起来像在闪）；
 * - 尺寸算出来可能是 0/1 行（面板折叠、页签隐藏时），契约要求 cols/rows ≥ 2，发出去会被 zod 拒。
 *
 * 所以：**合并 + 去重 + 过滤非法值**，并且定时器可注入（单测用假 schedule，不睡真实时间）。
 */

export const MIN_TERMINAL_DIMENSION = 2
export const MAX_TERMINAL_DIMENSION = 1_000

export function isValidSize(size: TerminalSize | null | undefined): size is TerminalSize {
  if (!size) return false
  const { cols, rows } = size
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= MIN_TERMINAL_DIMENSION &&
    cols <= MAX_TERMINAL_DIMENSION &&
    rows >= MIN_TERMINAL_DIMENSION &&
    rows <= MAX_TERMINAL_DIMENSION
  )
}

export function sizesEqual(left: TerminalSize | null, right: TerminalSize | null): boolean {
  if (!left || !right) return left === right
  return left.cols === right.cols && left.rows === right.rows
}

export interface ResizeCoordinatorOptions {
  /** 量当前可用行列（通常 = FitAddon.proposeDimensions）；量不出来返回 null */
  fit(): TerminalSize | null
  /** 真正下发（ssh:resize）；抛错由调用方吞掉，不影响后续 resize */
  send(size: TerminalSize): void
  debounceMs?: number
  schedule?(callback: () => void, delayMs: number): number
  cancel?(handle: number): void
  onError?(error: unknown): void
}

export interface ResizeCoordinator {
  /** 请求一次 resize（会被合并/防抖）；尺寸没变则不发 */
  request(): void
  /** 立刻结算一次（切页签、字体变化后要马上校正，不能等下一个防抖窗口） */
  flush(): void
  lastSize(): TerminalSize | null
  isPending(): boolean
  dispose(): void
}

const DEFAULT_DEBOUNCE_MS = 40

export function createResizeCoordinator(options: ResizeCoordinatorOptions): ResizeCoordinator {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const schedule =
    options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs) as unknown as number)
  const cancel = options.cancel ?? ((handle: number) => clearTimeout(handle))

  let pendingHandle: number | null = null
  let lastSize: TerminalSize | null = null
  let disposed = false

  const settle = (): void => {
    pendingHandle = null
    if (disposed) return
    let measured: TerminalSize | null = null
    try {
      measured = options.fit()
    } catch (error) {
      options.onError?.(error)
      return
    }
    if (!isValidSize(measured)) return
    if (sizesEqual(measured, lastSize)) return
    try {
      options.send(measured)
    } catch (error) {
      // 下发失败就别记 lastSize：远端其实没收到新尺寸，下次 resize 还要再试
      options.onError?.(error)
      return
    }
    lastSize = measured
  }

  return {
    request(): void {
      if (disposed || pendingHandle !== null) return
      pendingHandle = schedule(settle, debounceMs)
    },
    flush(): void {
      if (disposed) return
      if (pendingHandle !== null) {
        cancel(pendingHandle)
        pendingHandle = null
      }
      settle()
    },
    lastSize: () => lastSize,
    isPending: () => pendingHandle !== null,
    dispose(): void {
      disposed = true
      if (pendingHandle !== null) {
        cancel(pendingHandle)
        pendingHandle = null
      }
    }
  }
}
