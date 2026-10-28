import { StringDecoder } from 'node:string_decoder'

/**
 * 输出整形 + 背压。
 *
 * 为什么不能直接把 ssh2 的 'data' 原样丢给 IPC：
 * 1. `cat 10MB.log` 会让 ssh2 在一个 data 事件里交出 32KB 甚至更大的 Buffer。
 *    `webContents.send` 是结构化克隆 + 反序列化，单帧越大越容易造成渲染进程卡顿（长任务），
 *    xterm 的 write 也要一次性吃掉整块文本。切片成 ≤8KB 的帧让渲染层能按帧让出事件循环。
 * 2. 主进程不能无限缓冲：远端比渲染层快时（本地回环、`yes`、`tail -f` 高频日志），
 *    pending 会持续增长直到 OOM。因此超过 highWaterMark 就 `pause()` 上游 Channel，
 *    降到 lowWaterMark 再 `resume()`——ssh2 的 Channel 是 Duplex，pause 之后 SSH 窗口不再上调，
 *    远端真正的写入会被 TCP 反压住，这才叫端到端背压。
 * 3. UTF-8 必须在字节边界之外缓冲：一个 4 字节 emoji 被切成 1 字节推送时，
 *    朴素 `chunk.toString('utf8')` 会吐出 U+FFFD，终端里显示成 `<?>`。
 *    StringDecoder 会跨帧保留不完整的多字节序列，因此这里解码是「流式」的。
 */

export interface PacerStats {
  /** 已下发的帧数 */
  frames: number
  /** 单帧最大字节数（测试用它证明切片生效） */
  maxFrameBytes: number
  /** 当前是否处于背压暂停状态 */
  paused: boolean
  /** 尚未下发的字节数 */
  pendingBytes: number
}

export interface OutputPacerOptions {
  /** 单帧上限 */
  maxChunkBytes?: number
  /** 每个 tick 最多下发多少字节（避免一个 tick 把积压全推出去） */
  maxBytesPerTick?: number
  /** 超过它就 pause 上游 */
  highWaterMark?: number
  /** 降到它就 resume 上游 */
  lowWaterMark?: number
  onData: (chunk: string) => void
  onPause?: () => void
  onResume?: () => void
  /** 调度下一个 tick；默认 setImmediate（不占微任务队列，渲染进程有时间处理 IPC） */
  schedule?: (fn: () => void) => void
}

const DEFAULTS = {
  maxChunkBytes: 8 * 1024,
  maxBytesPerTick: 64 * 1024,
  highWaterMark: 256 * 1024,
  lowWaterMark: 64 * 1024
}

export class OutputPacer {
  private readonly options: Required<Omit<OutputPacerOptions, 'onPause' | 'onResume' | 'onData' | 'schedule'>> &
    Pick<OutputPacerOptions, 'onData' | 'onPause' | 'onResume'> & { schedule: (fn: () => void) => void }

  private readonly decoder = new StringDecoder('utf8')
  private pending: Buffer[] = []
  private pendingBytes = 0
  private scheduled = false
  private paused = false
  private disposed = false
  private frameCount = 0
  private largestFrame = 0

  constructor(options: OutputPacerOptions) {
    this.options = {
      maxChunkBytes: options.maxChunkBytes ?? DEFAULTS.maxChunkBytes,
      maxBytesPerTick: options.maxBytesPerTick ?? DEFAULTS.maxBytesPerTick,
      highWaterMark: options.highWaterMark ?? DEFAULTS.highWaterMark,
      lowWaterMark: options.lowWaterMark ?? DEFAULTS.lowWaterMark,
      onData: options.onData,
      onPause: options.onPause,
      onResume: options.onResume,
      schedule: options.schedule ?? ((fn) => setImmediate(fn))
    }
  }

  /** 上游（ssh2 Channel）有数据就调它 */
  push(chunk: Buffer): void {
    if (this.disposed || chunk.length === 0) return
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (!this.paused && this.pendingBytes >= this.options.highWaterMark) {
      this.paused = true
      this.options.onPause?.()
    }
    this.scheduleFlush()
  }

  /** 通道关闭时调用：把剩下的全部吐出去（含解码器里可能挂着的半个字符） */
  end(): void {
    if (this.disposed) return
    this.drainAll()
    this.disposed = true
    const tail = this.decoder.end()
    if (tail.length > 0) this.emit(tail, Buffer.byteLength(tail))
  }

  dispose(): void {
    this.disposed = true
    this.pending = []
    this.pendingBytes = 0
    this.paused = false
  }

  get stats(): PacerStats {
    return {
      frames: this.frameCount,
      maxFrameBytes: this.largestFrame,
      paused: this.paused,
      pendingBytes: this.pendingBytes
    }
  }

  private scheduleFlush(): void {
    if (this.scheduled || this.disposed) return
    this.scheduled = true
    this.options.schedule(() => {
      this.scheduled = false
      this.drainOnce()
    })
  }

  /** 一个 tick 最多 maxBytesPerTick，切片 ≤maxChunkBytes */
  private drainOnce(): void {
    if (this.disposed) return
    let budget = this.options.maxBytesPerTick
    while (this.pending.length > 0 && budget > 0) {
      const head = this.pending[0]
      const take = Math.min(head.length, budget, this.options.maxChunkBytes)
      const slice = take === head.length ? head : head.subarray(0, take)
      if (take === head.length) this.pending.shift()
      else this.pending[0] = head.subarray(take)
      this.pendingBytes -= take
      budget -= take
      this.write(slice)
    }
    this.afterDrain()
  }

  private drainAll(): void {
    while (this.pending.length > 0) {
      const head = this.pending.shift() as Buffer
      this.pendingBytes -= head.length
      let offset = 0
      while (offset < head.length) {
        const end = Math.min(offset + this.options.maxChunkBytes, head.length)
        this.write(head.subarray(offset, end))
        offset = end
      }
    }
    this.pendingBytes = 0
    if (this.paused) {
      this.paused = false
      this.options.onResume?.()
    }
  }

  private write(slice: Buffer): void {
    const text = this.decoder.write(slice)
    if (text.length === 0) return
    this.frameCount += 1
    if (slice.length > this.largestFrame) this.largestFrame = slice.length
    this.options.onData(text)
  }

  private emit(text: string, bytes: number): void {
    this.frameCount += 1
    if (bytes > this.largestFrame) this.largestFrame = bytes
    this.options.onData(text)
  }

  private afterDrain(): void {
    if (this.pending.length > 0) {
      this.scheduleFlush()
      return
    }
    if (this.paused && this.pendingBytes <= this.options.lowWaterMark) {
      this.paused = false
      this.options.onResume?.()
    }
  }
}
