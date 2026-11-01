# TECHNICAL · 解锁自救 + 另开本地库（Termans r3）

> 基线依赖：`docs/teamflow/20261101-r3-vault-unlock-lockout/PRD.md`（AC-1..AC-26）+ 同目录 `DESIGN.md`（M1..M6、§4.4 契约、§4.5 组件边界）
> 取代：无（跨代行为变更仅 AC-21 对同步写链的内部语义收紧，不涉及对外文案契约）
> 落盘纪律：本文写于分支 `master`、HEAD `742be01`；未提交改动 2 处（`M docs/teamflow/memory.md`、`?? 本任务夹`）。本轮**不动** `e2e/fixtures`、不改既有 12 个 e2e spec 的断言口径。

---

## 1. 结论摘要（先看这 5 条）

1. **写链的根缺陷是"槽与盐可以分别来源"**：`manifest.passphraseKey` 的 AAD 绑定 `envelope.kdf.salt`（`envelope.ts:284`），而 `resealPayload` 允许调用方**任意传入** `kdfSalt`（`envelope.ts:531-549`）同时**原样保留** `manifest.passphraseKey`；`assertIntegrity`（`envelope.ts:352`）只校验摘要，**不校验盐归属**。于是"槽是这台机的、盐是那台机的"这种组合在 API 层完全合法且能通过全部摘要校验，症状恰好是 `bad-passphrase`（`envelope.ts:479` 的 AAD 绑定让 GCM 先失败），与"口令真的错了"不可区分。
2. **同步把"本机口令槽"这个信任锚交给了远端**：三条路径都无条件 adopt 远端 `manifest + envelope`（`sync.ts:319-322` 快进、`sync.ts:645-647` 无冲突合并、`sync.ts:422` 冲突解决后推送）；其中 `sync.ts:319-322` **连 `isUnlocked()` 都不校验**。修复口径按 PRD AC-21 ①：**同步只写 payload 与 revision，绝不替换本地槽**。
3. **修复不靠"更严的校验"，靠让错误状态不可表示**：引入 `LocalSlotRecord`（槽+盐+指纹，本机权威记录，落 `local.json`），`resealPayload` 改成"盐只能取自当前 envelope + 调用方声明值必须相等否则抛"（AC-22），落盘改成 manifest/vault.enc **成对事务**（AC-23，暂存区在 `localDir` 而不是 `repoDir`——`repo-layout.test.ts:52` 断言仓储根只有两只文件，AC-18 不许破）。
4. **`slot-record-mismatch` 不是新故障类别，而是"不可判定时的诚实出口"**：没有本机指纹记录就永远不判这一类（AC-2）；判定优先级 `throttled > slot-record-mismatch > corrupt > bad-passphrase`。
5. **多库是"目录 + 索引 + 一次只活一个 manager"**，不是多实例常驻：切换 = 旧库 `lock()`（清零 VMK）→ 新库 `init()`（仅当它自己有 `session.json` 才会还原）。老安装零迁移：默认库继续用 `userData/vault` 与 `userData/vault-local`，只是多一条索引记录。

---

## 2. 现状取证与缺陷分解

### 2.1 已实测（file:line 可复核）

| # | 事实 | 坐标 |
|---|---|---|
| E1 | 单库路径写死：`repoDir = join(userDataDir,'vault')`、`localDir = join(userDataDir,'vault-local')`，`new VaultManager` + `new SyncCoordinator` 各一次 | `src/main/ipc/index.ts:63-64` 及其后注册段 |
| E2 | 快进分支不校验解锁态，直接 `fastForward()` → `manager.reload()` | `src/main/git/sync.ts:319-322`、`fastForward` 定义 `:582` |
| E3 | 无冲突合并：`resetTo → reload → applyMergedPayload → commitAll → pushWithRetry` | `src/main/git/sync.ts:645-647` |
| E4 | 冲突解决后推送：`if(!isUnlocked()) throw lockedError()` 后 `applyMergedPayload(merged)` | `src/main/git/sync.ts:407`、`:422` |
| E5 | `reload()` 在已解锁时用内存 `vaultKey` 解远端 payload，成功即 `adopt()` 远端 `manifest+envelope+encBytes`；解不开则 `forceLock('unlock-failed')` | `src/main/vault/manager.ts:834`、`adopt` `:898-907` |
| E6 | `afterMutation` 用 `kdfSalt: this.envelope!.kdf.salt` 重封 payload，同时把 `this.manifest`（含其 `passphraseKey`）原样带下去 | `src/main/vault/manager.ts:1005-1030`（`:1011` 取盐） |
| E7 | `passphraseAad(cost, salt)` 把 salt 绑进 AAD；`openVault` 的 passphrase 分支用 `envelope.kdf.salt` 派生 KEK 再开 `manifest.passphraseKey`，失败即 `bad-passphrase` | `src/main/crypto/envelope.ts:284`、`:479` 起 |
| E8 | `assertIntegrity` 校验 format/version/cipher/envelope.version/`payload_sha256`/`keywrap_sha256`/manifest.kdf 与 envelope.kdf 的 `N,r,p` 一致——**不校验 salt** | `src/main/crypto/envelope.ts:352` |
| E9 | `resealPayload` 用 `input.kdfSalt` 造新 envelope，`kdf.N/r/p` 取自 `input.manifest.kdf` | `src/main/crypto/envelope.ts:531-549` |
| E10 | `writeRepo` 先 `writeAtomic(vault.enc)` 再 `writeAtomic(manifest.json)`（各自 `.tmp-<pid>` + `renameSync`），**不是成对事务** | `src/main/vault/repo.ts:68-85` |
| E11 | 仓储根必须只有 `manifest.json` / `vault.enc` / `themes/`（断言级） | `src/main/vault/repo-layout.test.ts:52-53` |
| E12 | `VaultStatus` 无 `libraries` / `revision` / `slotFingerprint` / `unlockFailure` | `src/shared/models/vault.ts`（`vaultStatusSchema`） |
| E13 | 解锁屏 `Mode = 'unlock'|'create'|'recover'|'recovery-saved'`，footer 常驻预览模式出口 | `src/renderer/features/unlock/UnlockScreen.tsx:10` |
| E14 | `vaultsync` namespace 用 `addResourceBundle` 挂在渲染层（en 与 zh-CN 同文件） | `src/renderer/features/vault/i18n.ts` |
| E15 | 既有 e2e 12 个 spec（含 `vault-security` / `dual-machine` / `conflict`），`e2e/fixtures` 为共享夹具 | `e2e/*.spec.ts` |

### 2.2 缺陷分解（修复对象）

- **D1（结构性，P0）** 槽与盐可分离：`resealPayload` 的 `kdfSalt` 是自由参数（E9），manifest 里的槽被原样保留（E6），而完整性校验看不见盐归属（E8）⇒ "错配对"可被写出且被判定为完整。
- **D2（策略性，P0）** 同步无条件 adopt 远端槽（E2/E3/E4/E5）⇒ 本机口令槽在本机没有任何权威副本，任何一次同步都可能把它换成本机解不开的那一个。
- **D3（工程性，P0）** 成对落盘缺失（E10）⇒ 崩溃/断电可留"新 enc + 旧 manifest"半对，同样表现为 `bad-passphrase`（因为盐跟着 enc 走、槽跟着 manifest 走）。
- **D4（可用性，P0）** 失败归因只有一个粗口径（`rethrowCrypto` 只分 `bad-passphrase`/`corrupt`）⇒ 上述三种状态被统一表述成"口令错误"，用户唯一的自救动作是"再输一遍"。

### 2.3 AC-20「先红后绿」的**红证复核协议**（评审请重点看这一节）

PRD 认定的机制链（远端槽 → 远端盐重封本地 VMK payload → 三项摘要自洽 → 本地口令 `bad-passphrase`）中，**前三个环节（E2/E5/E6/E7/E8）我已逐条 file:line 复核**；但"必然自然产生错配"这一步依赖两台机器的重封时序，我**没有**在这次技术方案里把它实测出来。

因此 T7 的第一件事不是写实现，而是**先把红证跑出来**：

1. 写 `src/main/git/sync.test.ts` 的临时用例，用 `test-git-server.ts` + 两个 `VaultManager` 复现"同口令 → 远端正向合并/冲突解决 → 本机 `unlock(同口令)`"。
2. 若**当前实现确实红**（`reason === 'bad-passphrase'`）：按 AC-20 留证（失败输出 + `file:line`），转绿后保留该用例。
3. 若**当前实现是绿的**（即自然路径不会产生错配）：**立即停止按"红"叙述**，改为两条可判定的等价红证，并在 QA-REPORT 里写清"PRD 叙述的自然触发未复现"：
   - 红证 A（结构不可表示性）：构造一对"槽来自 A、盐来自 B"的值直接调 `resealPayload`，当前实现**写出且 `assertIntegrity` 通过**（红），修复后同一调用**抛错**（绿）。
   - 红证 B（半对落盘）：在 `writeAtomic(vault.enc)` 之后、`writeAtomic(manifest.json)` 之前抛错，当前实现留下半对并让 `unlock` 变 `bad-passphrase`（红），修复后 `readRepo` 走事务恢复、`unlock` 仍成功（绿）。
   两者都满足 AC-25 的可分辨性（回退修复点必红）。
4. **禁止**为了凑"红"而人为放宽断言或伪造失败输出；这条纪律与 PRD §9「三条执行底线」同级。

---

## 3. 不变量（实现必须围绕这 6 条，而不是零散打补丁）

| 编号 | 不变量 | 落点 |
|---|---|---|
| **I1** | **槽盐同源**：`manifest.passphraseKey` 只允许与"当初派生 KEK 用的那个 salt"一起存在；任何写盘前二者必须成对且同源 | `resealPayload` 硬断言（AC-22）+ `LocalSlotRecord` |
| **I2** | **盐只有一个来源**：`envelope.kdf.salt`；调用方只能"声明期望值"，不能"提供新值" | AC-22 的 `expectedKdfSalt` |
| **I3** | **同步不换槽**：三条同步路径结束后，磁盘上的槽必须仍是本机的那个（只有"本机无槽"的新机 bootstrap 才接受远端槽） | AC-21 `adoptRemotePayload` |
| **I4** | **成对落盘**：`manifest.json` 与 `vault.enc` 同一次事务写、可恢复；仓储根永远只有三类内容 | AC-23 + E11 |
| **I5** | **本机记录是唯一权威**：`local.json.slot`（含 8 位指纹）是"上次能开的是什么"的唯一凭据；无记录时不得做任何"被换过"的断言 | AC-2 |
| **I6** | **会话还原零写入**：`tryRestoreSession` 成功路径不写 `repoDir` 任何文件（还原后同口令仍能解锁，且两只文件 sha256 不变） | AC-24 |

---

## 4. 数据模型与存储

### 4.1 `local.json` 扩展（`src/main/vault/manager.ts` 内的 `LocalState`）

```ts
export interface LocalSlotRecord {
  passphraseKey: VaultManifest['passphraseKey']   // 与 manifest 同形的密文槽（非明文秘密，仓库里本来就有同一份）
  recoveryKey: VaultManifest['recoveryKey']
  kdf: { name: 'scrypt'; N: number; r: number; p: number }
  /** 与 passphraseKey 的 AAD 绑定的盐（base64）——**槽与盐成对记录** */
  salt: string
  /** sha256(Buffer.from(passphraseKey.ciphertext,'base64')) 前 8 位小写 hex（AC-2 口径） */
  fingerprint: string
  recordedAt: string   // ISO
}

export type SlotDriftSource = 'sync-fast-forward' | 'sync-merge' | 'sync-push'
export interface SlotAuditEntry {
  at: string
  action: 'slot-preserved' | 'slot-resealed' | 'slot-adopted-remote'
  source: SlotDriftSource | 'unlock-variant' | 'create' | 'rotate' | 'recover'
  fromFingerprint: string | null
  toFingerprint: string
  variant?: 'identity' | 'nfkc' | 'trim' | 'strip-zero-width'
}

export interface LocalState {
  version: 2                      // 1 → 2 迁移：只补默认值，不重写仓库
  createdAt: string
  lastUnlockedAt: string | null
  lastSyncedAt: string | null
  lastSyncedRevision: number | null
  lastSyncedPayloadSha: string | null
  repo: SyncRepo | null
  rememberedUntil: string | null
  // —— 本轮新增 ——
  slot: LocalSlotRecord | null                                  // I5
  slotDrift: { recordedFingerprint: string; currentFingerprint: string; at: string; source: SlotDriftSource } | null
  slotAudit: SlotAuditEntry[]                                   // 上限 20 条，FIFO
  variantNotice: { variant: 'nfkc' | 'trim' | 'strip-zero-width'; at: string } | null  // AC-7 一次性提示
}
```

写入时机（**只用一条函数 `rememberSlot()`，禁止散落**）：`create` / `unlock` 成功 / `rotate` / `recover` / `tryRestoreSession` 成功 / AC-7 重封后 / 同步保槽后。`slotDrift` 只在"检测到远端槽不一致且本机此刻无法纠正（锁定态）"时写，成功解锁或保槽后清空。

> 为什么把槽密文本体也放本机记录：它是被 KEK 包裹的密文，与仓库里那份**完全相同**，不引入新的离线爆破面（攻击者拿到仓库就已经有同一份）；而不放它，"本机权威"就只剩一个指纹，锁定时无法自证、也无法在同步后把槽写回去。

### 4.2 多库索引 `userData/libraries.json`

```ts
export interface LibraryEntry {
  id: string                 // 'default' | 'lib-<8hex>'
  name: string | null        // null = 默认库，渲染层用 i18n 兜底名（不把 zh 文案写进数据）
  repoDir: string            // 相对 userData 的路径
  localDir: string
  createdAt: string | null
  lastUnlockedAt: string | null
}
export interface LibraryIndexFile {
  version: 1
  current: string            // 当前库 id
  libraries: LibraryEntry[]
}
```

- 老安装零迁移（AC-18）：索引不存在时**惰性建立**，首条记录固定为 `{ id:'default', name:null, repoDir:'vault', localDir:'vault-local' }`——路径与现状逐字相同，`ipc/index.ts:63-64` 的默认值不变。
- 新库：`repoDir:'vaults/<id>/repo'`、`localDir:'vaults/<id>/local'`（物理隔离，AC-12）。
- `createdAt`/`lastUnlockedAt` 从该库自己的 `local.json` 读，索引里只是缓存（写索引失败不影响解锁）。
- 索引写盘走 `writeAtomic`（同目录 `.tmp` + rename），`name` 判重 = `trim().toLowerCase()` 比较（AC-14）。

### 4.3 成对落盘事务（I4 / AC-23）

**暂存区必须在 `localDir`**，不能在 `repoDir`（E11 的 `ls -R` 断言 + 仓库不进垃圾目录）：

```
<localDir>/.pair-tx/
  journal.json          { phase:'prepared'|'done', repoDir, target:{manifest,vault}, backup:{manifest,vault}, at }
  vault.enc.new
  manifest.json.new
  vault.enc.old         （第二步重命名产生）
  manifest.json.old
```

序列：
1. 写 `.new` 两份 + `fsync`（`openSync/writeSync/fsyncSync/closeSync`），`journal.json(phase:'prepared')`；
2. `rename(vault.enc → .pair-tx/vault.enc.old)`、`rename(manifest.json → .pair-tx/manifest.json.old)`；
3. `rename(.new → 目标)` 两次；
4. `journal.phase='done'` → `rm -rf .pair-tx`。

`readRepo(dir)` 开头 `recoverPairTx(dir, localDir)`：`phase='prepared'` 且两份 `.new` 都在 → 完成第 3 步；只有 `.old` → 回滚；然后清 `.pair-tx`。**顺序无关**触发（任何一次启动都会自愈）。

`themes/` 不参与事务（它坏了不影响解锁），仍在成对写成功之后写。

### 4.4 目录布局总表

| 路径 | 内容 | 进 Git？ |
|---|---|---|
| `userData/vault/`（默认库） | `manifest.json`、`vault.enc`、`themes/*.json` | 是 |
| `userData/vault-local/` | `local.json`、`session.json`、`credentials.json`、`.pair-tx/`、冲突快照 | 否 |
| `userData/libraries.json` | 多库索引 | 否 |
| `userData/vaults/<id>/{repo,local}/` | 新库的同上两份 | repo 进各自远端 |

---

## 5. 契约变更（契约先行，T1 一次落定）

### 5.1 `src/shared/models/vault.ts`

```ts
export const unlockFailureClassSchema = z.enum(['bad-passphrase','throttled','slot-record-mismatch','corrupt'])
export type UnlockFailureClass = z.infer<typeof unlockFailureClassSchema>

export const vaultUnlockFailureSchema = z.object({
  class: unlockFailureClassSchema,
  retryAfterSeconds: z.number().int().min(0).optional()   // 仅 throttled
})
export type VaultUnlockFailure = z.infer<typeof vaultUnlockFailureSchema>

export const vaultLibraryMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).nullable(),
  createdAt: isoTimestampSchema.nullable(),
  lastUnlockedAt: isoTimestampSchema.nullable(),
  isCurrent: z.boolean()
})
export type VaultLibraryMeta = z.infer<typeof vaultLibraryMetaSchema>

export const vaultLibraryCreateRequestSchema = z.object({ name: z.string().min(1).max(64), rememberWithKeychain: z.boolean() }).strict()
export type VaultLibraryCreateRequest = z.infer<typeof vaultLibraryCreateRequestSchema>

export const vaultLibrarySwitchRequestSchema = z.object({ id: z.string().min(1) }).strict()
export type VaultLibrarySwitchRequest = z.infer<typeof vaultLibrarySwitchRequestSchema>
```

`vaultStatusSchema` **追加 4 个必填字段**（契约形状不改、既有字段一个不动）：

```ts
revision: z.number().int().min(0),
slotFingerprint: z.string().regex(/^[0-9a-f]{8}$/).nullable(),
libraries: z.array(vaultLibraryMetaSchema),
unlockFailure: vaultUnlockFailureSchema.nullable()
```

> 诊断区六项**不新增对象**：`createdAt`/`lastUnlockedAt`/`lastSyncedAt`/`kdf` 已有，只补 `revision` 与 `slotFingerprint`——这是 DESIGN §4.4 列的最小字段集，逐字对齐。

### 5.2 `src/shared/ipc.ts`（3 条新通道，`IPC_CHANNELS.vault` 内）

| 常量 | 通道 | request | response |
|---|---|---|---|
| `vault.libraries` | `vault:libraries` | `void` | `{ libraries: VaultLibraryMeta[] }` |
| `vault.libraryCreate` | `vault:library-create` | `VaultLibraryCreateRequest` | `VaultCreateResult`（复用既有 `{status, recoveryCode}`） |
| `vault.librarySwitch` | `vault:library-switch` | `VaultLibrarySwitchRequest` | `VaultStatus` |

`IPC_INVOKE_MAP` 补三条同名键；`preload/index.ts` 由 `IPC_INVOKE_CHANNELS` 派生，**不需要改**。新增 `IPC_EVENTS.vaultSlotNotice = 'vault:slot-notice'`？**不加**——一次性告知条读 `VaultStatus.variantNotice`（见 5.3），少一条事件通道。

### 5.3 `VaultStatus` 再补一个可选字段（AC-7 提示条载体）

```ts
variantNotice: z.object({ variant: z.enum(['nfkc','trim','strip-zero-width']), at: isoTimestampSchema }).nullable()
```
理由：告知条要在**解锁成功后**出现在主窗口顶部（DESIGN M5），而此刻渲染层拿到的就是 `vault:state-changed` 推来的 `VaultStatus`；再加一条事件通道会让"关闭后不再出现"的状态分裂成两处。

### 5.4 `src/main/vault/errors.ts`

`VaultFailureReason` 追加：`'slot-record-mismatch' | 'slot-drift' | 'name-taken'`。
`rethrowCrypto` 行为不变（错误码不变，AC-18）；归因由 `attribution.ts` 决定，不靠错误码猜。

---

## 6. 主进程模块设计（签名即契约，dev 必须逐字调用）

### 6.1 `src/main/crypto/envelope.ts`（改，T2）

```ts
/** AC-2 口径：sha256(Buffer.from(passphraseKey.ciphertext,'base64')) 的前 8 位小写 hex */
export function slotFingerprint(manifest: Pick<VaultManifest, 'passphraseKey'>): string

/** AC-22：调用方声明期望的盐，与 envelope.kdf.salt 不等即抛 VaultCryptoError('corrupt'|'bad-params') */
export function assertKdfSalt(expected: string, envelope: VaultEnvelope): void

export interface RawSealInput {
  manifest: VaultManifest
  /** I2：盐的唯一来源（新增，必填，取代原来的裸 kdfSalt 语义） */
  envelope: VaultEnvelope
  /** AC-22 硬断言：调用方认为的盐；与 envelope.kdf.salt 不等即抛 */
  expectedKdfSalt: string
  vaultKey: Buffer
  payload: string
  revision: number
  now?: Date
}
/** 返回值新增 envelope（新盐即 envelope.kdf.salt，调用方无需再拼） */
export function resealPayload(input: RawSealInput): { manifest: VaultManifest; envelope: VaultEnvelope; encBytes: Buffer }

/** AC-7：非原样变体命中后，用规范形 + 新 salt/新 nonce 重封口令槽（VMK 不变，payload 同步换盐重封） */
export function resealPassphraseSlot(input: {
  manifest: VaultManifest
  envelope: VaultEnvelope
  vaultKey: Buffer
  passphrase: string        // 已规范化的口令（调用方负责）
  cost?: ScryptCost
  revision: number
  now?: Date
}): { manifest: VaultManifest; envelope: VaultEnvelope; encBytes: Buffer; fingerprint: string }

/** 结构一致性（N/r/p 与 keywrap 摘要重算），给 manager 写盘前自检 */
export function assertSlotBinding(manifest: VaultManifest, envelope: VaultEnvelope): void

/** AC-9 计数钩子：每次 KEK 派生回调一次（只用于测试与诊断，不改变行为） */
export interface OpenVaultInput { /* …既有… */ onKekDerived?: () => void }
```

要点：
- `resealPayload` **保留** `manifest.passphraseKey` / `recoveryKey` / `kdf` 原样（它不换槽，只换 payload），但**盐必须来自传入的 envelope 且与 `expectedKdfSalt` 相等**——把 I1/I2 变成"写错就抛"而不是"写错了也能通过摘要"。
- `resealPassphraseSlot` 是**唯一的换盐入口**（AC-7 与将来的 rotate 共用）；它产出的是**成对**结果并当场自检 `assertSlotBinding`，`fingerprint` 回传给 manager 记 `LocalSlotRecord`。
- `openVault` 的 `onKekDerived` 只在 passphrase 分支调用一次（每次 `deriveKek` 一次），recovery/keychain 分支不调用。

### 6.2 `src/main/crypto/passphrase.ts`（改，T4 — AC-5/AC-6 的单一实现）

```ts
export type PassphraseVariant = 'identity' | 'nfkc' | 'trim' | 'strip-zero-width'
export interface PassphraseCandidate { variant: PassphraseVariant; value: string }

/** 固定顺序、去重后 ≤4 个、首个永远是 identity（AC-9 成功路径零新增延迟） */
export function passphraseVariants(input: string): PassphraseCandidate[]

/** AC-7 的"规范形"：变体表里第一个（原样之外）能还原出规范形的候选；identity 输入返回 null */
export function canonicalPassphrase(input: string): { value: string; variant: PassphraseVariant } | null
```

- 顺序固定：`identity` → `nfkc`（`value.normalize('NFKC')`）→ `trim`（`value.trim()`）→ `strip-zero-width`（`replace(/[\u200B-\u200D\u2060\uFEFF]/g,'')`）。
- 去重按**结果值**去重（`a` 与 `a ` 的 `trim` 结果相同时只留一个），保证 AC-9 的"≤4 次派生"是硬上界。
- **只用于口令槽**：`normalizeRecoveryCode` 一行不改（AC-6）。
- 单一定义点：全仓 `grep -rn "passphraseVariants" src` 必须只有 `passphrase.ts` 的定义 + `manager.ts` 的调用（QA 直接用这条 grep 验 AC-5 的"单一实现"）。

### 6.3 `src/main/vault/repo.ts`（改，T3 — AC-23）

```ts
export interface RepoSnapshot { manifest: VaultManifest; envelope: VaultEnvelope; encBytes: Buffer; themes?: ThemeFile[] }
/** 签名不变（AC-18：repo-layout.test.ts 与既有调用点不动），实现改成成对事务 */
export function writeRepo(dir: string, snapshot: RepoSnapshot, localDir?: string): void
/** 签名不变，开头加 recoverPairTx(dir, localDir) 自愈 */
export function readRepo(dir: string, localDir?: string): RepoSnapshot
export function recoverPairTx(dir: string): void          // 新导出，供 init 期随手调用与单测
export function listRepoFiles(dir: string): string[]      // 既有，不动
export function listThemeFiles(dir: string): string[]     // 既有，不动
```
- `localDir` 变成可选第二参：不传时退化为"暂存区放 `dir` 的同级 `.pair-tx`"（仅供老测试）；正式调用点（manager）**必须**传 `localDir`。
- 严禁把 `.pair-tx` 建在 `repoDir` 内（E11）。

### 6.4 `src/main/vault/attribution.ts`（新，T5 — AC-1/AC-2/AC-3）

```ts
export interface ClassifyInput {
  reason: VaultFailureReason | null
  retryAfterMs?: number
  currentFingerprint: string | null      // 磁盘上现在的槽指纹
  recordedFingerprint: string | null     // local.json.slot?.fingerprint
  driftRecorded: boolean                 // local.json.slotDrift != null
}
/** 优先级：throttled > slot-record-mismatch > corrupt > bad-passphrase */
export function classifyUnlockFailure(input: ClassifyInput): VaultUnlockFailure

/** AC-3：日志用的一行脱敏描述，只含 class / retryAfterSeconds / 8 位指纹，绝不含路径/主机名/IP/用户名/口令 */
export function describeUnlockFailure(failure: VaultUnlockFailure | null): string

/** AC-3 守卫：把任意字符串里的类路径片段与 IP 抹掉（用于错误 message 落日志前的兜底） */
export function redactForLog(text: string): string
```

规则（逐条对应 AC）：
- `reason==='throttled'` → `{class:'throttled', retryAfterSeconds: Math.ceil(retryAfterMs/1000)}`——**必须有秒数**，缺失即视为实现缺陷。
- 否则若 `recordedFingerprint !== null && currentFingerprint !== null && 两者不等` → `slot-record-mismatch`；**无记录或 driftRecorded 但无指纹一律不判该类**（AC-2）。
- 否则 `reason==='corrupt'` → `corrupt`。
- 否则 `bad-passphrase`。**"口令错误"字样只允许出现在 `bad-passphrase` 的文案里**（AC-1）。
- 本模块**不读磁盘、不读 settings**，纯函数——这是它单独成文件（而不是塞进 1218 行的 `manager.ts`）的唯一理由：归因是最需要穷举单测的部分。

### 6.5 `src/main/vault/library-index.ts`（新，T6 — AC-10..AC-14 的纯函数层）

```ts
export const DEFAULT_LIBRARY_ID = 'default'
export interface LibraryPaths { repoDir: string; localDir: string }
export function readLibraryIndex(userDataDir: string): LibraryIndexFile            // 不存在则返回惰性默认（不写盘）
export function writeLibraryIndex(userDataDir: string, index: LibraryIndexFile): void
export function resolveLibraryPaths(userDataDir: string, entry: LibraryEntry): LibraryPaths
export function newLibraryId(existing: string[]): string                           // 'lib-<8hex>'，不调 randomUUID 以便可读
export function validateLibraryName(name: string, existing: LibraryEntry[]): { ok: true; name: string } | { ok: false; field: 'name' }
export function ensureLibraryDirFree(userDataDir: string, id: string): { ok: true } | { ok: false; field: 'dir' }
```
- 判重口径：名称 `trim()` 后按 `toLowerCase()` 全等比较；目录以 `existsSync(dir)` 为准（AC-14）。
- 失败**不写任何文件**（AC-14「前后文件数与 sha256 不变」）⇒ 校验全部前置于任何 `mkdir`/写盘。
- 与 `errors.ts` 的契约：调用方把 `{ok:false, field}` 翻成 `vaultFail('E_INVALID_ARGUMENT', …, { reason: field === 'name' ? 'name-taken' : 'already-exists', field })`。

### 6.6 `src/main/vault/manager.ts`（改，T7 — D1/D2/D4 的主战场）

新增/改动的公开面：

```ts
export interface VaultManagerOptions {
  /* …既有 8 个字段一个不动… */
  /** AC-5/AC-20：测试可只留 identity（"变体全关"复验），生产默认 true */
  passphraseVariants?: boolean
  /** AC-9：注入计数钩子（单测断言 ≤4 次派生） */
  onKekDerived?: () => void
}

export class VaultManager {
  /** 本机权威槽记录（I5）；首次为 null，成功解锁/创建后自举 */
  localSlot(): LocalSlotRecord | null
  /** 状态里的解锁失败归因（AC-1），成功即清空 */
  status(): VaultStatus                                   // 追加 revision/slotFingerprint/libraries/unlockFailure/variantNotice
  unlock(passphrase: string, rememberWithKeychain?: boolean): VaultStatus   // 变体循环 + 归因 + 失败只计 1 次
  /** AC-21 唯一入口：接受远端 payload/revision，保留本地槽，成对写回磁盘 */
  adoptRemotePayload(input: { payload: string; revision: number; source: SlotDriftSource }): void
  /** 一次性告知条消费（AC-7） */
  dismissVariantNotice(): VaultStatus
}
```

实现要点（每条都对应一个 AC）：
1. `unlock()`：
   - `assertNotThrottled()`（既有）→ 失败归因走 `throttled`；
   - `passphraseVariants(passphrase)` 依次 `openVault({ …, onKekDerived })`，**首个成功即 break**（identity 在最前 ⇒ 成功路径派生次数仍为 1，AC-9）；
   - 命中非 identity → `resealPassphraseSlot(canonical)` → `writeRepo(成对)` → `rememberSlot()` → `slotAudit.push({action:'slot-resealed', variant})` → `variantNotice = {variant, at}`，然后**用规范形口令复验一次** `openVault`（重封后必须能开，AC-7 的硬保证；此行失败即抛 `corrupt`，绝不静默）；
   - 全失败：**整体只 `registerFailure()` 一次**（AC-8：变体不许放大节流计数），`lastUnlockFailure = classifyUnlockFailure(...)`，`persistLocal()`，`rethrowCrypto(error)`；
   - 成功：`rememberSlot()`、清 `slotDrift`、清 `lastUnlockFailure`。
2. `afterMutation()`：`const slot = this.requireSlot()`（null 时**先自举**：由 `this.manifest` + `this.envelope.kdf.salt` 生成并持久化——老安装升级兼容 AC-18）→ `resealPayload({ manifest:{...this.manifest!, passphraseKey:slot.passphraseKey, recoveryKey:slot.recoveryKey, kdf:slot.kdf}, envelope:this.envelope!, expectedKdfSalt:slot.salt, … })` → `writeRepo(dir, pair, localDir)` → 更新内存 `manifest/envelope/encBytes` → `touch()` → `onLocalChange()` → `emit()`。
3. `reload()`（供 sync 调用）：
   - 读盘；若 `this.vaultKey` 存在且能用它解开远端 payload → 若 `slotFingerprint(远端)` ≠ `local.slot.fingerprint`：**保本地槽**（用 `local.slot` 回填 manifest 的槽 + 用 `local.slot.salt` 重封 payload）→ `writeRepo` 成对 → `slotAudit.push({action:'slot-preserved', source})` → 再 `adopt()`；
   - 若锁定态且指纹不一致（无法重封）：**不写盘**，只记 `local.slotDrift = {…, source}`（供 AC-2 归类），`adopt()` 远端（B 机 bootstrap 语义）；
   - 解不开 payload：`forceLock('unlock-failed')`（既有行为不变）。
4. `adoptRemotePayload()`：`requireUnlocked()` → 直接用(3)的"保本地槽"分支把 `payload`+`revision` 落地（AC-21 的统一入口，`sync.ts:422` 改调它）。
5. `tryRestoreSession()`：**一行写盘都不加**（I6/AC-24）；成功时调 `rememberSlot()`（写 `local.json`，不碰 `repoDir`）。
6. `status()`：`libraries` 由外部注入（`VaultHub` 用 `onStatus` 前合并，见 6.7），`manager` 自身不认识多库——保持单一职责，也避免 manager 依赖 fs 索引。

### 6.7 `src/main/vault/hub.ts`（新，T11 — 多库编排）

```ts
export interface VaultHubDeps {
  userDataDir: string
  boxFor: (localDir: string) => SecretBox
  /** 每库一套 manager+sync 由 hub 造，settings/box 由 feature 层给 */
  createManager: (paths: LibraryPaths, entry: LibraryEntry) => VaultManager
  createSync: (paths: LibraryPaths, manager: VaultManager, entry: LibraryEntry) => SyncCoordinator
  onStatus: (status: VaultStatus) => void
  onLocalChange: () => void
}

export class VaultHub {
  init(): void                                   // 读索引（惰性建默认库）→ 建当前库
  current(): { entry: LibraryEntry; manager: VaultManager; sync: SyncCoordinator }
  libraryMeta(): VaultLibraryMeta[]              // AC-13 列表（isCurrent 标记）
  libraries(): { libraries: VaultLibraryMeta[] } // IPC: vault:libraries
  createLibrary(input: VaultLibraryCreateRequest): VaultCreateResult  // AC-14/15/16
  switchLibrary(input: VaultLibrarySwitchRequest): VaultStatus        // AC-12/13，免重启
  /** AC-10 的反向守卫素材：是否有"已有库" */
  hasVault(): boolean
}
```
- **一次只活一个 manager**：切换先 `manager.lock()`（清零 VMK、清内存 manifest/payload）再 `init()` 目标库；目标库是否自动解锁完全由它自己的 `session.json` + `requirePassphraseOnLaunch` 决定（AC-12）。
- `createLibrary` 顺序：`validateLibraryName` → `ensureLibraryDirFree` → `mkdir` → 新 manager `create(passphrase?)`（口令由渲染层在同一次请求里不带，走标准新建流程：先建库再要求设置口令？→ **不**：AC-16 要求强制确认恢复码，所以流程是"确认 → 名字 → 在**新库自己的解锁屏**里设口令 → 展示恢复码 → 我已保存"。实现上 `createLibrary` 只建**空壳库记录 + 目录**并把 current 切过去，随后返回 `VaultStatus(state:'uninitialized')`，由既有 `create` 流程设口令）。**注意**：`VaultCreateResult` 的 `recoveryCode` 在此步为 `''`，真正的恢复码来自随后的 `vault:create`。这一点渲染层必须按顺序走（见 7.1）。
- 切换**不允许**中途失败留半态：先 `mkdir` 成功再写索引（索引是唯一提交点）。

### 6.8 `src/main/git/sync.ts`（改，T8 — AC-21）

| 位置 | 现状 | 改为 |
|---|---|---|
| `:319-322` 快进（remote 落后/持平） | 无条件 `fastForward → reload` | 先 `requireUnlocked()`（无法保槽时不许静默 adopt），再 `reload({source:'sync-fast-forward'})` |
| `:582` `fastForward()` | `engine.fastForward + manager.reload()` | 同传 source；reload 语义见 6.6(3) |
| `:645-647` 无冲突合并 | `reload → applyMergedPayload` | `reload({source:'sync-merge'})` 后调 `manager.adoptRemotePayload({payload: merged, revision, source:'sync-merge'})` |
| `:422` 冲突解决后推送 | `applyMergedPayload(merged)` | `manager.adoptRemotePayload({payload: merged, revision, source:'sync-push'})` |
| `:516` `alignFreshFromRemote` | 先 `manager.lock()` 再 clone+reload | **保留**（本机无槽的 bootstrap 是唯一允许接受远端槽的路径），注释写明"这是 I3 的例外及原因" |

**不得削弱既有同步语义**（AC-21）：`sync.test.ts`（8 例）、`sync-robustness.test.ts`（10 例）、`dual-machine.spec.ts` 的既有断言一条不改；若要改断言（例如解锁态前置导致某条用例的 setup 需要先 unlock），**必须逐条在报告里列出原断言、新断言与理由**。

### 6.9 接线：`src/main/vault/register.ts` + `src/main/ipc/index.ts`（T11）

- `VaultHandlerContext` 从 `{ manager, sync }` 改为 `{ hub: VaultHub }`；26 个 handler 里 `manager.xxx` → `hub.current().manager.xxx`（同一文件内机械改写，一次性完成）。
- 新增 3 个 handler：`vault:libraries` / `vault:library-create` / `vault:library-switch`，请求一律过 zod `.strict()`（沿用既有约定）。
- `src/main/ipc/index.ts:63-64` 的 `repoDir/localDir` 常量**保留**（成为 `LibraryEntry('default')` 的字面值来源），`new VaultManager/new SyncCoordinator` 改为 `new VaultHub({...})` 并 `hub.init()`。
- 反向守卫（AC-17）：注册表里**不允许**出现 `vault:reset` / `vault:clear` / `vault:wipe` / `vault:overwrite` 之类通道；`tests/contract/ipc.test.ts` 的通道全集断言会自动覆盖"新增通道必须登记"。

---

## 7. 渲染层设计

### 7.1 `UnlockScreen.tsx` 的 Mode 状态机（T9）

```ts
type Mode = 'unlock' | 'create' | 'recover' | 'recovery-saved'
          | 'new-library-confirm' | 'new-library-create' | 'new-library-created'
```
- **不复用 `'create'`**（AC-10：`uninitialized` 下不能出现第二个创建按钮）。
- 新建库的完整路径：M1 次级链接 `create-library-entry`（仅 `state==='locked'` 渲染）→ M2 `new-library-confirm`（三句编号文案，`create-library-confirm` + `create-library-confirm-points`）→「继续」进入 `new-library-create`（`new-library-name` 输入）→「提交」调 `createLibrary({name, rememberWithKeychain:false})` → 索引切到新库、状态变 `uninitialized` → **自动进入 `'create'`**（设口令，复用既有表单与 testid `passphrase-input`/`passphrase-repeat`/`create-vault`）→ 成功 → `recovery-saved`（AC-16：本态**不渲染 footer**、不响应 Esc、唯一出口「我已保存」）。
- `state==='uninitialized'` 且 `libraries.length<=1`：保持现状（只有一个建库按钮）。
- 转场用一个 `const [mode, setMode] = useState<Mode>(...)` + 一个 `useEffect` 监听 `status.state` 的**既有**逻辑，不引入路由/状态机库。

### 7.2 组件边界（严格遵守 DESIGN §4.5：新增组件文件只有 1 个）

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/renderer/features/unlock/UnlockScreen.tsx` | 改 | 卡内全部子组件**同文件内定义**：`<LibrarySwitcher>`、`<UnlockAttribution>`、`<VaultDiagnostics>`、`<NewLibraryConfirm>`；保持 251 行文件的单一入口地位 |
| `src/renderer/features/unlock/VaultNoticeBar.tsx` | 新 | AC-7 顶部一次性告知条（含 `variant-notice` / `variant-notice-dismiss`） |
| `src/renderer/app/App.tsx` | 改 | 挂载 `<VaultNoticeBar />` |
| `src/renderer/features/vault/vault.css` | 改 | 新增 `.ts-unlock__lib*` / `.ts-unlock__attr*` / `.ts-unlock__diag*` / `.ts-notice*`；**0 新增 token**，动效只走既有 `--ts-motion-fast` |
| `src/renderer/features/vault/api.ts` | 改 | `listVaultLibraries()`、`createVaultLibrary(input)`、`switchVaultLibrary(id)`、`dismissVariantNotice()` |
| `src/renderer/features/vault/store.ts` | 改 | `applyStatus` 透传新字段；`run()` 失败时**不再**把 `slot-record-mismatch` 当文案来源（归因只读 `status.unlockFailure`）；新增 `switchLibrary`/`createLibrary`/`dismissVariantNotice` 三个 action |
| `src/renderer/features/vault/i18n.ts` | 改 | 按 DESIGN §4.3 全量补 `en` 与 `zh-CN` 两份（同批） |

归因块 DOM 契约（QA 锚点，逐字）：
```tsx
<section data-testid="unlock-attribution" data-class={failure.class}> … </section>
```
`data-class` 取值只能是 `bad-passphrase|throttled|slot-record-mismatch|corrupt`（DESIGN §4.4）。图标按 DESIGN §0.1 表：`CircleAlert` / `Timer` / `HardDrive` / `FileX`；红色**只**给 `corrupt`。

### 7.3 库切换（AC-12/AC-13）

- `libraries.length === 1` → 只读行「当前库 · {name ?? t('unlock.library.default')}」+ 当前徽标，**不给下拉**。
- `>= 2` → 原生 `<select data-testid="library-switcher">` + `<details>` 折叠列表 `library-list` / `library-row[data-current]`。
- `onChange` → `switchVaultLibrary(id)` → 返回的 `VaultStatus` 直接 `applyStatus`；若目标库 `state==='locked'`，留在解锁屏并**清空**口令输入（AC-12：必须重新输入）。

### 7.4 i18n 纪律（AC-17 的反向守卫）

- 新 key 禁含 `reset|clear|delete|wipe|bypass|overwrite` 词根；新 testid 同禁令。
- 既有 `unlock.recoverSubmit`（中文「重置口令」）是**文案值**，本轮不动；守卫只扫 key 与 testid。

---

## 8. 关键实现点与易错点（踩过就会红的地方）

1. **`repoDir` 里绝不能出现 `.pair-tx`**（E11 的 `ls -R` 断言会直接红，且 AC-18 要求 repo-layout.test.ts 不回归）⇒ 暂存区一律放 `localDir`。
2. **失败计数只加一次**：变体循环整体算一次 `registerFailure()`；写成"每个变体一次"会让 AC-8/AC-9 的 4 次与 3 次阈值全乱。
3. **成功路径派生次数必须仍是 1**：identity 必须排在候选表首位且首个成功即 break（AC-9）。
4. **`status()` 每加一个字段就要同步 zod schema**：`vaultStatusSchema` 是运行时校验源，漏改会让 `IpcResult` 序列化悄悄丢字段（`registry.ts` 统一包信封，类型检查不拦）。
5. **诊断区永不渲染路径**：`status.repo.remoteUrl` 可能含 `user:token@host`，它**不是**六项之一，任何"顺手显示仓库地址"都会踩 AC-3 的用户名 0 命中。
6. **`createdAt`/`lastUnlockedAt` 无记录时显示「未知（旧版本库）」**：填 0、填当前时间都属于 AC-4 违规。
7. **锁定时不得写 `repoDir`**：`reload()` 锁定分支只记 `slotDrift`，任何写盘都应视为 I3 违规。
8. **切换库必须先 `lock()`**：否则两个 VMK 同时驻留内存，AC-12 的"互不自动解锁"失去意义。
9. **`e2e/fixtures` 与既有 12 spec 不动**：新流程自建夹具；若确实需要改 `harness.ts`（qa owner），按团队纪律先打招呼并把"是否动了 fixtures"写进报告（AC-19 必答项）。
10. **API 名称逐字对齐本文 6.x**：例如 `adoptRemotePayload` 不要写成 `adopt`（`adopt` 是既有的私有方法，重名会让 AC-21 的守卫测试挂错位置）。

---

## 9. AC → 落点对照（dev/QA 检查表）

| AC | 落点（文件/函数） | 判据 |
|---|---|---|
| 1 四分类 | `attribution.ts:classifyUnlockFailure` + `UnlockScreen` 归因块 | `unlock-attribution[data-class]` 四值互斥；`throttled` 必带 `unlock-throttle-countdown`；「口令错误」字样只在 bad 类 |
| 2 指纹口径 | `envelope.ts:slotFingerprint`、`manager.rememberSlot` | 8 位小写 hex = sha256(ciphertext base64 解码) 前 8；无记录不判 `slot-record-mismatch`；文案只陈述"与本机记录不一致" |
| 3 不泄密 | `attribution.ts:describeUnlockFailure/redactForLog`、诊断区 | 诊断区与日志 grep 口令原文/主机名/IP/用户名 0 命中（结构解析，非子串自匹配） |
| 4 台账诚实 | `VaultStatus.revision/slotFingerprint` + `UnlockScreen` 诊断区 | 六项齐全；无记录显示「未知」；不显示路径 |
| 5 变体表 | `passphrase.ts:passphraseVariants` | 恰 4 种、固定顺序、`grep -rn passphraseVariants src` 单点定义 |
| 6 只用于口令槽 | `manager.unlock` 调用点 | 恢复码加零宽仍失败（`normalizeRecoveryCode` 未动） |
| 7 重封规范形 | `envelope.ts:resealPassphraseSlot` + `manager.unlock` | 新 salt/新 nonce；`slotAudit` 有 `slot-resealed`；`variantNotice` 一次性可关 |
| 8 反例 ≥8 | `passphrase.test.ts`（新 8 组反例） | 8 组字符差异全部失败；失败计数 +1/次 |
| 9 ≤4 派生 | `manager.unlock` + `onKekDerived` 钩子 | 成功 1 次、失败 ≤4 次；无字典/暴力路径；成功路径无新增元素 |
| 10 兜底入口 | `UnlockScreen` 条件渲染 | `locked` 且有库才渲染；`uninitialized` 0 命中 |
| 11 旧库零改动 | `hub.createLibrary` | 前后旧库两文件 sha256 四值两两全等；themes 与文件数不变 |
| 12 隔离 | `hub.switchLibrary` + 每库 `localDir` | 独立 repo/local/session；切到未勾选库必须要求口令 |
| 13 列表与切换 | `hub.libraryMeta` + `LibrarySwitcher` | 名称/创建时间/上次解锁/当前标记；切换免重启；`status/itemCounts/createdAt` 归属新库；非当前库 sha256 不变 |
| 14 拒绝覆盖 | `library-index.ts` 校验 + `hub.createLibrary` | `E_INVALID_ARGUMENT` + `details.reason`(+`field`)；前后文件数与 sha256 不变 |
| 15 三句确认 | `UnlockScreen:NewLibraryConfirm` + i18n | en/zh-CN 各一份；三句齐全 |
| 16 恢复码强制 | `UnlockScreen` 的 `recovery-saved` | 不渲染 footer、不响应 Esc、唯一出口「我已保存」 |
| 17 反向守卫 | `tests/contract/vault-unlock-contract.test.ts` | key/testid 里 `reset|clear|delete|wipe|bypass|overwrite` 0 命中；无 reset 类通道 |
| 18 不回归 | 全量门禁 | S-01/S-03/S-04/S-08/S-09、`repo-layout.test.ts`、既有 8 个 testid 不改名、默认库路径不变 |
| 19 门禁四连 | T13 | typecheck 0 / vitest 全绿+新增≥14 / build / 全量 e2e；贴 HEAD 与真实数字与耗时；显式路径提交；答"是否动 e2e fixtures / 同步语义" |
| 20 先红后绿 | §2.3 红证复核协议 | 复现用例带失败输出与 `file:line`；`passphraseVariants:false` 复验仍绿 |
| 21 同步不脱钩 | `sync.ts` 三处 + `manager.adoptRemotePayload` | 快进/合并/冲突后推送三路径 × 同口令仍能解锁；不削弱既有同步语义 |
| 22 AAD 硬断言 | `envelope.ts:assertKdfSalt` + `resealPayload` | 盐不匹配必抛；单测构造错配必红 |
| 23 成对落盘 | `repo.ts` 事务 + `recoverPairTx` | 崩溃点注入后仍能读到完整对；仓储根仍只有三类 |
| 24 会话还原 | `manager.tryRestoreSession` | 还原后两文件 sha256 不变且同口令仍能解锁 |
| 25 可分辨性 | 各新测试注释 | AC-20/22/23 用例注释写明"回退点 file:line"；回退必红 |
| 26 文档 | `docs/VAULT-SYNC.md` 新增一节 + `memory.md` | 多库目录/槽不变量/变体表三件事写清；memory 只记新约定 |

---

## 10. 测试策略

### 10.1 新增测试（≥14 例，落在既有 co-located 风格）

| 文件 | 新增例数 | 覆盖 |
|---|---|---|
| `src/main/crypto/envelope.test.ts` | +4 | AC-22 错配必抛、`slotFingerprint` 口径、`resealPassphraseSlot` 成对与可开、`assertSlotBinding` |
| `src/main/crypto/passphrase-variants.test.ts`（新） | +6 | 表恰 4 种/顺序/去重；AC-8 八组反例（≥8 断言）；零宽中间插入的归属确认 |
| `src/main/vault/repo-pair.test.ts`（新） | +3 | AC-23 事务成功/中途失败自愈/`recoverPairTx` 幂等 |
| `src/main/vault/attribution.test.ts`（新） | +5 | 四类优先级、无记录不判 mismatch、throttled 秒数、脱敏（路径/IP/用户名 0 命中） |
| `src/main/vault/library-index.test.ts`（新） | +4 | 惰性默认库、名称判重、目录占用、失败零写入 |
| `src/main/vault/manager.test.ts` | +6 | 变体解锁 4 形态（AC-5/6）、失败只计一次（AC-8）、≤4 派生（AC-9）、重封后审计与提示（AC-7）、会话还原零写入（AC-24）、AC-22 守卫（写盘前抛） |
| `src/main/git/sync.test.ts` | +3 | AC-21 三路径同口令可解锁、AC-20 复现（或 §2.3 的等价红证） |
| `tests/contract/vault-unlock-contract.test.ts`（新） | +4 | AC-17 反向守卫、AC-1 文案独占、en/zh 键对齐、诊断区不引用 `status.repo` |

> `pnpm test` = `vitest run`，co-located `*.test.ts` 与 `tests/**` 一起跑；新增例数按 `it(` 净增计算，报告里贴真实数字。

### 10.2 可分辨性（AC-25）写法模板

```ts
it('AC-22 盐与槽错配必须拒绝写盘', () => {
  // 回退点：src/main/crypto/envelope.ts:542 `resealPayload` 去掉 assertKdfSalt 调用 → 本例必红（不抛）
  …
  expect(() => resealPayload(mismatched)).toThrow()
})
```

### 10.3 门禁四连顺序（T13 执行，逐条贴真实输出与耗时）

```
pnpm typecheck            # 0 error
pnpm test                 # 全绿 + 新增例数
pnpm run build            # 成功
pnpm exec playwright test # 全量 12+1 spec 全绿
```

真机（AC-19）：`pnpm pack:dir` → 走一遍「口令错 → 归因块 → 新建库二次确认 → 设口令 → 恢复码确认 → 切回旧库（原口令）」，截图与 HEAD 一并贴进 QA-REPORT。

---

## 11. 任务拆分（13 个任务、5 个波次；files = 会改的文件，reads = 只读依赖）

### 波次 0（串行，其他人全部等它）
**T1 契约与错误码** · files: `src/shared/models/vault.ts`、`src/shared/ipc.ts`、`src/main/vault/errors.ts`、`tests/contract/models.test.ts`、`tests/contract/ipc.test.ts`
按 §5 逐字落 4+1 状态字段、3 条通道、3 个 reason；框架层不实现任何逻辑。验收：`pnpm typecheck` 0、`pnpm exec vitest run tests/contract/models.test.ts tests/contract/ipc.test.ts` 绿。

### 波次 1（5 条并行，互不重叠）
**T2 信封层** · files: `src/main/crypto/envelope.ts`、`src/main/crypto/envelope.test.ts` · reads: `models/vault.ts`
落 §6.1 五个导出 + `OpenVaultInput.onKekDerived`；`resealPayload` 改签名（`envelope`+`expectedKdfSalt`，返回带 `envelope`）并修既有 25 例里的构造点。验收：`pnpm exec vitest run src/main/crypto/envelope.test.ts` 绿（净增 ≥4）。

**T3 仓储成对落盘** · files: `src/main/vault/repo.ts`、`src/main/vault/repo-pair.test.ts`(新) · reads: `models/vault.ts`、`repo-layout.test.ts`
落 §4.3 事务与 `recoverPairTx`；**不得**让 `repoDir` 出现暂存目录。验收：`pnpm exec vitest run src/main/vault/repo-pair.test.ts src/main/vault/repo-layout.test.ts` 绿（后者一例不许改）。

**T4 口令变体表** · files: `src/main/crypto/passphrase.ts`、`src/main/crypto/passphrase-variants.test.ts`(新)
落 §6.2 两导出（顺序/去重/≤4）；`normalizeRecoveryCode` 一行不动。验收：新测试绿（≥6 例）+ `pnpm exec vitest run src/main/crypto/passphrase.test.ts` 不回归。

**T5 归因与脱敏** · files: `src/main/vault/attribution.ts`(新)、`src/main/vault/attribution.test.ts`(新) · reads: `models/vault.ts`、`vault/errors.ts`
落 §6.4 三导出；纯函数、零 IO。验收：新测试绿（≥5 例），含"路径/IP/用户名 0 命中"的结构化断言。

**T6 多库索引** · files: `src/main/vault/library-index.ts`(新)、`src/main/vault/library-index.test.ts`(新) · reads: `models/vault.ts`
落 §6.5；校验前置于任何写盘（AC-14）。验收：新测试绿（≥4 例）。

### 波次 2（3 条并行）
**T7 管理器改造** · files: `src/main/vault/manager.ts`、`src/main/vault/manager.test.ts` · reads: `crypto/envelope.ts`、`crypto/passphrase.ts`、`vault/attribution.ts`、`vault/repo.ts`、`vault/errors.ts`、`models/vault.ts`
落 §6.6 全部要点（含 `LocalState` v2 与 `rememberSlot`）。**开工第一件事：按 §2.3 跑红证；若现状为绿，立刻回报并改走等价红证，不得按"红"叙述**。验收：`pnpm exec vitest run src/main/vault/manager.test.ts` 绿（净增 ≥6）+ `pnpm typecheck` 0。

**T9 渲染层** · files: `src/renderer/features/unlock/UnlockScreen.tsx`、`src/renderer/features/unlock/VaultNoticeBar.tsx`(新)、`src/renderer/app/App.tsx`、`src/renderer/features/vault/vault.css`、`src/renderer/features/vault/api.ts`、`src/renderer/features/vault/store.ts`、`src/renderer/features/vault/i18n.ts`、`tests/contract/vault-unlock-contract.test.ts`(新) · reads: `models/vault.ts`、`ipc.ts`、`DESIGN.md §4`
落 §7 全部；Mode 三态扩容、四类归因块、诊断区、库切换、新建库三态、告知条、i18n 双语。验收：`pnpm typecheck` 0 + `pnpm exec vitest run tests/contract/vault-unlock-contract.test.ts tests/contract/e2e-selectors.test.ts` 绿 + `pnpm run build` 成功。

**T10 文档** · files: `docs/VAULT-SYNC.md`、`docs/teamflow/memory.md`
`VAULT-SYNC.md` 增「多库与口令诊断」一节（目录布局、槽不变量、变体表、归因四类、备份建议）；`memory.md` 只记**新约定**（库目录布局、槽-盐成对、`passphraseVariants` 单点入口），不写进展流水。

### 波次 3（2 条并行）
**T8 同步保槽** · files: `src/main/git/sync.ts`、`src/main/git/sync.test.ts`、`src/main/git/sync-robustness.test.ts` · reads: `vault/manager.ts`
按 §6.8 表逐行改；既有 18 例一条不改（要改必须列原/新断言与理由）。验收：三文件测试全绿（净增 ≥3）。

**T11 多库接线** · files: `src/main/vault/hub.ts`(新)、`src/main/vault/register.ts`、`src/main/ipc/index.ts` · reads: `vault/library-index.ts`、`vault/manager.ts`、`git/sync.ts`、`ipc.ts`
落 §6.7/§6.9。验收：`pnpm typecheck` 0 + `pnpm exec vitest run tests/contract/ipc.test.ts` 绿 + `pnpm run build` 成功。

### 波次 4
**T12 e2e** · files: `e2e/unlock-lockout.spec.ts`(新) · reads: `e2e/harness.ts`、`e2e/vault-security.spec.ts`、`e2e/dual-machine.spec.ts`
覆盖：四类归因（构造节流与错配）、新建库三句确认 + 恢复码强制（footer 不出现）、库列表切回旧库、AC-10 反向（uninitialized 无兜底入口）。**不新建共享夹具**；确需改 `harness.ts` 按团队纪律先沟通并在报告披露。验收：`pnpm exec playwright test e2e/unlock-lockout.spec.ts` 绿。

### 波次 5
**T13 交付自检** · files: 无（发现即修，改动就地记入对应任务）
只做交付自检：门禁四连 + 真机 pack 走查 + 把"动没动 e2e fixtures / 同步语义"与真实数字耗时整理好交给 QA。**不写 QA-REPORT/ACCEPTANCE，不跑跨浏览器/多环境矩阵**。

### 提交纪律（PRD §9，逐条搬进每个任务）
1. 每个任务**只在自检通过后**提交一次；提交命令一律 `git commit -- <显式路径>`，**禁止 `git add -A` / `git add .`**。
2. commit message 前缀：`feat(vault):` / `fix(vault):` / `test(vault):` / `docs(teamflow):`；一个任务一笔，不混入他人改动。
3. 提交前 `git status --porcelain -- <本任务路径>` 必须只剩本任务的文件；发现别人的在途改动（`M` 同一文件）→ 停下先报 captain。
4. 本轮结束前工作树只允许剩 `docs/teamflow/...` 与文档类改动；`logs/` 不进仓（已被 `.gitignore` 覆盖）。
5. 分支：当前 `master`；若 pipeline 已建 `feat/*` 分支则在其中提交，否则在 `master` 上按上面纪律提交（不新建分支、不 rebase）。

---

## 12. 风险与已知取舍

| 风险 | 应对 |
|---|---|
| T7 的红证可能无法自然复现（§2.3） | 已有明确替代方案与"禁止伪造"纪律；红线是**不许**在没有实测的情况下把"必然红"写进报告 |
| `resealPayload` 签名变更波及既有 25 例 | T2 负责一次性改完（机械改动），不留给 T7/T8 分摊 |
| 多库接线改 `register.ts` 26 处 | 单任务、单文件、机械改写；`tests/contract/ipc.test.ts` 兜底通道全集 |
| 变体表被误解为"放宽校验" | AC-8 八组反例 + AC-20「变体全关复验」双保险；`passphraseVariants` 开关可一键关闭 |
| 本机记录 `local.json.slot` 扩大攻击面 | 与仓库内同一份密文等同，无新增离线爆破面；已在 §4.1 说明理由 |
| `alignFreshFromRemote` 保留"接受远端槽" | 这是 B 机 bootstrap 的唯一合法例外，注释写明；由 AC-12/AC-21 用例分别守住两侧 |

**不做的事**：不引入组件库、不新增 CSS token、不改 `manifest.json` 格式（老安装必须能直接开）、不做"重置/清空/接管"入口（AC-17）、不动 `e2e/fixtures` 与既有 12 spec 的断言口径、不重构 `manager.ts` 的既有职责边界（只加不搬）。
