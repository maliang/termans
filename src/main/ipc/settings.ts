import { settingsPatchSchema } from '@shared'
import type { SettingsStore } from '../store/settings-store'
import { emitToAll, handle } from './registry'

export interface SettingsHandlerDeps {
  settings: SettingsStore
}

/**
 * 设置读写。
 * 每次变更都广播 `settings:changed`：多窗口/多面板（设置页、终端、AI 面板）各自订阅刷新，
 * 避免「改了主题只有当前页生效」这类状态分叉。
 */
export function registerSettingsHandlers(deps: SettingsHandlerDeps): void {
  handle('settings:get', () => deps.settings.get())

  handle(
    'settings:update',
    (patch) => {
      const next = deps.settings.update(patch)
      emitToAll('settings:changed', next)
      return next
    },
    settingsPatchSchema
  )

  handle('settings:reset', () => {
    const next = deps.settings.reset()
    emitToAll('settings:changed', next)
    return next
  })
}
