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

/**
 * 允许的 kdf 参数区间 + 内存预算。
 *
 * kdf 参数来自**远端** `manifest.json`（同步仓库可被投毒），而 scrypt 的内存开销是
 * 128*N*r 字节 —— 一条 N=2^20,r=32 的声明就是一次 4 GiB 分配，等于把「打开别人的仓库」
 * 变成一行 DoS。所以设**两道独立闸门**：
 *
 * 1. 逐字段区间（COST_LIMITS）：挡住形状离谱的组合；
 * 2. 内存预算（KDF_MEMORY_BUDGET_BYTES）：按 128*N*r 实算，超预算就拒。
 *
 * 只留闸门 1 不够：N=2^18、r=16 每个字段都在区间内，但 128*2^18*16 = 512 MiB，
 * 加上 Node 的额外副本足以拖垮低内存机器；只留闸门 2 也不够，它对「N 不是 2 的幂」
 * 这类形状没有意见。两道都要有，因为 `maxmem` 是这块唯一的硬闸。
 *
 * 区间取「生产参数附近」：生产是 N=2^17,r=8,p=1（134 MiB）；上限 N=2^18（8 倍工作量）、
 * r=16、p=4，给未来把 N 提到 2^18 留出余量。
 */
const COST_LIMITS = { minN: 1 << 14, maxN: 1 << 18, maxR: 16, maxP: 4 } as const

/** scrypt 单次派生的内存硬预算：512 MiB（生产 134 MiB，留约 3.8 倍余量） */
export const KDF_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024

/** scrypt 的近似内存占用（RFC 7914：128 * N * r 字节） */
export function estimateKdfMemoryBytes(cost: Pick<ScryptCost, 'N' | 'r'>): number {
  return 128 * cost.N * cost.r
}

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

/**
 * kdf 参数闸门：**必须在任何派生之前**调用（`assertIntegrity()` 里是唯一入口，
 * 所以伪造 manifest 在 `deriveKek()` 之前就会被拒，不会真的去分配几百 MB）。
 *
 * 导出是为了让测试能直接断言边界值，而不必真的跑一次大参数 scrypt。
 */
export function assertCostWithinBounds(cost: ScryptCost, failure: VaultCryptoFailure = 'bad-params'): void {
  const { N, r, p } = cost
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new VaultCryptoError(failure, 'scrypt cost must be integers')
  }
  if ((N & (N - 1)) !== 0 || N < COST_LIMITS.minN || N > COST_LIMITS.maxN) {
    throw new VaultCryptoError(
      failure,
      `scrypt N out of range: ${N} (allowed ${COST_LIMITS.minN}..${COST_LIMITS.maxN})`
    )
  }
  if (r < 1 || r > COST_LIMITS.maxR || p < 1 || p > COST_LIMITS.maxP) {
    throw new VaultCryptoError(
      failure,
      `scrypt r/p out of range: r=${r} p=${p} (allowed r<=${COST_LIMITS.maxR} p<=${COST_LIMITS.maxP})`
    )
  }
  // 闸门 2：逐字段都在区间内也可能刚好顶到预算（N=2^18, r=16 → 512 MiB），
  // 按 128*N*r 实算一遍；**达到或超过**预算即拒（预算本身就是上限，不做「等于预算」的分配）
  const required = estimateKdfMemoryBytes({ N, r })
  if (required >= KDF_MEMORY_BUDGET_BYTES) {
    throw new VaultCryptoError(
      failure,
      `scrypt kdf needs ${Math.round(required / (1024 * 1024))} MiB (128*N*r), over the ${Math.round(
        KDF_MEMORY_BUDGET_BYTES / (1024 * 1024)
      )} MiB budget: N=${N} r=${r} p=${p}`
    )
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

/* -------------------------------------------------------------------------- */
/* 槽-盐同源：唯一封装入口（I1 / I2）                                           */
/* -------------------------------------------------------------------------- */

/**
 * 口令槽的**唯一**封装入口：salt 由调用方给出（只在 createVault / rewrapVault /
 * resealPassphraseSlot 三处生成），KEK 派生与 AAD 绑定都收在这里。
 *
 * 为什么必须收成一个函数：D1 的成因就是「槽」与「盐」可以分别来源。只要还存在第二处
 * `deriveKek(passphrase, cost, salt)` + `sealBox(kek, …)` 的临时拼装点，就又有机会拼出
 * 「A 机的槽 + B 机的盐」—— 那种组合能通过全部摘要，只在 AES-GCM 上失败，症状与
 * 「口令真的错了」不可区分（bad-passphrase）。
 */
function sealPassphraseKey(vaultKey: Buffer, passphrase: string, cost: ScryptCost, saltBase64: string): SealedBox {
  const kek = deriveKek(passphrase, cost, Buffer.from(saltBase64, 'base64'))
  try {
    return sealBox(kek, vaultKey, passphraseAad(cost, saltBase64))
  } finally {
    zeroize(kek)
  }
}

/**
 * payload 信封的**唯一**封装入口：盐必须装在信封里（I2：盐只有一个来源）。
 * AAD、摘要、落盘字节都从这里派生，调用方拿不到「绕过盐」的路径。
 */
function sealEnvelope(
  vaultKey: Buffer,
  payloadBytes: Buffer,
  cost: ScryptCost,
  saltBase64: string
): { envelope: VaultEnvelope; encBytes: Buffer } {
  const envelope: VaultEnvelope = {
    format: MANIFEST_FORMAT,
    version: MANIFEST_VERSION,
    cipher: ENVELOPE_CIPHER,
    kdf: { name: 'scrypt', N: cost.N, r: cost.r, p: cost.p, salt: saltBase64 },
    ...sealBox(vaultKey, payloadBytes, payloadAad())
  }
  return { envelope, encBytes: serializeEnvelope(envelope) }
}

/**
 * scrypt 派生 KEK。必须显式给 maxmem：N=2^17 时默认 32MB 上限会直接失败。
 * 参数闸门（`assertCostWithinBounds`）在这里再跑一次——即使调用方跳过了
 * `assertIntegrity()`（例如内存里的 VMK 路径），也不可能带着超预算参数进 scrypt。
 */
export function deriveKek(secret: string, cost: ScryptCost, salt: Buffer): Buffer {
  assertCostWithinBounds(cost)
  // 128*N*r 是数据区，scrypt 还需要同等量级的临时缓冲；给 2 倍 + 1 MiB 余量
  const maxmem = estimateKdfMemoryBytes(cost) * 2 + 1024 * 1024
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
 * AC-2 口径的**唯一**实现：`sha256(Buffer.from(passphraseKey.ciphertext,'base64'))` 的前 8 位小写 hex。
 *
 * 指纹回答的是「本机上次能开的那只口令槽，是不是眼前这只」——它刻意只看槽密文
 * （不解密、不需要口令、不需要 VMK），所以锁定时也能自证；也刻意不掺 salt：
 * 槽密文本身已经与 salt 绑定（AAD 覆盖 salt），掺进去只会让两个实现分别漂移。
 * 归因层（attribution.ts）与渲染层只消费这个结果，**禁止**各自重算一遍。
 */
export function slotFingerprint(manifest: Pick<VaultManifest, 'passphraseKey'>): string {
  const ciphertext = decodeBase64(manifest.passphraseKey.ciphertext, 'corrupt', 'passphraseKey.ciphertext')
  return sha256Hex(ciphertext).slice(0, 8)
}

/**
 * AC-22 硬断言：调用方声明「我以为现在用的是这只盐」，与信封实际携带的盐不等即抛。
 *
 * 盐的**唯一来源永远是 envelope**：调用方只能声明期望值，不能提供新值。把「自由传盐」
 * 换成「声明期望值 + 目前信封」之后，槽盐错配在函数入口就被拒，而不是等到下游
 * AES-GCM 失败再被误报成 bad-passphrase（AC-20 的症状）。
 */
export function assertKdfSalt(expected: string, envelope: VaultEnvelope): void {
  const expectedBytes = decodeFixed(expected, SALT_BYTES, 'corrupt', 'expectedKdfSalt')
  const actualBytes = decodeFixed(envelope.kdf.salt, SALT_BYTES, 'corrupt', 'envelope.kdf.salt')
  if (!timingSafeEqual(expectedBytes, actualBytes)) {
    // 不把任何一侧的盐写进消息：错误文案会进日志与诊断区
    throw new VaultCryptoError(
      'corrupt',
      'kdf salt mismatch: slot and envelope do not belong to the same vault (槽盐错配，拒绝按这只盐重封)'
    )
  }
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

/**
 * 结构一致性自检（写盘前用）：manifest.kdf 与 envelope.kdf 必须同参，且 keywrap 摘要必须可重算。
 *
 * 边界必须说清：它**发现不了**「槽与盐来自不同库」——那两者的 kdf 参数往往一模一样、
 * keywrap 摘要也自洽，唯一能把它们对上的是本机权威指纹（`LocalSlotRecord.slot.fingerprint`
 * 与 `slotFingerprint()` 对账，由归因层判定）。所以这道检查挡的是结构性漂移（半写/改参/改槽），
 * 不是身份错配；两者都要有，缺一都不是完整的守卫。
 */
export function assertSlotBinding(manifest: VaultManifest, envelope: VaultEnvelope): void {
  if (manifest.kdf.N !== envelope.kdf.N || manifest.kdf.r !== envelope.kdf.r || manifest.kdf.p !== envelope.kdf.p) {
    throw new VaultCryptoError('corrupt', 'manifest.kdf and vault.enc kdf disagree (slot binding broken)')
  }
  if (!safeEqualHex(keywrapDigest(manifest), manifest.keywrap_sha256)) {
    throw new VaultCryptoError('corrupt', 'manifest key slots were modified (keywrap_sha256 mismatch)')
  }
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

  const passSalt = randomBytes(SALT_BYTES).toString('base64')
  const passphraseBox = sealPassphraseKey(vaultKey, input.passphrase, cost, passSalt)

  const recoverySalt = randomBytes(SALT_BYTES)
  const recoveryKek = deriveKek(normalizeRecoveryCode(input.recoveryCode) ?? input.recoveryCode, cost, recoverySalt)
  const recoveryBox = sealBox(recoveryKek, vaultKey, recoveryAad(recoverySalt.toString('base64')))
  zeroize(recoveryKek)

  const { encBytes } = sealEnvelope(vaultKey, payloadBytes, cost, passSalt)
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
  /**
   * AC-9 计数钩子：**每次口令 KEK 派生**回调一次（口令分支恰好一次；recovery/keychain 分支不调）。
   * 只用于测试与诊断（数「这一次解锁一共派生了几个 KEK」），不改变任何行为、不影响返回值。
   */
  onKekDerived?: () => void
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
  const payloadBytes = openPayloadBytes(input.manifest, envelope, input.credential, input.onKekDerived)
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
  credential: UnlockCredential,
  onKekDerived?: () => void
): { payload: Buffer; vaultKey: Buffer; slot: 'passphrase' | 'recovery' | 'keychain' } {
  let vaultKey: Buffer
  let slot: 'passphrase' | 'recovery' | 'keychain'

  if ('vaultKey' in credential) {
    vaultKey = Buffer.from(credential.vaultKey)
    slot = 'keychain'
  } else if ('passphrase' in credential) {
    const salt = decodeFixed(envelope.kdf.salt, SALT_BYTES, 'corrupt', 'kdf.salt')
    const kek = deriveKek(credential.passphrase, { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p }, salt)
    // AC-9：每次口令派生回调一次（放在 deriveKek 之后、GCM 之前——口令错了也如实计数，
    // 否则「≤4 次派生」的判据会被失败路径拉高却不自知）
    onKekDerived?.()
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
  /** 当前 `vault.enc` 的信封：**盐的唯一来源**（I2）。调用方不能再自己捏一只盐进来 */
  envelope: VaultEnvelope
  /** AC-22 硬断言：调用方「以为」现在用的是这只盐；与 `envelope.kdf.salt` 不等即抛 */
  expectedKdfSalt: string
  vaultKey: Buffer
  payload: string
  revision: number
  now?: Date
}

/**
 * 只重封 payload（改数据时用）：密钥槽、kdf 参数、盐全部保持不变。
 *
 * 与旧签名（自由 `kdfSalt`）的区别不是风格，而是缺陷边界：旧写法允许「槽来自 A 机、
 * 盐来自 B 机」这种组合通过全部摘要，只在 AES-GCM 上以 `bad-passphrase` 现形——
 * 与「口令真的错了」不可区分。现在盐只能取自传入的信封，调用方只能声明期望值。
 */
export function resealPayload(input: RawSealInput): { manifest: VaultManifest; envelope: VaultEnvelope; encBytes: Buffer } {
  const now = input.now ?? new Date()
  // AC-22：入口即拒（回退点 = 删掉这一行，错配用例立刻由「抛」变「不抛」）
  assertKdfSalt(input.expectedKdfSalt, input.envelope)
  const cost: ScryptCost = { N: input.manifest.kdf.N, r: input.manifest.kdf.r, p: input.manifest.kdf.p }
  const { envelope, encBytes } = sealEnvelope(input.vaultKey, Buffer.from(input.payload, 'utf8'), cost, input.envelope.kdf.salt)
  const manifest: VaultManifest = {
    ...input.manifest,
    revision: input.revision,
    payload_sha256: payloadDigest(encBytes),
    updated_at: now.toISOString()
  }
  manifest.keywrap_sha256 = keywrapDigest(manifest)
  return { manifest, envelope, encBytes }
}

export interface ResealPassphraseSlotInput {
  manifest: VaultManifest
  /** 当前 `vault.enc`：既是旧盐来源，也是「payload 用哪把 VMK 加密」的判据 */
  envelope: VaultEnvelope
  vaultKey: Buffer
  /** 已规范化的口令（AC-7 的规范形由 `passphrase.ts:canonicalPassphrase` 给出，本层不重复实现） */
  passphrase: string
  cost?: ScryptCost
  revision: number
  now?: Date
}

/**
 * AC-7：非原样变体命中后，用**规范形口令 + 新 salt + 新 nonce** 重封口令槽（VMK 不变）。
 *
 * 这是全仓**唯一**的「换盐」入口（`rewrapVault` 是 rotate/recover 的另一个语义入口，
 * 二者共用 `sealPassphraseKey` 的单点实现）。任何第三处「新 salt + sealBox」的拼装
 * 都会把 D1（槽盐可分离）重新打开。
 *
 * 返回的是**成对**结果（manifest + envelope + 字节）并当场 `assertSlotBinding` 自检；
 * `fingerprint` 回传给 manager 记进 `LocalSlotRecord`，锁定时才能自证「上次能开的是哪只槽」。
 */
export function resealPassphraseSlot(input: ResealPassphraseSlotInput): {
  manifest: VaultManifest
  envelope: VaultEnvelope
  encBytes: Buffer
  fingerprint: string
} {
  const now = input.now ?? new Date()
  const current: ScryptCost = { N: input.manifest.kdf.N, r: input.manifest.kdf.r, p: input.manifest.kdf.p }
  const cost: ScryptCost = input.cost ?? current
  // 恢复码槽的 KEK 是用 manifest.kdf 派生的（recovery 的 AAD 只绑自己的 salt，但参数来自 manifest.kdf）。
  // 换放 kdf 参数会让「口令能开、恢复码开不了」，而这里拿不到恢复码、无法同步重封 —— 所以直接拒，不做半套。
  if (cost.N !== current.N || cost.r !== current.r || cost.p !== current.p) {
    throw new VaultCryptoError(
      'bad-params',
      'resealPassphraseSlot cannot change scrypt cost: the recovery slot still binds the old cost (rotate instead)'
    )
  }

  // 先把 payload 解出来：VMK 与这只信封不配套时立刻 corrupt（绝不产出「新槽包着旧 payload」的半成品）
  const payloadBytes = openBox(input.vaultKey, input.envelope, payloadAad(), 'corrupt')
  try {
    const salt = randomBytes(SALT_BYTES).toString('base64')
    const passphraseKey = sealPassphraseKey(input.vaultKey, input.passphrase, cost, salt)
    const { envelope, encBytes } = sealEnvelope(input.vaultKey, payloadBytes, cost, salt)
    const manifest: VaultManifest = {
      ...input.manifest,
      kdf: { name: 'scrypt', N: cost.N, r: cost.r, p: cost.p },
      passphraseKey,
      // 恢复码槽原样保留：它的 salt/AAD 自成一体，不受口令槽换盐影响
      recoveryKey: input.manifest.recoveryKey,
      revision: input.revision,
      payload_sha256: payloadDigest(encBytes),
      updated_at: now.toISOString()
    }
    manifest.keywrap_sha256 = keywrapDigest(manifest)
    assertSlotBinding(manifest, envelope)
    return { manifest, envelope, encBytes, fingerprint: slotFingerprint(manifest) }
  } finally {
    zeroize(payloadBytes)
  }
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
    passphraseKey = sealPassphraseKey(input.vaultKey, input.passphrase, cost, passphraseSalt)
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
    const { encBytes } = sealEnvelope(input.vaultKey, payloadBytes, cost, passphraseSalt)
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
