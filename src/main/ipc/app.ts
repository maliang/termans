import { shell } from 'electron'
import { z } from 'zod'
import { IpcCallError, type AppInfo } from '@shared'
import { handle } from './registry'

export interface AppHandlerDeps {
  getAppInfo: () => AppInfo
}

const openExternalSchema = z.object({ url: z.string().url() })

export function registerAppHandlers(deps: AppHandlerDeps): void {
  handle('app:info', () => deps.getAppInfo())

  /**
   * 只允许 http(s) 外链。放任 `file:` / 自定义 scheme 会让 AI 或 host 数据里的一句话
   * 变成「点一下就执行本机程序」的入口。
   */
  handle(
    'app:open-external',
    async ({ url }) => {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new IpcCallError({
          code: 'E_INVALID_ARGUMENT',
          message: `Refusing to open non-http(s) url: ${parsed.protocol}`
        })
      }
      await shell.openExternal(url)
      return { opened: true }
    },
    openExternalSchema
  )
}
