import { join } from 'node:path'
import { powerMonitor, safeStorage } from 'electron'
import type { AppInfo } from '@shared'
import { createAiModule, registerAiHandlers } from '../ai/ipc'
import { SyncCoordinator } from '../git/sync'
import { createSshEngine } from '../ssh'
import { createFileSecretBox, wrapSafeStorage, type SecretBox } from '../vault/secret-box'
import { VaultManager } from '../vault/manager'
import { registerVaultHandlers } from '../vault/register'
import type { SettingsStore } from '../store/settings-store'
import { registerAppHandlers } from './app'
import {
  createAiVaultPort,
  createVaultHostResolver,
  createVaultKnownHostsGateway,
  createVaultPrivateKeyReader,
  createVaultSecretResolver
} from './bridges'
import { registerSettingsHandlers } from './settings'
import { registerThemeHandlers } from './theme'
import { emitToAll, installPlaceholders, registeredChannels } from './registry'

/**
 * IPC 接线点（**唯一**）。
 *
 * 约定：每个功能模块在自己目录下实现 `registerXxxHandlers(deps)`，然后在这里加一行注册。
 * 除了这个文件，任何人不要直接 `ipcMain.handle`——否则信封、校验、日志三件事都会被绕过。
 *
 * 注册顺序有硬约束：
 *   1. `registerVaultHandlers` 必须在 `installPlaceholders()` **之前**（否则 30 个 vault 通道
 *      会被 E_NOT_IMPLEMENTED 桩占坑，随后真实现再注册就会撞 "already registered"）；
 *   2. `engine.registerIpc()`（ssh:*）、`registerAiHandlers`（ai:*）、`registerThemeHandlers`（theme:*）
 *      同理；
 *   3. 桩是**最后**兜底，它会把剩下的通道登记下来，并在日志里列出来（骨架期可见性）。
 */
export interface IpcContext {
  /** 由 main/index.ts 注入（含 electron/chrome/node 版本与 userData 路径） */
  getAppInfo: () => AppInfo
  settings: SettingsStore
}

/** 接线后可用于生命周期控制/测试的句柄 */
export interface IpcRuntime {
  vault: VaultManager
  sync: SyncCoordinator
  /** 停掉事件订阅与 SSH 会话（测试与热重启用；正常退出由进程结束兜底） */
  dispose(): void
}

function createSecretBox(localDir: string): SecretBox {
  // 系统钥匙串可用时优先 safeStorage（macOS Keychain / Windows DPAPI / Linux libsecret），
  // 否则退化成 0600 的文件密钥（静态混淆，仅强于「明文落盘」）。
  try {
    if (safeStorage.isEncryptionAvailable()) return wrapSafeStorage(safeStorage)
  } catch {
    // 某些 Linux 环境下调用 isEncryptionAvailable 会抛，退化成文件密钥
  }
  return createFileSecretBox(localDir)
}

export function registerIpcHandlers(ctx: IpcContext): IpcRuntime {
  const userDataDir = ctx.getAppInfo().userDataPath
  const repoDir = join(userDataDir, 'vault')
  const localDir = join(userDataDir, 'vault-local')
  const box = createSecretBox(localDir)

  const vault = new VaultManager({
    repoDir,
    localDir,
    box,
    autoLockMinutes: () => ctx.settings.get().security.autoLockMinutes,
    requirePassphraseOnLaunch: () => ctx.settings.get().security.requirePassphraseOnLaunch,
    onStatus: (status) => emitToAll('vault:state-changed', status)
  })
  // 启动握手：读仓库、尝试「记住本机」自动解锁。任何损坏都在内部降级为 locked，
  // 绝不在这里抛（否则窗口起不来，用户连解锁屏都看不到）。
  vault.init()

  const sync = new SyncCoordinator({
    repoDir,
    localDir,
    manager: vault,
    box,
    onStatus: (status) => emitToAll('sync:status-changed', status)
  })

  const ai = createAiModule({
    vault: createAiVaultPort(vault),
    userDataDir,
    getSettings: () => ctx.settings.get().ai,
    emit: emitToAll
  })

  const engine = createSshEngine({
    userDataDir,
    getSettings: () => ctx.settings.get().ssh,
    resolveHost: createVaultHostResolver(vault),
    resolveSecret: createVaultSecretResolver(vault),
    knownHosts: createVaultKnownHostsGateway(vault),
    overrides: { readPrivateKey: createVaultPrivateKeyReader(vault) }
  })

  registerAppHandlers({ getAppInfo: ctx.getAppInfo })
  registerSettingsHandlers({ settings: ctx.settings })
  registerThemeHandlers({ userDataDir })
  registerVaultHandlers({ manager: vault, sync })
  engine.registerIpc()
  registerAiHandlers(ai.service)

  const pending = installPlaceholders()
  const total = registeredChannels().length
  console.info(`[ipc] registered ${total} channels (${pending.length} placeholder)`)
  if (pending.length > 0) console.info(`[ipc] placeholders: ${pending.join(', ')}`)

  // 系统休眠/合盖 → 立即上锁（内存里的明文与 VMK 不清空就是「锁屏了但还能用」的假锁）。
  const onSuspend = (): void => {
    try {
      const status = vault.lock()
      console.info(`[vault] locked on system suspend (state=${status.state})`)
    } catch (error) {
      console.warn(`[vault] lock on suspend failed: ${(error as Error).message}`)
    }
  }
  powerMonitor.on('suspend', onSuspend)

  return {
    vault,
    sync,
    dispose(): void {
      powerMonitor.removeListener('suspend', onSuspend)
      engine.dispose()
    }
  }
}

export { emitToAll, handle, toIpcError } from './registry'
export type { IpcHandler } from './registry'
