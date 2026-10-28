import { describe, expect, it } from 'vitest'
import type { TerminalSize } from '@shared'
import { createTerminalPool } from './terminal-pool'
import type { RendererKind, TerminalFactory, TerminalHandle } from './types'

/**
 * 终端实例池单测：验证「切页签不重建、关页签真释放」。
 *
 * 这里用假工厂而不是真 xterm：单测跑在 node 环境（没有 DOM），
 * 而池的职责本来就只有「谁持有实例、什么时候 dispose」，跟渲染无关。
 */

interface FakeHandle extends TerminalHandle {
  disposedFlag: boolean
}

function createFakeFactory() {
  const created: FakeHandle[] = []
  const factory: TerminalFactory = ({ tabId }) => {
    const handle: FakeHandle = {
      tabId,
      disposedFlag: false,
      terminal: { write: () => {} } as unknown as TerminalHandle['terminal'],
      fit: {} as TerminalHandle['fit'],
      search: {} as TerminalHandle['search'],
      renderer: 'dom' as RendererKind,
      get disposed() {
        return handle.disposedFlag
      },
      size: (): TerminalSize => ({ cols: 80, rows: 24 }),
      propose: (): TerminalSize | null => ({ cols: 100, rows: 30 }),
      dispose: () => {
        handle.disposedFlag = true
      }
    }
    created.push(handle)
    return handle
  }
  return { factory, created }
}

describe('createTerminalPool', () => {
  it('同一个 tabId 重复 create 返回同一实例（React StrictMode 会双挂载）', () => {
    const { factory, created } = createFakeFactory()
    const pool = createTerminalPool({ factory })
    const first = pool.create('tab-1', null)
    const second = pool.create('tab-1', null)
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
    expect(pool.stats()).toEqual({ created: 1, disposed: 0, live: 1 })
  })

  it('不同页签拿到不同实例，切页签不重建（get 命中同一个）', () => {
    const { factory, created } = createFakeFactory()
    const pool = createTerminalPool({ factory })
    const a = pool.create('tab-1', null)
    pool.create('tab-2', null)
    expect(created).toHaveLength(2)
    // 模拟「切走再切回」：组件重渲染只会 get，不会 create
    expect(pool.get('tab-1')).toBe(a)
    expect(pool.get('tab-1')?.disposed).toBe(false)
  })

  it('dispose 会调用实例的 dispose 并把它从池里摘掉（统计可断言）', () => {
    const { factory, created } = createFakeFactory()
    const pool = createTerminalPool({ factory })
    pool.create('tab-1', null)
    expect(pool.dispose('tab-1')).toBe(true)
    expect(created[0]?.disposedFlag).toBe(true)
    expect(pool.get('tab-1')).toBeNull()
    expect(pool.has('tab-1')).toBe(false)
    expect(pool.stats()).toEqual({ created: 1, disposed: 1, live: 0 })
  })

  it('重复 dispose 不重复计数；dispose 未知页签返回 false', () => {
    const { factory } = createFakeFactory()
    const pool = createTerminalPool({ factory })
    pool.create('tab-1', null)
    expect(pool.dispose('tab-1')).toBe(true)
    expect(pool.dispose('tab-1')).toBe(false)
    expect(pool.dispose('nope')).toBe(false)
    expect(pool.stats().disposed).toBe(1)
  })

  it('disposeAll 清空（关窗口时不留实例）', () => {
    const { factory } = createFakeFactory()
    const pool = createTerminalPool({ factory })
    pool.create('tab-1', null)
    pool.create('tab-2', null)
    pool.create('tab-3', null)
    pool.disposeAll()
    expect(pool.size()).toBe(0)
    expect(pool.stats()).toEqual({ created: 3, disposed: 3, live: 0 })
  })

  it('实例 dispose 抛错不影响关页签流程，且计入已释放', () => {
    const errors: unknown[] = []
    const factory: TerminalFactory = ({ tabId }) => ({
      tabId,
      terminal: {} as unknown as TerminalHandle['terminal'],
      fit: {} as TerminalHandle['fit'],
      search: {} as TerminalHandle['search'],
      renderer: 'dom',
      disposed: false,
      size: () => ({ cols: 80, rows: 24 }),
      propose: () => null,
      dispose: () => {
        throw new Error('xterm 未 open 时 dispose 会抛')
      }
    })
    const pool = createTerminalPool({ factory, onError: (error) => errors.push(error) })
    pool.create('tab-1', null)
    expect(pool.dispose('tab-1')).toBe(true)
    expect(errors).toHaveLength(1)
    expect(pool.size()).toBe(0)
    expect(pool.stats().disposed).toBe(1)
  })

  it('已释放的实例再次 create 会重新建一个（不是复用死对象）', () => {
    const { factory, created } = createFakeFactory()
    const pool = createTerminalPool({ factory })
    pool.create('tab-1', null)
    pool.dispose('tab-1')
    const fresh = pool.create('tab-1', null)
    expect(created).toHaveLength(2)
    expect(fresh).not.toBe(created[0])
    expect(fresh.disposed).toBe(false)
  })
})
