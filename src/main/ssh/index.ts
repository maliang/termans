import type { HostRecord, SshSettings } from '@shared'
import { emitToAll } from '../ipc/registry'
import { registerSshHandlers } from './ipc'
import { JsonKnownHostsGateway, type KnownHostsGateway } from './known-hosts'
import { SshManager } from './manager'
import type { SshLogger } from './redact'
import type { SshEngineDeps } from './types'

export * from './errors'
export * from './redact'
export * from './known-hosts'
export * from './types'
export * from './backoff'
export * from './pacer'
export * from './auth'
export * from './exec'
export * from './sftp'
export * from './session'
export * from './manager'
export { registerSshHandlers, type SshHandlerDeps } from './ipc'

/**
 * 引擎装配入口（主进程接线用）。
 *
 * 集成层（src/main/ipc/index.ts，归属 integration）只需：
 * ```ts
 * const engine = createSshEngine({
 *   userDataDir: app.getPath('userData'),
 *   getSettings: () => settings.get().ssh,
 *   resolveHost: (hostId) => hostStore.get(hostId),
 *   resolveSecret: (ref) => vault.readSecret(ref)
 * })
 * engine.registerIpc()
 * ```
 * 其余依赖（事件广播、known_hosts 存储、日志、密钥读取、agent、定时器）都有可用默认值，
 * 测试里也可整体替换——所以会话/管理器/协议层都不 import `electron`，只有本文件做接线。
 */
export interface CreateSshEngineOptions {
  /** known_hosts 兜底存储目录（通常 app.getPath('userData')） */
  userDataDir: string
  getSettings: () => SshSettings
  resolveHost: (hostId: string) => HostRecord | Promise<HostRecord>
  resolveSecret: (credentialRef: string) => string | null | Promise<string | null>
  /** 注入后由 vault-sync 的加密存储接管；缺省用明文 JSON 兜底 */
  knownHosts?: KnownHostsGateway
  log?: SshLogger
  /** 测试/定制注入点：定时器、随机数、时钟、密钥读取、agent、重连策略、exec 上限 */
  overrides?: Partial<Omit<SshEngineDeps, 'resolveHost' | 'resolveSecret' | 'getSettings' | 'knownHosts' | 'emit'>>
}

export interface SshEngine {
  deps: SshEngineDeps
  manager: SshManager
  /** 注册 ssh:* 六个通道（必须早于 registerIpcHandlers 里的 installPlaceholders） */
  registerIpc(): void
  dispose(): void
}

export function createSshEngine(options: CreateSshEngineOptions): SshEngine {
  // 事件广播走 registry 的 emitToAll：请求/响应走 invoke，流式输出与状态走 send
  // TODO(vault-sync 接线): 这里的 JsonKnownHostsGateway 是**明文**实现，仅供测试与降级。
  // 生产接线必须换成 vault 侧的加密实现（实现同一个 KnownHostsGateway 接口，无缝替换）——
  // 明文里躺着「内网 IP + 端口 + 主机密钥指纹」，落盘即在磁盘上暴露内网拓扑。
  // 接线方式：createSshEngine({ ..., knownHosts: vaultKnownHostsGateway })。
  const knownHosts =
    options.knownHosts ??
    new JsonKnownHostsGateway({
      dir: options.userDataDir,
      fileName: 'known_hosts.json'
    })

  const deps: SshEngineDeps = {
    resolveHost: options.resolveHost,
    resolveSecret: options.resolveSecret,
    knownHosts,
    getSettings: options.getSettings,
    emit: emitToAll,
    ...options.overrides,
    log: options.log ?? options.overrides?.log
  }

  const manager = new SshManager({ deps })

  return {
    deps,
    manager,
    registerIpc(): void {
      registerSshHandlers({ manager })
    },
    dispose(): void {
      manager.disposeAll()
    }
  }
}
