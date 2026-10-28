import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vaultFail } from './errors'
import { writePrivateFile, type SecretBox } from './secret-box'

/**
 * 本机凭据与私钥存储（**绝不进仓库**）。
 *
 * 两类东西都落在这个文件里，但语义不同：
 * - `entries`：本机专用凭据（会话密钥 `vault:session`、Git token `git:token`…），
 *   这些**不参与同步**，所以只能放在本机；
 * - `privateKeys`：用户「导入/粘贴」进来的私钥本体（PEM/OpenSSH 文本），
 *   按 hostId 索引，用 SecretBox 加密后落盘。仓库里永远只有 `privateKeyPath` 这个路径引用。
 *
 * 文件本身是 `vault-local/credentials.json`，权限 0600；每个值都是 `sb1:` 前缀的密文，
 * 即使整个文件被拷走，没有本机 keychain / machine.key 也解不开。
 */

interface CredentialFile {
  version: 1
  entries: Record<string, string>
  privateKeys: Record<string, string>
}

const PRIVATE_KEY_MARKERS = ['-----BEGIN', 'PRIVATE KEY', 'PuTTY-User-Key-File']

export interface CredentialStoreOptions {
  dir: string
  box: SecretBox
  fileName?: string
}

export class CredentialStore {
  private readonly path: string
  private readonly box: SecretBox
  private cache: CredentialFile | null = null

  constructor(options: CredentialStoreOptions) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 })
    this.path = join(options.dir, options.fileName ?? 'credentials.json')
    this.box = options.box
  }

  private load(): CredentialFile {
    if (this.cache) return this.cache
    if (!existsSync(this.path)) {
      this.cache = { version: 1, entries: {}, privateKeys: {} }
      return this.cache
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<CredentialFile>
      this.cache = {
        version: 1,
        entries: typeof raw.entries === 'object' && raw.entries !== null ? { ...raw.entries } : {},
        privateKeys: typeof raw.privateKeys === 'object' && raw.privateKeys !== null ? { ...raw.privateKeys } : {}
      }
    } catch {
      // 损坏就是损坏：不静默重置（否则用户的 Git token / 私钥会被无声清空）
      throw vaultFail('E_IO', 'credential store is corrupt', { reason: 'corrupt', path: this.path })
    }
    return this.cache
  }

  private persist(): void {
    const data = this.load()
    writePrivateFile(this.path, `${JSON.stringify(data, null, 2)}\n`)
  }

  set(reference: string, secret: string): { reference: string } {
    if (reference.trim() === '') {
      throw vaultFail('E_INVALID_ARGUMENT', 'credential reference is required', { reason: 'invalid-payload', field: 'reference' })
    }
    const data = this.load()
    data.entries[reference] = this.box.encrypt(secret)
    this.persist()
    return { reference }
  }

  has(reference: string): boolean {
    return this.load().entries[reference] !== undefined
  }

  get(reference: string): string | null {
    const sealed = this.load().entries[reference]
    if (sealed === undefined) return null
    try {
      return this.box.decrypt(sealed)
    } catch {
      // 换机器 / 换 keychain 后旧密文解不开：当作不存在，让调用方走「重新输入」路径
      return null
    }
  }

  clear(reference: string): void {
    const data = this.load()
    if (data.entries[reference] === undefined) return
    delete data.entries[reference]
    this.persist()
  }

  listReferences(): string[] {
    return Object.keys(this.load().entries).sort()
  }

  // ---- 私钥本体（不同步） ----

  setPrivateKey(hostId: string, content: string): void {
    const trimmed = content.trim()
    if (!PRIVATE_KEY_MARKERS.some((marker) => trimmed.includes(marker))) {
      throw vaultFail('E_INVALID_ARGUMENT', 'private key does not look like a key file', {
        reason: 'invalid-payload',
        field: 'privateKey'
      })
    }
    const data = this.load()
    data.privateKeys[hostId] = this.box.encrypt(trimmed)
    this.persist()
  }

  hasPrivateKey(hostId: string): boolean {
    return this.load().privateKeys[hostId] !== undefined
  }

  getPrivateKey(hostId: string): string | null {
    const sealed = this.load().privateKeys[hostId]
    if (sealed === undefined) return null
    try {
      return this.box.decrypt(sealed)
    } catch {
      return null
    }
  }

  clearPrivateKey(hostId: string): void {
    const data = this.load()
    if (data.privateKeys[hostId] === undefined) return
    delete data.privateKeys[hostId]
    this.persist()
  }

  /** 「抹除仓库凭据」：清掉所有本机凭据（含会话密钥与私钥缓存） */
  eraseAll(): void {
    this.cache = { version: 1, entries: {}, privateKeys: {} }
    this.persist()
  }
}
