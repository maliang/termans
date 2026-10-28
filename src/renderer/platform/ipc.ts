import {
  IpcCallError,
  getTermansBridge,
  isIpcCallError,
  type IpcCallArgs,
  type IpcEventMap,
  type IpcEventName,
  type IpcInvokeChannel,
  type IpcResponseOf
} from '@shared'

/**
 * 渲染层唯一的 IPC 入口。
 *
 * 三层：preload 哑管道（白名单） → 这里做**类型化 + 解信封** → 各 feature 直接用。
 * 失败信封统一抛 `IpcCallError`（带 code），业务代码可以 `isIpcCallError(e) && e.code === 'E_VAULT_LOCKED'`。
 *
 * 不要在各组件里直接 `getTermansBridge().invoke(...)`：那样每处都要手写 ok/error 分支，
 * 漏一处就是「界面一直 loading」或者「吞掉错误继续跑」。
 */
export async function call<C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcCallArgs<C>
): Promise<IpcResponseOf<C>> {
  const bridge = getTermansBridge()
  const result = await bridge.invoke(channel, args[0])
  if (result.ok) return result.data as IpcResponseOf<C>
  throw new IpcCallError(result.error)
}

/** 订阅主进程事件，返回取消订阅函数 */
export function subscribe<E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEventMap[E]) => void
): () => void {
  return getTermansBridge().on(event, listener as (payload: unknown) => void)
}

/** 判断「该通道对应模块还没接线」——骨架期据此降级而不是报错弹窗 */
export function isNotImplemented(error: unknown): boolean {
  return isIpcCallError(error) && error.code === 'E_NOT_IMPLEMENTED'
}

/** 把任意错误转成可展示文案（不把堆栈丢给用户） */
export function describeError(error: unknown): string {
  if (isIpcCallError(error)) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
