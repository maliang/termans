import { useEffect, useRef, useState } from 'react'
import { findTab, useTabStore } from '../tabs/tab-store'
import { writeClipboardText } from './paste'
import { createResizeCoordinator } from './resize'
import { useSessionStore } from './session-store'
import { useTerminalRuntime, useTerminalUi } from './runtime-context'

/**
 * 一个页签的终端面板。
 *
 * 关键取舍：
 * 1. **所有页签都保持挂载**，非激活的用 `hidden` 藏起来。卸载会丢 scrollback，
 *    而「切回上一个页签还能看到刚才的输出」是终端的基本预期。
 * 2. 隐藏时容器是 0 尺寸，`fit` 会算不出尺寸——所以尺寸逻辑全部走 ResizeObserver，
 *    显示回来时它自己会触发一次收敛。
 * 3. xterm 实例由 runtime 的池持有，本组件只负责「挂到 DOM 上 + 接事件」，
 *    卸载时把池里的实例 dispose 掉（关页签 = 真释放）。
 */

export interface XtermSurfaceProps {
  tabId: string
  active: boolean
}

export function XtermSurface({ tabId, active }: XtermSurfaceProps) {
  const runtime = useTerminalRuntime()
  const ui = useTerminalUi()
  const containerRef = useRef<HTMLDivElement>(null)
  const [themeVersion, setThemeVersion] = useState(() => runtime.themeVersion())
  const [bellFlash, setBellFlash] = useState(false)
  const bellTimer = useRef<number | null>(null)

  // 页签级字号覆盖（缩放）与全局设置变化都要重新应用；订阅一个值即可触发重渲染
  const fontSizeOverride = useSessionStore((state) => state.byTab[tabId]?.fontSize ?? null)
  const tabStatus = useTabStore((state) => findTab(state.tabs, tabId)?.status ?? 'idle')

  useEffect(() => runtime.subscribeTheme(() => setThemeVersion(runtime.themeVersion())), [runtime])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const handle = runtime.createHandle(tabId, element)
    const sessionStore = useSessionStore.getState()
    sessionStore.ensure(tabId, { renderer: handle.renderer })

    const subscriptions = [
      handle.terminal.onData((data) => runtime.controller.sendInput(tabId, data)),
      handle.terminal.onBell(() => {
        if (runtime.settings().bellStyle === 'none') return
        setBellFlash(true)
        if (bellTimer.current !== null) window.clearTimeout(bellTimer.current)
        bellTimer.current = window.setTimeout(() => setBellFlash(false), 140)
      })
    ]

    // 选中即复制：用 mouseup 而不是 onSelectionChange —— 拖动过程中会触发几十次，
    // 每次都写剪贴板既慢又会把用户原本的剪贴板内容覆盖成半截文本
    const onMouseUp = (): void => {
      if (!runtime.settings().copyOnSelect) return
      const text = handle.terminal.getSelection()
      if (text) void writeClipboardText(text)
    }
    element.addEventListener('mouseup', onMouseUp)

    // 右键 = 粘贴（终端里右键菜单没有意义，Termius 也是这个约定）
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault()
      void ui.requestPaste(tabId)
    }
    element.addEventListener('contextmenu', onContextMenu)

    // resize：合并 + 只在尺寸真变时才发（拖动窗口会连续触发几十次）
    const coordinator = createResizeCoordinator({
      fit: () => handle.propose(),
      send: (size) => runtime.controller.sendResize(tabId, size)
    })
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => coordinator.request()) : null
    observer?.observe(element)
    const onWindowResize = (): void => coordinator.request()
    window.addEventListener('resize', onWindowResize)

    // 首帧布局稳定后再 fit，然后才发起连接：否则握手用的是默认 80x24，
    // 远端 shell 会按错误宽度折行，用户看到的是一屏乱行
    const raf = window.requestAnimationFrame(() => {
      coordinator.flush()
      const tab = findTab(useTabStore.getState().tabs, tabId)
      if (tab?.hostId && !tab.sessionId) void runtime.controller.connectTab(tabId)
    })

    return () => {
      window.cancelAnimationFrame(raf)
      if (bellTimer.current !== null) window.clearTimeout(bellTimer.current)
      window.removeEventListener('resize', onWindowResize)
      observer?.disconnect()
      coordinator.dispose()
      element.removeEventListener('mouseup', onMouseUp)
      element.removeEventListener('contextmenu', onContextMenu)
      for (const subscription of subscriptions) subscription.dispose()
      runtime.pool.dispose(tabId)
    }
    // 只随页签/runtime 变化重建；设置变化走下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, tabId])

  // 设置 / 主题 / 字号变化：作用到已存在的终端，然后重新 fit 并补发 resize
  useEffect(() => {
    runtime.applySettingsTo(tabId)
    const handle = runtime.handle(tabId)
    if (active && handle) {
      try {
        handle.fit.fit()
        const size = handle.size()
        runtime.controller.sendResize(tabId, size)
      } catch {
        /* 隐藏状态下 fit 会抛，切回来时 ResizeObserver 兜底 */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, tabId, themeVersion, fontSizeOverride, active])

  // 切到这个页签：把焦点交给终端，用户立刻可以打字
  useEffect(() => {
    if (!active) return
    const handle = runtime.handle(tabId)
    if (!handle) return
    handle.fit.fit()
    handle.terminal.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, runtime, tabId])

  return (
    <div
      className={`ts-term-surface${bellFlash ? ' ts-term-surface--bell' : ''}`}
      data-testid={`terminal-surface-${tabId}`}
      data-status={tabStatus}
      hidden={!active}
    >
      <div className="ts-term-surface__canvas" ref={containerRef} data-testid={`xterm-${tabId}`} />
    </div>
  )
}
