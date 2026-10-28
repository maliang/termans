import type { AppInfo } from '@shared'
import type { SettingsStore } from '../store/settings-store'
import { registerAppHandlers } from './app'
import { registerSettingsHandlers } from './settings'
import { installPlaceholders, registeredChannels } from './registry'

/**
 * IPC 接线点（**唯一**）。
 *
 * 约定：每个功能模块在自己目录下实现 `registerXxxHandlers(deps)`，然后在这里加一行注册。
 * 除了这个文件，任何人不要直接 `ipcMain.handle`——否则信封、校验、日志三件事都会被绕过。
 *
 * 并行开发期的小设计：末尾的 `installPlaceholders()` 会给还没接进来的通道补
 * `E_NOT_IMPLEMENTED` 桩，因此渲染层不必等所有后端就绪就能跑通完整 UI。
 */
export interface IpcContext {
  /** 由 main/index.ts 注入（含 electron/chrome/node 版本与 userData 路径） */
  getAppInfo: () => AppInfo
  settings: SettingsStore
}

export function registerIpcHandlers(ctx: IpcContext): void {
  registerAppHandlers({ getAppInfo: ctx.getAppInfo })
  registerSettingsHandlers({ settings: ctx.settings })

  const pending = installPlaceholders()
  const total = registeredChannels().length
  console.info(`[ipc] registered ${total} channels (${pending.length} placeholder)`)
  if (pending.length > 0) console.info(`[ipc] placeholders: ${pending.join(', ')}`)
}

export { emitToAll, handle, toIpcError } from './registry'
export type { IpcHandler } from './registry'
