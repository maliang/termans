import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  SshConfigFieldUpdate,
  SshConfigParseResult,
  SshConfigWriteRequest,
  SshConfigWriteResult
} from '@shared'
import { vaultFail } from './errors'
import { diffTexts, parseSshConfigText, updateHostFields } from './ssh-config-text'

/**
 * 系统 `ssh_config` 的**显式**读写（用户点按钮才动系统文件，默认绝不自动写）。
 *
 * 安全细节：
 * - 落盘权限 0600、父目录（~/.ssh）0700；
 * - 覆盖已有文件前默认生成 `<path>.termans-backup-<ts>`，备份失败就整个放弃（宁可不写）；
 * - `dryRun=true` 只算 diff 不落盘，UI 先用它给用户看「会改哪几行」；
 * - `path` 支持 `~` 展开，但**不允许相对路径**（相对路径会落在 main 进程 cwd，用户完全预期不到）。
 */

export function expandHomePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

export function defaultSshConfigPaths(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    const profile = process.env.USERPROFILE ?? home
    return [join(profile, '.ssh', 'config')]
  }
  return [join(home, '.ssh', 'config')]
}

function requireAbsolutePath(input: string): string {
  const expanded = expandHomePath(input)
  if (expanded === '') {
    throw vaultFail('E_INVALID_ARGUMENT', 'ssh config path is required', { reason: 'invalid-payload', field: 'path' })
  }
  if (!isAbsolute(expanded)) {
    throw vaultFail('E_INVALID_ARGUMENT', `ssh config path must be absolute: ${input}`, {
      reason: 'invalid-payload',
      field: 'path',
      path: input
    })
  }
  return resolve(expanded)
}

export function readSshConfigFile(path: string | null): SshConfigParseResult {
  const target = path === null || path.trim() === '' ? defaultSshConfigPaths()[0]! : requireAbsolutePath(path)
  if (!existsSync(target)) {
    return { path: target, exists: false, entries: [], includedFiles: [], warnings: [] }
  }
  const stats = statSync(target)
  if (!stats.isFile()) {
    throw vaultFail('E_INVALID_ARGUMENT', `not a regular file: ${target}`, { reason: 'invalid-payload', path: target })
  }
  if (stats.size > 4 * 1024 * 1024) {
    throw vaultFail('E_INVALID_ARGUMENT', `ssh config is unexpectedly large: ${target}`, {
      reason: 'invalid-payload',
      path: target,
      size: stats.size
    })
  }
  return parseSshConfigText(readFileSync(target, 'utf8'), target)
}

/**
 * 按 alias 更新字段并落盘。
 *
 * 写回策略：先算出整份新文本 → 只有 dryRun 才比较「有没有真的变」→
 * 有变化才备份 + 原子写。没变化就不碰文件（不产生无意义 mtime 变化与备份垃圾）。
 */
export function writeSshConfig(request: SshConfigWriteRequest): SshConfigWriteResult {
  const target = requireAbsolutePath(request.path)
  const exists = existsSync(target)
  const before = exists ? readFileSync(target, 'utf8') : ''
  if (exists && !statSync(target).isFile()) {
    throw vaultFail('E_INVALID_ARGUMENT', `not a regular file: ${target}`, { reason: 'invalid-payload', path: target })
  }

  let after = before
  const modifiedAliases: string[] = []
  const appendedAliases: string[] = []
  for (const update of request.updates as SshConfigFieldUpdate[]) {
    const result = updateHostFields(after, update.alias, update.fields)
    after = result.text
    if (result.appended) appendedAliases.push(update.alias)
    else if (result.modified) modifiedAliases.push(update.alias)
  }

  const changedLineCount = countChangedLines(before, after)
  const diff = diffTexts(before, after)
  const base: SshConfigWriteResult = {
    path: target,
    backupPath: null,
    modifiedAliases,
    appendedAliases,
    changedLineCount,
    diff,
    dryRun: request.dryRun
  }
  if (request.dryRun || changedLineCount === 0) return base

  const backupPath = request.createBackup ? backupFile(target, exists) : null
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${target}.termans-tmp-${process.pid}`
  writeFileSync(tmp, after, { mode: 0o600 })
  renameSync(tmp, target)
  return { ...base, backupPath }
}

/** 整份文本导出（把密文里的 ssh_config 写到系统文件，显式动作） */
export function exportSshConfigText(path: string, text: string, createBackup: boolean, dryRun: boolean): SshConfigWriteResult {
  const target = requireAbsolutePath(path)
  const exists = existsSync(target)
  const before = exists ? readFileSync(target, 'utf8') : ''
  if (exists && !statSync(target).isFile()) {
    throw vaultFail('E_INVALID_ARGUMENT', `not a regular file: ${target}`, { reason: 'invalid-payload', path: target })
  }
  const body = text.endsWith('\n') || text === '' ? text : `${text}\n`
  const changedLineCount = countChangedLines(before, body)
  const diff = diffTexts(before, body)
  const base: SshConfigWriteResult = {
    path: target,
    backupPath: null,
    modifiedAliases: [],
    appendedAliases: [],
    changedLineCount,
    diff,
    dryRun
  }
  if (dryRun || changedLineCount === 0) return base
  const backupPath = createBackup ? backupFile(target, exists) : null
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.termans-tmp-${process.pid}`
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, target)
  return { ...base, backupPath }
}

function backupFile(target: string, exists: boolean): string | null {
  if (!exists) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${target}.termans-backup-${stamp}`
  try {
    const content = readFileSync(target)
    writeFileSync(backupPath, content, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    throw vaultFail('E_IO', `failed to back up ${target}`, {
      reason: 'corrupt',
      path: target,
      backupPath,
      message: error instanceof Error ? error.message : String(error)
    })
  }
  return backupPath
}

function countChangedLines(before: string, after: string): number {
  if (before === after) return 0
  const a = before.split('\n')
  const b = after.split('\n')
  const common = Math.min(a.length, b.length)
  let same = 0
  for (let index = 0; index < common; index += 1) {
    if (a[index] === b[index]) same += 1
  }
  return Math.max(a.length, b.length) - same
}
