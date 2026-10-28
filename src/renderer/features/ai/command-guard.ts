/**
 * 命令建议守卫（渲染层，纯函数 + 一个小状态机，方便单测）。
 *
 * 三条不可协商的规则（对应 task t5 第 5 条与 SPEC A-06/A-07）：
 * 1. **默认只复制**：卡片上的主按钮是「复制」，不是「执行」。
 * 2. **执行要两次交互**：点「执行」→ 弹二次确认 → 确认后才拿到一次性的执行许可。
 *    许可由 `take()` 发放且**一次性**，拿不到许可的路径无法把命令写进终端。
 * 3. **危险命令额外红色告警**：`rm -rf /`、`dd of=/dev/sda`、`mkfs`、`shutdown`、fork bomb 等，
 *    二次确认对话框会用危险色显示命中的原因，并且不允许「一键确认」以外的隐式路径。
 *
 * 这个文件不碰 DOM、不碰 IPC：UI 只是把 `request → confirm → take` 串起来。
 */
import type { AiCommandSuggestion } from '@shared/models/ai'

export type DangerReason =
  | 'rm-recursive'
  | 'rm-force'
  | 'rm-recursive-root'
  | 'disk-write'
  | 'filesystem-format'
  | 'shutdown'
  | 'fork-bomb'
  | 'permission-wide'
  | 'remote-script'
  | 'sql-destructive'
  | 'device-overwrite'

export interface CommandAssessment {
  dangerous: boolean
  /** 高危：红色告警；非高危（如 curl | bash）只算「注意」 */
  highRisk: boolean
  reasons: DangerReason[]
}

const HIGH_RISK: ReadonlySet<DangerReason> = new Set<DangerReason>([
  'rm-recursive-root',
  'disk-write',
  'filesystem-format',
  'shutdown',
  'fork-bomb',
  'device-overwrite',
  'sql-destructive'
])

function hasShortFlag(segment: string, flag: string): boolean {
  // 匹配 -rf / -fr / -r -f / --recursive 这类组合，但不要误伤 `-r` 出现在别的参数里（如 --dry-run）
  const shortFlags = segment.match(/(?:^|\s)-([A-Za-z]+)/g) ?? []
  for (const group of shortFlags) {
    const letters = group.trim().slice(1)
    if (letters.includes(flag)) return true
  }
  return false
}

/** 判断一条命令的危险程度（纯字符串规则，宁可多报也不漏报） */
export function assessCommand(command: string): CommandAssessment {
  const text = command.replace(/\r/g, '').trim()
  const lower = text.toLowerCase()
  const reasons = new Set<DangerReason>()

  // rm -rf / rm -r -f / rm --recursive --force
  const rmMatches = lower.match(/(?:^|[;&|]\s*|\bsudo\s+)rm\s+[^\n]*/g) ?? []
  for (const segment of rmMatches) {
    const recursive = hasShortFlag(segment, 'r') || segment.includes('--recursive')
    const force = hasShortFlag(segment, 'f') || segment.includes('--force')
    if (recursive) reasons.add('rm-recursive')
    // 只有 -f（不带 -r）：同样是「不确认就删数据」，但原因文案必须说实话，不能写成递归删除
    else if (force) reasons.add('rm-force')
    if (!recursive && !force) continue
    const targetsRoot =
      /\s(?:\/|\/\*|~|~\/|\$HOME|"\/"|'\/')\s*$/.test(segment) ||
      /\s--no-preserve-root\b/.test(segment) ||
      /\s\/(?:\s|$)/.test(segment)
    if (targetsRoot) reasons.add('rm-recursive-root')
  }

  // dd of=/dev/... 或 > /dev/sdX
  if (/\bdd\b[^\n]*\bof=\/dev\//.test(lower) || />\s*\/dev\/(?:sd|nvme|disk|hd)/.test(lower)) {
    reasons.add('disk-write')
  }
  if (/\bof=\/dev\/(?:sd|nvme|disk|hd)/.test(lower)) reasons.add('device-overwrite')

  // 格式化
  if (/\bmkfs(?:\.[a-z0-9]+)?\b/.test(lower) || /\bmke2fs\b/.test(lower)) {
    reasons.add('filesystem-format')
  }

  // 关机/重启
  if (
    /(?:^|[;&|]\s*)(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff)\b/.test(lower) ||
    /\bsystemctl\s+(?:poweroff|reboot|halt)\b/.test(lower) ||
    /\binit\s+0\b/.test(lower)
  ) {
    reasons.add('shutdown')
  }

  // fork bomb（:(){ :|:& };: 及其空白变体）
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/.test(text)) {
    reasons.add('fork-bomb')
  }

  // 全盘权限放开
  if (/\bch(?:mod|own)\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\s+)[^\n]*\s\/(?:\s|$)/.test(lower)) {
    reasons.add('permission-wide')
  }

  // curl ... | sh / wget ... | bash
  if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/.test(lower)) {
    reasons.add('remote-script')
  }

  // SQL 破坏性语句
  if (/\bdrop\s+(?:table|database|schema)\b/.test(lower) || /\btruncate\s+table\b/.test(lower)) {
    reasons.add('sql-destructive')
  } else if (/\bdelete\s+from\b/.test(lower) && !/\bwhere\b/.test(lower)) {
    reasons.add('sql-destructive')
  }

  const list = [...reasons]
  return {
    dangerous: list.length > 0,
    highRisk: list.some((reason) => HIGH_RISK.has(reason)),
    reasons: list
  }
}

export interface CommandBlock {
  command: string
  language: string | null
  explanation: string | null
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'pwsh', 'cmd', 'bat'])

/** 从 AI 回复里抽出可执行命令块（```bash 代码块；无语言标记的块按 shell 处理） */
export function extractCommandBlocks(text: string): CommandBlock[] {
  const blocks: CommandBlock[] = []
  const pattern = /```([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const language = match[1].trim().toLowerCase()
    const body = match[2].replace(/\s+$/, '')
    if (body.trim().length === 0) continue
    const isShell = language.length === 0 || SHELL_LANGS.has(language)
    if (!isShell) continue
    const command = body
      .split('\n')
      // 去掉 readme 风格的提示符前缀（`$ ls` / `> ls`）
      .map((line) => line.replace(/^\s*[$#>]\s?/, ''))
      .join('\n')
      .trim()
    if (command.length === 0) continue
    blocks.push({
      command,
      language: language.length > 0 ? language : null,
      explanation: explanationBefore(text, match.index) ?? explanationAfter(text, match.index + match[0].length)
    })
  }
  return blocks
}

function explanationBefore(text: string, fenceStart: number): string | null {
  const before = text.slice(0, fenceStart).trimEnd()
  if (before.length === 0) return null
  const paragraph = before.split(/\n\s*\n/).pop() ?? ''
  const line = paragraph.split('\n').filter((l) => l.trim().length > 0).pop() ?? ''
  if (line.length === 0 || line.startsWith('```') || line.length > 240) return null
  return line
}

function explanationAfter(text: string, fenceEnd: number): string | null {
  const after = text.slice(fenceEnd).trim()
  if (after.length === 0) return null
  const line = after.split(/\n\s*\n/)[0].split('\n')[0]
  if (line.length === 0 || line.length > 240) return null
  return line
}

/** 转成 shared 契约里的命令建议（`requiresConfirmation` 恒为 true） */
export function toSuggestion(block: CommandBlock): AiCommandSuggestion {
  return {
    command: block.command.slice(0, 4000),
    explanation: block.explanation ?? '',
    requiresConfirmation: true
  }
}

export type GuardPhase = 'idle' | 'awaiting-confirm' | 'ready'

export interface GuardTicket {
  token: string
  command: string
  assessment: CommandAssessment
  /** 契约里的字面量要求：UI 必须走二次确认 */
  requiresConfirmation: true
}

export type ConfirmFailure = 'no-pending' | 'token-mismatch' | 'expired'

export type ConfirmResult =
  | { ok: true; command: string; assessment: CommandAssessment }
  | { ok: false; reason: ConfirmFailure }

export interface CommandGuardOptions {
  now?: () => number
  /** 二次确认对话框的有效期（默认 5 分钟，避免弹窗挂一晚上后还能执行） */
  ttlMs?: number
  tokenFactory?: () => string
}

let guardSeq = 0

/**
 * 二次确认状态机。
 *
 * `request()` 只产生待确认票据；`confirm()` 校验票据并转入 ready；
 * `take()` **一次性**发放执行许可。UI 里唯一允许写终端的路径是
 * `const ticket = guard.request(cmd)` → 用户点确认 → `guard.confirm(ticket.token)` → `guard.take(ticket.token)`。
 */
export class CommandGuard {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly tokenFactory: () => string
  private pendingTicket: GuardTicket | null = null
  private readyTicket: GuardTicket | null = null

  constructor(options: CommandGuardOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000
    this.tokenFactory =
      options.tokenFactory ??
      (() => {
        guardSeq += 1
        return `cmd-${this.now().toString(36)}-${guardSeq}`
      })
  }

  get phase(): GuardPhase {
    if (this.readyTicket) return 'ready'
    if (this.pendingTicket) return 'awaiting-confirm'
    return 'idle'
  }

  get pending(): GuardTicket | null {
    return this.pendingTicket
  }

  request(command: string): GuardTicket {
    const trimmed = command.trim()
    if (trimmed.length === 0) throw new Error('empty command')
    const ticket: GuardTicket = {
      token: this.tokenFactory(),
      command: trimmed,
      assessment: assessCommand(trimmed),
      requiresConfirmation: true
    }
    this.pendingTicket = ticket
    this.readyTicket = null
    return ticket
  }

  confirm(token: string): ConfirmResult {
    const ticket = this.pendingTicket
    if (!ticket) return { ok: false, reason: 'no-pending' }
    if (ticket.token !== token) return { ok: false, reason: 'token-mismatch' }
    if (this.isExpired(ticket)) {
      this.pendingTicket = null
      return { ok: false, reason: 'expired' }
    }
    this.pendingTicket = null
    this.readyTicket = ticket
    return { ok: true, command: ticket.command, assessment: ticket.assessment }
  }

  /** 取执行许可（一次性）；拿不到返回 null —— 调用方必须把 null 当成「拒绝执行」 */
  take(token: string): string | null {
    const ready = this.readyTicket
    if (!ready || ready.token !== token) return null
    this.readyTicket = null
    return ready.command
  }

  cancel(): void {
    this.pendingTicket = null
    this.readyTicket = null
  }

  reset(): void {
    this.cancel()
  }

  private isExpired(ticket: GuardTicket): boolean {
    // token 形如 `cmd-<base36 毫秒>-<序号>`：时间戳编在 token 里，票据本身不需要额外字段
    const issuedMs = Number.parseInt(ticket.token.split('-')[1] ?? '', 36)
    if (!Number.isFinite(issuedMs)) return false
    return this.now() - issuedMs > this.ttlMs
  }
}
