import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { normalizeRecoveryCode } from './recovery-code'

/**
 * 加密信封（vault envelope）。
 *
 * 结构上分两层，**故意如此**：
 *
 * 1. `vault.enc`（自描述信封）：版本 + kdf 参数（含 salt）+ cipher + nonce + tag + 密文。
 *    它是仓库里唯一的敏感数据载体，口令派生所需的全部信息都在它自己身上
 *    （`manifest.json` 就算丢了、或者被旧版本重写，也能从 vault.enc 看出怎么解）。
 * 2. `manifest.json`（明文同步元信息）：revision / payload_sha256 / 两个「包裹密钥槽」。
 *    密文无法三路合并，所以乐观锁判据（revision + payload_sha256）必须明文可读。
 *
 * 密钥分层（VMK = vault master key，32B 随机）：
 *
 *     passphrase --scrypt--> KEK_pass  --AES-GCM--> [包裹 VMK]
 *     recovery   --scrypt--> KEK_rec   --AES-GCM--> [包裹 VMK]
 *                                       VMK --AES-GCM--> payload
 *
 * 为什么要有 VMK 这一层：口令轮换只换「包裹」，不用把整份数据重新加密一遍，
 * 而恢复码与主口令是两条独立入口（任一可用即可开锁，且都能在不解密数据的情况下先验证）。
 * **VMK 在轮换/恢复时保持不变**——两台机器的 VMK 一致，B 机拉到 A 机轮换后重新提交的
 * `vault.enc` 才能用内存里的 VMK 直接解开（否则每次远端轮换都要用户重新输口令）。
 *
 * 「口令错」与「数据损坏」必须能区分（任务书硬要求，也是 S-14 的判据）：
 * - 先做**结构 + 摘要校验**（manifest 与 vault.enc 的 sha256 交叉绑定）：不符 = 数据损坏。
 * - 再做 AES-GCM 认证：摘要全对、但 GCM tag 验证失败 = 口令（或恢复码）错。
 * 两者都不允许「回退明文」或吞异常。
 */

export const MANIFEST_FORMAT = 'termans-vault' as const
export const MANIFEST_VERSION = 1 as const
export const ENVELOPE_CIPHER = 'aes-256-gcm' as const

export const KEY_BYTES = 32
export const SALT_BYTES = 32
export const NONCE_BYTES = 12
export const TAG_BYTES = 16
/** 恢复码随机源字节数：20B = 160 bit（任务书要求 ≥128bit） */
export { RECOVERY_CODE_BYTES } from './recovery-code'

export interface ScryptCost {
  N: number
  r: number
  p: number
}

/**
 * 生产参数：N=2^17, r=8, p=1（内存 128*N*r ≈ 134MB，单次派生约 300ms @ Apple Silicon）。
 * 这是任务书指定的参数，不要为了「测试快」在生产代码里改小。
 */
export const SCRYPT_PRODUCTION: ScryptCost = { N: 131_072, r: 8, p: 1 }

/**
 * 测试参数：N=2^14。**只允许测试代码使用**，生产代码的默认值必须是 SCRYPT_PRODUCTION。
 * 取舍写在文档里：安全性与 KDF 参数绑定的断言用生产参数测（少量用例），
 * 其余大量 CRUD/同步用例用测试参数，避免整套单测被 300ms × N 次派生拖成几分钟。
 */
export const SCRYPT_TEST: ScryptCost = { N: 16_384, r: 8, p: 1 }

/** 允许的参数上限：防止恶意仓库用 N=2^22 把内存打爆（DoS） */
const COST_LIMITS = { minN: 1 << 14, maxN: 1 << 20, maxR: 32, maxP: 8 } as const

export type VaultCryptoFailure = 'bad-passphrase' | 'bad-recovery-code' | 'corrupt' | 'unsupported-format' | 'bad-params'

export class VaultCryptoError extends Error {
  readonly reason: VaultCryptoFailure

  constructor(reason: VaultCryptoFailure, message: string) {
    super(message)
    this.name = 'VaultCryptoError'
    this.reason = reason
  }
}

/* -------------------------------------------------------------------------- */
/* 结构                                                                        */
/* -------------------------------------------------------------------------- */

const sealedBoxShape = {
  nonce: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string()
}

export const sealedBoxSchema = z.object(sealedBoxShape)
export type SealedBox = z.infer<typeof sealedBoxSchema>

export const recoverySlotSchema = z.object({ ...sealedBoxShape, salt: z.string().min(1) })
export type RecoverySlot = z.infer<typeof recoverySlotSchema>

export const scryptCostSchema = z.object({
  name: z.literal('scrypt'),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive()
})
export type ScryptCostDescriptor = z.infer<typeof scryptCostSchema>

export const vaultManifestSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  version: z.literal(MANIFEST_VERSION),
  cipher: z.literal(ENVELOPE_CIPHER),
  /** 口令槽的 KDF 参数（salt 在 vault.enc 里，见文件头注释） */
  kdf: scryptCostSchema,
  /** passphrase --KEK--> VMK（AAD 绑定 kdf 参数与 salt，改参数即认证失败） */
  passphraseKey: sealedBoxSchema,
  /** recovery code --KEK--> VMK（独立 salt，与口令槽完全解耦） */
  recoveryKey: recoverySlotSchema,
  /** 单调递增：乐观锁的「版本号」 */
  revision: z.number().int().min(0),
  /** sha256(vault.enc 的落盘字节)，十六进制 */
  payload_sha256: z.string().length(64),
  /** sha256(规范化后的密钥槽描述)，用来区分「manifest 被改」与「口令错」 */
  keywrap_sha256: z.string().length(64),
  updated_at: z.iso.datetime()
})
export type VaultManifest = z.infer<typeof vaultManifestSchema>

export const vaultEnvelopeSchema = z.object({
  format: z.literal(MANIFEST_FORMAT),
  version: z.literal(MANIFEST_VERSION),
  cipher: z.literal(ENVELOPE_CIPHER),
  kdf: z.object({
    name: z.literal('scrypt'),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    salt: z.string().min(1)
  }),
  nonce: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string()
})
export type VaultEnvelope = z.infer<typeof vaultEnvelopeSchema>

/* -------------------------------------------------------------------------- */
/* 底层工具                                                                    */
/* -------------------------------------------------------------------------- */

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 密钥材料用完清零（best-effort：V8 可能已把内容复制到别处，但至少不留引用） */
export function zeroize(...buffers: (Buffer | null | undefined)[]): void {
  for (const buffer of buffers) {
    if (buffer && buffer.length > 0) buffer.fill(0)
  }
}

function decodeBase64(value: string, failure: VaultCryptoFailure, label: string): Buffer {
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length === 0) throw new VaultCryptoError(failure, `${label} is empty`)
  return buffer
}

function decodeFixed(value: string, length: number, failure: VaultCryptoFailure, label: string): Buffer {
  const buffer = decodeBase64(value, failure, label)
  if (buffer.length !== length) {
    throw new VaultCryptoError(failure, `${label} has unexpected length ${buffer.length} (expected ${length})`)
  }
  return buffer
}

function assertCostWithinBounds(cost: ScryptCost, failure: VaultCryptoFailure = 'bad-params'): void {
  const { N, r, p } = cost
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new VaultCryptoError(failure, 'scrypt cost must be integers')
  }
  if ((N & (N - 1)) !== 0 || N < COST_LIMITS.minN || N > COST_LIMITS.maxN) {
    throw new VaultCryptoError(failure, `scrypt N out of range: ${N}`)
  }
  if (r < 1 || r > COST_LIMITS.maxR || p < 1 || p > COST_LIMITS.maxP) {
    throw new VaultCryptoError(failure, `scrypt r/p out of range: r=${r} p=${p}`)
  }
}

/** AES-256-GCM 加密；每次随机 12B nonce，AAD 由调用方给出（必须绑定版本/参数） */
export function sealBox(key: Buffer, plaintext: Buffer, aad: string): SealedBox {
  if (key.length !== KEY_BYTES) throw new VaultCryptoError('bad-params', `key must be ${KEY_BYTES} bytes`)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ENVELOPE_CIPHER, key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    nonce: nonce.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

/**
 * 解密 + 认证。失败一律抛 VaultCryptoError，`failure` 决定归因（口令错 vs 数据损坏）。
 * 注意：这里**不做**任何回退（没有「解不开就当明文」的分支）。
 */
export function openBox(key: Buffer, box: SealedBox, aad: string, failure: VaultCryptoFailure): Buffer {
  if (key.length !== KEY_BYTES) throw new VaultCryptoError('bad-params', `key must be ${KEY_BYTES} bytes`)
  const nonce = decodeFixed(box.nonce, NONCE_BYTES, failure, 'nonce')
  const tag = decodeFixed(box.tag, TAG_BYTES, failure, 'tag')
  const ciphertext = decodeBase64(box.ciphertext, failure, 'ciphertext')
  try {
    const decipher = createDecipheriv(ENVELOPE_CIPHER, key, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    // GCM 认证失败：口令/恢复码错，或者数据在摘要校验之后又被改过。
    throw new VaultCryptoError(failure, 'AES-256-GCM authentication failed')
  }
}

/** scrypt 派生 KEK。必须显式给 maxmem：N=2^17 时默认 32MB 上限会直接失败。 */
export function deriveKek(secret: string, cost: ScryptCost, salt: Buffer): Buffer {
  assertCostWithinBounds(cost)
  const maxmem = 128 * cost.N * cost.r * 2 + 1024 * 1024
  return scryptSync(secret.normalize('NFKC'), salt, KEY_BYTES, { N: cost.N, r: cost.r, p: cost.p, maxmem })
}

/* -------------------------------------------------------------------------- */
/* AAD                                                                         */
/* -------------------------------------------------------------------------- */

/** payload 的 AAD 只绑定 format+版本（不含 revision：换密钥时 payload 字节可以原样保留） */
export function payloadAad(): string {
  return `${MANIFEST_FORMAT}|v${MANIFEST_VERSION}|payload`
}

export function passphraseAad(cost: ScryptCost, saltBase64: string): string {
  return `${MANIFEST_FORMAT}|v${MANIFEST_VERSION}|key|passphrase|N=${cost.N}|r=${cost.r}|p=${cost.p}|salt=${saltBase64}`
}

export function recoveryAad(saltBase64: string): string {
  return `${MANIFEST_FORMAT}|v${MANIFEST_VERSION}|key|recovery|salt=${saltBase64}`
}

/* -------------------------------------------------------------------------- */
/* 摘要                                                                        */
/* -------------------------------------------------------------------------- */

/** vault.enc 的落盘字节与其摘要必须一一对应：这是「数据损坏」的第一道判据 */
export function serializeEnvelope(envelope: VaultEnvelope): Buffer {
  return Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8')
}

export function parseEnvelope(bytes: Buffer | string): VaultEnvelope {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultCryptoError('corrupt', 'vault.enc is not valid JSON')
  }
  const marker = (raw as { format?: unknown } | null)?.format
  if (typeof marker === 'string' && marker !== MANIFEST_FORMAT) {
    throw new VaultCryptoError('unsupported-format', `vault.enc belongs to another format: ${marker}`)
  }
  if (marker !== MANIFEST_FORMAT) {
    // 是我们的文件必然带 format 标记；缺失说明这个文件不是我们写的，或者已被破坏
    throw new VaultCryptoError('corrupt', 'vault.enc is missing the termans-vault format marker')
  }
  const parsed = vaultEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw new VaultCryptoError('corrupt', `vault.enc header is malformed: ${first?.path.join('.')} ${first?.message}`)
  }
  return parsed.data
}

/** 密钥槽的规范化摘要：manifest 里任何槽位/参数被改都会让 keywrap_sha256 对不上 */
export function keywrapDigest(manifest: Pick<VaultManifest, 'kdf' | 'passphraseKey' | 'recoveryKey'>): string {
  const canonical = JSON.stringify({
    kdf: { name: manifest.kdf.name, N: manifest.kdf.N, r: manifest.kdf.r, p: manifest.kdf.p },
    passphraseKey: {
      nonce: manifest.passphraseKey.nonce,
      tag: manifest.passphraseKey.tag,
      ciphertext: manifest.passphraseKey.ciphertext
    },
    recoveryKey: {
      salt: manifest.recoveryKey.salt,
      nonce: manifest.recoveryKey.nonce,
      tag: manifest.recoveryKey.tag,
      ciphertext: manifest.recoveryKey.ciphertext
    }
  })
  return sha256Hex(canonical)
}

export function payloadDigest(encBytes: Buffer): string {
  return sha256Hex(encBytes)
}

/**
 * 结构/摘要校验：任何一条不符都归因为「数据损坏」，绝不继续尝试解密。
 * 顺序很重要——先校验摘要再派生密钥，能省掉一次 300ms 的 scrypt。
 */
export function assertIntegrity(manifest: VaultManifest, encBytes: Buffer, envelope?: VaultEnvelope): VaultEnvelope {
  if (manifest.format !== MANIFEST_FORMAT) {
    throw new VaultCryptoError('unsupported-format', `manifest format must be ${MANIFEST_FORMAT}, got ${manifest.format}`)
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new VaultCryptoError(
      'unsupported-format',
      `manifest version ${manifest.version} is newer or unknown (this build understands v${MANIFEST_VERSION})`
    )
  }
  if (manifest.cipher !== ENVELOPE_CIPHER) {
    throw new VaultCryptoError('unsupported-format', `unsupported cipher: ${manifest.cipher}`)
  }

  const parsedEnvelope = envelope ?? parseEnvelope(encBytes)
  if (parsedEnvelope.version !== manifest.version) {
    throw new VaultCryptoError('corrupt', 'manifest.version and vault.enc.version disagree')
  }

  const actualPayloadDigest = payloadDigest(encBytes)
  if (!safeEqualHex(actualPayloadDigest, manifest.payload_sha256)) {
    throw new VaultCryptoError(
      'corrupt',
      `vault.enc digest mismatch: manifest says ${manifest.payload_sha256.slice(0, 12)}…, file is ${actualPayloadDigest.slice(0, 12)}…`
    )
  }
  const expectedKeywrap = keywrapDigest(manifest)
  if (!safeEqualHex(expectedKeywrap, manifest.keywrap_sha256)) {
    throw new VaultCryptoError('corrupt', 'manifest key slots were modified (keywrap_sha256 mismatch)')
  }
  // manifest 与 vault.enc 的参数必须一致：不一致说明两者来自不同次写入（半写/回滚/手工编辑）
  const envCost = parsedEnvelope.kdf
  if (envCost.N !== manifest.kdf.N || envCost.r !== manifest.kdf.r || envCost.p !== manifest.kdf.p) {
    throw new VaultCryptoError('corrupt', 'manifest.kdf and vault.enc kdf disagree')
  }
  assertCostWithinBounds({ N: envCost.N, r: envCost.r, p: envCost.p }, 'bad-params')
  return parsedEnvelope
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/* -------------------------------------------------------------------------- */
/* 高层 API                                                                    */
/* -------------------------------------------------------------------------- */

export interface CreateVaultInput {
  /** 明文 payload（JSON 字符串）；调用方负责先序列化并校验 schema */
  payload: string
  passphrase: string
  recoveryCode: string
  revision?: number
  cost?: ScryptCost
  now?: Date
}

export interface CreatedVault {
  manifest: VaultManifest
  encBytes: Buffer
  /** 调用方拿到后只应放进内存/内存 keychain，且用完 zeroize */
  vaultKey: Buffer
}

export function createVault(input: CreateVaultInput): CreatedVault {
  const cost = input.cost ?? SCRYPT_PRODUCTION
  const revision = input.revision ?? 0
  const now = input.now ?? new Date()
  const payloadBytes = Buffer.from(input.payload, 'utf8')
  const vaultKey = randomBytes(KEY_BYTES)

  const passSalt = randomBytes(SALT_BYTES)
  const passKek = deriveKek(input.passphrase, cost, passSalt)
  const passphraseBox = sealBox(passKek, vaultKey, passphraseAad(cost, passSalt.toString('base64')))
  zeroize(passKek)

  const recoverySalt = randomBytes(SALT_BYTES)
  const recoveryKek = deriveKek(normalizeRecoveryCode(input.recoveryCode) ?? input.recoveryCode, cost, recoverySalt)
  const recoveryBox = sealBox(recoveryKek, vaultKey, recoveryAad(recoverySalt.toString('base64')))
  zeroize(recoveryKek)

  const envelope: VaultEnvelope = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    cipher: ENVELOPE_CIPHER,
    kdf: { name: 'scrypt', N: cost.N, r: cost.r, p: cost.p, salt: passSalt.toString('base64') },
    ...sealBox(vaultKey, payloadBytes, payloadAad())
  }
  const encBytes = serializeEnvelope(envelope)
  const manifest: VaultManifest = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    cipher: ENVELOPE_CIPHER,
    kdf: { name: 'scrypt', N: cost.N, r: cost.r, p: cost.p },
    passphraseKey: passphraseBox,
    recoveryKey: { ...recoveryBox, salt: recoverySalt.toString('base64') },
    revision,
    payload_sha256: payloadDigest(encBytes),
    keywrap_sha256: '',
    updated_at: now.toISOString()
  }
  manifest.keywrap_sha256 = keywrapDigest(manifest)
  return { manifest, encBytes, vaultKey }
}

export type UnlockCredential = { passphrase: string } | { recoveryCode: string } | { vaultKey: Buffer }

export interface OpenVaultInput {
  manifest: VaultManifest
  encBytes: Buffer
  credential: UnlockCredential
  envelope?: VaultEnvelope
}

export interface OpenedVault {
  payload: string
  vaultKey: Buffer
  slot: 'passphrase' | 'recovery' | 'keychain'
}

/**
 * 解锁：先摘要，再派生，再 GCM。
 * 返回的 `vaultKey` 交由调用方持有（内存会话密钥 / keychain 包裹），本函数不清零它。
 */
export function openVault(input: OpenVaultInput): OpenedVault {
  const envelope = assertIntegrity(input.manifest, input.encBytes, input.envelope)
  const payloadBytes = openPayloadBytes(input.manifest, envelope, input.credential)
  const vaultKey = payloadBytes.vaultKey
  try {
    return { payload: payloadBytes.payload.toString('utf8'), vaultKey, slot: payloadBytes.slot }
  } finally {
    zeroize(payloadBytes.payload)
  }
}

function openPayloadBytes(
  manifest: VaultManifest,
  envelope: VaultEnvelope,
  credential: UnlockCredential
): { payload: Buffer; vaultKey: Buffer; slot: 'passphrase' | 'recovery' | 'keychain' } {
  let vaultKey: Buffer
  let slot: 'passphrase' | 'recovery' | 'keychain'

  if ('vaultKey' in credential) {
    vaultKey = Buffer.from(credential.vaultKey)
    slot = 'keychain'
  } else if ('passphrase' in credential) {
    const salt = decodeFixed(envelope.kdf.salt, SALT_BYTES, 'corrupt', 'kdf.salt')
    const kek = deriveKek(credential.passphrase, { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p }, salt)
    try {
      vaultKey = openBox(kek, manifest.passphraseKey, passphraseAad(manifest.kdf, envelope.kdf.salt), 'bad-passphrase')
    } finally {
      zeroize(kek)
    }
    slot = 'passphrase'
  } else {
    const salt = decodeFixed(manifest.recoveryKey.salt, SALT_BYTES, 'corrupt', 'recoveryKey.salt')
    const kek = deriveKek(normalizeRecoveryCode(credential.recoveryCode) ?? credential.recoveryCode, manifest.kdf, salt)
    try {
      vaultKey = openBox(kek, manifest.recoveryKey, recoveryAad(manifest.recoveryKey.salt), 'bad-recovery-code')
    } finally {
      zeroize(kek)
    }
    slot = 'recovery'
  }

  try {
    const payload = openBox(vaultKey, envelope, payloadAad(), 'corrupt')
    return { payload, vaultKey, slot }
  } catch (error) {
    zeroize(vaultKey)
    // 摘要已通过却仍认证失败：只可能是「密钥槽与 payload 不配套」（半写/回滚），归为数据损坏
    throw error instanceof VaultCryptoError ? error : new VaultCryptoError('corrupt', 'payload authentication failed')
  }
}

export interface RawSealInput {
  manifest: VaultManifest
  vaultKey: Buffer
  payload: string
  revision: number
  /** 远端/旧 vault.enc 的 kdf.salt：换 payload 时必须沿用，否则口令槽解不开（AAD 绑定 salt） */
  kdfSalt: string
  now?: Date
}

/** 只重封 payload（改数据时用）：密钥槽、kdf 参数、salt 全部保持不变 */
export function resealPayload(input: RawSealInput): { manifest: VaultManifest; encBytes: Buffer } {
  const now = input.now ?? new Date()
  const envelope: VaultEnvelope = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    cipher: ENVELOPE_CIPHER,
    kdf: { name: 'scrypt', N: input.manifest.kdf.N, r: input.manifest.kdf.r, p: input.manifest.kdf.p, salt: input.kdfSalt },
    ...sealBox(input.vaultKey, Buffer.from(input.payload, 'utf8'), payloadAad())
  }
  const encBytes = serializeEnvelope(envelope)
  const manifest: VaultManifest = {
    ...input.manifest,
    revision: input.revision,
    payload_sha256: payloadDigest(encBytes),
    updated_at: now.toISOString()
  }
  manifest.keywrap_sha256 = keywrapDigest(manifest)
  return { manifest, encBytes }
}

export interface RewrapInput {
  manifest: VaultManifest
  /** 当前 vault.enc（要沿用它里面的 kdf.salt 才能验证旧口令 / 重封 payload） */
  encBytes: Buffer
  vaultKey: Buffer
  passphrase?: string
  recoveryCode?: string
  cost?: ScryptCost
  revision: number
  now?: Date
}

/**
 * 轮换入口：用当前的 VMK 重新包裹密钥槽。
 * - `rotate`：换口令 + 换恢复码（两个槽都换）。
 * - `recover`：只换口令槽，恢复码槽原样保留（契约 `vault:recover` 不返回新恢复码，
 *   详见 docs/VAULT-SYNC.md 的「与 SPEC S-08 的偏差」一节）。
 * - VMK 不变：这样才能「A 机轮换后 B 机仍能用内存里的 VMK 解远端 payload」。
 */
export function rewrapVault(input: RewrapInput): { manifest: VaultManifest; encBytes: Buffer } {
  const envelope = parseEnvelope(input.encBytes)
  const cost = input.cost ?? input.manifest.kdf
  const now = input.now ?? new Date()

  let passphraseKey = input.manifest.passphraseKey
  let passphraseSalt = envelope.kdf.salt
  if (input.passphrase !== undefined) {
    passphraseSalt = randomBytes(SALT_BYTES).toString('base64')
    const kek = deriveKek(input.passphrase, cost, Buffer.from(passphraseSalt, 'base64'))
    try {
      passphraseKey = sealBox(kek, input.vaultKey, passphraseAad(cost, passphraseSalt))
    } finally {
      zeroize(kek)
    }
  }

  let recoveryKey = input.manifest.recoveryKey
  if (input.recoveryCode !== undefined) {
    const recoverySalt = randomBytes(SALT_BYTES).toString('base64')
    const kek = deriveKek(input.recoveryCode, cost, Buffer.from(recoverySalt, 'base64'))
    try {
      recoveryKey = { ...sealBox(kek, input.vaultKey, recoveryAad(recoverySalt)), salt: recoverySalt }
    } finally {
      zeroize(kek)
    }
  }

  // payload 用同一把 VMK 重新加密（新 nonce），顺带把 kdf.salt 换成新的口令槽 salt
  const payloadBytes = openBox(input.vaultKey, envelope, payloadAad(), 'corrupt')
  try {
    const nextEnvelope: VaultEnvelope = {
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      cipher: ENVELOPE_CIPHER,
      kdf: { name: 'scrypt', N: cost.N, r: cost.r, p: cost.p, salt: passphraseSalt },
      ...sealBox(input.vaultKey, payloadBytes, payloadAad())
    }
    const encBytes = serializeEnvelope(nextEnvelope)
    const manifest: VaultManifest = {
      format: MANIFEST_FORMAT,
      version: MANIFEST_VERSION,
      cipher: ENVELOPE_CIPHER,
      kdf: { name: 'scrypt', N: cost.N, r: cost.r, p: cost.p },
      passphraseKey,
      recoveryKey,
      revision: input.revision,
      payload_sha256: payloadDigest(encBytes),
      keywrap_sha256: '',
      updated_at: now.toISOString()
    }
    manifest.keywrap_sha256 = keywrapDigest(manifest)
    return { manifest, encBytes }
  } finally {
    zeroize(payloadBytes)
  }
}
