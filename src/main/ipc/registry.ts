import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import {
  IpcCallError,
  IPC_INVOKE_CHANNELS,
  type IpcError,
  type IpcEventMap,
  type IpcEventName,
  type IpcInvokeChannel,
  type IpcRequestOf,
  type IpcResponseOf,
  type IpcResult
} from '@shared'

/**
 * IPC 注册内核 —— 全项目**只有这里**调用 `ipcMain.handle` / `webContents.send`。
 *
 * 每个 handler 都被统一包成信封（`IpcResult`）：
 * 抛错在 Electron 里会被转成 `Error invoking remote method '<channel>': ...` 字符串，
 * 错误码与细节全部丢失，渲染层只能靠正则猜——所以这里集中 catch 并结构化。
 *
 * 签名带 request schema：传了就先 zod 校验再进业务，任何外部输入都不会直接落地到 fs/ssh。
 */
export type IpcHandler<C extends IpcInvokeChannel> = (
  request: IpcRequestOf<C>,
  event: IpcMainInvokeEvent
) => IpcResponseOf<C> | Promise<IpcResponseOf<C>>

const handledChannels = new Set<IpcInvokeChannel>()

export function handle<C extends IpcInvokeChannel>(
  channel: C,
  handler: IpcHandler<C>,
  requestSchema?: z.ZodType
): void {
  if (handledChannels.has(channel)) {
    throw new Error(`IPC handler already registered: ${channel}`)
  }
  handledChannels.add(channel)

  ipcMain.handle(channel, async (event, payload: unknown): Promise<IpcResult<IpcResponseOf<C>>> => {
    try {
      const request = (requestSchema ? requestSchema.parse(payload) : payload) as IpcRequestOf<C>
      const data = await handler(request, event)
      return { ok: true, data }
    } catch (error) {
      const ipcError = toIpcError(error)
      // 主进程侧留一条日志：渲染层只看得到信封，排查时需要有服务端视角
      console.warn(`[ipc] ${channel} failed: ${ipcError.code} ${ipcError.message}`)
      return { ok: false, error: ipcError }
    }
  })
}

/** 广播事件给所有窗口（单窗口应用，但别把假设写死） */
export function emitToAll<E extends IpcEventName>(event: E, payload: IpcEventMap[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(event, payload)
  }
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof IpcCallError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details }
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'E_INVALID_ARGUMENT',
      message: 'Invalid argument',
      details: error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    }
  }
  if (error instanceof Error) return { code: 'E_UNKNOWN', message: error.message }
  return { code: 'E_UNKNOWN', message: String(error) }
}

/**
 * 给「还没实现」的通道补桩 —— 必须在所有 feature 注册完之后调用。
 *
 * 作用：队友的模块还没落地时，渲染层调用得到的是 `E_NOT_IMPLEMENTED` 而不是
 * `Error: No handler registered for 'vault:status'`。前者能在 UI 上被优雅降级，
 * 后者会让整个面板崩掉、也看不出「谁该实现」。
 */
export function installPlaceholders(): IpcInvokeChannel[] {
  const pending = IPC_INVOKE_CHANNELS.filter((channel) => !handledChannels.has(channel))
  for (const channel of pending) {
    handle(channel, () => {
      throw new IpcCallError({
        code: 'E_NOT_IMPLEMENTED',
        message: `IPC channel not implemented yet: ${channel}`
      })
    })
  }
  return pending
}

/** 已注册（含桩）的通道列表，供启动日志与测试断言 */
export function registeredChannels(): IpcInvokeChannel[] {
  return IPC_INVOKE_CHANNELS.filter((channel) => handledChannels.has(channel))
}
