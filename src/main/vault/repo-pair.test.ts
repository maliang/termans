import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { ThemeDefinition } from '@shared'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  SCRYPT_TEST,
  createVault,
  generateRecoveryCode,
  openVault,
  parseEnvelope,
  payloadDigest,
  type CreatedVault
} from '../crypto'
import {
  ENVELOPE_FILE,
  MANIFEST_FILE,
  PAIR_TX_DIR,
  listRepoFiles,
  listThemeFiles,
  readRepo,
  recoverPairTx,
  setPairTxFaultForTest,
  writeRepo
} from './repo'

/**
 * AC-23 成对落盘（manifest.json + vault.enc 同一次事务）。
 *
 * 三条纪律，缺一条这个文件就退化成「写了个 rename 也算过」：
 * 1. **崩溃点是真的注入的**（`setPairTxFaultForTest`）：两处断点 = 第一个 rename 之前 / 两个 rename 之间；
 * 2. **自愈走的是生产路径**：全部用 `readRepo()`（`manager.init()` 读盘的同一入口），不是直接调 `recoverPairTx`；
 * 3. **每例都验「同一对」**：`manifest.payload_sha256 === payloadDigest(vault.enc)` + 同口令能开，
 *    因为 r3 的事故症状恰恰是「摘要全过、口令判错」。
 */

const PASSPHRASE = 'pair-tx-passphrase-2026'
const PAYLOAD_A = '{"note":"revision-0"}'
const PAYLOAD_B = '{"note":"revision-1"}'

const roots: string[] = []

afterEach(() => {
  setPairTxFaultForTest(null)
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Seeded {
  root: string
  repoDir: string
  localDir: string
  first: CreatedVault
  second: CreatedVault
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'termans-pair-'))
  roots.push(root)
  return root
}

function newVault(payload: string, revision: number, day: number): CreatedVault {
  return createVault({
    payload,
    passphrase: PASSPHRASE,
    recoveryCode: generateRecoveryCode(),
    revision,
    cost: SCRYPT_TEST,
    now: new Date(`2026-01-0${day}T00:00:00.000Z`)
  })
}

/** 一个已经落过盘（revision=0）的仓库 + 一份待写入的新的一对（revision=1） */
function seedRepo(): Seeded {
  const root = makeRoot()
  const repoDir = join(root, 'vault')
  const localDir = join(root, 'vault-local')
  const first = newVault(PAYLOAD_A, 0, 1)
  const second = newVault(PAYLOAD_B, 1, 2)
  writeRepo(repoDir, { manifest: first.manifest, encBytes: first.encBytes, envelope: parseEnvelope(first.encBytes) }, localDir)
  return { root, repoDir, localDir, first, second }
}

function writeSecond(target: Seeded, opts: { localDir?: boolean; envelope?: boolean } = {}): void {
  const snapshot = {
    manifest: target.second.manifest,
    encBytes: target.second.encBytes,
    ...(opts.envelope === false ? {} : { envelope: parseEnvelope(target.second.encBytes) })
  }
  if (opts.localDir === false) writeRepo(target.repoDir, snapshot)
  else writeRepo(target.repoDir, snapshot, target.localDir)
}

/** 从 (manifest, encBytes) 这一对里解出 payload：这一对必须真的能开，否则「自愈成功」是假的 */
function payloadOf(repoDir: string, localDir?: string): string {
  const snapshot = readRepo(repoDir, localDir)
  if (!snapshot) throw new Error('repo is empty')
  const opened = openVault({
    manifest: snapshot.manifest,
    encBytes: snapshot.encBytes,
    credential: { passphrase: PASSPHRASE }
  })
  opened.vaultKey.fill(0)
  return opened.payload
}

/** 崩溃现场断言：磁盘上不允许出现「manifest 与 vault.enc 不是同一对」的组合 */
function expectPairConsistent(repoDir: string, localDir?: string): void {
  const snapshot = readRepo(repoDir, localDir)
  expect(snapshot, '自愈后仓库应当可读').not.toBeNull()
  expect(snapshot!.manifest.payload_sha256, 'manifest 摘要必须指向磁盘上的 vault.enc').toBe(
    payloadDigest(snapshot!.encBytes)
  )
  expect(snapshot!.manifest.payload_sha256).toBe(payloadDigest(readFileSync(join(repoDir, ENVELOPE_FILE))))
}

describe('AC-23 成对落盘事务（.pair-tx 只在 localDir）', () => {
  it('成对写成功：两只文件一起换新、暂存区清空、仓储根仍只有两只文件', () => {
    const target = seedRepo()
    expect(readRepo(target.repoDir, target.localDir)?.manifest.revision).toBe(0)

    writeSecond(target)

    const snapshot = readRepo(target.repoDir, target.localDir)
    expect(snapshot?.manifest.revision).toBe(1)
    expect(snapshot?.encBytes.equals(target.second.encBytes)).toBe(true)
    expectPairConsistent(target.repoDir, target.localDir)
    expect(payloadOf(target.repoDir, target.localDir)).toBe(PAYLOAD_B)

    // E11：仓储根永远只有这三类内容；暂存区绝不能建在 repoDir 里
    expect(listRepoFiles(target.repoDir)).toEqual([MANIFEST_FILE, ENVELOPE_FILE])
    expect(existsSync(join(target.repoDir, PAIR_TX_DIR))).toBe(false)
    expect(existsSync(join(target.localDir, PAIR_TX_DIR))).toBe(false)
  })

  it('第一个 rename 之前被打断：旧的一对原样可用，下次读盘前进到已 fsync 的新的一对', () => {
    const target = seedRepo()
    setPairTxFaultForTest('before-first-rename')

    expect(() => writeSecond(target)).toThrow(/injected crash at before-first-rename/)

    // 崩溃现场：目标文件还是旧的一对（新的一对只在暂存区，还没进仓）
    expect(readFileSync(join(target.repoDir, ENVELOPE_FILE)).equals(target.first.encBytes)).toBe(true)
    expect(existsSync(join(target.localDir, PAIR_TX_DIR, `${ENVELOPE_FILE}.new`))).toBe(true)

    setPairTxFaultForTest(null)
    // 走生产读盘路径（manager.init() 用的是同一个入口）
    expectPairConsistent(target.repoDir, target.localDir)
    const snapshot = readRepo(target.repoDir, target.localDir)
    expect(snapshot?.manifest.revision).toBe(1)
    expect(snapshot?.encBytes.equals(target.second.encBytes)).toBe(true)
    expect(payloadOf(target.repoDir, target.localDir)).toBe(PAYLOAD_B)
    expect(existsSync(join(target.localDir, PAIR_TX_DIR))).toBe(false)
  })

  it('两个 rename 之间被打断：不会出现半对，下次读盘补齐成完整的一对且同口令可开', () => {
    const target = seedRepo()
    setPairTxFaultForTest('between-renames')

    expect(() => writeSecond(target)).toThrow(/injected crash at between-renames/)

    // 崩溃现场：旧的一对已归档进暂存区、新的一对还没就位 ⇒ 目标目录里两只文件都不在
    expect(existsSync(join(target.repoDir, ENVELOPE_FILE))).toBe(false)
    expect(existsSync(join(target.repoDir, MANIFEST_FILE))).toBe(false)
    expect(existsSync(join(target.localDir, PAIR_TX_DIR, `${ENVELOPE_FILE}.old`))).toBe(true)

    setPairTxFaultForTest(null)
    expectPairConsistent(target.repoDir, target.localDir)
    const snapshot = readRepo(target.repoDir, target.localDir)
    expect(snapshot?.manifest.revision).toBe(1)
    expect(payloadOf(target.repoDir, target.localDir)).toBe(PAYLOAD_B)
    expect(listRepoFiles(target.repoDir)).toEqual([MANIFEST_FILE, ENVELOPE_FILE])
  })

  it('recoverPairTx 幂等：连跑两次不产生新副作用，也不丢任何一只文件', () => {
    const target = seedRepo()
    setPairTxFaultForTest('between-renames')
    expect(() => writeSecond(target)).toThrow(/injected crash/)
    setPairTxFaultForTest(null)

    recoverPairTx(target.repoDir, target.localDir)
    const once = {
      vault: payloadDigest(readFileSync(join(target.repoDir, ENVELOPE_FILE))),
      manifest: payloadDigest(readFileSync(join(target.repoDir, MANIFEST_FILE)))
    }
    expect(() => recoverPairTx(target.repoDir, target.localDir)).not.toThrow()
    expect(payloadDigest(readFileSync(join(target.repoDir, ENVELOPE_FILE)))).toBe(once.vault)
    expect(payloadDigest(readFileSync(join(target.repoDir, MANIFEST_FILE)))).toBe(once.manifest)
    expect(existsSync(join(target.localDir, PAIR_TX_DIR))).toBe(false)
    expect(payloadOf(target.repoDir, target.localDir)).toBe(PAYLOAD_B)
  })

  it('只有归档的旧文件在（回滚进行到一半）：把旧的一对还回原位，而不是留一个空仓库', () => {
    const target = seedRepo()
    const staging = join(target.localDir, PAIR_TX_DIR)
    mkdirSync(staging, { recursive: true })
    renameSync(join(target.repoDir, ENVELOPE_FILE), join(staging, `${ENVELOPE_FILE}.old`))
    renameSync(join(target.repoDir, MANIFEST_FILE), join(staging, `${MANIFEST_FILE}.old`))
    writeFileSync(
      join(staging, 'journal.json'),
      `${JSON.stringify({ version: 1, phase: 'prepared', repoDir: resolve(target.repoDir), at: '2026-01-03T00:00:00.000Z' })}\n`,
      'utf8'
    )

    expectPairConsistent(target.repoDir, target.localDir)
    const snapshot = readRepo(target.repoDir, target.localDir)
    expect(snapshot?.manifest.revision).toBe(0)
    expect(snapshot?.encBytes.equals(target.first.encBytes)).toBe(true)
    expect(payloadOf(target.repoDir, target.localDir)).toBe(PAYLOAD_A)
    expect(existsSync(staging)).toBe(false)
    expect(listRepoFiles(target.repoDir)).toEqual([MANIFEST_FILE, ENVELOPE_FILE])
  })

  it('老调用点不传 localDir：暂存区退化为仓储的同级目录，事务后不留痕、仓库不脏', () => {
    const target = seedRepo()

    writeSecond(target, { localDir: false, envelope: false })

    expect(readRepo(target.repoDir)?.manifest.revision).toBe(1)
    expect(listRepoFiles(target.repoDir)).toEqual([MANIFEST_FILE, ENVELOPE_FILE])
    expect(existsSync(join(target.repoDir, PAIR_TX_DIR))).toBe(false)
    expect(existsSync(join(dirname(target.repoDir), PAIR_TX_DIR))).toBe(false)
    // themes 省略 = 不动主题目录（避免漏传字段把主题当僵尸文件删掉）
    expect(listThemeFiles(target.repoDir)).toEqual([])
    expect(existsSync(join(target.repoDir, 'themes'))).toBe(false)
  })

  it('不是同一对的 manifest / vault.enc 必须拒绝落盘（写入口闸门）', () => {
    const target = seedRepo()

    // 回退点：删掉 repo.ts:assertPairConsistent 的摘要比较 → 本例必红（半对会被写进仓库）
    expect(() => writeRepo(target.repoDir, { manifest: target.first.manifest, encBytes: target.second.encBytes }, target.localDir)).toThrow(
      /payload_sha256/
    )

    const snapshot = readRepo(target.repoDir, target.localDir)
    expect(snapshot?.manifest.revision, '被拒的写入不能污染仓库').toBe(0)
    expectPairConsistent(target.repoDir, target.localDir)
    expect(existsSync(join(target.localDir, PAIR_TX_DIR))).toBe(false)
  })

  it('AC-18 不回归：带主题的成对写之后，`ls -R` 仍只有 manifest.json / vault.enc / themes/*.json', () => {
    // 这条与 repo-layout.test.ts 的断言同构，但**不经过 manager**（它由 T7 改写中），
    // 所以它是「成对事务没有把任何东西漏进 repoDir」的独立证据。
    const root = makeRoot()
    const repoDir = join(root, 'vault')
    const localDir = join(root, 'vault-local')
    const vault = newVault(PAYLOAD_A, 0, 1)
    const theme: ThemeDefinition = {
      id: 'ocean',
      name: 'Ocean',
      appearance: 'dark',
      builtin: false,
      extends: 'termans-dark',
      tokens: {},
      createdAt: null,
      updatedAt: null
    }

    writeRepo(repoDir, { manifest: vault.manifest, encBytes: vault.encBytes, themes: [theme] }, localDir)

    const tree = execFileSync('ls', ['-R', repoDir], { encoding: 'utf8' })
    const names = tree
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith(':'))
      .sort()

    expect(listRepoFiles(repoDir)).toEqual([MANIFEST_FILE, ENVELOPE_FILE])
    expect(listThemeFiles(repoDir)).toEqual(['ocean.json'])
    expect(names).toEqual([MANIFEST_FILE, 'ocean.json', 'themes', ENVELOPE_FILE])
    expect(tree, '暂存区绝不允许出现在仓储根').not.toContain(PAIR_TX_DIR)
    expect(tree).not.toContain('local.json')
    expect(tree).not.toContain('session')
    expect(existsSync(join(localDir, PAIR_TX_DIR)), '事务结束后暂存区必须清空').toBe(false)
  })
})
