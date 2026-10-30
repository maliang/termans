import { useCallback, useRef } from 'react'

export interface PanelSplitterProps {
  /** 拖动时写回实时宽度（不落盘，避免拖动过程几百次 IPC） */
  onLive: (width: number) => void
  /** 松手时落盘一次 */
  onCommit: (width: number) => void
  /** 当前面板宽度（拖动起点的基准） */
  value: number
  min: number
  max: number
  /** 'left'：拖动改变的是它左边那块（侧栏）；'right'：改变右边那块（AI 面板） */
  side: 'left' | 'right'
  label: string
  testId: string
}

/**
 * 面板分栏拖拽条（t53）。
 *
 * 为什么用 `pointerdown + setPointerCapture` 而不是 HTML5 drag 或 `mousemove` on window：
 * 指针捕获让「拖出元素甚至拖出窗口」仍然收到事件、松手也不会漏 `pointerup`；
 * 而且不需要往 window 上挂/摘监听器（那类写法漏摘监听器会在卸载后继续改状态）。
 *
 * 宽度钳制在这里做（min/max 由调用方按 settings schema 的同名范围传入），
 * 主进程 `uiSettingsSchema` 也是同一组边界——两边不一致会让拖动看起来被吞掉。
 */
export function PanelSplitter({
  onLive,
  onCommit,
  value,
  min,
  max,
  side,
  label,
  testId
}: PanelSplitterProps): JSX.Element {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  const clamp = useCallback((width: number) => Math.min(max, Math.max(min, Math.round(width))), [max, min])

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // 只响应主键：右键/中键拖拽不该改布局
      if (event.button !== 0) return
      event.preventDefault()
      drag.current = { startX: event.clientX, startWidth: value }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.dataset['dragging'] = 'true'
    },
    [value]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current
      if (state === null) return
      const delta = event.clientX - state.startX
      // 侧栏在左边：往右拖变宽；AI 面板在右边：往左拖变宽
      const next = side === 'left' ? state.startWidth + delta : state.startWidth - delta
      onLive(clamp(next))
    },
    [clamp, onLive, side]
  )

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const state = drag.current
      if (state === null) return
      drag.current = null
      delete event.currentTarget.dataset['dragging']
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      const delta = event.clientX - state.startX
      onCommit(clamp(side === 'left' ? state.startWidth + delta : state.startWidth - delta))
    },
    [clamp, onCommit, side]
  )

  return (
    <div
      className="ts-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // 键盘也能调：← / → 各 16px（无障碍要求可聚焦控件必须可键盘操作）
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const step = event.shiftKey ? 48 : 16
        const direction = event.key === 'ArrowRight' ? 1 : -1
        const next = clamp(side === 'left' ? value + direction * step : value - direction * step)
        onLive(next)
        onCommit(next)
      }}
    />
  )
}
