import { useEffect } from 'react'
import type { AppPlatform } from '@shared'
import { useTabStore } from '../tabs/tab-store'
import type { ZoomDirection } from './runtime'
import { isEditableTarget, resolveShortcut } from './shortcuts'

/**
 * 全局快捷键接线。
 *
 * 三个细节决定它是否「像个正经终端」：
 * 1. **capture 阶段**监听：xterm 自己会在 textarea 上处理按键，冒泡阶段我们可能收不到；
 * 2. 命中后 `preventDefault` + `stopPropagation`，否则同一组合键会既切页签又进 shell；
 * 3. 在输入框/搜索框里打字时一律不拦（`isEditableTarget`），否则用户没法输入「w」以外的字符——
 *    最典型的坑是 ⌘F 在搜索框里又被解析成「打开搜索」。
 */

export interface TerminalShortcutActions {
  newTab: () => void
  closeTab: () => void
  find: () => void
  clear: () => void
  copyAll: () => void
  paste: () => void
  zoom: (direction: ZoomDirection) => void
}

export function useTerminalShortcuts(actions: TerminalShortcutActions, platform: AppPlatform): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      const action = resolveShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        platform,
        inEditable: isEditableTarget(event.target)
      })
      if (!action) return
      event.preventDefault()
      event.stopPropagation()

      const tabs = useTabStore.getState()
      switch (action.type) {
        case 'new-tab':
          actions.newTab()
          break
        case 'close-tab':
          actions.closeTab()
          break
        case 'next-tab':
          tabs.activateRelative(1)
          break
        case 'previous-tab':
          tabs.activateRelative(-1)
          break
        case 'activate-tab':
          tabs.activateIndex(action.index)
          break
        case 'find':
          actions.find()
          break
        case 'clear':
          actions.clear()
          break
        case 'copy-all':
          actions.copyAll()
          break
        case 'paste':
          actions.paste()
          break
        case 'zoom-in':
          actions.zoom(1)
          break
        case 'zoom-out':
          actions.zoom(-1)
          break
        case 'zoom-reset':
          actions.zoom(0)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [actions, platform])
}
