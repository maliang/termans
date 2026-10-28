import type { TerminalFactory, TerminalHandle } from './types'

/**
 * 终端实例池：`tabId → TerminalHandle` 的**唯一**持有者。
 *
 * 为什么要有池，而不是让每个 React 组件自己 new 一个 Terminal：
 * 1. 切页签不能重建终端——重建就会丢 scrollback。组件可以卸载重挂（隐藏/显示），
 *    实例必须活在这里；
 * 2. 关页签必须真 dispose，否则 xterm 的 canvas/滚动 DOM 与 addon 监听器会泄漏。
 *    把「有没有 dispose」变成一个可断言的计数（stats），泄漏就能写成单测；
 * 3. 测试环境没有 DOM——工厂是注入的，单测塞一个假工厂即可。
 */

export interface TerminalPoolStats {
  /** 累计创建数 */
  created: number
  /** 累计释放数 */
  disposed: number
  /** 当前存活数（应恒等于 created - disposed） */
  live: number
}

export interface TerminalPool {
  /** 同一个 tabId 重复调用返回同一个实例（React StrictMode 会双挂载） */
  create: (tabId: string, element: HTMLElement | null, factory?: TerminalFactory) => TerminalHandle
  get: (tabId: string) => TerminalHandle | null
  has: (tabId: string) => boolean
  list: () => TerminalHandle[]
  size: () => number
  dispose: (tabId: string) => boolean
  disposeAll: () => void
  stats: () => TerminalPoolStats
}

export interface TerminalPoolOptions {
  factory: TerminalFactory
  /** dispose 抛错不应打断关页签流程 */
  onError?: (error: unknown, tabId: string) => void
}

export function createTerminalPool(options: TerminalPoolOptions): TerminalPool {
  const handles = new Map<string, TerminalHandle>()
  let created = 0
  let disposed = 0

  const create: TerminalPool['create'] = (tabId, element, factory) => {
    const existing = handles.get(tabId)
    if (existing && !existing.disposed) return existing
    if (existing) handles.delete(tabId)
    const handle = (factory ?? options.factory)({ tabId, element })
    handles.set(tabId, handle)
    created += 1
    return handle
  }

  const dispose = (tabId: string): boolean => {
    const handle = handles.get(tabId)
    if (!handle) return false
    handles.delete(tabId)
    try {
      handle.dispose()
    } catch (error) {
      options.onError?.(error, tabId)
    }
    disposed += 1
    return true
  }

  return {
    create,
    get: (tabId) => {
      const handle = handles.get(tabId)
      return handle && !handle.disposed ? handle : null
    },
    has: (tabId) => Boolean(handles.get(tabId)),
    list: () => [...handles.values()],
    size: () => handles.size,
    dispose,
    disposeAll: () => {
      for (const tabId of [...handles.keys()]) dispose(tabId)
    },
    stats: () => ({ created, disposed, live: handles.size })
  }
}
