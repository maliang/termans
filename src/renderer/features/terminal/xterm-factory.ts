import { Terminal } from '@xterm/xterm'
import type { ITerminalAddon, ITerminalOptions } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSize } from '@shared'
import { registerXterm } from '@renderer/theme'
import type { RendererKind, TerminalHandle } from './types'
import { attachRenderer, type RendererAttachment } from './renderers/webgl'
import { isValidSize } from './resize'

/**
 * 真实 xterm 实例的唯一构造点。
 *
 * 这是**整个 feature 里唯一**允许静态 import `@xterm/*` 运行时的文件：
 * 单测跑在 node 环境（没有 DOM，也没装 jsdom），任何被测试 import 到的模块
 * 只要在顶层碰 @xterm 就会在 import 期炸。所以纯逻辑都在别处，只有这里碰真货。
 */

export interface XtermHandleOptions {
  tabId: string
  /** 挂载容器；null = 先建实例后挂载（组件重挂载时复用同一实例） */
  element: HTMLElement | null
  options: ITerminalOptions
  /** 链接点击：默认交给系统浏览器，绝不 navigate 当前窗口 */
  onLink?: (uri: string) => void
  /** WebGL 装载失败 / context lost 时回调，用来更新 UI 上的渲染器标记 */
  onRendererChange?: (kind: RendererKind) => void
  /** 关掉 WebGL（排障/测试用） */
  webgl?: boolean
}

export function createXtermHandle(input: XtermHandleOptions): TerminalHandle {
  const terminal = new Terminal(input.options)
  const fit = new FitAddon()
  const search = new SearchAddon()
  terminal.loadAddon(fit)
  terminal.loadAddon(search)
  if (input.onLink) {
    terminal.loadAddon(new WebLinksAddon((_event, uri) => input.onLink?.(uri)))
  }

  // 主题联动**只走**主题模块的注册表：它监听 documentElement 的 style/data-theme，
  // 切主题时给每个已注册终端重设 options.theme（换新对象）+ refresh，不重建实例。
  // 这里不要再自己挂 MutationObserver，两套并存会双写、切主题时闪一次旧配色。
  const unregisterTheme = registerXterm(terminal)

  let renderer: RendererKind = 'dom'
  let attachment: RendererAttachment | null = null
  let disposed = false
  let mounted = false

  if (input.element) {
    terminal.open(input.element)
    mounted = true
    if (input.webgl !== false) {
      attachment = attachRenderer(
        { loadAddon: (addon) => terminal.loadAddon(addon as unknown as ITerminalAddon) },
        () => new WebglAddon(),
        () => {
          renderer = 'dom'
          input.onRendererChange?.('dom')
        }
      )
      renderer = attachment.kind
    }
    input.onRendererChange?.(renderer)
    // 首帧布局可能还没稳定；这里尽力而为，真正的尺寸由 ResizeObserver 收敛
    try {
      fit.fit()
    } catch {
      /* 容器 0 尺寸时 fit 会抛，忽略：等 resize 再来 */
    }
  }

  const size = (): TerminalSize => ({ cols: terminal.cols, rows: terminal.rows })

  const propose = (): TerminalSize | null => {
    const element = input.element
    if (!element || !mounted) return null
    if (element.clientWidth < 1 || element.clientHeight < 1) return null
    try {
      const dims = fit.proposeDimensions()
      if (!dims) return null
      const candidate: TerminalSize = { cols: Math.floor(dims.cols), rows: Math.floor(dims.rows) }
      return isValidSize(candidate) ? candidate : null
    } catch {
      return null
    }
  }

  return {
    tabId: input.tabId,
    terminal,
    fit,
    search,
    get renderer() {
      return attachment ? attachment.kind : renderer
    },
    get disposed() {
      return disposed
    },
    size,
    propose,
    dispose: () => {
      if (disposed) return
      disposed = true
      unregisterTheme()
      attachment?.dispose()
      attachment = null
      try {
        terminal.dispose()
      } catch {
        /* xterm 在未 open 时 dispose 偶发抛错，不影响后续流程 */
      }
    }
  }
}
