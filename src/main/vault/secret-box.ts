import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vaultFail } from './errors'

/**
 * 本机密钥封装（SecretBox）—— 「密码 / passphrase / 私钥 / Git token」在**本机**的落盘方式。
 *
 * 三层实现，运行期按可用性降级（`vault:status.keychainBacked` 会如实反映降级结果）：
 * 1. `safeStorage`（Electron，走 macOS Keychain / Windows DPAPI / Linux libsecret）——首选；
 * 2. `file`：系统 keychain 不可用时，用 `localDir/machine.key`（0600，32B 随机）做 AES-256-GCM。
 *    这是「静态混淆」而不是操作系统级保护，必须在 UI 上说明，不能假装和 keychain 一样；
 * 3. `memory`：仅测试用，进程退出即丢。
 *
 * 这里**不做**加密库抽象大而全的接口：只要求 encrypt/decrypt 两个字符串方法，
 * 因为调用方（CredentialStore / 会话密钥保管）只需要这两个。
 */

export type SecretBoxKind = 'safeStorage' | 'file' | 'memory'

export interface SecretBox {
  readonly kind: SecretBoxKind
  /** 是否提供操作系统级保护（决定 UI 是否显示「已托管到系统 keychain」） */
  isOsBacked(): boolean
  available(): boolean
  encrypt(plain: string): string
  decrypt(sealed: string): string
}

const SEAL_PREFIX = 'sb1:'

/** 内存实现：测试与「keychain 不可用且用户拒绝落盘」时使用 */
export function createMemorySecretBox(): SecretBox {
  const store = new Map<string, string>()
  return {
    kind: 'memory',
    isOsBacked: () => false,
    available: () => true,
    encrypt: (plain) => {
      const id = randomBytes(12).toString('hex')
      store.set(id, plain)
      return `${SEAL_PREFIX}memory:${id}`
    },
    decrypt: (sealed) => {
      const id = sealed.startsWith(`${SEAL_PREFIX}memory:`) ? sealed.slice(`${SEAL_PREFIX}memory:`.length) : ''
      const value = store.get(id)
      if (value === undefined) throw vaultFail('E_UNAUTHORIZED', 'secret not found in memory box', { reason: 'not-found' })
      return value
    }
  }
}

/**
 * 文件实现：`machine.key` 是本机随机密钥（0600），密文用 AES-256-GCM。
 * 明确说明：拿到磁盘 + 这个 key 文件的人可以解开，**不等价于**系统 keychain。
 */
export function createFileSecretBox(dir: string): SecretBox {
  const keyPath = join(dir, 'machine.key')
  let cachedKey: Buffer | null = null

  const loadKey = (): Buffer => {
    if (cachedKey) return cachedKey
    if (!existsSync(keyPath)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const key = randomBytes(32)
      writeFileSync(keyPath, key, { mode: 0o600 })
      cachedKey = key
      return key
    }
    const key = readFileSync(keyPath)
    if (key.length !== 32) throw vaultFail('E_IO', 'machine.key is corrupt', { reason: 'corrupt', path: keyPath })
    cachedKey = key
    return key
  }

  return {
    kind: 'file',
    isOsBacked: () => false,
    available: () => true,
    encrypt: (plain) => {
      const key = loadKey()
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return `${SEAL_PREFIX}file:${nonce.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`
    },
    decrypt: (sealed) => {
      if (!sealed.startsWith(`${SEAL_PREFIX}file:`)) {
        throw vaultFail('E_UNAUTHORIZED', 'secret was sealed by another backend', { reason: 'stale-session' })
      }
      const [, , nonceB64, tagB64, dataB64] = sealed.split(':')
      try {
        const decipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(nonceB64 ?? '', 'base64'))
        decipher.setAuthTag(Buffer.from(tagB64 ?? '', 'base64'))
        return Buffer.concat([decipher.update(Buffer.from(dataB64 ?? '', 'base64')), decipher.final()]).toString('utf8')
      } catch {
        throw vaultFail('E_UNAUTHORIZED', 'secret could not be decrypted on this machine', { reason: 'stale-session' })
      }
    }
  }
}

/**
 * 包一层 Electron `safeStorage`。
 *
 * 不入参 `Electron.SafeStorage` 类型，只用结构类型：这样单测可以在纯 node 下构造假实现，
 * 也避免 crypto 层被 electron 的 import 绑住（`vitest` 环境里没有 electron）。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function wrapSafeStorage(safeStorage: SafeStorageLike): SecretBox {
  return {
    kind: 'safeStorage',
    isOsBacked: () => safeStorage.isEncryptionAvailable(),
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => `${SEAL_PREFIX}safeStorage:${safeStorage.encryptString(plain).toString('base64')}`,
    decrypt: (sealed) => {
      if (!sealed.startsWith(`${SEAL_PREFIX}safeStorage:`)) {
        throw vaultFail('E_UNAUTHORIZED', 'secret was sealed by another backend', { reason: 'stale-session' })
      }
      try {
        return safeStorage.decryptString(Buffer.from(sealed.slice(`${SEAL_PREFIX}safeStorage:`.length), 'base64'))
      } catch {
        throw vaultFail('E_UNAUTHORIZED', 'safeStorage could not decrypt the secret', { reason: 'stale-session' })
      }
    }
  }
}

/** 0600 权限的普通文本文件（本机私有目录用；不进 Git，不进 vault.enc） */
export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 上 chmod 基本无效，忽略；Linux/macOS 已经是 0600
  }
}
