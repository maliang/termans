import { powerMonitor, safeStorage } from 'electron'
import type { AppInfo, VaultStatus } from '@shared'
import { createAiModule, registerAiHandlers } from '../ai/ipc'
import { SyncCoordinator } from '../git/sync'
import { createSshEngine } from '../ssh'
import { createFileSecretBox, wrapSafeStorage, type SecretBox } from '../vault/secret-box'
import { VaultManager } from '../vault/manager'
import { VaultHub } from '../vault/hub'
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
  /** 多库编排器：`hub.current()` 就是「当前库」的 manager/sync（切库后自动变） */
  hub: VaultHub
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

  // 默认库（老安装）的路径仍是 `vault` + `vault-local`，与 r2 逐字相同（AC-18 零迁移）。
  // 这两个字面值现在只住在 `vault/library-index.ts` 的默认记录里 —— 多库不是搬目录，
  // 而是多几条索引记录，所以这里不再需要第二份路径常量。

  // hub 要在自己的 onStatus 闭包里被引用（推送前补库列表），先声明后赋值。
  let hub: VaultHub
  /** 推送出口：manager 只认识单库（`status().libraries` 恒为 `[]`），多库事实在这里合并 */
  const withLibraries = (status: VaultStatus): VaultStatus => ({ ...status, libraries: hub.libraryMeta() })

  // 每个库一个 SecretBox（文件密钥按 localDir 隔离），同一个库的 manager 与 sync 必须共用一份，
  // 否则首次生成密钥时两边会各写一把、后写的赢（表现是同步侧解不开 manager 写的密文）。
  const boxes = new Map<string, SecretBox>()
  const boxFor = (localDir: string): SecretBox => {
    const cached = boxes.get(localDir)
    if (cached !== undefined) return cached
    const box = createSecretBox(localDir)
    boxes.set(localDir, box)
    return box
  }

  hub = new VaultHub({
    userDataDir,
    createManager: (paths) => {
      const manager = new VaultManager({
        repoDir: paths.repoDir,
        localDir: paths.localDir,
        box: boxFor(paths.localDir),
        autoLockMinutes: () => ctx.settings.get().security.autoLockMinutes,
        requirePassphraseOnLaunch: () => ctx.settings.get().security.requirePassphraseOnLaunch,
        onStatus: (status) => emitToAll('vault:state-changed', withLibraries(status))
      })
      // 上锁 → 清掉存活 SSH 会话里缓存的凭据副本。**不断开连接**
      // （产品裁定，见 docs/VAULT-SYNC.md §4「上锁不终止已建立的 SSH 会话」）：
      // 已建连的通道用的是 ssh2 内部协商的密钥，与本处缓存的明文口令无关；
      // 而自动上锁可能由 15 分钟空闲触发，那时用户可能正在跑长任务。
      // 挂在这里而不是构造之后一次：每个库的 manager 都要有，切库后依然生效。
      manager.onLock = () => {
        const cleared = engine.releaseCredentials()
        if (cleared > 0) {
          console.info(`[vault] cleared cached credentials in ${cleared} live ssh session(s)`)
        }
      }
      return manager
    },
    createSync: (paths, manager) =>
      new SyncCoordinator({
        repoDir: paths.repoDir,
        localDir: paths.localDir,
        manager,
        box: boxFor(paths.localDir),
        onStatus: (status) => emitToAll('sync:status-changed', status)
      }),
    onStatus: (status) => emitToAll('vault:state-changed', withLibraries(status))
  })
  // 启动握手：打开索引里的当前库（老安装 = 惰性默认库），读仓库并尝试「记住本机」自动解锁。
  // 任何损坏都在内部降级为 locked，绝不在这里抛（否则窗口起不来，用户连解锁屏都看不到）。
  hub.init()

  // 引擎与 AI 都长期持有 manager：一律「现取当前库」，切库后立刻跟到新库，
  // 而不是抱着构造期那个实例（否则切到 B 库仍按 A 库解析主机与 API key）。
  const managerNow = (): VaultManager => hub.current().manager
  const aiPort = () => createAiVaultPort(managerNow())
  const knownHostsGateway = () => createVaultKnownHostsGateway(managerNow())

  const ai = createAiModule({
    vault: {
      isUnlocked: () => aiPort().isUnlocked(),
      readDoc: (key) => aiPort().readDoc(key),
      writeDoc: (key, value) => aiPort().writeDoc(key, value),
      deleteDoc: (key) => aiPort().deleteDoc(key)
    },
    userDataDir,
    getSettings: () => ctx.settings.get().ai,
    emit: emitToAll
  })

  const engine = createSshEngine({
    userDataDir,
    getSettings: () => ctx.settings.get().ssh,
    resolveHost: (hostId) => createVaultHostResolver(managerNow())(hostId),
    resolveSecret: (reference) => createVaultSecretResolver(managerNow())(reference),
    knownHosts: {
      list: () => knownHostsGateway().list(),
      find: (host, port) => knownHostsGateway().find(host, port),
      trust: (request) => knownHostsGateway().trust(request),
      remove: (request) => knownHostsGateway().remove(request)
    },
    overrides: { readPrivateKey: (path) => createVaultPrivateKeyReader(managerNow())(path) }
  })

  registerAppHandlers({ getAppInfo: ctx.getAppInfo })
  registerSettingsHandlers({ settings: ctx.settings })
  registerThemeHandlers({ userDataDir })
  registerVaultHandlers({ hub })
  engine.registerIpc()
  registerAiHandlers(ai.service)

  const pending = installPlaceholders()
  const total = registeredChannels().length
  console.info(`[ipc] registered ${total} channels (${pending.length} placeholder)`)
  if (pending.length > 0) console.info(`[ipc] placeholders: ${pending.join(', ')}`)

  // 系统休眠/合盖 → 立即上锁（内存里的明文与 VMK 不清空就是「锁屏了但还能用」的假锁）。
  // 只锁**当前库**：一次只活一个 manager，其它库本来就没有 VMK 驻留。
  const onSuspend = (): void => {
    try {
      const status = hub.current().manager.lock()
      console.info(`[vault] locked on system suspend (state=${status.state})`)
    } catch (error) {
      console.warn(`[vault] lock on suspend failed: ${(error as Error).message}`)
    }
  }
  powerMonitor.on('suspend', onSuspend)

  return {
    hub,
    dispose(): void {
      powerMonitor.removeListener('suspend', onSuspend)
      engine.dispose()
    }
  }
}

export { emitToAll, handle, toIpcError } from './registry'
export type { IpcHandler } from './registry'
