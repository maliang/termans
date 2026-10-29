import { existsSync } from 'node:fs'
import { IpcCallError, type HostRecord, type KnownHostEntry, type KnownHostRemoveRequest, type KnownHostTrustRequest } from '@shared'
import type { AiVaultPort } from '../ai/vault-port'
import { AiVaultLockedError } from '../ai/vault-port'
import { PROVIDER_DOC_KEY, apiKeyDocKey } from '../ai/provider-store'
import type { KnownHostsGateway } from '../ssh/known-hosts'
import type { VaultManager } from '../vault/manager'

/**
 * 加密包（vault）与其它模块之间的适配层（t7 接线专用）。
 *
 * 为什么这些适配器长在这里而不是各自模块里：
 * - `ssh` 与 `ai` 都只依赖**窄接口**（`KnownHostsGateway` / `AiVaultPort`），这样它们能脱离 vault
 *   单测；把「窄接口 → VaultManager」的胶水放在接线层，两个模块都不用 import 对方。
 * - 任何一条胶水都在这里，接线出问题只看一个文件。
 *
 * 安全约束（全部来自 captain 的交接）：
 * - known_hosts 必须落密文包（明文 JSON 里有内网 IP + 端口 + 指纹），所以**绝不**使用
 *   `JsonKnownHostsGateway`。
 * - 私钥原文只在本机 SecretBox 里：vault 导入的私钥没有磁盘路径，这里用
 *   `vault://privatekey/<hostId>` 这个**虚拟路径**把它接到引擎的 `readPrivateKey` 钩子上，
 *   既不落盘也不改 engine。
 */

export const VAULT_PRIVATE_KEY_PATH_PREFIX = 'vault://privatekey/'

/* -------------------------------------------------------------------------- */
/* known_hosts：引擎的网关接口 → 密文包                                          */
/* -------------------------------------------------------------------------- */

export function createVaultKnownHostsGateway(manager: VaultManager): KnownHostsGateway {
  return {
    list: (): KnownHostEntry[] => manager.listKnownHosts(),
    find: (host: string, port: number): KnownHostEntry[] =>
      manager.listKnownHosts().filter((entry) => entry.host === host && entry.port === port),
    trust: (request: KnownHostTrustRequest): KnownHostEntry => manager.trustKnownHost(request),
    remove: (request: KnownHostRemoveRequest): boolean => {
      // 网关契约要求区分「删掉了」与「本来就没有」，而 manager 侧是 void —— 先查后删
      const before = manager
        .listKnownHosts()
        .some((entry) => entry.host === request.host && entry.port === request.port)
      if (!before) return false
      manager.removeKnownHost(request)
      return true
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 主机解析 + 凭据解析：引擎的 deps → 密文包                                      */
/* -------------------------------------------------------------------------- */

/**
 * `resolveHost`：hostId → HostRecord（锁定态抛 E_VAULT_LOCKED，引擎会把它显示成连接失败原因）。
 *
 * 额外职责：vault 里「粘贴导入」的私钥没有磁盘路径（只在 SecretBox 里）。为了不改 engine，
 * 这里把它换成一个虚拟路径 `vault://privatekey/<hostId>`，再由
 * `createVaultPrivateKeyReader()` 在读取时还原成私钥原文。
 */
export function createVaultHostResolver(manager: VaultManager): (hostId: string) => HostRecord {
  return (hostId: string): HostRecord => {
    const library = manager.listLibrary()
    const host = library.hosts.find((candidate) => candidate.id === hostId)
    if (!host) {
      throw new IpcCallError({ code: 'E_NOT_FOUND', message: `Host not found: ${hostId}` })
    }
    const hasFileKey = host.privateKeyPath !== null && host.privateKeyPath.length > 0
    if (host.authMethod === 'publickey' && (!hasFileKey || !existsSync(host.privateKeyPath ?? ''))) {
      if (manager.hasPrivateKey(host.id)) {
        return { ...host, privateKeyPath: `${VAULT_PRIVATE_KEY_PATH_PREFIX}${host.id}` }
      }
    }
    return host
  }
}

/** 引擎的 `readPrivateKey(path)` 钩子：虚拟路径 → 本机 SecretBox 里的私钥原文 */
export function createVaultPrivateKeyReader(manager: VaultManager): (path: string) => string {
  return (path: string): string => {
    if (!path.startsWith(VAULT_PRIVATE_KEY_PATH_PREFIX)) {
      throw new Error(`Not a vault private key path: ${path}`)
    }
    const hostId = path.slice(VAULT_PRIVATE_KEY_PATH_PREFIX.length)
    const auth = manager.resolveHostAuth(hostId)
    if (auth.privateKey === null) throw new Error(`Private key is not stored for host ${hostId}`)
    return auth.privateKey
  }
}

/**
 * `resolveSecret`：credentialRef → 明文口令。
 *
 * 现实约束：引擎一个 ref 只会问一次，并把返回值同时当 password 与 passphrase 用
 * （`src/main/ssh/session.ts` 的 `loadCredential()`）；而 vault 把 passphrase 存在
 * `passphrase:<ref>` 这个派生引用下（见 `src/main/vault/register.ts` 的前缀约定）。
 * 所以这里按「密码优先、否则 passphrase」合成，两种认证方式都能连上。
 */
export function createVaultSecretResolver(manager: VaultManager): (reference: string) => string | null {
  return (reference: string): string | null => {
    const direct = manager.getSecret(reference)
    if (direct?.password) return direct.password
    const passphrase = manager.getSecret(`passphrase:${reference}`)
    return passphrase?.passphrase ?? direct?.passphrase ?? null
  }
}

/* -------------------------------------------------------------------------- */
/* AI：AiVaultPort → 密文包                                                      */
/* -------------------------------------------------------------------------- */

/**
 * AI 的供应商配置与 API key 全部落在密文包里（`payload.integrations`），
 * 这里把 t5 的两个文档 key 映射到 vault 的两种存储：
 *   `ai/providers.json`   → `integrations.aiProvidersConfig`（整段 JSON 原文）
 *   `ai/api-key.<id>`     → `payload.integrations.aiApiKeys[<id>]`
 * 锁定态抛 `AiVaultLockedError`（AI 模块会转成 `E_VAULT_LOCKED` 的 IPC 错误，不落明文兜底）。
 */
export function createAiVaultPort(manager: VaultManager): AiVaultPort {
  function providerIdFromDocKey(key: string): string | null {
    const prefix = apiKeyDocKey('')
    return key.startsWith(prefix) ? key.slice(prefix.length) : null
  }

  function assertUnlocked(): void {
    if (manager.status().state !== 'unlocked') throw new AiVaultLockedError()
  }

  return {
    isUnlocked: () => manager.status().state === 'unlocked',
    readDoc: async (key: string): Promise<string | null> => {
      assertUnlocked()
      if (key === PROVIDER_DOC_KEY) return manager.getAiProvidersConfig()
      const providerId = providerIdFromDocKey(key)
      if (providerId !== null) return manager.getAiApiKey(providerId)
      return null
    },
    writeDoc: async (key: string, value: string): Promise<void> => {
      assertUnlocked()
      if (key === PROVIDER_DOC_KEY) {
        manager.setAiProvidersConfig(value)
        return
      }
      const providerId = providerIdFromDocKey(key)
      if (providerId !== null) {
        manager.setAiApiKey(providerId, value)
        return
      }
      // 未知文档 key 不能静默丢：写丢一条 key 的后果是「用户以为保存了、实际没保存」
      throw new IpcCallError({
        code: 'E_INVALID_ARGUMENT',
        message: `Unsupported AI vault document: ${key}`
      })
    },
    deleteDoc: async (key: string): Promise<void> => {
      assertUnlocked()
      if (key === PROVIDER_DOC_KEY) {
        manager.setAiProvidersConfig(null)
        return
      }
      const providerId = providerIdFromDocKey(key)
      if (providerId !== null) {
        manager.clearAiApiKey(providerId)
        return
      }
      throw new IpcCallError({
        code: 'E_INVALID_ARGUMENT',
        message: `Unsupported AI vault document: ${key}`
      })
    }
  }
}
