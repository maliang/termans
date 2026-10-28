import { describe, expect, it } from 'vitest'
import type { TerminalSize } from '@shared'
import { createResizeCoordinator, isValidSize, MAX_TERMINAL_DIMENSION, sizesEqual } from './resize'

/**
 * resize 传播单测（验收矩阵里的「resize 传播」）。
 *
 * 关键点：定时器注入 —— 单测不睡真实时间，也不该依赖 jsdom 的 requestAnimationFrame。
 */

function createHarness(initial: TerminalSize | null) {
  let measured = initial
  const sent: TerminalSize[] = []
  const scheduled: Array<{ callback: () => void; handle: number }> = []
  let nextHandle = 1
  const errors: unknown[] = []

  const coordinator = createResizeCoordinator({
    fit: () => measured,
    send: (size) => sent.push(size),
    schedule: (callback) => {
      const handle = nextHandle++
      scheduled.push({ callback, handle })
      return handle
    },
    cancel: (handle) => {
      const index = scheduled.findIndex((item) => item.handle === handle)
      if (index >= 0) scheduled.splice(index, 1)
    },
    onError: (error) => errors.push(error)
  })

  const runPending = (): void => {
    const pending = [...scheduled]
    scheduled.length = 0
    for (const item of pending) item.callback()
  }

  return {
    coordinator,
    sent,
    errors,
    runPending,
    pendingCount: () => scheduled.length,
    setMeasured: (size: TerminalSize | null) => {
      measured = size
    }
  }
}

describe('isValidSize / sizesEqual', () => {
  it('过滤 0/1 与超界尺寸（契约要求 cols/rows ∈ [2,1000]）', () => {
    expect(isValidSize({ cols: 80, rows: 24 })).toBe(true)
    expect(isValidSize({ cols: 1, rows: 24 })).toBe(false)
    expect(isValidSize({ cols: 80, rows: 0 })).toBe(false)
    expect(isValidSize({ cols: 80.5, rows: 24 })).toBe(false)
    expect(isValidSize({ cols: MAX_TERMINAL_DIMENSION + 1, rows: 24 })).toBe(false)
    expect(isValidSize(null)).toBe(false)
  })

  it('sizesEqual 把「两个都空」当相等', () => {
    expect(sizesEqual(null, null)).toBe(true)
    expect(sizesEqual({ cols: 1, rows: 1 }, null)).toBe(false)
    expect(sizesEqual({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true)
    expect(sizesEqual({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe(false)
  })
})

describe('createResizeCoordinator', () => {
  it('连续 request 只排一个定时器（合并）', () => {
    const harness = createHarness({ cols: 100, rows: 30 })
    harness.coordinator.request()
    harness.coordinator.request()
    harness.coordinator.request()
    expect(harness.pendingCount()).toBe(1)
    expect(harness.coordinator.isPending()).toBe(true)
    harness.runPending()
    expect(harness.sent).toEqual([{ cols: 100, rows: 30 }])
    expect(harness.coordinator.isPending()).toBe(false)
  })

  it('尺寸没变时不重复下发（避免远端反复重画）', () => {
    const harness = createHarness({ cols: 100, rows: 30 })
    harness.coordinator.flush()
    harness.coordinator.flush()
    expect(harness.sent).toHaveLength(1)
    harness.setMeasured({ cols: 120, rows: 40 })
    harness.coordinator.flush()
    expect(harness.sent).toEqual([
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 }
    ])
  })

  it('量不出尺寸（页签隐藏时 fit 返回 null）就不下发', () => {
    const harness = createHarness(null)
    harness.coordinator.flush()
    expect(harness.sent).toHaveLength(0)
    harness.setMeasured({ cols: 1, rows: 0 })
    harness.coordinator.flush()
    expect(harness.sent).toHaveLength(0)
  })

  it('flush 会取消已排队的定时器并立即结算', () => {
    const harness = createHarness({ cols: 90, rows: 20 })
    harness.coordinator.request()
    expect(harness.pendingCount()).toBe(1)
    harness.coordinator.flush()
    expect(harness.pendingCount()).toBe(0)
    expect(harness.sent).toEqual([{ cols: 90, rows: 20 }])
  })

  it('fit 抛错走 onError，不把异常抛给 ResizeObserver', () => {
    const errors: unknown[] = []
    const coordinator = createResizeCoordinator({
      fit: () => {
        throw new Error('容器尚未布局')
      },
      send: () => {
        throw new Error('不该调用')
      },
      onError: (error) => errors.push(error)
    })
    expect(() => coordinator.flush()).not.toThrow()
    expect(errors).toHaveLength(1)
  })

  it('send 抛错也不影响后续 resize', () => {
    const sent: TerminalSize[] = []
    let throwOnce = true
    const errors: unknown[] = []
    const coordinator = createResizeCoordinator({
      fit: () => ({ cols: 80 + sent.length, rows: 24 }),
      send: (size) => {
        if (throwOnce) {
          throwOnce = false
          throw new Error('IPC 失败')
        }
        sent.push(size)
      },
      onError: (error) => errors.push(error)
    })
    coordinator.flush()
    coordinator.flush()
    expect(errors).toHaveLength(1)
    expect(sent).toEqual([{ cols: 80, rows: 24 }])
  })

  it('dispose 之后不再下发，并取消挂起的定时器', () => {
    const harness = createHarness({ cols: 100, rows: 30 })
    harness.coordinator.request()
    harness.coordinator.dispose()
    // dispose 必须真的撤掉挂起的定时器，否则窗口拖完还会发一次 resize
    expect(harness.pendingCount()).toBe(0)
    harness.coordinator.flush()
    harness.runPending()
    expect(harness.sent).toHaveLength(0)
  })
})
