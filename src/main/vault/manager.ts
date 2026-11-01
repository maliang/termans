import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  syncRepoSchema,
  type GroupInput,
  type GroupRecord,
  type HostInput,
  type HostLibrary,
  type HostRecord,
  type HostSortUpdate,
  type KnownHostEntry,
  type KnownHostRemoveRequest,
  type KnownHostTrustRequest,
  type Settings,
  type SshConfigImportResult,
  type SshConfigParseResult,
  type ThemeDefinition,
  type VaultCreateResult,
  type VaultRecoveryRequest,
  type VaultRotateRequest,
  type VaultState,
  type VaultStatus,
  type VaultUnlockFailure,
  type VaultVariantNotice
} from '@shared'
import {
  SCRYPT_PRODUCTION,
  assertSlotBinding,
  createVault,
  generateRecoveryCode,
  normalizeRecoveryCode,
  openVault,
  parseEnvelope,
  resealPassphraseSlot,
  resealPayload,
  rewrapVault,
  sha256Hex,
  slotFingerprint,
  zeroize,
  type ScryptCost,
  type VaultEnvelope,
  type VaultManifest
} from '../crypto'
import {
  MIN_PASSPHRASE_LENGTH,
  assessPassphrase,
  canonicalPassphrase,
  passphraseVariants,
  type PassphraseCandidate,
  type PassphraseVariant
} from '../crypto/passphrase'
import { classifyUnlockFailure } from './attribution'
import { CredentialStore } from './credentials'
import { lockedError, rethrowCrypto, vaultFail, type VaultFailureReason } from './errors'
import {
  clearSecret as clearPayloadSecret,
  createGroupRecord,
  createHostRecord,
  deleteGroupRecord,
  deleteHostRecord,
  getSecret as getPayloadSecret,
  listKnownHosts as listPayloadKnownHosts,
  removeKnownHost as removePayloadKnownHost,
  reorderHosts as reorderPayloadHosts,
  setSecret as setPayloadSecret,
  trustKnownHost as trustPayloadKnownHost,
  updateGroupRecord,
  updateHostRecord
} from './library'
import {
  countItems,
  emptyPayload,
  parsePayload,
  serializePayload,
  toHostLibrary,
  type VaultPayload
} from './model'
import { listThemeFiles, readRepo, writeRepo, type VaultRepoSnapshot } from './repo'
import { writePrivateFile, type SecretBox } from './secret-box'
import { filterSshConfigText, updateHostFields } from './ssh-config-text'

/** 本机私有状态（**不进仓库**）：仓库地址、上次同步的 revision、记住本机的会话包裹 */
/** 同步来源：三条同步路径写 payload 时都要声明，用于 slotAudit 归因 */
export type SlotDriftSource = 'sync-fast-forward' | 'sync-merge' | 'sync-push'

/**
 * 本机权威口令槽记录（AC-2 / AC-22）。
 *
 * 为什么它必须落在 local.json 而不是仓库里：仓库共享、会被远端覆盖，
 * 「上次能开的是什么」只有本机能证明；锁定时也能自证（不需要 VMK）。
 * `salt` 与 `passphraseKey` 是**成对**的：passphraseKey 的 AAD 绑的就是这只盐，
 * 拆开使用正是 r3 要消灭的 D1（槽与盐可分别来源）。
 */
export interface LocalSlotRecord {
  passphraseKey: VaultManifest['passphraseKey']
  recoveryKey: VaultManifest['recoveryKey']
  kdf: VaultManifest['kdf']
  salt: string
  fingerprint: string
  recordedAt: string
}

/** 槽审计（只留最近 SLOT_AUDIT_LIMIT 条）：回答「我的锁是什么时候被换掉的」 */
export interface SlotAuditEntry {
  action: 'slot-resealed' | 'slot-preserved' | 'slot-adopted'
  source?: SlotDriftSource
  variant?: PassphraseVariant
  fingerprint?: string
  at: string
}

export interface SlotDriftRecord {
  source: SlotDriftSource
  remoteFingerprint: string | null
  recordedFingerprint: string | null
  at: string
}

const SLOT_AUDIT_LIMIT = 20

const passphraseSlotSchema = z.custom<VaultManifest['passphraseKey']>((value) => value !== null && value !== undefined)
const recoverySlotSchema = z.custom<VaultManifest['recoveryKey']>((value) => value !== null && value !== undefined)
const kdfParamsSchema = z.custom<VaultManifest['kdf']>((value) => value !== null && value !== undefined)

const localSlotSchema = z.object({
  passphraseKey: passphraseSlotSchema,
  recoveryKey: recoverySlotSchema,
  kdf: kdfParamsSchema,
  salt: z.string().min(1),
  fingerprint: z.string().min(1),
  recordedAt: z.string().min(1)
})

const slotAuditSchema = z.object({
  action: z.enum(['slot-resealed', 'slot-preserved', 'slot-adopted']),
  source: z.enum(['sync-fast-forward', 'sync-merge', 'sync-push']).optional(),
  variant: z.enum(['identity', 'nfkc', 'trim', 'strip-zero-width']).optional(),
  fingerprint: z.string().optional(),
  at: z.string().min(1)
})

const slotDriftSchema = z.object({
  source: z.enum(['sync-fast-forward', 'sync-merge', 'sync-push']),
  remoteFingerprint: z.string().nullable(),
  recordedFingerprint: z.string().nullable(),
  at: z.string().min(1)
})

/**
 * 本机私有状态，v2：多了 `slot`（本机权威口令槽）、`slotDrift`（最近一次「远端换了槽」）、
 * `slotAudit`（槽变更审计）、`variantNotice`（AC-7 一次性告知条）。
 * v1 文件在 `loadLocal` 里升级（AC-18：老安装不迁目录、不丢会话）。
 */
const localStateSchema = z.object({
  version: z.number().int(),
  createdAt: z.string().nullable(),
  lastUnlockedAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  lastSyncedRevision: z.number().int().nullable(),
  lastSyncedPayloadSha: z.string().nullable(),
  repo: syncRepoSchema.nullable(),
  rememberedUntil: z.string().nullable(),
  slot: localSlotSchema.nullable(),
  slotDrift: slotDriftSchema.nullable(),
  slotAudit: z.array(slotAuditSchema),
  variantNotice: z
    .object({ variant: z.enum(['nfkc', 'trim', 'strip-zero-width']), at: z.string().min(1) })
    .nullable()
})
type LocalState = z.infer<typeof localStateSchema>

const sessionSchema = z.object({
  version: z.literal(1),
  /** SecretBox 包裹的 VMK（base64 明文在包裹里，落盘只有密文） */
  sealed: z.string().min(1),
  until: z.string().min(1)
})

function emptyLocalState(): LocalState {
  return {
    version: 2,
    createdAt: null,
    lastUnlockedAt: null,
    lastSyncedAt: null,
    lastSyncedRevision: null,
    lastSyncedPayloadSha: null,
    repo: null,
    rememberedUntil: null,
    slot: null,
    slotDrift: null,
    slotAudit: [],
    variantNotice: null
  }
}

/**
 * 从两种错误形状里取 `reason`：crypto 层直接抛的 `VaultCryptoError` 把 reason 放在顶层，
 * 而 `vaultFail()` 造的 `IpcCallError` 把它放在 `details.reason`（节流、仓储读写失败都是后者）。
 *
 * 单点定义是有意的：归因（`recordUnlockFailure`）与「哪些错误不该归因」（`unlock()` 的
 * uninitialized 例外）必须读同一份解析，否则两处会各错过一种形状。
 */
function reasonOf(error: unknown): VaultFailureReason | null {
  const shaped = error as { reason?: unknown; details?: { reason?: unknown } } | null | undefined
  const raw = shaped?.reason ?? shaped?.details?.reason
  return typeof raw === 'string' ? (raw as VaultFailureReason) : null
}

export interface VaultManagerOptions {
  /** 仓库工作区（userData/vault）：只有 manifest.json / vault.enc / themes/*.json */
  repoDir: string
  /** 本机私有目录（userData/vault-local）：凭据、会话、同步状态、冲突快照 */
  localDir: string
  box: SecretBox
  /** scrypt 参数；测试用小 N，生产用 SCRYPT_PRODUCTION */
  cost?: ScryptCost
  clock?: () => number
  /** 闲置自动上锁（分钟，0=关闭）；可以是函数以便跟随设置变化 */
  autoLockMinutes?: number | (() => number)
  /** true = 启动时不使用「记住本机」，必须输入口令 */
  requirePassphraseOnLaunch?: boolean | (() => boolean)
  /** 「记住本机」有效期（天） */
  rememberDays?: number
  /** 状态变化回调（feature 层转成 `vault:state-changed` 事件） */
  onStatus?: (status: VaultStatus) => void
  /** 每次本地数据变更后的回调（feature 层据此提交 Git / 标记 pendingLocalChanges） */
  onLocalChange?: () => void
  /** AC-5/AC-6：是否允许「受控输入变体」尝试（默认开；关掉后只认原样口令） */
  passphraseVariants?: boolean
  /** AC-9：每派生一次 KEK 调一次（测试用它数「变体循环只派生几次」） */
  onKekDerived?: () => void
}

/**
 * 主机库门面：口令 → 密钥 → 内存明文 → 落盘密文。
 *
 * 不变式（全部有测试守着）：
 * - **锁定时不持有任何明文**：`payload` / `vaultKey` 置 null，`hosts:list` 抛 `E_VAULT_LOCKED`，
 *   `VaultStatus.itemCounts` 为 null；
 * - 每次写操作都重新用**新 nonce** 加密整份 payload，`revision + 1`，
 *   `payload_sha256` 让远端能判断「这份密文是不是同一份内容」；
 * - 密钥槽只被 `rotate` / `recover` 改写，且 VMK 不变，
 *   所以「A 机轮换口令后 B 机仍能解远端 payload」。
 */
export class VaultManager {
  private readonly options: VaultManagerOptions
  private readonly cost: ScryptCost
  private readonly credentials: CredentialStore
  private readonly localPath: string
  private readonly sessionPath: string

  private local: LocalState = emptyLocalState()
  private manifest: VaultManifest | null = null
  private envelope: VaultEnvelope | null = null
  private encBytes: Buffer | null = null
  private payload: VaultPayload | null = null
  private vaultKey: Buffer | null = null
  /**
   * 单一真源：state 不再是一个可以独立赋值的字段，而是每次都从「payload 是否真的挂载」推导。
   * 曾经 state 与 payload 各走各的，于是出现过「vault:status 说 unlocked、hosts:list 抛 E_VAULT_LOCKED」
   * 这种自相矛盾（t8 的 F-1）。派生之后，两者不可能再不一致。
   */
  private deriveState(): VaultState {
    if (this.payload !== null && this.vaultKey !== null) return 'unlocked'
    if (this.manifest !== null || this.repoError !== null || this.local.createdAt !== null) return 'locked'
    return 'uninitialized'
  }

  private failedAttempts = 0
  private lockedUntilMs = 0
  private pendingWeak: { digest: string; at: number } | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private repoError: unknown = null
  /**
   * 最近一次解锁失败的四分类归因（AC-1..AC-3）。
   * **只由主进程写**：渲染层必须读 `status.unlockFailure`，不许拿 error.reason 反推 class
   * （DESIGN §7 第 2 条）——两处各维护一份映射，四分类就一定会有两种口径。
   */
  private lastUnlockFailure: VaultUnlockFailure | null = null

  /**
   * AC-7 告知条的**本进程副本**：`local.json` 里的记录在首次投递后即作废（一次性），
   * 但同一次运行里界面还没关掉它，所以内存再留一份直到用户关闭或进程退出。
   * 回退点＝把 `takeVariantNotice()` 里的清盘三行删掉：`告警条是一次性提示` 用例立刻红。
   */
  private deliveredVariantNotice: VaultVariantNotice | null = null

  constructor(options: VaultManagerOptions) {
    this.options = options
    this.cost = options.cost ?? SCRYPT_PRODUCTION
    mkdirSync(options.localDir, { recursive: true, mode: 0o700 })
    mkdirSync(options.repoDir, { recursive: true, mode: 0o700 })
    this.localPath = join(options.localDir, 'local.json')
    this.sessionPath = join(options.localDir, 'session.json')
    this.credentials = new CredentialStore({ dir: options.localDir, box: options.box })
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /** 启动握手：读仓库、尝试「记住本机」自动解锁；任何损坏都不在这里抛（否则窗口起不来） */
  init(): VaultStatus {
    this.local = this.loadLocal()
    this.repoError = null
    let snapshot: VaultRepoSnapshot | null = null
    try {
      snapshot = readRepo(this.options.repoDir, this.options.localDir)
    } catch (error) {
      this.repoError = error
      snapshot = null
      // AC-1：仓储读不出来（摘要对不上 / JSON 坏了 / 少了半个文件）属于「数据坏了」，
      // 不是「口令错了」。启动时就落一次归因，用户不必先白输一次口令才知道该去找备份；
      // 归因只写 `status.unlockFailure`，界面文案仍由渲染层按 class 取。
      this.recordUnlockFailure(error)
    }

    if (snapshot) {
      this.manifest = snapshot.manifest
      this.envelope = snapshot.envelope
      this.encBytes = snapshot.encBytes
      if (!this.requirePassphraseOnLaunch()) this.tryRestoreSession(snapshot)
    } else {
      this.manifest = null
      this.envelope = null
      this.encBytes = null
    }
    return this.status()
  }

  private tryRestoreSession(snapshot: VaultRepoSnapshot): void {
    const session = this.readSession()
    if (!session) return
    if (Date.parse(session.until) <= this.now()) {
      this.clearSession()
      return
    }
    try {
      const vaultKey = Buffer.from(this.options.box.decrypt(session.sealed), 'base64')
      const opened = openVault({
        manifest: snapshot.manifest,
        encBytes: snapshot.encBytes,
        credential: { vaultKey },
        envelope: snapshot.envelope,
        onKekDerived: this.options.onKekDerived
      })
      this.adopt(opened.payload, opened.vaultKey, snapshot)
      // AC-24：会话恢复**只写本机 local.json**（记下「这台机器上次能开的是哪只槽」），
      // 绝不重封、绝不写 repoDir。回退点 = 把这两行合并成 afterMutation()：
      // 那会重封并写盘，AC-24 的「零仓库写」用例立刻红。
      this.rememberSlot(snapshot.manifest, snapshot.envelope)
      this.lastUnlockFailure = null
      this.persistLocal()
    } catch {
      // 换机器 / keychain 变了 / 远端轮换过口令槽：静默丢弃会话，回到输入口令
      this.clearSession()
    }
  }

  status(): VaultStatus {
    const state = this.deriveState()
    const unlocked = state === 'unlocked'
    return {
      state,
      cipher: this.manifest ? 'aes-256-gcm' : null,
      kdf: this.manifest ? { ...this.manifest.kdf } : null,
      recoveryAvailable: this.manifest !== null,
      keychainBacked: this.hasSession(),
      repo: this.local.repo,
      policy: { secretsExcluded: true, privateKeysExcluded: true, plaintextHostnamesInRepo: false },
      itemCounts: unlocked ? countItems(this.payload!, listThemeFiles(this.options.repoDir).length) : null,
      createdAt: this.local.createdAt,
      lastUnlockedAt: this.local.lastUnlockedAt,
      lastSyncedAt: this.local.lastSyncedAt,
      // revision 是真值（manifest 自带）；slotFingerprint 来自**本机权威槽记录**，
      // 没有记录时按契约给 null（渲染层显示「未知」，绝不填 0 或当前时间）——
      // 锁定时也能给出这个值，正是 AC-2「拿本机记录对账」的前提。
      // libraries 由 VaultHub 在 onStatus 前合并（TECHNICAL §6.6 第 6 条：manager 不认识多库）。
      revision: this.manifest?.revision ?? 0,
      slotFingerprint: this.local.slot?.fingerprint ?? null,
      libraries: [],
      unlockFailure: this.lastUnlockFailure,
      variantNotice: this.takeVariantNotice()
    }
  }

  /**
   * AC-7「一次性」：告知条**投递过一次就作废**。
   *
   * 旧实现只把 `variantNotice` 放在 `local.json` 里、依赖渲染层调 `dismissVariantNotice()` 清除，
   * 而那条路在渲染层根本没有通道（关闭只写 zustand 内存），于是记录永远留着，
   * 重启后会再弹一条「已按…修正输入编码差异」——而这一版什么都没修正，是过期事实。
   * 现在改成：第一次被 `status()` 读走时就把持久记录清掉（本进程留副本，界面不闪），
   * 无论用户关不关，重启都不会复发。
   */
  private takeVariantNotice(): VaultVariantNotice | null {
    const persisted = this.local.variantNotice
    if (persisted !== null) {
      this.deliveredVariantNotice = persisted
      this.local.variantNotice = null
      try {
        this.persistLocal()
      } catch {
        // 本机写盘失败不该让一次状态查询失败：下一条状态会再投递一次（宁重不漏）
        this.local.variantNotice = persisted
      }
    }
    return this.deliveredVariantNotice
  }

  /** 本机权威槽记录（诊断区/测试读它；渲染层只读 `status.slotFingerprint`） */
  localSlot(): LocalSlotRecord | null {
    return this.local.slot
  }

  /** AC-7：用户关掉顶部告知条（清内存副本；持久记录在投递时已作废，不动仓库） */
  dismissVariantNotice(): VaultStatus {
    this.deliveredVariantNotice = null
    this.local.variantNotice = null
    this.persistLocal()
    return this.status()
  }

  /** 首次创建（同时返回一次性恢复码；此后再也拿不到，除非轮换） */
  create(passphrase: string): VaultCreateResult {
    if (this.deriveState() !== 'uninitialized') {
      throw vaultFail('E_INVALID_ARGUMENT', 'vault already exists', { reason: 'already-exists' })
    }
    this.assertPassphraseAcceptable(passphrase)

    const now = new Date(this.now())
    const nowIso = now.toISOString()
    const recoveryCode = generateRecoveryCode()
    const payload = emptyPayload(nowIso)
    const created = createVault({
      payload: serializePayload(payload),
      passphrase,
      recoveryCode,
      cost: this.cost,
      now
    })
    writeRepo(
      this.options.repoDir,
      { manifest: created.manifest, envelope: parseEnvelope(created.encBytes), encBytes: created.encBytes, themes: [] },
      this.options.localDir
    )

    this.manifest = created.manifest
    this.envelope = parseEnvelope(created.encBytes)
    this.encBytes = created.encBytes
    this.payload = payload
    this.vaultKey = created.vaultKey
    this.local.createdAt = nowIso
    this.local.lastUnlockedAt = nowIso
    // 槽写入的唯一入口（TECHNICAL §6.6 重复风险第 4 条）：
    // create / rotate / recover / unlock / session-restore / 重封 / 保槽 七个时机都走 rememberSlot
    this.rememberSlot(this.manifest, this.envelope)
    this.local.slotDrift = null
    this.lastUnlockFailure = null
    this.persistLocal()
    this.clearSession()
    this.armIdleTimer()
    this.emit()
    return { status: this.status(), recoveryCode }
  }

  /**
   * 解锁：先按**原样**口令试，再（可选）按受控输入变体试。
   *
   * 三条硬口径（AC-8 / AC-9）：
   * 1. `identity` 必须排首位 —— 成功路径于是只派生 1 次 KEK；
   * 2. 变体循环整体只算**一次**失败（`registerFailure` 在循环外只调一次），
   *    否则一次手滑会按 4 次计数，节流阈值随输入形态变化；
   * 3. 非原样变体命中后用**规范形 + 新盐**重封口令槽（`resealPassphraseSlot`
   *    是全仓唯一换盐入口），下次同一输入仍走变体循环。
   */
  unlock(passphrase: string, rememberWithKeychain: boolean): VaultStatus {
    // 被限流时也要落一次归因：AC-1 要求「throttled 必须显示剩余秒数」，而渲染层只读
    // `status.unlockFailure`（不许拿 error.details.reason 反推 class，见 DESIGN §7 第 2 条）。
    // 回退点 = 删掉这个 try/catch：第 4 次尝试后 status.unlockFailure 会停在 bad-passphrase，
    // 界面就只剩「口令错误」而没有倒计时。
    try {
      this.assertNotThrottled()
    } catch (error) {
      this.recordUnlockFailure(error)
      throw error
    }
    let snapshot: VaultRepoSnapshot
    try {
      snapshot = this.readSnapshotOrThrow()
    } catch (error) {
      // AC-1：读仓储本身失败（`init()` 之后才坏、或同步把仓储换坏了）同样要落归因，
      // 否则界面上只剩一行原始错误文案，「corrupt 不得冒充 bad-passphrase」就无从表达。
      // 例外：`uninitialized` 不是解锁失败，别给它编一个 bad-passphrase 归因。
      const reason = reasonOf(error)
      if (reason !== 'uninitialized') this.recordUnlockFailure(error)
      throw error
    }
    // 归因要对得上「仓库现在说的是哪只槽」：先认这份快照，再判断失败类别
    this.manifest = snapshot.manifest
    this.envelope = snapshot.envelope
    this.encBytes = snapshot.encBytes

    const candidates: PassphraseCandidate[] = this.variantsEnabled()
      ? passphraseVariants(passphrase)
      : [{ variant: 'identity', value: passphrase }]

    let opened: ReturnType<typeof openVault> | null = null
    let hit: PassphraseCandidate | null = null
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        opened = openVault({
          manifest: snapshot.manifest,
          encBytes: snapshot.encBytes,
          credential: { passphrase: candidate.value },
          envelope: snapshot.envelope,
          onKekDerived: this.options.onKekDerived
        })
        hit = candidate
        break
      } catch (error) {
        lastError = error
      }
    }

    if (opened === null || hit === null) {
      // 回退点 = 把 registerFailure() 挪进循环体：一次手滑算 N 次，AC-8 的节流阈值立刻失真
      this.registerFailure()
      this.recordUnlockFailure(lastError)
      rethrowCrypto(lastError)
    }

    if (hit.variant === 'identity') {
      this.adopt(opened.payload, opened.vaultKey, snapshot)
    } else {
      this.resealToCanonical(passphrase, hit, snapshot, opened)
    }

    this.failedAttempts = 0
    this.lockedUntilMs = 0
    this.lastUnlockFailure = null
    this.local.slotDrift = null
    this.local.lastUnlockedAt = new Date(this.now()).toISOString()
    this.rememberSlot(this.manifest ?? snapshot.manifest, this.envelope ?? snapshot.envelope)
    if (rememberWithKeychain) this.writeSession(this.vaultKey!)
    else this.clearSession()
    this.persistLocal()
    this.armIdleTimer()
    this.emit()
    return this.status()
  }

  /**
   * AC-7：非原样变体命中 → 用**规范形**口令重封口令槽（新盐 + 新 nonce，VMK 不变），
   * 再按新信封重解一次自证（解不开说明产出半成品，直接判 corrupt）。
   */
  private resealToCanonical(
    input: string,
    hit: PassphraseCandidate,
    snapshot: VaultRepoSnapshot,
    opened: ReturnType<typeof openVault>
  ): void {
    const canonical = canonicalPassphrase(input)
    if (canonical === null) {
      throw vaultFail('E_IO', 'passphrase variant hit but no canonical form is available', { reason: 'corrupt' })
    }
    // 先挂上 payload（下面要拿 themes，且 adopt 之后各字段才与快照一致）
    this.adopt(opened.payload, opened.vaultKey, snapshot)
    const resealed = resealPassphraseSlot({
      manifest: snapshot.manifest,
      envelope: snapshot.envelope,
      vaultKey: opened.vaultKey,
      passphrase: canonical.value,
      revision: snapshot.manifest.revision + 1,
      now: new Date(this.now())
    })
    writeRepo(
      this.options.repoDir,
      {
        manifest: resealed.manifest,
        envelope: resealed.envelope,
        encBytes: resealed.encBytes,
        themes: this.payload?.themes ?? []
      },
      this.options.localDir
    )
    const verify = openVault({
      manifest: resealed.manifest,
      encBytes: resealed.encBytes,
      credential: { passphrase: canonical.value },
      envelope: resealed.envelope,
      onKekDerived: this.options.onKekDerived
    })
    this.manifest = resealed.manifest
    this.envelope = parseEnvelope(resealed.encBytes)
    this.encBytes = resealed.encBytes
    this.payload = parsePayload(verify.payload)
    zeroize(opened.vaultKey)
    this.vaultKey = verify.vaultKey
    this.rememberSlot(resealed.manifest, this.envelope)
    this.pushSlotAudit({ action: 'slot-resealed', variant: hit.variant, fingerprint: resealed.fingerprint })
    // 告知条只认「非 identity 的变体」；identity 命中永远不会走到这里
    this.local.variantNotice = {
      variant: hit.variant as VaultVariantNotice['variant'],
      at: this.nowIso()
    }
    this.persistLocal()
  }

  lock(): VaultStatus {
    if (this.deriveState() !== 'unlocked') return this.status()
    zeroize(this.vaultKey)
    this.vaultKey = null
    this.payload = null
    // 「从未初始化」与「已初始化但锁着」在 UI 上是两个完全不同的界面：由 deriveState() 区分
    this.disarmIdleTimer()
    this.emit()
    this.notifyLock()
    return this.status()
  }

  /** 轮换口令：旧口令解密 → 新口令重加密 → 换恢复码 → `revision + 1`。返回新恢复码。 */
  rotate(request: VaultRotateRequest): VaultCreateResult {
    this.assertNotThrottled()
    const snapshot = this.readSnapshotOrThrow()
    // 即使当前处于解锁状态也必须重新验证旧口令（否则「解锁态」等于免口令改密）
    let opened
    try {
      opened = openVault({
        manifest: snapshot.manifest,
        encBytes: snapshot.encBytes,
        credential: { passphrase: request.currentPassphrase },
        envelope: snapshot.envelope
      })
    } catch (error) {
      this.registerFailure()
      rethrowCrypto(error)
    }
    this.assertPassphraseAcceptable(request.newPassphrase)

    const recoveryCode = generateRecoveryCode()
    const rewrapped = rewrapVault({
      manifest: snapshot.manifest,
      encBytes: snapshot.encBytes,
      vaultKey: opened.vaultKey,
      passphrase: request.newPassphrase,
      recoveryCode,
      cost: this.cost,
      revision: snapshot.manifest.revision + 1,
      now: new Date(this.now())
    })
    writeRepo(
      this.options.repoDir,
      {
        manifest: rewrapped.manifest,
        envelope: parseEnvelope(rewrapped.encBytes),
        encBytes: rewrapped.encBytes,
        themes: this.payload?.themes ?? []
      },
      this.options.localDir
    )

    this.manifest = rewrapped.manifest
    this.envelope = parseEnvelope(rewrapped.encBytes)
    this.encBytes = rewrapped.encBytes
    const payload = parsePayload(opened.payload)
    this.payload = payload
    zeroize(this.vaultKey)
    this.vaultKey = opened.vaultKey
    this.local.lastUnlockedAt = new Date(this.now()).toISOString()
    // 轮换是**有意的**换槽：本机记录跟着换，并按审计留一条
    this.rememberSlot(this.manifest, this.envelope)
    this.pushSlotAudit({ action: 'slot-resealed', fingerprint: this.local.slot?.fingerprint })
    this.local.slotDrift = null
    this.lastUnlockFailure = null
    // 记住本机的会话里放的是 VMK，轮换后 VMK 不变 → 只需刷新有效期
    if (this.hasSession()) this.writeSession(opened.vaultKey)
    this.persistLocal()
    this.armIdleTimer()
    this.onLocalChangeHook()
    this.emit()
    return { status: this.status(), recoveryCode }
  }

  /**
   * 恢复码恢复：用恢复码解出 VMK → 换成新口令。
   *
   * 与 SPEC S-08「恢复后旧恢复码失效」的偏差：`vault:recover` 的响应类型只有 `VaultStatus`，
   * 没有字段能把新恢复码带回渲染层。如果这里换掉恢复码，用户会「恢复成功但永久失去恢复码」。
   * 所以恢复流程**保留原恢复码**（只换口令槽），并在文档里写明。
   */
  recover(request: VaultRecoveryRequest): VaultStatus {
    this.assertNotThrottled()
    const code = normalizeRecoveryCode(request.recoveryCode)
    if (code === null) {
      throw vaultFail('E_INVALID_ARGUMENT', 'recovery code has an invalid format', {
        reason: 'bad-recovery-code',
        expectedLength: 32
      })
    }
    const snapshot = this.readSnapshotOrThrow()
    let opened
    try {
      opened = openVault({
        manifest: snapshot.manifest,
        encBytes: snapshot.encBytes,
        credential: { recoveryCode: code },
        envelope: snapshot.envelope
      })
    } catch (error) {
      this.registerFailure()
      rethrowCrypto(error)
    }
    this.assertPassphraseAcceptable(request.newPassphrase)

    const rewrapped = rewrapVault({
      manifest: snapshot.manifest,
      encBytes: snapshot.encBytes,
      vaultKey: opened.vaultKey,
      passphrase: request.newPassphrase,
      revision: snapshot.manifest.revision + 1,
      now: new Date(this.now())
    })
    writeRepo(
      this.options.repoDir,
      {
        manifest: rewrapped.manifest,
        envelope: parseEnvelope(rewrapped.encBytes),
        encBytes: rewrapped.encBytes,
        themes: this.payload?.themes ?? []
      },
      this.options.localDir
    )

    this.manifest = rewrapped.manifest
    this.envelope = parseEnvelope(rewrapped.encBytes)
    this.encBytes = rewrapped.encBytes
    this.payload = parsePayload(opened.payload)
    zeroize(this.vaultKey)
    this.vaultKey = opened.vaultKey
    this.local.lastUnlockedAt = new Date(this.now()).toISOString()
    this.rememberSlot(this.manifest, this.envelope)
    this.pushSlotAudit({ action: 'slot-resealed', fingerprint: this.local.slot?.fingerprint })
    this.local.slotDrift = null
    this.lastUnlockFailure = null
    this.clearSession()
    this.persistLocal()
    this.armIdleTimer()
    this.onLocalChangeHook()
    this.emit()
    return this.status()
  }

  /** 丢弃「记住本机 7 天」的会话密钥（导出恢复码前必须做） */
  forgetSession(): void {
    this.clearSession()
    this.persistLocal()
    this.emit()
  }

  /** 「抹除仓库凭据」：本机会话 + Git token + 密文里的 token 一起清掉 */
  eraseRepoCredentials(): void {
    this.clearSession()
    this.local.repo = null
    this.persistLocal()
    if (this.deriveState() === 'unlocked' && this.payload !== null) {
      this.payload.integrations.gitToken = null
      this.afterMutation()
    }
    this.credentials.clear('git:token')
    this.credentials.clear('vault:session')
    this.emit()
  }

  /* ------------------------------------------------------------------ */
  /* 主机库                                                              */
  /* ------------------------------------------------------------------ */

  listLibrary(): HostLibrary {
    return toHostLibrary(this.requireUnlocked())
  }

  createHost(input: HostInput): HostRecord {
    return this.mutate((payload) => {
      const now = this.nowIso()
      const record = createHostRecord(payload, input, now)
      this.mirrorHostToSshConfig(payload, record)
      return record
    })
  }

  updateHost(hostId: string, patch: HostInput): HostRecord {
    return this.mutate((payload) => {
      const record = updateHostRecord(payload, hostId, patch, this.nowIso())
      this.mirrorHostToSshConfig(payload, record)
      return record
    })
  }

  deleteHost(hostId: string): void {
    this.mutate((payload) => {
      deleteHostRecord(payload, hostId)
      this.credentials.clearPrivateKey(hostId)
    })
  }

  reorderHosts(updates: HostSortUpdate[]): HostLibrary {
    return this.mutate((payload) => reorderPayloadHosts(payload, updates))
  }

  createGroup(input: GroupInput): GroupRecord {
    return this.mutate((payload) => createGroupRecord(payload, input, this.nowIso()))
  }

  updateGroup(groupId: string, patch: GroupInput): GroupRecord {
    return this.mutate((payload) => updateGroupRecord(payload, groupId, patch, this.nowIso()))
  }

  deleteGroup(groupId: string): void {
    this.mutate((payload) => deleteGroupRecord(payload, groupId))
  }

  /* ------------------------------------------------------------------ */
  /* 凭据（密码 / passphrase / 私钥）                                     */
  /* ------------------------------------------------------------------ */

  setSecret(reference: string, patch: { password?: string | null; passphrase?: string | null }): { reference: string } {
    this.mutate((payload) => setPayloadSecret(payload, reference, patch, this.nowIso()))
    return { reference }
  }

  getSecret(reference: string): { password: string | null; passphrase: string | null } | null {
    const secret = getPayloadSecret(this.requireUnlocked(), reference)
    return secret === null ? null : { password: secret.password, passphrase: secret.passphrase }
  }

  clearSecret(reference: string): void {
    this.mutate((payload) => clearPayloadSecret(payload, reference))
  }

  /** 连接前解析凭据：密码/passphrase 来自密文包，私钥来自本机 SecretBox（绝不进仓库） */
  resolveHostAuth(hostId: string): {
    password: string | null
    passphrase: string | null
    privateKey: string | null
    privateKeyPath: string | null
    privateKeyStatus: 'present' | 'missing' | 'not-required'
  } {
    const payload = this.requireUnlocked()
    const host = payload.hosts.find((item) => item.id === hostId)
    if (!host) throw vaultFail('E_NOT_FOUND', `host not found: ${hostId}`, { reason: 'not-found', id: hostId })
    const secret = host.credentialRef === null ? null : getPayloadSecret(payload, host.credentialRef)
    const importedKey = this.credentials.getPrivateKey(host.id)
    const privateKeyPath = host.privateKeyPath
    let privateKeyStatus: 'present' | 'missing' | 'not-required' = 'not-required'
    if (host.authMethod === 'publickey') {
      const hasFile = privateKeyPath !== null && existsSync(privateKeyPath) && statSync(privateKeyPath).isFile()
      privateKeyStatus = importedKey !== null || hasFile ? 'present' : 'missing'
    }
    return {
      password: secret?.password ?? null,
      passphrase: secret?.passphrase ?? null,
      privateKey: importedKey,
      privateKeyPath,
      privateKeyStatus
    }
  }

  /** 导入/粘贴私钥：只进本机 SecretBox，仓库里仍然只有路径引用 */
  importPrivateKey(hostId: string, content: string, updatePath?: string | null): void {
    this.requireUnlocked()
    this.credentials.setPrivateKey(hostId, content)
    if (updatePath !== undefined) {
      const payload = this.requireUnlocked()
      const host = payload.hosts.find((item) => item.id === hostId)
      if (host) {
        host.privateKeyPath = updatePath
        host.updatedAt = this.nowIso()
        this.afterMutation()
      }
    }
    this.emit()
  }

  clearPrivateKey(hostId: string): void {
    this.credentials.clearPrivateKey(hostId)
  }

  hasPrivateKey(hostId: string): boolean {
    return this.credentials.hasPrivateKey(hostId)
  }

  /* 本机凭据（不进仓库）：Git token、会话类引用都在这里 */

  setLocalCredential(reference: string, secret: string): { reference: string } {
    const result = this.credentials.set(reference, secret)
    this.emit()
    return result
  }

  clearLocalCredential(reference: string): void {
    this.credentials.clear(reference)
    this.emit()
  }

  localCredentialReferences(): string[] {
    return this.credentials.listReferences()
  }

  credentialStore(): CredentialStore {
    return this.credentials
  }

  /* ------------------------------------------------------------------ */
  /* AI 供应商配置（t5 写入；全部进密文包，仓库里只有密文）                */
  /* ------------------------------------------------------------------ */

  /**
   * 保存某供应商的 API key。
   *
   * 与 `privateKeyPath` 的取舍一样：key 文本**进密文包**而不是只放本机 safeStorage，
   * 这样「换机器后 AI 面板仍能直接用」；但它同样只以密文形式进 Git 仓库。
   * 与 `host.ts` 头注释的偏差与理由见 docs/VAULT-SYNC.md。
   */
  /* 主机备注（密文包里；hostInputSchema 没有 notes 字段） ---------------- */

  getHostNotes(hostId: string): string {
    return this.requireUnlocked().hostNotes[hostId] ?? ''
  }

  setHostNotes(hostId: string, notes: string): void {
    this.mutate((payload) => {
      if (!payload.hosts.some((host) => host.id === hostId)) {
        throw vaultFail('E_NOT_FOUND', `host not found: ${hostId}`, { reason: 'not-found', field: 'hostId', id: hostId })
      }
      const trimmed = notes.trim()
      if (trimmed.length > 2_000) {
        throw vaultFail('E_INVALID_ARGUMENT', 'host notes are too long (max 2000 chars)', {
          reason: 'invalid-payload',
          field: 'notes'
        })
      }
      if (trimmed.length === 0) delete payload.hostNotes[hostId]
      else payload.hostNotes[hostId] = trimmed
    })
  }

  listHostNotes(): Record<string, string> {
    return { ...this.requireUnlocked().hostNotes }
  }

  setAiApiKey(providerId: string, value: string): void {
    const id = providerId.trim()
    if (id === '') {
      throw vaultFail('E_INVALID_ARGUMENT', 'providerId must not be empty', { reason: 'invalid-payload', field: 'providerId' })
    }
    if (value === '') {
      throw vaultFail('E_INVALID_ARGUMENT', 'api key must not be empty', { reason: 'invalid-payload', field: 'apiKey' })
    }
    this.mutate((payload) => {
      payload.integrations.aiApiKeys[id] = value
    })
  }

  /** 读取 API key；**锁定时抛 E_VAULT_LOCKED**（返回 null 会让调用方误以为「没配 key」） */
  getAiApiKey(providerId: string): string | null {
    const payload = this.requireUnlocked()
    return payload.integrations.aiApiKeys[providerId] ?? null
  }

  /** 清除 API key（不存在也成功，幂等） */
  clearAiApiKey(providerId: string): void {
    const had = this.requireUnlocked().integrations.aiApiKeys[providerId] !== undefined
    if (!had) return
    this.mutate((payload) => {
      delete payload.integrations.aiApiKeys[providerId]
    })
  }

  /** 保存 t5 的 `ai/providers.json` 全文（原样字符串；非法 JSON 直接拒绝，避免污染密文包） */
  setAiProvidersConfig(json: string | null): void {
    if (json !== null) {
      if (json.length > 1_000_000) {
        throw vaultFail('E_INVALID_ARGUMENT', 'AI providers config is too large', {
          reason: 'invalid-payload',
          field: 'aiProvidersConfig',
          bytes: json.length
        })
      }
      try {
        JSON.parse(json)
      } catch (error) {
        throw vaultFail('E_INVALID_ARGUMENT', 'AI providers config must be valid JSON', {
          reason: 'invalid-payload',
          field: 'aiProvidersConfig',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    this.mutate((payload) => {
      payload.integrations.aiProvidersConfig = json
    })
  }

  getAiProvidersConfig(): string | null {
    return this.requireUnlocked().integrations.aiProvidersConfig ?? null
  }

  /* ------------------------------------------------------------------ */
  /* known_hosts                                                         */
  /* ------------------------------------------------------------------ */

  listKnownHosts(): KnownHostEntry[] {
    return listPayloadKnownHosts(this.requireUnlocked())
  }

  trustKnownHost(request: KnownHostTrustRequest): KnownHostEntry {
    return this.mutate((payload) => trustPayloadKnownHost(payload, request, this.nowIso()))
  }

  removeKnownHost(request: KnownHostRemoveRequest): void {
    this.mutate((payload) => removePayloadKnownHost(payload, request))
  }

  /* ------------------------------------------------------------------ */
  /* settings / themes（由各自的 owner 写入，这里只负责进密文/进仓库）      */
  /* ------------------------------------------------------------------ */

  updateSettings(settings: Settings): void {
    if (this.deriveState() !== 'unlocked' || this.payload === null) return
    this.payload.settings = settings
    this.afterMutation()
  }

  setThemes(themes: ThemeDefinition[]): void {
    this.mutate((payload) => {
      payload.themes = themes
    })
  }

  /* ------------------------------------------------------------------ */
  /* ssh_config（密文里保留完整文本）                                      */
  /* ------------------------------------------------------------------ */

  sshConfigText(): { text: string; aliasMap: Record<string, string>; sourcePath: string | null } {
    const payload = this.requireUnlocked()
    return { ...payload.sshConfig, aliasMap: { ...payload.sshConfig.aliasMap } }
  }

  setSshConfigText(text: string, sourcePath?: string | null): void {
    this.mutate((payload) => {
      payload.sshConfig.text = text
      if (sourcePath !== undefined) payload.sshConfig.sourcePath = sourcePath
    })
  }

  /** 从解析结果导入主机；`aliases=null` 表示全部；已存在的同名 alias 默认跳过（overwriteExisting=true 则覆盖） */
  importSshConfig(parsed: SshConfigParseResult, overwriteExisting: boolean, aliases: string[] | null): SshConfigImportResult {
    return this.mutate((payload) => {
      const importedAliases: string[] = []
      const skipped: SshConfigImportResult['skipped'] = []
      const origins: SshConfigImportResult['origins'] = []
      const wanted = aliases === null ? null : new Set(aliases.map((alias) => alias.toLowerCase()))

      for (const entry of parsed.entries) {
        if (wanted !== null && !wanted.has(entry.alias.toLowerCase())) {
          skipped.push({ alias: entry.alias, reason: 'excluded' })
          continue
        }
        if (entry.patterns.some((pattern) => pattern.includes('*') || pattern.includes('?'))) {
          skipped.push({ alias: entry.alias, reason: 'wildcard' })
          continue
        }
        if (entry.hostname === null) {
          skipped.push({ alias: entry.alias, reason: 'no-hostname' })
          continue
        }
        const existingId = payload.sshConfig.aliasMap[entry.alias]
        const existing = existingId === undefined ? undefined : payload.hosts.find((host) => host.id === existingId)
        if (existing !== undefined && !overwriteExisting) {
          skipped.push({ alias: entry.alias, reason: 'duplicate' })
          continue
        }

        const input: HostInput = {
          label: entry.alias,
          groupId: null,
          hostname: entry.hostname,
          port: entry.port ?? 22,
          username: entry.user ?? existing?.username ?? 'root',
          authMethod: entry.identityFile === null ? (existing?.authMethod ?? 'password') : 'publickey',
          privateKeyPath: entry.identityFile ?? existing?.privateKeyPath ?? null,
          credentialRef: existing?.credentialRef ?? null,
          jumpHostId: existing?.jumpHostId ?? null,
          forwardAgent: existing?.forwardAgent ?? false,
          keepaliveSeconds: existing?.keepaliveSeconds ?? 30,
          terminalProfileId: existing?.terminalProfileId ?? null,
          startupCommand: existing?.startupCommand ?? null,
          env: existing?.env ?? {},
          tags: existing?.tags ?? [],
          color: existing?.color ?? null,
          portForwards: existing?.portForwards ?? [],
          sshConfigOrigin: { file: parsed.path, alias: entry.alias }
        }

        const record = existing === undefined
          ? createHostRecord(payload, input, this.nowIso())
          : updateHostRecord(payload, existing.id, input, this.nowIso())
        payload.sshConfig.aliasMap[entry.alias] = record.id
        importedAliases.push(entry.alias)
        origins.push({ alias: entry.alias, file: parsed.path })
      }

      // 密文里保留完整原文（注释/未知指令逐字保留），而不是从主机记录重建
      payload.sshConfig.text = parsed.entries.length === 0 ? payload.sshConfig.text : mergeImportedText(payload, parsed)
      payload.sshConfig.sourcePath = parsed.path
      return { importedAliases, skipped, origins }
    })
  }

  /** 导出：从密文里的完整文本按 alias 过滤（aliases=null 导出全部） */
  exportSshConfigText(aliases: string[] | null): string {
    return filterSshConfigText(this.requireUnlocked().sshConfig.text, aliases)
  }

  /* ------------------------------------------------------------------ */
  /* 同步支持（供 src/main/git 使用）                                      */
  /* ------------------------------------------------------------------ */

  isUnlocked(): boolean {
    return this.deriveState() === 'unlocked' && this.payload !== null && this.vaultKey !== null
  }

  vaultKeyForSync(): Buffer {
    if (!this.isUnlocked()) throw lockedError()
    return this.vaultKey!
  }

  payloadForSync(): VaultPayload {
    return structuredClone(this.requireUnlocked())
  }

  manifestForSync(): VaultManifest | null {
    return this.manifest
  }

  setRepo(repo: VaultStatus['repo']): void {
    this.local.repo = repo
    this.persistLocal()
    this.emit()
  }

  markSynced(revision: number, payloadSha: string): void {
    this.local.lastSyncedAt = new Date(this.now()).toISOString()
    this.local.lastSyncedRevision = revision
    this.local.lastSyncedPayloadSha = payloadSha
    this.persistLocal()
    this.emit()
  }

  /**
   * 拉取后重读仓库：解锁态下用内存 VMK 刷新 payload；解不开就回到锁定态。
   *
   * r3（AC-21 / AC-2）：远端可能把口令槽换掉了（另一台机轮换 / 整份覆盖 / 变体重封）。
   * 只要内存里还有 VMK 且远端 payload 打得开，就**保本机槽**——用本机槽记录的那只盐
   * 重封远端 payload 并写回仓库，把「用谁的锁」这个决定收回 manager。
   * 锁定时没有 VMK、重封不了：一个字节都不写，只记 `slotDrift` 供诊断区显示。
   */
  reload(source?: SlotDriftSource): VaultStatus {
    this.local = this.loadLocal()
    let snapshot: VaultRepoSnapshot | null = null
    try {
      snapshot = readRepo(this.options.repoDir, this.options.localDir)
    } catch (error) {
      this.repoError = error
      this.forceLock('read-failed')
      return this.status()
    }
    if (snapshot === null) {
      this.manifest = null
      this.envelope = null
      this.encBytes = null
      this.payload = null
      zeroize(this.vaultKey)
      this.vaultKey = null
      this.emit()
      return this.status()
    }
    this.manifest = snapshot.manifest
    this.envelope = snapshot.envelope
    this.encBytes = snapshot.encBytes

    if (this.deriveState() === 'unlocked' && this.vaultKey !== null) {
      let opened: ReturnType<typeof openVault>
      try {
        opened = openVault({
          manifest: snapshot.manifest,
          encBytes: snapshot.encBytes,
          credential: { vaultKey: this.vaultKey },
          envelope: snapshot.envelope,
          onKekDerived: this.options.onKekDerived
        })
      } catch {
        // 远端换了 VMK（别人轮换过口令/在别的机器重建过库）：内存里的密钥已经打不开它
        this.forceLock('unlock-failed')
        return this.status()
      }
      if (this.slotNeedsRebase()) {
        // 同一个库（VMK 打得开）只是槽变了 → 本机槽写回去，用户的口令不该因为同步而失效
        this.resealWithLocalSlot(
          opened.payload,
          snapshot.manifest.revision + 1,
          source ?? 'sync-fast-forward',
          parsePayload(opened.payload).themes
        )
        return this.status()
      }
      this.payload = parsePayload(opened.payload)
      this.emit()
      return this.status()
    }

    if (this.slotNeedsRebase()) {
      // 锁定态：无力重封 ⇒ 绝不写盘，只记漂移（AC-3 的诊断区据此说明「与本机记录不一致」）
      this.local.slotDrift = {
        source: source ?? 'sync-fast-forward',
        remoteFingerprint: this.manifestFingerprint(),
        recordedFingerprint: this.local.slot?.fingerprint ?? null,
        at: this.nowIso()
      }
      this.persistLocal()
    }
    this.emit()
    return this.status()
  }

  /**
   * AC-21 单点入口：同步三条路径（快进 / 无冲突合并 / 冲突后推送）拿到远端 payload 后
   * 一律走这里，由 manager 决定「用谁的锁」。**不许**在 sync 层自己重封。
   */
  adoptRemotePayload(input: { payload: string; revision: number; source: SlotDriftSource }): VaultStatus {
    if (!this.isUnlocked()) throw lockedError()
    const payload = parsePayload(input.payload)
    if (this.slotNeedsRebase()) {
      this.resealWithLocalSlot(
        input.payload,
        Math.max(input.revision, this.manifest?.revision ?? 0) + 1,
        input.source,
        payload.themes
      )
      return this.status()
    }
    this.payload = payload
    this.afterMutation(payload)
    return this.status()
  }

  /**
   * 写入「人工合并后」的 payload（冲突解决的最后一步）：
   * revision 取「本地/远端最大值 + 1」，保证下一次远端比较能看出这是新版本。
   */
  applyMergedPayload(merged: VaultPayload): VaultStatus {
    if (!this.isUnlocked()) throw lockedError()
    this.payload = merged
    this.afterMutation(merged)
    return this.status()
  }

  /** 冲突快照用的「当前密文」（可直接落盘给人看，不含明文） */
  currentEncryptedSnapshot(): { manifest: VaultManifest | null; encBytes: Buffer | null } {
    return { manifest: this.manifest, encBytes: this.encBytes }
  }

  /* ------------------------------------------------------------------ */
  /* 内部                                                                */
  /* ------------------------------------------------------------------ */

  private adopt(payloadJson: string, vaultKey: Buffer, snapshot: VaultRepoSnapshot): void {
    const payload = parsePayload(payloadJson)
    zeroize(this.vaultKey)
    this.payload = payload
    this.vaultKey = vaultKey
    this.manifest = snapshot.manifest
    this.envelope = snapshot.envelope
    this.encBytes = snapshot.encBytes
    this.repoError = null
  }

  /**
   * 槽记录的**唯一**写入口（TECHNICAL §6.6 重复风险第 4 条）：
   * create / rotate / recover / unlock（含变体重封）/ session-restore / 保槽 都调它。
   * 任何别处直接拼 `this.local.slot = …` 都会让「本机权威」分裂成两份口径。
   */
  private rememberSlot(manifest: VaultManifest, envelope: VaultEnvelope): void {
    this.local.slot = {
      passphraseKey: manifest.passphraseKey,
      recoveryKey: manifest.recoveryKey,
      kdf: manifest.kdf,
      salt: envelope.kdf.salt,
      fingerprint: slotFingerprint(manifest),
      recordedAt: this.nowIso()
    }
  }

  private pushSlotAudit(entry: Omit<SlotAuditEntry, 'at'>): void {
    this.local.slotAudit = [...this.local.slotAudit, { ...entry, at: this.nowIso() }].slice(-SLOT_AUDIT_LIMIT)
  }

  /**
   * 取本机权威槽；本机还没有记录时（AC-18 老安装升级）用**成对的**仓库 manifest+vault.enc 播种一次。
   * 播种前必须过 `assertSlotBinding`：一对「槽来自 A、盐来自 B」的仓库不许被写成权威，
   * 否则本机会永久记下错配的盐——那正是 r3 要消灭的状态。
   */
  private requireSlot(): LocalSlotRecord {
    if (this.local.slot !== null) return this.local.slot
    if (this.manifest === null || this.envelope === null) throw lockedError()
    try {
      assertSlotBinding(this.manifest, this.envelope)
    } catch {
      throw vaultFail('E_IO', 'manifest/vault.enc 不成对（槽与盐错配），拒绝以它为权威播种本机槽', {
        reason: 'slot-record-mismatch'
      })
    }
    this.rememberSlot(this.manifest, this.envelope)
    this.persistLocal()
    return this.local.slot!
  }

  private manifestFingerprint(): string | null {
    if (this.manifest === null) return null
    try {
      return slotFingerprint(this.manifest)
    } catch {
      return null
    }
  }

  /** 仓库里的槽与本机记录的是不是同一只（含盐）；不同就要「保本机槽」 */
  private slotNeedsRebase(): boolean {
    const slot = this.local.slot
    if (slot === null) return false
    const remote = this.manifestFingerprint()
    if (remote !== null && remote !== slot.fingerprint) return true
    if (this.envelope !== null && this.envelope.kdf.salt !== slot.salt) return true
    return false
  }

  /**
   * 造一只「盐被指定」的信封。`resealPayload` **只从信封取 `kdf.salt` 一项**
   * （其余字段由它自己重新生成），所以这里替换盐不是绕过断言，而是把「本机槽记录的那只盐」
   * 显式交进去；成对一致性由返回的新 manifest 保证（槽来自本机记录，其 AAD 绑的正是这只盐）。
   */
  private envelopeWithSalt(envelope: VaultEnvelope, salt: string): VaultEnvelope {
    return { ...envelope, kdf: { ...envelope.kdf, salt } }
  }

  /** 保本机槽重封远端 payload 并写回仓库（AC-21 的唯一实现，reload 与 adoptRemotePayload 共用） */
  private resealWithLocalSlot(
    payloadJson: string,
    revision: number,
    source: SlotDriftSource,
    themes: ThemeDefinition[]
  ): void {
    const slot = this.local.slot
    if (slot === null || this.manifest === null || this.envelope === null || this.vaultKey === null) {
      throw lockedError()
    }
    const sealed = resealPayload({
      manifest: {
        ...this.manifest,
        passphraseKey: slot.passphraseKey,
        recoveryKey: slot.recoveryKey,
        kdf: slot.kdf
      },
      envelope: this.envelopeWithSalt(this.envelope, slot.salt),
      expectedKdfSalt: slot.salt,
      vaultKey: this.vaultKey,
      payload: payloadJson,
      revision,
      now: new Date(this.now())
    })
    writeRepo(
      this.options.repoDir,
      { manifest: sealed.manifest, envelope: sealed.envelope, encBytes: sealed.encBytes, themes },
      this.options.localDir
    )
    this.manifest = sealed.manifest
    this.envelope = sealed.envelope
    this.encBytes = sealed.encBytes
    this.payload = parsePayload(payloadJson)
    this.rememberSlot(sealed.manifest, sealed.envelope)
    this.pushSlotAudit({ action: 'slot-preserved', source, fingerprint: slot.fingerprint })
    this.local.slotDrift = null
    this.persistLocal()
    this.touch()
    this.onLocalChangeHook()
    this.emit()
  }

  /** 解锁失败的四分类（AC-1..AC-3）：纯函数在 attribution.ts，这里只负责供料与落盘 */
  private recordUnlockFailure(error: unknown): void {
    // reason 的形状解析单点在 `reasonOf()`：crypto 层抛的 `VaultCryptoError` 在顶层，
    // `vaultFail()` 造的 `IpcCallError` 在 `details.reason`（节流、仓储读写失败都是后者）。
    // 回退点 = 只读 `error.reason`：第 4 次尝试后 status.unlockFailure 会停在 bad-passphrase，
    // AC-1 要求的「throttled 必须显示剩余秒数」直接失效。
    const shaped = error as { details?: { retryAfterMs?: unknown } } | null | undefined
    const hinted = shaped?.details?.retryAfterMs
    const retryAfterMs =
      typeof hinted === 'number' && hinted > 0
        ? hinted
        : this.lockedUntilMs > this.now()
          ? this.lockedUntilMs - this.now()
          : undefined
    this.lastUnlockFailure = classifyUnlockFailure({
      reason: reasonOf(error),
      retryAfterMs,
      currentFingerprint: this.manifestFingerprint(),
      recordedFingerprint: this.local.slot?.fingerprint ?? null,
      driftRecorded: this.local.slotDrift !== null
    })
    this.persistLocal()
  }

  /** AC-5/AC-6 的开关：关掉后只认原样口令（错误信息里不提示「可能只是全角」） */
  private variantsEnabled(): boolean {
    return this.options.passphraseVariants !== false
  }

  /**
   * 强制回锁（清内存里的 VMK 与 payload）。
   *
   * 关键：这里**必须 emit()**。t8 的 F-1 就是这条路径漏了通知 —— 主进程已经回锁，
   * 但渲染层没有收到 `vault:state-changed`，界面上继续显示「已解锁的空库」，
   * 而同一时刻 `hosts:list` 却抛 `E_VAULT_LOCKED`。
   */
  private forceLock(stage: 'read-failed' | 'unlock-failed'): void {
    zeroize(this.vaultKey)
    this.vaultKey = null
    this.payload = null
    this.disarmIdleTimer()
    this.lastLockReason = stage
    this.emit()
    this.notifyLock()
  }

  /**
   * 通知锁事件。**吞掉回调里的异常**：清理凭据是「尽力而为」，
   * 不能因为它失败就让上锁流程（或 suspend 处理）半途抛错——
   * 那会留下「以为锁上了、其实 VMK 还在」的更糟状态。
   */
  private notifyLock(): void {
    try {
      this.onLock?.()
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[vault] onLock handler failed: ${(error as Error).message}`)
      }
    }
  }

  /** 仅供诊断/测试：任何时刻 state 必须与「真实挂载」一致，否则立刻炸 */
  assertStateConsistent(): void {
    const state = this.deriveState()
    const mounted = this.payload !== null && this.vaultKey !== null
    const problems: string[] = []
    if ((state === 'unlocked') !== mounted) {
      problems.push(`state=${state} but mounted=${mounted}`)
    }
    if (state !== 'unlocked' && (this.payload !== null || this.vaultKey !== null)) {
      problems.push('locked but payload/vaultKey still held in memory')
    }
    if (state === 'uninitialized' && this.manifest !== null) {
      problems.push('uninitialized but manifest present')
    }
    if (this.status().state !== state) {
      problems.push(`status() reported ${this.status().state}, derived ${state}`)
    }
    if (problems.length > 0) {
      throw new Error(`vault state invariant violated: ${problems.join('; ')}`)
    }
  }

  /**
   * 上锁回调（组合根 `src/main/ipc/index.ts` 接上）。
   *
   * 用途：锁屏后**清掉主进程里残留的凭据副本**（`SshManager.releaseCredentials()`）。
   * 刻意做成公有可赋值字段而不是构造参数：`VaultManager` 先于 ssh 引擎创建，
   * 而这块只关心「锁了」这一件事，不需要把引擎对象塞进 vault 的依赖里。
   *
   * 产品口径：**不主动断开已建立的 SSH 会话**（用户可能在跑长任务，15 分钟空闲自动锁
   * 不该把终端踢掉），只清内存里的明文副本。详见 docs/VAULT-SYNC.md §4。
   */
  onLock: (() => void) | null = null

  /** 最近一次「被动回锁」的原因（诊断用；主动 lock() 不记录） */
  lastLockReason: 'read-failed' | 'unlock-failed' | null = null

  private readSnapshotOrThrow(): VaultRepoSnapshot {
    if (this.repoError !== null) {
      const error = this.repoError
      this.repoError = null
      rethrowCrypto(error)
    }
    const snapshot = readRepo(this.options.repoDir, this.options.localDir)
    if (snapshot === null) {
      throw vaultFail('E_INVALID_ARGUMENT', 'vault is not initialized yet', { reason: 'uninitialized' })
    }
    return snapshot
  }

  private requireUnlocked(): VaultPayload {
    if (this.deriveState() !== 'unlocked' || this.payload === null || this.vaultKey === null) throw lockedError()
    return this.payload
  }

  private mutate<T>(fn: (payload: VaultPayload) => T): T {
    const payload = this.requireUnlocked()
    const result = fn(payload)
    if (this.payload !== null) this.afterMutation(this.payload)
    return result
  }

  /**
   * 每次写盘都走这里：**槽取自本机权威记录，盐取自同一只槽记录**（AC-22）。
   *
   * 回退点 = 把 `expectedKdfSalt` 换回 `this.envelope!.kdf.salt`、manifest 直接传 `this.manifest`：
   * 那正是 r3 的 D1（槽与盐可分别来源），红证探针的 R2/R4 用例会立刻回红。
   */
  private afterMutation(payload: VaultPayload = this.payload!): void {
    if (this.vaultKey === null) throw lockedError()
    const slot = this.requireSlot()
    payload.updatedAt = this.nowIso()
    if (this.envelope === null) throw lockedError()
    if (this.envelope.kdf.salt !== slot.salt) {
      // 「不可表示」优先于「写完再发现」：仓库信封的盐与本机槽记录的盐不一致时直接拒写。
      // 老版本会把两只盐拼起来重封，症状是「口令明明对却提示口令错」（AC-20）。
      throw vaultFail('E_IO', '本机口令槽与仓库重封盐不一致，已拒绝按错配重封', {
        reason: 'slot-record-mismatch'
      })
    }
    const sealed = resealPayload({
      manifest: {
        ...this.manifest!,
        passphraseKey: slot.passphraseKey,
        recoveryKey: slot.recoveryKey,
        kdf: slot.kdf
      },
      envelope: this.envelope,
      expectedKdfSalt: slot.salt,
      vaultKey: this.vaultKey,
      payload: serializePayload(payload),
      revision: (this.manifest?.revision ?? 0) + 1,
      now: new Date(this.now())
    })
    writeRepo(
      this.options.repoDir,
      { manifest: sealed.manifest, envelope: sealed.envelope, encBytes: sealed.encBytes, themes: payload.themes },
      this.options.localDir
    )
    this.manifest = sealed.manifest
    this.encBytes = sealed.encBytes
    this.envelope = sealed.envelope
    this.payload = payload
    this.local.slotDrift = null
    this.persistLocal()
    this.touch()
    this.onLocalChangeHook()
    this.emit()
  }

  private mirrorHostToSshConfig(payload: VaultPayload, host: HostRecord): void {
    const alias = host.sshConfigOrigin?.alias
    if (alias === undefined) return
    const fields: Record<string, string | null> = {
      HostName: host.hostname,
      Port: String(host.port),
      User: host.username,
      IdentityFile: host.privateKeyPath,
      ProxyJump: host.jumpHostId === null ? null : (payload.hosts.find((item) => item.id === host.jumpHostId)?.hostname ?? null)
    }
    const updated = updateHostFields(payload.sshConfig.text, alias, fields)
    payload.sshConfig.text = updated.text
    payload.sshConfig.aliasMap[alias] = host.id
  }

  private assertPassphraseAcceptable(passphrase: string): void {
    const assessment = assessPassphrase(passphrase)
    if (!assessment.acceptable) {
      throw vaultFail('E_INVALID_ARGUMENT', `master passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`, {
        reason: 'too-short',
        minLength: MIN_PASSPHRASE_LENGTH,
        length: assessment.length,
        warnings: assessment.warnings
      })
    }
    if (!assessment.requiresConfirmation) {
      this.pendingWeak = null
      return
    }
    const digest = sha256Hex(Buffer.from(passphrase.normalize('NFKC'), 'utf8'))
    if (this.pendingWeak !== null && this.pendingWeak.digest === digest && this.now() - this.pendingWeak.at < 5 * 60_000) {
      this.pendingWeak = null
      return
    }
    this.pendingWeak = { digest, at: this.now() }
    throw vaultFail('E_INVALID_ARGUMENT', 'master passphrase looks weak; submit the same passphrase again to confirm', {
      reason: 'weak-passphrase',
      requiresConfirmation: true,
      warnings: assessment.warnings,
      entropyBits: Math.round(assessment.entropyBits),
      strength: assessment.strength
    })
  }

  private assertNotThrottled(): void {
    if (this.lockedUntilMs > this.now()) {
      throw vaultFail('E_UNAUTHORIZED', 'too many failed attempts; try again later', {
        reason: 'throttled',
        retryAfterMs: this.lockedUntilMs - this.now()
      })
    }
  }

  private registerFailure(): void {
    this.failedAttempts += 1
    if (this.failedAttempts < 3) return
    const backoffSeconds = Math.min(2 ** (this.failedAttempts - 3), 30)
    this.lockedUntilMs = this.now() + backoffSeconds * 1_000
  }

  private now(): number {
    return this.options.clock ? this.options.clock() : Date.now()
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString()
  }

  private onLocalChangeHook(): void {
    this.options.onLocalChange?.()
  }

  private emit(): void {
    this.options.onStatus?.(this.status())
  }

  /* 闲置自动上锁 */

  private autoLockMinutes(): number {
    const value = this.options.autoLockMinutes
    if (typeof value === 'function') return value()
    return value ?? 15
  }

  private requirePassphraseOnLaunch(): boolean {
    const value = this.options.requirePassphraseOnLaunch
    if (typeof value === 'function') return value()
    return value ?? false
  }

  private touch(): void {
    this.armIdleTimer()
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer()
    if (this.deriveState() !== 'unlocked') return
    const minutes = this.autoLockMinutes()
    if (!(minutes > 0)) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      this.lock()
    }, minutes * 60_000)
    // 定时器不能把进程钉住（测试与退出流程都要干净）
    this.idleTimer.unref?.()
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  /* 本机私有状态 / 会话 */

  private loadLocal(): LocalState {
    if (!existsSync(this.localPath)) return emptyLocalState()
    try {
      const raw = JSON.parse(readFileSync(this.localPath, 'utf8')) as Record<string, unknown>
      // v1 → v2 就地升级（AC-18：老安装不迁目录、不丢会话；缺的字段补默认值而不是判损坏，
      // 否则升级后第一次启动就会因为「少一个字段」把 local.json 隔离成 .corrupt 文件）
      const upgraded = {
        ...raw,
        version: 2,
        slot: raw.slot ?? null,
        slotDrift: raw.slotDrift ?? null,
        slotAudit: raw.slotAudit ?? [],
        variantNotice: raw.variantNotice ?? null
      }
      const parsed = localStateSchema.safeParse(upgraded)
      return parsed.success ? parsed.data : this.quarantineLocal()
    } catch {
      return this.quarantineLocal()
    }
  }

  private quarantineLocal(): LocalState {
    try {
      const corrupt = `${this.localPath}.corrupt-${Date.now()}`
      rmSync(corrupt, { force: true })
      writePrivateFile(corrupt, readFileSync(this.localPath, 'utf8'))
    } catch {
      // 备份失败也不阻塞启动
    }
    return emptyLocalState()
  }

  private persistLocal(): void {
    writePrivateFile(this.localPath, `${JSON.stringify(this.local, null, 2)}\n`)
  }

  private readSession(): { sealed: string; until: string } | null {
    if (!existsSync(this.sessionPath)) return null
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(readFileSync(this.sessionPath, 'utf8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  private hasSession(): boolean {
    const session = this.readSession()
    if (session === null) return false
    return Date.parse(session.until) > this.now()
  }

  private writeSession(vaultKey: Buffer): void {
    const days = this.options.rememberDays ?? 7
    const until = new Date(this.now() + days * 24 * 60 * 60 * 1_000).toISOString()
    writePrivateFile(
      this.sessionPath,
      `${JSON.stringify({ version: 1, sealed: this.options.box.encrypt(vaultKey.toString('base64')), until }, null, 2)}\n`
    )
    this.local.rememberedUntil = until
    this.persistLocal()
  }

  private clearSession(): void {
    rmSync(this.sessionPath, { force: true })
    this.local.rememberedUntil = null
  }
}

/**
 * 把「导入的原文」与「密文里已有的文本」合并：
 * 新增/变化的主机块用新原文里的块替换，其余（其它别名、全局指令、注释）逐字保留。
 */
function mergeImportedText(payload: VaultPayload, parsed: SshConfigParseResult): string {
  const lines = payload.sshConfig.text
  let text = lines
  for (const entry of parsed.entries) {
    if (entry.patterns.some((pattern) => pattern.includes('*') || pattern.includes('?'))) continue
    const fields: Record<string, string | null> = {
      HostName: entry.hostname,
      Port: entry.port === null ? null : String(entry.port),
      User: entry.user,
      IdentityFile: entry.identityFile,
      ProxyJump: entry.proxyJump
    }
    const updated = updateHostFields(text, entry.alias, fields)
    text = updated.text
  }
  return text
}
