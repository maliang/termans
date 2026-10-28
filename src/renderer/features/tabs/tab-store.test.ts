import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findTab,
  hasActiveSession,
  requestCloseTab,
  subscribeTabEvents,
  useTabStore,
  type TabStatus,
  type TerminalTab
} from './tab-store'

/**
 * 页签生命周期单测。
 *
 * 这里的用例对应验收矩阵里的「tab 生命周期」：新建 → 激活 → 输出未读 → 关闭后谁接手激活 →
 * 什么时候要二次确认 → 重排 → 序号快捷键。全部是纯 store 逻辑，不碰 DOM/xterm。
 */

const store = (): ReturnType<typeof useTabStore.getState> => useTabStore.getState()

function openHostTab(label: string): string {
  return store().openTab({ hostId: 'host-1', hostLabel: label, origin: 'host' })
}

beforeEach(() => {
  store().reset()
})

describe('openTab', () => {
  it('新页签加入列表、成为激活页签，并按序号生成默认标题', () => {
    const first = openHostTab('prod-web')
    const second = store().openTab({ hostId: 'host-2', hostLabel: 'staging' })

    expect(store().tabs.map((tab) => tab.id)).toEqual([first, second])
    expect(store().activeTabId).toBe(second)
    expect(store().tabs[0].title).toBe('prod-web')
    expect(store().tabs[0].status).toBe('connecting')
    expect(store().tabs[1].seq).toBe(2)
  })

  it('没有主机时用 Terminal N 兜底，状态是 idle', () => {
    const id = store().openTab()
    const tab = findTab(store().tabs, id)
    expect(tab?.title).toBe('Terminal 1')
    expect(tab?.status).toBe('idle')
    expect(tab?.hostId).toBeNull()
  })
})

describe('closeTab 与激活接力', () => {
  it('关闭激活页签后由右侧邻居接手', () => {
    const first = openHostTab('a')
    const second = openHostTab('b')
    const third = openHostTab('c')
    store().activateTab(second)
    store().closeTab(second)
    expect(store().activeTabId).toBe(third)
    expect(store().tabs.map((tab) => tab.id)).toEqual([first, third])
  })

  it('关闭最右页签后由左侧邻居接手', () => {
    const first = openHostTab('a')
    const second = openHostTab('b')
    store().closeTab(second)
    expect(store().activeTabId).toBe(first)
  })

  it('关闭最后一个页签后 activeTabId 归空', () => {
    const only = openHostTab('a')
    const closed = store().closeTab(only)
    expect(closed?.id).toBe(only)
    expect(store().tabs).toHaveLength(0)
    expect(store().activeTabId).toBeNull()
  })

  it('关闭非激活页签不影响当前激活项', () => {
    const first = openHostTab('a')
    const second = openHostTab('b')
    store().closeTab(first)
    expect(store().activeTabId).toBe(second)
  })

  it('关闭不存在的页签返回 null 且不广播事件', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTabEvents(listener)
    expect(store().closeTab('tab-does-not-exist')).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe('未读标记', () => {
  it('非激活页签累计未读，激活后清零', () => {
    const first = openHostTab('a')
    const second = openHostTab('b')
    store().markOutput(first, 2)
    expect(findTab(store().tabs, first)?.unreadCount).toBe(2)
    store().activateTab(first)
    expect(findTab(store().tabs, first)?.unreadCount).toBe(0)
    // 激活页签自己的输出不计未读
    store().markOutput(first, 5)
    expect(findTab(store().tabs, first)?.unreadCount).toBe(0)
    expect(store().activeTabId).toBe(first)
    expect(second).not.toBe(first)
  })
})

describe('切换快捷键语义', () => {
  it('activateRelative 双向回绕', () => {
    const first = openHostTab('a')
    const second = openHostTab('b')
    openHostTab('c')
    store().activateTab(first)
    store().activateRelative(1)
    expect(store().activeTabId).toBe(second)
    store().activateRelative(-1)
    expect(store().activeTabId).toBe(first)
    store().activateRelative(-1)
    expect(store().activeTabId).toBe(store().tabs[2].id)
  })

  it('activateIndex 是 1 基，9 表示最后一个，越界不动', () => {
    const ids = [openHostTab('a'), openHostTab('b'), openHostTab('c')]
    store().activateIndex(1)
    expect(store().activeTabId).toBe(ids[0])
    store().activateIndex(9)
    expect(store().activeTabId).toBe(ids[2])
    store().activateIndex(7)
    expect(store().activeTabId).toBe(ids[2])
  })
})

describe('拖拽重排', () => {
  it('moveTab 按目标位插入并把越界值夹紧', () => {
    const ids = [openHostTab('a'), openHostTab('b'), openHostTab('c')]
    store().moveTab(ids[2], 0)
    expect(store().tabs.map((tab) => tab.id)).toEqual([ids[2], ids[0], ids[1]])
    store().moveTab(ids[2], 99)
    expect(store().tabs.map((tab) => tab.id)).toEqual([ids[0], ids[1], ids[2]])
  })
})

describe('关闭确认判定', () => {
  it('活跃会话默认要确认，关闭确认开关后直接关', () => {
    const id = openHostTab('prod')
    store().setStatus(id, 'connected', 'session-1')
    expect(requestCloseTab(id)).toMatchObject({ closed: false, reason: 'active-session' })
    expect(requestCloseTab(id, { confirmOnClose: false })).toMatchObject({ closed: true })
  })

  it('已断开/报错的页签不拦', () => {
    const id = openHostTab('prod')
    store().setStatus(id, 'closed')
    expect(requestCloseTab(id)).toMatchObject({ closed: true })
    store().setStatus(id, 'error')
    expect(requestCloseTab(id)).toMatchObject({ closed: true })
  })

  it('不存在的页签返回 not-found', () => {
    expect(requestCloseTab('nope')).toEqual({ closed: false, reason: 'not-found', tab: null })
  })

  it('hasActiveSession 只认连接中/已连接/重连中', () => {
    const cases: Array<[TabStatus, boolean]> = [
      ['idle', false],
      ['connecting', true],
      ['connected', true],
      ['reconnecting', true],
      ['closed', false],
      ['error', false]
    ]
    for (const [status, expected] of cases) {
      const tab = { status } as TerminalTab
      expect(hasActiveSession(tab)).toBe(expected)
    }
  })
})

describe('setStatus / setSessionId', () => {
  it('状态与会话 id 落到对应页签，不污染其它页签', () => {
    const first = openHostTab('a')
    const second = openHostTab('b')
    store().setStatus(first, 'connected', 'session-9')
    store().setSessionId(second, 'session-10')
    expect(findTab(store().tabs, first)).toMatchObject({ status: 'connected', sessionId: 'session-9' })
    expect(findTab(store().tabs, second)).toMatchObject({ status: 'connecting', sessionId: 'session-10' })
  })
})

describe('标签事件', () => {
  it('打开/激活/关闭都会广播，取消订阅后不再收到', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTabEvents(listener)
    const first = openHostTab('a')
    const second = openHostTab('b')
    store().activateTab(first)
    store().closeTab(first)
    expect(listener.mock.calls.map(([event]) => event.type)).toEqual([
      'opened',
      'opened',
      'activated', // activateTab(first) 切回第一个
      'closed',
      'activated' // 关闭后 second 接手激活
    ])
    unsubscribe()
    openHostTab('c')
    expect(listener).toHaveBeenCalledTimes(5)
    expect(second).toBeTruthy()
  })
})
