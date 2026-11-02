import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IpcCallError, type GitTokenCandidate } from '@shared'

/**
 * Git 令牌的来源探测（t57）。
 *
 * 为什么要在主进程里做：这些来源全是**进程外的事实**——环境变量、`gh` CLI 的登录态、
 * `~/.git-credentials` 文件。渲染层没有 fs/exec 权限，而把它们暴露给渲染层再读一遍
 * 等于把「哪里可能有令牌」写成两份实现，早晚不一致。
 *
 * 安全约束：
 * - 明文令牌**只在主进程内部流转**：检测结果的 `token` 字段不随 IPC 下发给渲染层（只发掩码）；
 *   用户点「复制」时走一次性的 `sync:token-reveal`，那是用户主动动作、可以审计。
 * - 不读 `security find-internet-password`（会弹系统授权框，打断用户且无法静默）。
 * - 每个来源都单独 try/catch：`gh` 没装、文件不存在、环境变量缺失都是**正常情况**，
 *   不允许因为一个来源失败就让整个检测报错。
 */

/** 令牌最长 8KB：个人访问令牌远小于这个数，超出的一定不是令牌 */
const MAX_TOKEN_BYTES = 8_192

/** 掩码：只露尾 4 位；长度不足 12 时整体遮住（否则尾 4 位就占了大半，等于明文） */
export function maskGitToken(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length < 12) return '••••'
  return `••••${trimmed.slice(-4)}`
}

interface DetectedToken extends GitTokenCandidate {
  token: string
}

const ENV_SOURCES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'GITHUB_TOKEN', label: 'env:GITHUB_TOKEN' },
  { name: 'GH_TOKEN', label: 'env:GH_TOKEN' },
  { name: 'GITLAB_TOKEN', label: 'env:GITLAB_TOKEN' },
  { name: 'TERMANS_GIT_TOKEN', label: 'env:TERMANS_GIT_TOKEN' }
]

function fromEnv(): DetectedToken[] {
  const found: DetectedToken[] = []
  for (const { name, label } of ENV_SOURCES) {
    const value = (process.env[name] ?? '').trim()
    if (value.length === 0) continue
    found.push({ id: label, label, source: 'env', masked: maskGitToken(value), token: value })
  }
  return found
}

function fromGhCli(): DetectedToken[] {
  try {
    const output = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const value = output.trim()
    if (value.length === 0) return []
    return [{ id: 'gh:cli', label: 'gh CLI', source: 'gh', masked: maskGitToken(value), token: value }]
  } catch {
    // gh 没装 / 没登录 / 超时 —— 都是正常的「没有这个来源」
    return []
  }
}

/**
 * `~/.git-credentials` 的一行形如 `https://user:ghp_xxx@github.com`。
 * 只取第一个冒号之后、最后一个 `@` 之前那段；URL 里可能有编码字符，做一次 decode。
 */
function fromGitCredentialsFile(): DetectedToken[] {
  try {
    const path = join(homedir(), '.git-credentials')
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 64 * 1_024) return []
    const found: DetectedToken[] = []
    const lines = readFileSync(path, 'utf8').split(/\r?\n/)
    let index = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const schemeAt = trimmed.indexOf('://')
      const at = trimmed.lastIndexOf('@')
      if (schemeAt < 0 || at < 0) continue
      const credentials = trimmed.slice(schemeAt + 3, at)
      const colon = credentials.indexOf(':')
      if (colon < 0) continue
      let value = credentials.slice(colon + 1)
      try {
        value = decodeURIComponent(value)
      } catch {
        /* 保持原样 */
      }
      if (value.length === 0) continue
      index += 1
      const host = trimmed.slice(at + 1).split('/')[0] ?? ''
      found.push({
        id: `git-credentials:${index}`,
        label: `~/.git-credentials · ${host}`,
        source: 'git-credentials',
        masked: maskGitToken(value),
        token: value
      })
    }
    return found
  } catch {
    return []
  }
}

/**
 * 检测系统里能用的令牌。**同一个令牌值只报一次**（先 env、再 gh、最后 git-credentials），
 * 否则用户会在界面上看到三条一模一样的 `••••abcd`，分不清该点哪个。
 */
export function detectSystemGitTokens(): DetectedToken[] {
  const ordered = [...fromEnv(), ...fromGhCli(), ...fromGitCredentialsFile()]
  const seen = new Set<string>()
  const unique: DetectedToken[] = []
  for (const item of ordered) {
    if (seen.has(item.token)) continue
    seen.add(item.token)
    unique.push(item)
  }
  return unique
}

/**
 * 读令牌文件。**失败必须说清是哪一种失败**（路径不存在 / 是目录 / 太大 / 空文件）：
 * 「令牌读取失败」这种话对用户没有任何帮助，他无从下手。
 */
export function readGitTokenFile(path: string): string {
  const target = path.trim()
  if (target.length === 0) {
    throw new IpcCallError({ code: 'E_INVALID_ARGUMENT', message: '令牌文件路径为空', details: { reason: 'token-file-empty-path' } })
  }
  let stat
  try {
    stat = statSync(target)
  } catch {
    throw new IpcCallError({ code: 'E_INVALID_ARGUMENT', message: `令牌文件不存在：${target}`, details: { reason: 'token-file-missing', path: target } })
  }
  if (!stat.isFile()) {
    throw new IpcCallError({ code: 'E_INVALID_ARGUMENT', message: `不是普通文件：${target}`, details: { reason: 'token-file-not-a-file', path: target } })
  }
  if (stat.size > MAX_TOKEN_BYTES) {
    throw new IpcCallError({ code: 'E_INVALID_ARGUMENT', message: `令牌文件超过 ${MAX_TOKEN_BYTES} 字节，看起来不是令牌：${target}`, details: {
      reason: 'token-file-too-large',
      path: target
    } })
  }
  let text: string
  try {
    text = readFileSync(target, 'utf8')
  } catch {
    throw new IpcCallError({ code: 'E_IO', message: `令牌文件读不出来（权限？）：${target}`, details: { reason: 'token-file-unreadable', path: target } })
  }
  // 取第一条非空行：允许文件里有注释/换行，但不允许「整个文件当令牌」蒙对
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstLine === undefined) {
    throw new IpcCallError({ code: 'E_INVALID_ARGUMENT', message: `令牌文件是空的：${target}`, details: { reason: 'token-file-empty', path: target } })
  }
  return firstLine
}
