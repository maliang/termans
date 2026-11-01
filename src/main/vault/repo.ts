import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { themeDefinitionSchema, type ThemeDefinition } from '@shared'
import { parseEnvelope, payloadDigest, vaultManifestSchema, type VaultEnvelope, type VaultManifest } from '../crypto'
import { vaultFail } from './errors'

/**
 * 仓库（Git 工作区）的文件布局 —— 这是「仓库里只有密文」的物理证据。
 *
 *     <repoDir>/manifest.json     明文：版本/kdf/revision/payload_sha256/密钥槽（不含任何主机信息）
 *     <repoDir>/vault.enc         密文：唯一的敏感数据载体（主机、密码、备注、ssh_config 全文…）
 *     <repoDir>/themes/*.json     明文：主题（非敏感，保留 git diff 可读性）
 *
 * 除此之外**任何东西都不许进这个目录**：私钥本体、机器专用的会话密钥、Git token、
 * 冲突快照、以及本文件引入的成对事务暂存区 `.pair-tx/` 都在 `localDir`（userData/vault-local），
 * 并且 `.gitignore` 之外还有单测守着（repo-layout.test.ts 用真实 `ls -R` 断言）。
 */

export const MANIFEST_FILE = 'manifest.json'
export const ENVELOPE_FILE = 'vault.enc'
export const THEMES_DIR = 'themes'

/**
 * 成对落盘的暂存区目录名（AC-23）。**只能建在 `localDir`**：
 * 建在 `repoDir` 里会让 `ls -R` 多出一行 `.pair-tx`，直接踩 repo-layout.test.ts 的断言（AC-18 不回归）。
 */
export const PAIR_TX_DIR = '.pair-tx'

const JOURNAL_FILE = 'journal.json'
const NEW_FILES = { vault: `${ENVELOPE_FILE}.new`, manifest: `${MANIFEST_FILE}.new` } as const
const OLD_FILES = { vault: `${ENVELOPE_FILE}.old`, manifest: `${MANIFEST_FILE}.old` } as const

/** 成对事务的入参：写盘用的两个字节流 + 可选的同源 envelope（传了就校验「两文件属于同一对」） */
export interface RepoSnapshot {
  manifest: VaultManifest
  /**
   * 与 `encBytes` 同源的 envelope。传了就在写盘前做一致性校验（AC-23：绝不落半对）；
   * 省略时只校验 manifest.payload_sha256 与 encBytes 的对应关系（既有调用点不传，T7 起传入）。
   */
  envelope?: VaultEnvelope
  encBytes: Buffer
  /** 省略 = 不动 themes 目录（避免调用方漏传字段导致主题被当成僵尸文件删掉） */
  themes?: ThemeDefinition[]
}

/** 读盘结果（`envelope` 一定与 `encBytes` 同源，已解析过结构） */
export interface VaultRepoSnapshot {
  manifest: VaultManifest
  encBytes: Buffer
  envelope: VaultEnvelope
}

/** 兼容旧名：`writeRepo` 的入参曾经叫 `VaultRepoWrites` */
export type VaultRepoWrites = RepoSnapshot

/* -------------------------------------------------------------------------- */
/* 成对事务（AC-23）                                                           */
/* -------------------------------------------------------------------------- */

type PairTxPhase = 'prepared' | 'done'

interface PairTxJournal {
  version: 1
  phase: PairTxPhase
  /** 这份暂存区属于哪个仓储目录：`localDir` 与 `repoDir` 是一对一，但仍然要自证 */
  repoDir: string
  at: string
}

/**
 * 仅供单测注入「崩溃点」（AC-23 的两处：第一个 rename 之前 / 两个 rename 之间）。
 * 生产代码**永不调用**；它模拟的是进程在两次系统调用之间被杀掉。
 */
export type PairTxFaultPoint = 'before-first-rename' | 'between-renames'

let faultForTest: PairTxFaultPoint | null = null

export function setPairTxFaultForTest(point: PairTxFaultPoint | null): void {
  faultForTest = point
}

function injectedFault(point: PairTxFaultPoint): never {
  throw new Error(`pair-tx: injected crash at ${point}`)
}

/** 暂存区路径：给了 `localDir` 就用它；没给时退化为仓储的同级目录（仅供不传 localDir 的老调用点） */
function stagingDir(repoDir: string, localDir?: string): string {
  return localDir ? join(localDir, PAIR_TX_DIR) : join(dirname(resolve(repoDir)), PAIR_TX_DIR)
}

/** 写文件并 fsync：字节没落到盘上就不能算「新的一对已就绪」，否则恢复逻辑会前进到半截数据 */
function writeFileDurable(path: string, content: Buffer): void {
  const fd = openSync(path, 'w', 0o600)
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeJournal(path: string, phase: PairTxPhase, repoDir: string): void {
  const journal: PairTxJournal = { version: 1, phase, repoDir: resolve(repoDir), at: new Date().toISOString() }
  writeFileDurable(path, Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, 'utf8'))
}

function readJournal(path: string): PairTxJournal | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PairTxJournal>
    if (raw?.version !== 1 || typeof raw.repoDir !== 'string') return null
    if (raw.phase !== 'prepared' && raw.phase !== 'done') return null
    return raw as PairTxJournal
  } catch {
    // journal 自己写了一半（崩溃恰好在 JSON 落盘中途）⇒ 当成「没有 journal」，靠文件存在性判断
    return null
  }
}

/**
 * 移动文件。同一分区内是 rename（原子）；`localDir` 与 `repoDir` 落在不同卷时退化为「拷贝+fsync+删除源」，
 * 目标仍然只会在最后一步以完整字节出现。
 */
function moveFile(from: string, to: string): void {
  if (!existsSync(from)) return
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    writeFileDurable(to, readFileSync(from))
    rmSync(from, { force: true })
  }
}

/**
 * 崩溃自愈：把一次被打断的成对写入补完或退回，最后清空暂存区。**顺序无关**——任何一次
 * 读盘 / `init()` 都会顺手调用它，所以调用方不必记住上次崩在哪一步。
 *
 * - 两份 `.new` 都在 ⇒ 新的一对字节已完整 fsync，前进（旧的先归档进暂存区，绝不直接覆盖）；
 * - `.new` 不完整、`.old` 在、目标缺失 ⇒ 回滚，把归档的旧文件还回原位；
 * - 其余 ⇒ 什么都没发生过，直接清理。
 */
export function recoverPairTx(repoDir: string, localDir?: string): void {
  const staging = stagingDir(repoDir, localDir)
  if (!existsSync(staging)) return
  const journal = readJournal(join(staging, JOURNAL_FILE))
  // 暂存区属于另一个仓储（未传 localDir 时的同级退化路径理论上可能撞上）：不碰别人的数据
  if (journal && journal.repoDir !== resolve(repoDir)) return
  if (journal?.phase === 'done') {
    rmSync(staging, { recursive: true, force: true })
    return
  }

  const targets = { vault: join(repoDir, ENVELOPE_FILE), manifest: join(repoDir, MANIFEST_FILE) }
  const staged = {
    newVault: join(staging, NEW_FILES.vault),
    newManifest: join(staging, NEW_FILES.manifest),
    oldVault: join(staging, OLD_FILES.vault),
    oldManifest: join(staging, OLD_FILES.manifest)
  }

  if (existsSync(staged.newVault) && existsSync(staged.newManifest)) {
    if (!existsSync(staged.oldVault)) moveFile(targets.vault, staged.oldVault)
    if (!existsSync(staged.oldManifest)) moveFile(targets.manifest, staged.oldManifest)
    moveFile(staged.newVault, targets.vault)
    moveFile(staged.newManifest, targets.manifest)
  } else {
    if (existsSync(staged.oldVault) && !existsSync(targets.vault)) moveFile(staged.oldVault, targets.vault)
    if (existsSync(staged.oldManifest) && !existsSync(targets.manifest)) moveFile(staged.oldManifest, targets.manifest)
  }
  rmSync(staging, { recursive: true, force: true })
}

/**
 * 落盘前的一致性闸门：manifest 与 vault.enc 必须是**同一对**。
 *
 * r3 的根缺陷正是「口令槽与 AAD 盐可以分别来源」，那种错配能过全部摘要、症状却是 bad-passphrase。
 * 在写入口拦一次「摘要对不上 / envelope 与字节不同源」，比事后从解锁失败里反推便宜得多。
 */
function assertPairConsistent(snapshot: RepoSnapshot): void {
  const actual = payloadDigest(snapshot.encBytes)
  if (snapshot.manifest.payload_sha256 !== actual) {
    throw vaultFail('E_INVALID_ARGUMENT', 'manifest.payload_sha256 does not match vault.enc bytes', {
      reason: 'invalid-payload',
      expected: snapshot.manifest.payload_sha256.slice(0, 12),
      actual: actual.slice(0, 12)
    })
  }
  if (!snapshot.envelope) return
  const parsed = parseEnvelope(snapshot.encBytes)
  if (JSON.stringify(parsed) !== JSON.stringify(snapshot.envelope)) {
    throw vaultFail('E_INVALID_ARGUMENT', 'envelope does not belong to vault.enc bytes', {
      reason: 'invalid-payload'
    })
  }
}

/* -------------------------------------------------------------------------- */
/* 读写                                                                        */
/* -------------------------------------------------------------------------- */

/** 仓库里没有 manifest.json 也没有 vault.enc 时返回 null（= 未初始化）；读之前先做崩溃自愈 */
export function readRepo(repoDir: string, localDir?: string): VaultRepoSnapshot | null {
  recoverPairTx(repoDir, localDir)
  const manifestPath = join(repoDir, MANIFEST_FILE)
  const encPath = join(repoDir, ENVELOPE_FILE)
  const hasManifest = existsSync(manifestPath)
  const hasEnc = existsSync(encPath)
  if (!hasManifest && !hasEnc) return null
  if (!hasManifest || !hasEnc) {
    throw vaultFail('E_IO', `vault repo is incomplete: ${hasManifest ? ENVELOPE_FILE : MANIFEST_FILE} is missing`, {
      reason: 'corrupt',
      repoDir
    })
  }

  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw vaultFail('E_IO', 'manifest.json is not valid JSON', { reason: 'corrupt', path: manifestPath })
  }
  const parsed = vaultManifestSchema.safeParse(rawManifest)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw vaultFail('E_INVALID_ARGUMENT', `manifest.json rejected: ${issue?.path.join('.')} ${issue?.message}`, {
      reason: 'unsupported-format'
    })
  }
  const encBytes = readFileSync(encPath)
  // 结构解析（版本/cipher/长度）在这里做，摘要校验留给解锁流程（要区分「损坏」与「口令错」）
  const envelope = parseEnvelope(encBytes)
  return { manifest: parsed.data, encBytes, envelope }
}

/**
 * 成对事务写：`manifest.json` 与 `vault.enc` 属于**同一次事务**（AC-23）。
 *
 * 序列（暂存区在 `localDir`，绝不在 `repoDir`）：
 * 0. 先自愈上一次被打断的事务；落 `journal.json(phase:'prepared')` 声明「这一对是谁」；
 * 1. 写两份 `.new` + fsync —— 此刻目标文件仍是旧的一对，这一步崩掉等于什么都没发生；
 * 2. 把旧的 `vault.enc` / `manifest.json` 移进暂存区（`rename`，不丢字节）；
 * 3. 把两份 `.new` 移到目标位置 ⇒ 从此刻起磁盘上是完整的新的一对；
 * 4. `journal.phase='done'` 并清空暂存区。
 *
 * 任何一步被打断，下一次 `readRepo`/`recoverPairTx` 都会把它补完或退回，绝不会留下
 * 「manifest 说新版本 + 密文是旧的」这种摘要不符的组合（AC-25：把成对写入改回「先写 enc 再写 manifest」
 * 后，`repo-pair.test.ts` 的中断用例必红）。
 *
 * `themes/` 不参与事务（它坏了不影响解锁），仍在成对写成功之后写。
 */
export function writeRepo(repoDir: string, snapshot: RepoSnapshot, localDir?: string): void {
  assertPairConsistent(snapshot)
  mkdirSync(repoDir, { recursive: true })
  recoverPairTx(repoDir, localDir)

  const staging = stagingDir(repoDir, localDir)
  mkdirSync(staging, { recursive: true })
  const targets = { vault: join(repoDir, ENVELOPE_FILE), manifest: join(repoDir, MANIFEST_FILE) }
  const journalPath = join(staging, JOURNAL_FILE)
  const newVault = join(staging, NEW_FILES.vault)
  const newManifest = join(staging, NEW_FILES.manifest)

  writeJournal(journalPath, 'prepared', repoDir)
  writeFileDurable(newVault, snapshot.encBytes)
  writeFileDurable(newManifest, Buffer.from(`${JSON.stringify(snapshot.manifest, null, 2)}\n`, 'utf8'))

  if (faultForTest === 'before-first-rename') injectedFault(faultForTest)

  moveFile(targets.vault, join(staging, OLD_FILES.vault))
  moveFile(targets.manifest, join(staging, OLD_FILES.manifest))

  if (faultForTest === 'between-renames') injectedFault(faultForTest)

  // 目标此时已被移走；`rm` 兜底处理「上一次事务留下了目标文件」的边界
  if (existsSync(targets.vault)) rmSync(targets.vault, { force: true })
  moveFile(newVault, targets.vault)
  if (existsSync(targets.manifest)) rmSync(targets.manifest, { force: true })
  moveFile(newManifest, targets.manifest)

  writeJournal(journalPath, 'done', repoDir)
  rmSync(staging, { recursive: true, force: true })

  if (snapshot.themes) writeThemes(repoDir, snapshot.themes)
}

/**
 * themes/*.json 是**明文**（非敏感 + 要能 git diff），所以单独写、单独清理。
 * 删掉的主题必须把文件也删掉，否则仓库里会留下去不掉的僵尸主题。
 */
export function writeThemes(repoDir: string, themes: ThemeDefinition[]): { written: string[]; removed: string[] } {
  const dir = join(repoDir, THEMES_DIR)
  mkdirSync(dir, { recursive: true })
  const wanted = new Map<string, ThemeDefinition>()
  for (const theme of themes) {
    const parsed = themeDefinitionSchema.safeParse(theme)
    if (!parsed.success) {
      throw vaultFail('E_INVALID_ARGUMENT', `invalid theme: ${theme?.id ?? '<unknown>'}`, {
        reason: 'invalid-payload',
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      })
    }
    wanted.set(`${parsed.data.id}.json`, parsed.data)
  }

  const written: string[] = []
  for (const [fileName, theme] of wanted) {
    writeFileSync(join(dir, fileName), `${JSON.stringify(theme, null, 2)}\n`, 'utf8')
    written.push(`${THEMES_DIR}/${fileName}`)
  }

  const removed: string[] = []
  for (const fileName of readdirSync(dir)) {
    if (!fileName.endsWith('.json') || wanted.has(fileName)) continue
    const path = join(dir, fileName)
    rmSync(path, { force: true })
    removed.push(`${THEMES_DIR}/${fileName}`)
  }
  return { written, removed }
}

/**
 * 仓库里实际存在的文件（不含 `.git`，不含 themes 下的文件），用于：
 * 1. 验收 `ls -R` 的断言（只许出现 manifest.json / vault.enc / themes）；
 * 2. 提交前确认没有误把敏感文件塞进仓库。
 */
export function listRepoFiles(repoDir: string): string[] {
  if (!existsSync(repoDir)) return []
  const files: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === THEMES_DIR) continue
        walk(join(dir, entry.name), rel)
        continue
      }
      files.push(rel)
    }
  }
  walk(repoDir, '')
  return files.sort()
}

/** themes 目录下的文件名列表（排序后，便于测试断言） */
export function listThemeFiles(repoDir: string): string[] {
  const dir = join(repoDir, THEMES_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
}

export function readBlobText(path: string): string {
  return readFileSync(path, 'utf8')
}
