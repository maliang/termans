import type { IpcResult } from './errors'
import type { IpcEventMap, IpcEventName, IpcInvokeChannel, IpcRequestOf, IpcResponseOf } from './ipc'
import type { AppPlatform } from './models/app'

/**
 * 渲染层与主进程之间唯一的桥（preload 暴露为 `window.termans`）。
 *
 * 设计取舍：桥本身是**哑管道**——`invoke(channel, payload)` 只认字符串通道，
 * 由 preload 的运行时白名单拦掉未登记通道；类型安全由上层 `src/renderer/platform/ipc.ts`
 * 的泛型包装提供。这样 preload 不需要引用任何业务类型（打包体积最小、也最不容易被绕过）。
 *
 * 缺失桥时不是静默 undefined：`getTermansBridge()` 直接抛错，
 * 否则表现是「点按钮没反应」这种最难查的故障。
 */
export interface TermansBridge {
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
  readonly platform: AppPlatform
  invoke(channel: string, payload?: unknown): Promise<IpcResult<unknown>>
  /** 返回取消订阅函数 */
  on(event: string, listener: (payload: unknown) => void): () => void
}

declare global {
  interface Window {
    /** 只在 Electron 渲染进程里存在；纯浏览器预览下为 undefined */
    termans?: TermansBridge
  }
}

export function getTermansBridge(): TermansBridge {
  // 用 globalThis 而不是裸 `window`：src/shared 同时被 tsconfig.node（无 DOM lib）编译，
  // 直接写 window 会让主进程侧的 typecheck 直接报 TS2304。
  const bridge = (globalThis as { window?: Window }).window?.termans
  if (!bridge) {
    throw new Error('Termans bridge is unavailable: preload script did not run (window.termans missing)')
  }
  return bridge
}

/** 类型化调用的参数元组：请求为 void 的通道可以省略实参 */
export type IpcCallArgs<C extends IpcInvokeChannel> = IpcRequestOf<C> extends void
  ? []
  : [request: IpcRequestOf<C>]

/** 类型化调用签名（渲染层 ipc client 实现它） */
export type IpcCaller = <C extends IpcInvokeChannel>(
  channel: C,
  ...args: IpcCallArgs<C>
) => Promise<IpcResponseOf<C>>

/** 类型化事件订阅签名 */
export type IpcSubscriber = <E extends IpcEventName>(event: E, listener: (payload: IpcEventMap[E]) => void) => () => void
