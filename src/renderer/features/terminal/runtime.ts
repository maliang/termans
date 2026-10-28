import type { Settings, TerminalSettings, TerminalSize } from '@shared'
import type { ISearchOptions } from '@xterm/addon-search'
import { call } from '@renderer/platform/ipc'
import { getXtermTheme } from '@renderer/theme'
import type { TerminalFactory, TerminalHandle, TerminalTransport } from './types'
import { createTerminalPool, type TerminalPool } from './terminal-pool'
import { createXtermHandle } from './xterm-factory'
import { createSessionController, type SessionController } from './session-controller'
import { getTerminalTransport } from './transport'
import { useSessionStore } from './session-store'
import { inspectPaste, normalizeNewlines, readClipboardText, writeClipboardText, type PasteInspection } from './paste'
import {
  buildTerminalOptions,
  clampFontSize,
  createCssVariableReader,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  hexOr,
  nextFontSize,
  resolveFontFamily
} from './xterm-options'
import { isValidSize } from './resize'

/**
 * 终端运行时：把池、控制器、设置、主题绑成一个对象，由 `TerminalWorkspace` 创建一次、
 * 通过 React context 发给子树。
 *
 * 为什么要有这一层：设置与主题变化要**作用到已存在的终端**（改字号、改 ANSI 配色），
 * 而终端实例又不能在 React state 里。集中在这里，组件只需要「拿 runtime 调方法」。
 */

export type ZoomDirection = 1 | -1 | 0

export interface TerminalRuntime {
  readonly transport: TerminalTransport
  readonly pool: TerminalPool
  readonly controller: SessionController
  settings: () => TerminalSettings
  setSettings: (next: TerminalSettings) => void
  /** CSS 变量（主题）变化计数；组件据此重建 xterm 主题 */
  themeVersion: () => number
  subscribeTheme: (listener: () => void) => () => void
  /** 立即重读 CSS 变量并通知（主题切换后手动调用更保险） */
  refreshTheme: () => void
  createHandle: (tabId: string, element: HTMLElement | null) => TerminalHandle
  handle: (tabId: string) => TerminalHandle | null
  /** 该页签实际生效字号（页签级覆盖 > 全局设置） */
  effectiveFontSize: (tabId: string) => number
  zoom: (tabId: string | null, direction: ZoomDirection) => number
  applySettingsTo: (tabId: string) => void
  clear: (tabId: string | null) => void
  copyAll: (tabId: string | null) => Promise<boolean>
  paste: (tabId: string | null, text: string) => void
  requestPaste: (tabId: string | null) => Promise<PasteInspection | null>
  readClipboard: () => Promise<string>
  search: (tabId: string | null, term: string, direction?: 'next' | 'prev') => boolean
  dispose: () => void
}

export interface CreateTerminalRuntimeOptions {
  settings: TerminalSettings
  transport?: TerminalTransport
  /** 关掉 WebGL（排障 / e2e 里的软件渲染） */
  webgl?: boolean
  onError?: (error: unknown) => void
}

export function createTerminalRuntime(options: CreateTerminalRuntimeOptions): TerminalRuntime {
  const transport = options.transport ?? getTerminalTransport()
  let settings = options.settings
  const readVar = createCssVariableReader()

  let themeVersion = 0
  const themeListeners = new Set<() => void>()
  const bumpTheme = (): void => {
    themeVersion += 1
    for (const listener of [...themeListeners]) listener()
  }

  const factory: TerminalFactory = (input) =>
    createXtermHandle({
      tabId: input.tabId,
      element: input.element,
      options: buildTerminalOptions(settings, {
        fontFamily: resolveFontFamily(settings.fontFamily, readVar),
        theme: getXtermTheme(),
        allowProposedApi: true
      }),
      webgl: options.webgl,
      onLink: (uri) => {
        void call('app:open-external', { url: uri }).catch(() => {
          /* 打开外链失败不打断终端 */
        })
      },
      onRendererChange: (kind) => useSessionStore.getState().setRenderer(input.tabId, kind)
    })

  const pool = createTerminalPool({
    factory,
    onError: (error) => options.onError?.(error)
  })
  const controller = createSessionController({ transport, pool })

  const effectiveFontSize = (tabId: string): number => {
    const override = useSessionStore.getState().byTab[tabId]?.fontSize ?? null
    return clampFontSize(override ?? settings.fontSize)
  }

  const applySettingsTo = (tabId: string): void => {
    const handle = pool.get(tabId)
    if (!handle) return
    handle.terminal.options.fontFamily = resolveFontFamily(settings.fontFamily, readVar)
    handle.terminal.options.fontSize = effectiveFontSize(tabId)
    handle.terminal.options.lineHeight = settings.lineHeight
    handle.terminal.options.cursorStyle = settings.cursorStyle
    handle.terminal.options.cursorBlink = settings.cursorBlink
    handle.terminal.options.scrollback = settings.scrollback
  }

  /** 改字号后容器尺寸没变，ResizeObserver 不会触发——必须主动 fit + 补发 resize */
  const refit = (tabId: string): void => {
    const handle = pool.get(tabId)
    if (!handle) return
    try {
      handle.fit.fit()
    } catch {
      /* 容器不可见（display:none）时 fit 会抛，等切回来再收敛 */
      return
    }
    const size = handle.size()
    if (isValidSize(size)) controller.sendResize(tabId, size)
  }

  const zoom = (tabId: string | null, direction: ZoomDirection): number => {
    if (!tabId) return settings.fontSize
    const current = effectiveFontSize(tabId)
    const next =
      direction === 0 ? clampFontSize(settings.fontSize) : clampFontSize(nextFontSize(current, direction))
    const store = useSessionStore.getState()
    store.ensure(tabId)
    store.setFontSize(tabId, next === clampFontSize(settings.fontSize) ? null : next)
    applySettingsTo(tabId)
    refit(tabId)
    return next
  }

  const resolveHandle = (tabId: string | null): TerminalHandle | null => (tabId ? pool.get(tabId) : null)

  const clear = (tabId: string | null): void => {
    const handle = resolveHandle(tabId)
    if (!handle) return
    handle.terminal.clear()
  }

  const copyAll = async (tabId: string | null): Promise<boolean> => {
    const handle = resolveHandle(tabId)
    if (!handle) return false
    handle.terminal.selectAll()
    const text = handle.terminal.getSelection()
    handle.terminal.clearSelection()
    if (!text) return false
    return writeClipboardText(text)
  }

  const paste = (tabId: string | null, text: string): void => {
    const handle = resolveHandle(tabId)
    if (!handle || !text) return
    // 统一成 \n：终端的 paste 会走 onData → ssh:input，原样 \r 会在 shell 里重复执行
    handle.terminal.paste(normalizeNewlines(text))
  }

  const requestPaste = async (tabId: string | null): Promise<PasteInspection | null> => {
    if (!tabId) return null
    const text = await readClipboardText()
    if (!text) return null
    return inspectPaste(text)
  }

  /**
   * 搜索必须带 `decorations`：addon 的 `onDidChangeResults` 只在带装饰时才 fire
   * （`SearchResultTracker.fireResultsChanged(withDecoration)` 第一行就是 `if (!withDecoration) return`），
   * 不带的话搜索框永远显示 0/0——不是没命中，是根本没收到计数。
   * 装饰色只认 `#RRGGBB`（addon 的注释明确要求），所以 token 不是六位十六进制时退回内置色。
   */
  const searchOptions = (): ISearchOptions => ({
    decorations: {
      matchBackground: hexOr(readVar('--ts-accent'), '#2f6fd0'),
      activeMatchBackground: hexOr(readVar('--ts-status-warn'), '#c98a1b'),
      matchOverviewRuler: hexOr(readVar('--ts-accent-strong'), '#2f6fd0'),
      activeMatchColorOverviewRuler: hexOr(readVar('--ts-status-warn'), '#c98a1b')
    }
  })

  const search = (tabId: string | null, term: string, direction: 'next' | 'prev' = 'next'): boolean => {
    const handle = resolveHandle(tabId)
    if (!handle || !term) {
      handle?.search.clearDecorations()
      return false
    }
    const options = searchOptions()
    return direction === 'prev'
      ? handle.search.findPrevious(term, options)
      : handle.search.findNext(term, options)
  }

  return {
    transport,
    pool,
    controller,
    settings: () => settings,
    setSettings: (next) => {
      settings = next
      bumpTheme()
    },
    themeVersion: () => themeVersion,
    subscribeTheme: (listener) => {
      themeListeners.add(listener)
      return () => themeListeners.delete(listener)
    },
    refreshTheme: bumpTheme,
    createHandle: (tabId, element) => pool.create(tabId, element),
    handle: (tabId) => pool.get(tabId),
    effectiveFontSize,
    zoom,
    applySettingsTo,
    clear,
    copyAll,
    paste,
    requestPaste,
    readClipboard: readClipboardText,
    search,
    dispose: () => {
      themeListeners.clear()
      controller.dispose()
      pool.disposeAll()
    }
  }
}

/** 便捷函数：从 Settings 里取终端设置 */
export function terminalSettingsOf(settings: Settings): TerminalSettings {
  return settings.terminal
}

/** 尺寸兜底：组件 hide 状态下拿到 0 尺寸时用它 */
export function safeSize(size: TerminalSize | null | undefined): TerminalSize {
  return size && isValidSize(size) ? size : { cols: 80, rows: 24 }
}

export { FONT_SIZE_MAX, FONT_SIZE_MIN }
