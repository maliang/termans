import { createContext, useContext } from 'react'
import type { TerminalRuntime, ZoomDirection } from './runtime'

/**
 * React 侧的两层上下文：
 * - `TerminalRuntimeContext`：无 React 依赖的编排水管（池 / 控制器 / 设置 / 主题）；
 * - `TerminalUiContext`：需要 React 状态的动作（搜索条、粘贴确认弹窗、字号缩放）。
 *
 * 拆两层的原因：右键粘贴「要不要确认」取决于剪贴板内容，这是渲染层的 UI 决定，
 * 不该塞进 runtime；而 runtime 又要能在没有 React 的地方被单测调用。
 */

export const TerminalRuntimeContext = createContext<TerminalRuntime | null>(null)

export function useTerminalRuntime(): TerminalRuntime {
  const runtime = useContext(TerminalRuntimeContext)
  if (!runtime) throw new Error('useTerminalRuntime 必须在 <TerminalWorkspace> 内部使用')
  return runtime
}

export interface TerminalUiActions {
  openSearch: () => void
  closeSearch: () => void
  /** 读剪贴板 → 多行则弹确认，否则直接写入终端 */
  requestPaste: (tabId: string) => Promise<void>
  zoom: (direction: ZoomDirection) => void
  clearActive: () => void
  copyAllActive: () => Promise<boolean>
}

export const TerminalUiContext = createContext<TerminalUiActions | null>(null)

export function useTerminalUi(): TerminalUiActions {
  const actions = useContext(TerminalUiContext)
  if (!actions) throw new Error('useTerminalUi 必须在 <TerminalWorkspace> 内部使用')
  return actions
}
