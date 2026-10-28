import type { RendererKind } from '../types'

/**
 * WebGL 渲染的装载与**回退**。
 *
 * 现实约束（这条踩过）：WebGL2 上下文在三种情况下会没有——GPU 黑名单、远程桌面/虚拟机、
 * 以及驱动重启导致的 context lost。xterm 的 DOM 渲染永远能用，只是慢。
 * 所以策略是：优先 WebGL，装载失败或中途丢失就原地退回 DOM，**终端本身不重开**
 * （重开会丢 scrollback，也会把正在输入的命令打断）。
 *
 * 这里只认结构不管具体包：`WebglAddon` 的实际类型由调用方（xterm-factory）静态 import 传入，
 * 单测可以塞一个假 addon，不需要真的 GPU。
 */

export interface WebglAddonLike {
  onContextLoss: (listener: () => void) => { dispose: () => void }
  dispose: () => void
  clearTextureAtlas?: () => void
}

export interface RendererAttachment {
  /** 当前实际生效的渲染器；context lost 之后会变成 'dom' */
  readonly kind: RendererKind
  dispose: () => void
}

export interface RenderTargetLike {
  loadAddon: (addon: WebglAddonLike) => void
}

export function attachRenderer(
  terminal: RenderTargetLike,
  loadWebgl: (() => WebglAddonLike) | null,
  onFallback?: (error: unknown) => void
): RendererAttachment {
  if (!loadWebgl) return { kind: 'dom', dispose: () => {} }

  let kind: RendererKind = 'webgl'
  let attached: WebglAddonLike | null = null

  try {
    const addon = loadWebgl()
    // 类型上是 ITerminalAddon；传结构体给 loadAddon 的签名由真实 addon 满足
    terminal.loadAddon(addon)
    attached = addon
  } catch (error) {
    onFallback?.(error)
    return { kind: 'dom', dispose: () => {} }
  }

  const addon = attached
  const lossSub = addon.onContextLoss(() => {
    // 上下文丢失：addon 自己已经没用，退回 DOM；此刻还在屏幕上的内容由 xterm 核心重绘
    kind = 'dom'
    try {
      addon.dispose()
    } catch {
      /* 丢失后 dispose 抛错是已知行为，忽略 */
    }
    onFallback?.(new Error('webgl context lost'))
  })

  let disposed = false
  return {
    get kind() {
      return kind
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      lossSub.dispose()
      try {
        addon.dispose()
      } catch {
        /* 已经因 context loss 释放过 */
      }
    }
  }
}
