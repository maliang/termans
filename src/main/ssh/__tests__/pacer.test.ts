import { describe, expect, it } from 'vitest'
import { OutputPacer } from '../pacer'

/**
 * 输出整形/背压。
 *
 * 用注入的 schedule 把 tick 变成可控队列，断言的是「每帧多大」「一个 tick 推多少」
 * 这些能杀变异的值；不依赖真实计时器，所以不会 flaky。
 */

function manualScheduler(): {
  schedule: (fn: () => void) => void
  /** 跑一个 tick（tick 内可能又排一个） */
  flushOne: () => void
  /** 跑到队列空 */
  flush: () => void
} {
  const queue: Array<() => void> = []
  return {
    schedule: (fn) => queue.push(fn),
    flushOne: () => {
      queue.shift()?.()
    },
    flush: () => {
      while (queue.length > 0) queue.shift()!()
    }
  }
}

function collect(): { chunks: string[]; text: () => string } {
  const chunks: string[] = []
  return { chunks, text: () => chunks.join('') }
}

describe('OutputPacer：切片', () => {
  it('单帧不超过 maxChunkBytes（32KB 输入被切成多帧，而不是一帧塞进 IPC）', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({ onData: (chunk) => sink.chunks.push(chunk), schedule })

    const payload = 'x'.repeat(32 * 1024)
    pacer.push(Buffer.from(payload))
    flush()

    expect(sink.chunks.length).toBeGreaterThan(1)
    expect(pacer.stats.maxFrameBytes).toBeLessThanOrEqual(8 * 1024)
    expect(sink.chunks.every((chunk) => Buffer.byteLength(chunk) <= 8 * 1024)).toBe(true)
    expect(sink.text()).toBe(payload)
  })

  it('每个 tick 最多推 maxBytesPerTick，剩余留给下一个 tick（避免一个 tick 卡住渲染进程）', () => {
    const { schedule, flush, flushOne } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({
      onData: (chunk) => sink.chunks.push(chunk),
      schedule,
      maxChunkBytes: 1024,
      maxBytesPerTick: 4 * 1024
    })

    pacer.push(Buffer.alloc(10 * 1024, 97))
    flushOne() // 一个 tick 只应推 4KB
    const afterOneTick = pacer.stats.pendingBytes
    expect(afterOneTick).toBe(6 * 1024)
    expect(sink.text().length).toBe(4 * 1024)

    flush()
    flush()
    expect(pacer.stats.pendingBytes).toBe(0)
    expect(sink.text().length).toBe(10 * 1024)
  })

  it('自定义 maxChunkBytes 生效（默认值不是硬编码）', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({ onData: (chunk) => sink.chunks.push(chunk), schedule, maxChunkBytes: 100 })

    pacer.push(Buffer.alloc(500, 98))
    flush()
    expect(sink.chunks.every((chunk) => Buffer.byteLength(chunk) <= 100)).toBe(true)
    expect(sink.text().length).toBe(500)
  })
})

describe('OutputPacer：背压', () => {
  it('超过 highWaterMark 立刻 pause，降到 lowWaterMark 后 resume（各一次）', () => {
    const steps: Array<() => void> = []
    const sink = collect()
    let pauses = 0
    let resumes = 0
    const pacer = new OutputPacer({
      onData: (chunk) => sink.chunks.push(chunk),
      schedule: (fn) => steps.push(fn),
      maxChunkBytes: 1024,
      maxBytesPerTick: 1024,
      highWaterMark: 4 * 1024,
      lowWaterMark: 1024,
      onPause: () => {
        pauses += 1
      },
      onResume: () => {
        resumes += 1
      }
    })
    const tick = (): void => {
      const fn = steps.shift()
      fn?.()
    }

    pacer.push(Buffer.alloc(3 * 1024, 99))
    expect(pacer.stats.paused).toBe(false) // 还没到高水位

    pacer.push(Buffer.alloc(2 * 1024, 100))
    expect(pacer.stats.paused).toBe(true)
    expect(pauses).toBe(1)

    // 每个 tick 推 1KB：pending 4KB → 3 → 2 → 1（到低水位才 resume）
    tick()
    expect(pacer.stats.pendingBytes).toBe(4 * 1024)
    expect(pacer.stats.paused).toBe(true)
    tick()
    tick()
    expect(pacer.stats.pendingBytes).toBe(2 * 1024)
    expect(resumes).toBe(0)
    tick()
    tick()
    expect(pacer.stats.pendingBytes).toBe(0)
    expect(pacer.stats.paused).toBe(false)
    expect(resumes).toBe(1)
    expect(pauses).toBe(1) // 只 pause 一次（重复 pause 会导致上游被 pause 两次、却只 resume 一次）
  })

  it('end() 把剩余全部吐出并 resume（通道关闭不能丢尾巴）', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    let resumed = 0
    const pacer = new OutputPacer({
      onData: (chunk) => sink.chunks.push(chunk),
      schedule,
      maxChunkBytes: 1024,
      maxBytesPerTick: 1024,
      highWaterMark: 2 * 1024,
      lowWaterMark: 1 * 1024,
      onResume: () => {
        resumed += 1
      }
    })

    pacer.push(Buffer.alloc(8 * 1024, 65))
    expect(pacer.stats.paused).toBe(true)
    flush()
    pacer.end()

    expect(pacer.stats.pendingBytes).toBe(0)
    expect(sink.text().length).toBe(8 * 1024)
    expect(resumed).toBe(1)
  })
})

describe('OutputPacer：UTF-8 边界', () => {
  it('4 字节 emoji 被逐字节推送时仍然是完整字符（不出现 U+FFFD）', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({ onData: (chunk) => sink.chunks.push(chunk), schedule })

    const bytes = Buffer.from('😀', 'utf8')
    expect(bytes.length).toBe(4)
    for (const byte of bytes) {
      pacer.push(Buffer.from([byte]))
      flush()
    }
    pacer.end()

    expect(sink.text()).toBe('😀')
    expect(sink.text()).not.toContain('\uFFFD')
  })

  it('中文跨帧边界同样完整', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({ onData: (chunk) => sink.chunks.push(chunk), schedule })

    const bytes = Buffer.from('你好世界', 'utf8')
    for (let offset = 0; offset < bytes.length; offset += 2) {
      pacer.push(bytes.subarray(offset, offset + 2))
      flush()
    }
    pacer.end()
    expect(sink.text()).toBe('你好世界')
  })

  it('空 chunk 被忽略（不产生空帧）', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({ onData: (chunk) => sink.chunks.push(chunk), schedule })
    pacer.push(Buffer.alloc(0))
    flush()
    expect(sink.chunks).toHaveLength(0)
  })

  it('dispose 之后不再下发（会话关闭后不能继续往 IPC 写）', () => {
    const { schedule, flush } = manualScheduler()
    const sink = collect()
    const pacer = new OutputPacer({ onData: (chunk) => sink.chunks.push(chunk), schedule })
    pacer.push(Buffer.from('before'))
    flush()
    pacer.dispose()
    pacer.push(Buffer.from('after'))
    flush()
    expect(sink.text()).toBe('before')
  })
})
