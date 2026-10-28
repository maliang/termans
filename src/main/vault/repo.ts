import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { themeDefinitionSchema, type ThemeDefinition } from '@shared'
import { parseEnvelope, vaultManifestSchema, type VaultEnvelope, type VaultManifest } from '../crypto'
import { vaultFail } from './errors'

/**
 * 仓库（Git 工作区）的文件布局 —— 这是「仓库里只有密文」的物理证据。
 *
 *     <repoDir>/manifest.json     明文：版本/kdf/revision/payload_sha256/密钥槽（不含任何主机信息）
 *     <repoDir>/vault.enc         密文：唯一的敏感数据载体（主机、密码、备注、ssh_config 全文…）
 *     <repoDir>/themes/*.json     明文：主题（非敏感，保留 git diff 可读性）
 *
 * 除此之外**任何东西都不许进这个目录**：私钥本体、机器专用的会话密钥、Git token、
 * 冲突快照都在 `localDir`（userData/vault-local），并且 `.gitignore` 之外还有单测守着。
 */

export const MANIFEST_FILE = 'manifest.json'
export const ENVELOPE_FILE = 'vault.enc'
export const THEMES_DIR = 'themes'

export interface VaultRepoSnapshot {
  manifest: VaultManifest
  encBytes: Buffer
  envelope: VaultEnvelope
}

export interface VaultRepoWrites {
  manifest: VaultManifest
  encBytes: Buffer
  themes: ThemeDefinition[]
}

/** 仓库里没有 manifest.json 也没有 vault.enc 时返回 null（= 未初始化） */
export function readRepo(repoDir: string): VaultRepoSnapshot | null {
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
 * 原子写：先写 `.tmp` 再 rename。
 *
 * 顺序上**先写 vault.enc、后写 manifest.json**：manifest 里的 payload_sha256 指向新密文，
 * 万一在这两步之间崩了，下次解锁会因摘要不符直接判「数据损坏」，是 fail-closed；
 * 反过来（先写 manifest）则会出现「manifest 说新版本、密文还是旧的」，症状一样但更难解释。
 */
export function writeRepo(repoDir: string, writes: VaultRepoWrites): void {
  mkdirSync(repoDir, { recursive: true })
  writeAtomic(join(repoDir, ENVELOPE_FILE), writes.encBytes)
  writeAtomic(join(repoDir, MANIFEST_FILE), Buffer.from(`${JSON.stringify(writes.manifest, null, 2)}\n`, 'utf8'))
  writeThemes(repoDir, writes.themes)
}

function writeAtomic(path: string, content: Buffer): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
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
