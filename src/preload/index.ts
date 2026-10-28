import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_EVENTS, IPC_INVOKE_CHANNELS } from '../shared/ipc'
import type { TermansBridge } from '../shared/bridge'
import type { AppPlatform } from '../shared/models/app'

/**
 * preload —— 渲染层能看到的**全部**本机能力面。
 *
 * 两条硬约束：
 *
 * 1. **这里绝不 import `@shared` 的桶文件**（`src/shared/index.ts`）。
 *    桶文件会拉进 zod 等 dependency，`externalizeDepsPlugin` 会把它转成 `require('zod')`；
 *    而 `sandbox: true` 的 preload 只能 require `electron`，于是 preload 静默加载失败、
 *    `window.termans` 消失，表现为渲染层所有调用都是 undefined。
 *    所以只从 `shared/ipc`（纯类型 + 常量，无运行时依赖）与类型文件取。
 *
 * 2. **白名单是运行时校验，不是类型约束**。通道名只能来自 IPC_CHANNELS / IPC_EVENTS；
 *    渲染层即使被注入脚本，也没法调用未登记的通道。
 */

const invokable = new Set<string>(IPC_INVOKE_CHANNELS)
const subscribable = new Set<string>(Object.values(IPC_EVENTS))

function readPlatform(): AppPlatform {
  if (typeof process === 'undefined') return 'linux'
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform
  }
  return 'linux'
}

const bridge: TermansBridge = {
  versions: {
    // 沙箱里 process 是精简 polyfill，取值用可选链兜底（缺失时渲染层不显示版本号而已）
    electron: process?.versions?.['electron'] ?? '0.0.0',
    chrome: process?.versions?.['chrome'] ?? '0.0.0',
    node: process?.versions?.['node'] ?? '0.0.0'
  },
  platform: readPlatform(),
  invoke(channel: string, payload?: unknown) {
    if (!invokable.has(channel)) {
      return Promise.reject(new Error(`Blocked IPC channel (not in allowlist): ${channel}`))
    }
    return ipcRenderer.invoke(channel, payload)
  },
  on(event: string, listener: (payload: unknown) => void) {
    if (!subscribable.has(event)) {
      throw new Error(`Blocked IPC event (not in allowlist): ${event}`)
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  }
}

// contextIsolation: true 时必须走 contextBridge，直接赋 window.termans 会被隔离掉
contextBridge.exposeInMainWorld('termans', bridge)
