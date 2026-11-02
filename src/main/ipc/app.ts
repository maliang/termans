import { clipboard, shell } from 'electron'
import { z } from 'zod'
import { IpcCallError, type AppInfo } from '@shared'
import { handle } from './registry'

export interface AppHandlerDeps {
  getAppInfo: () => AppInfo
}

const openExternalSchema = z.object({ url: z.string().url() })

/** 剪贴板写入上限：恢复码 39 字符、令牌 ≤8KB，1MB 是防守上限而不是业务上限 */
const clipboardWriteSchema = z.object({ text: z.string().max(1_000_000) })

export function registerAppHandlers(deps: AppHandlerDeps): void {
  handle('app:info', () => deps.getAppInfo())

  /**
   * 为什么不用 `navigator.clipboard`：主进程装了 `setPermissionRequestHandler(… => callback(false))`
   * （`src/main/index.ts:276`，一律拒绝网页权限），渲染层的剪贴板写入会被拒，
   * 而它**不会抛错到界面上**——按钮点了毫无反应。所以写剪贴板统一走主进程。
   */
  handle(
    'app:clipboard-write',
    async ({ text }) => {
      clipboard.writeText(text)
      // 回读校验：写入失败（例如系统剪贴板被占用）时不让 UI 谎报「已复制」。
      // 新版 Electron 的 readText 返回 Promise，必须 await 再比，否则恒为 false。
      const actual = await clipboard.readText()
      return { copied: actual === text }
    },
    clipboardWriteSchema
  )

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
