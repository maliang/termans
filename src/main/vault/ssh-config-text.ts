import type { SshConfigEntry, SshConfigParseResult } from '@shared'

/**
 * `~/.ssh/config` 的**纯文本**双向处理（无 IO，便于单测）。
 *
 * 硬性要求（shared/models/ssh-config.ts 头注释）：只改指定 alias 的指定字段，
 * **区间外文本逐字保留** —— 注释、空行、未知指令、缩进风格、大小写都不许被「重建」掉。
 * 所以这里全部按「行数组 + 只替换命中的行」实现，不做 parse → 序列化 → 重排那一套。
 *
 * 语义要点（与 OpenSSH 一致）：
 * - 一个 `Host a b c` 行开一个块，块内是若干 `Keyword value`；
 * - 块在下一个 `Host` / `Match` 行前结束；
 * - `Include` 行只记录被引用的文件，不在这里展开（写回时要保证不破坏它）；
 * - 新增字段缩进用 4 空格（与主流手写风格一致），已有行的缩进沿用原样。
 */

const KEYWORD_RE = /^(\s*)([A-Za-z][A-Za-z0-9]*)(\s*)(.*)$/
const INDENT = '    '

interface Line {
  text: string
}

interface BlockRange {
  /** 1-based 行号 */
  startLine: number
  /** 1-based 行号（含） */
  endLine: number
  patterns: string[]
  kind: 'host' | 'match'
}

function linesOf(text: string): Line[] {
  if (text === '') return []
  return text.split('\n').map((line) => ({ text: line }))
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text).join('\n')
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1)
  return trimmed
}

function parseKeyword(line: string): { keyword: string; value: string; indent: string; gap: string } | null {
  if (line.trim() === '' || line.trimStart().startsWith('#')) return null
  const match = KEYWORD_RE.exec(line)
  if (!match) return null
  const [, indent, keyword, gap, value] = match
  return { keyword: keyword ?? '', value: (value ?? '').trim(), indent: indent ?? '', gap: gap || ' ' }
}

/** 找出所有 `Host` / `Match` 块的行号范围（1-based，含首含尾） */
function findBlocks(lines: Line[]): BlockRange[] {
  const starts: { index: number; kind: 'host' | 'match'; patterns: string[] }[] = []
  lines.forEach((line, index) => {
    const parsed = parseKeyword(line.text)
    if (!parsed) return
    const keyword = parsed.keyword.toLowerCase()
    if (keyword !== 'host' && keyword !== 'match') return
    const patterns =
      keyword === 'host'
        ? parsed.value.split(/\s+/).filter(Boolean).map(stripQuotes)
        : parsed.value.split(/\s+/).filter(Boolean)
    starts.push({ index, kind: keyword === 'host' ? 'host' : 'match', patterns })
  })

  return starts.map((start, position) => {
    const next = starts[position + 1]
    let end = next ? next.index - 1 : lines.length - 1
    // 块尾的空行不属于块内容（否则删除/替换时会把分隔空行也带走）
    while (end > start.index && (lines[end]?.text ?? '').trim() === '') end -= 1
    return { startLine: start.index + 1, endLine: end + 1, patterns: start.patterns, kind: start.kind }
  })
}

export function parseSshConfigText(text: string, sourcePath: string): SshConfigParseResult {
  if (text === '') {
    return { path: sourcePath, exists: true, entries: [], includedFiles: [], warnings: [] }
  }
  const lines = linesOf(text)
  const blocks = findBlocks(lines)
  const includedFiles: string[] = []
  const warnings: { line: number; message: string }[] = []
  const entries: SshConfigEntry[] = []
  const seenAliases = new Map<string, number>()

  lines.forEach((line) => {
    const parsed = parseKeyword(line.text)
    if (!parsed) return
    if (parsed.keyword.toLowerCase() === 'include') {
      for (const file of parsed.value.split(/\s+/).filter(Boolean)) includedFiles.push(stripQuotes(file))
    }
  })

  for (const block of blocks) {
    if (block.kind === 'match' || block.patterns.length === 0) {
      warnings.push({ line: block.startLine, message: block.kind === 'match' ? 'Match block is not imported' : 'Host directive without patterns' })
      continue
    }
    const alias = block.patterns[0]!
    const previous = seenAliases.get(alias.toLowerCase())
    if (previous !== undefined) {
      warnings.push({ line: block.startLine, message: `duplicate Host block for "${alias}" (first at line ${previous}); SSH uses the first match` })
    } else {
      seenAliases.set(alias.toLowerCase(), block.startLine)
    }

    const entry: SshConfigEntry = {
      alias,
      patterns: block.patterns,
      hostname: null,
      port: null,
      user: null,
      identityFile: null,
      proxyJump: null,
      proxyCommand: null,
      options: {},
      startLine: block.startLine,
      endLine: block.endLine
    }

    for (let index = block.startLine; index <= block.endLine; index += 1) {
      const parsed = parseKeyword(lines[index - 1]?.text ?? '')
      if (!parsed || parsed.keyword.toLowerCase() === 'host') continue
      const keyword = parsed.keyword.toLowerCase()
      const value = stripQuotes(parsed.value)
      if (value === '') continue
      switch (keyword) {
        case 'hostname':
          entry.hostname ??= value
          break
        case 'port':
          if (entry.port === null && /^\d+$/.test(value)) entry.port = Number(value)
          break
        case 'user':
          entry.user ??= value
          break
        case 'identityfile':
          entry.identityFile ??= value
          break
        case 'proxyjump':
          entry.proxyJump ??= value
          break
        case 'proxycommand':
          entry.proxyCommand ??= value
          break
        default:
          // 未知/其它指令按原大小写保留，导出时能逐字写回
          entry.options[parsed.keyword] ??= value
      }
    }
    entries.push(entry)
  }

  return { path: sourcePath, exists: true, entries, includedFiles, warnings }
}

export interface HostBlockUpdate {
  text: string
  /** 命中了已存在的块（改了行） */
  modified: boolean
  /** 文件里没有这个 alias，追加了新块 */
  appended: boolean
  /** 实际改动的行数（diff 用） */
  changedLineCount: number
  /** 命中的块覆盖到的所有 pattern（多 pattern 时改一个等于改全部） */
  patterns: string[]
}

/**
 * 只改 `alias` 块内指定的 keyword 行。
 *
 * `fields` 的 key 是关键字（大小写不敏感匹配已有行；新增行按传入的写法写），
 * 值为 `null` 表示删除该行。未知关键字也支持（这就是「未知指令逐字保留 + 可改」的实现）。
 */
export function updateHostFields(text: string, alias: string, fields: Record<string, string | null>): HostBlockUpdate {
  const lines = linesOf(text)
  const block = findBlocks(lines).find(
    (item) => item.kind === 'host' && item.patterns.some((pattern) => pattern.toLowerCase() === alias.toLowerCase())
  )
  const entries = Object.entries(fields)

  if (!block) {
    const appendedLines: Line[] = []
    const body = entries.filter(([, value]) => value !== null)
    if (lines.length > 0) {
      const tail = lines[lines.length - 1]?.text ?? ''
      if (tail.trim() !== '') appendedLines.push({ text: '' })
    }
    appendedLines.push({ text: `Host ${alias}` })
    for (const [keyword, value] of body) appendedLines.push({ text: `${INDENT}${keyword} ${value}` })
    const next = joinLines([...lines, ...appendedLines])
    return {
      text: next.endsWith('\n') ? next : `${next}\n`,
      modified: false,
      appended: true,
      changedLineCount: appendedLines.length,
      patterns: [alias]
    }
  }

  let changed = 0
  const removals = new Set<number>()
  const replacements = new Map<number, string>()
  const insertions: string[] = []

  for (const [keyword, value] of entries) {
    const lower = keyword.toLowerCase()
    const index = findKeywordLine(lines, block, lower)
    if (index !== null) {
      if (value === null) {
        removals.add(index)
        changed += 1
        continue
      }
      const parsed = parseKeyword(lines[index]?.text ?? '')
      if (!parsed) continue
      const nextLine = `${parsed.indent}${parsed.keyword}${parsed.gap}${value}`
      if (nextLine !== lines[index]?.text) {
        replacements.set(index, nextLine)
        changed += 1
      }
      continue
    }
    if (value === null) continue
    insertions.push(`${INDENT}${keyword} ${value}`)
    changed += 1
  }

  if (changed === 0) {
    return { text, modified: false, appended: false, changedLineCount: 0, patterns: block.patterns }
  }

  const next: Line[] = []
  const insertAt = block.startLine - 1 + 1 // 插在 Host 行之后
  lines.forEach((line, index) => {
    if (index === insertAt && insertions.length > 0) {
      for (const insertion of insertions) next.push({ text: insertion })
    }
    if (removals.has(index)) return
    const replaced = replacements.get(index)
    next.push({ text: replaced ?? line.text })
  })
  if (insertAt >= lines.length && insertions.length > 0) {
    for (const insertion of insertions) next.push({ text: insertion })
  }

  return { text: joinLines(next), modified: true, appended: false, changedLineCount: changed, patterns: block.patterns }
}

function findKeywordLine(lines: Line[], block: BlockRange, lowerKeyword: string): number | null {
  for (let index = block.startLine; index <= block.endLine; index += 1) {
    const parsed = parseKeyword(lines[index - 1]?.text ?? '')
    if (!parsed) continue
    if (parsed.keyword.toLowerCase() === lowerKeyword) return index - 1
  }
  return null
}

/** 删除整个 Host 块（含它前面的分隔空行，避免越删越空） */
export function removeHostBlock(text: string, alias: string): { text: string; removed: boolean } {
  const lines = linesOf(text)
  const block = findBlocks(lines).find(
    (item) => item.kind === 'host' && item.patterns.some((pattern) => pattern.toLowerCase() === alias.toLowerCase())
  )
  if (!block) return { text, removed: false }
  let start = block.startLine - 1
  let end = block.endLine - 1
  while (start > 0 && (lines[start - 1]?.text ?? '').trim() === '') start -= 1
  while (end < lines.length - 1 && (lines[end + 1]?.text ?? '').trim() === '') end += 1
  const next = [...lines.slice(0, start), ...lines.slice(end + 1)]
  return { text: joinLines(next), removed: true }
}

/** 导出时按 alias 过滤（`aliases=null` = 原样返回整份文本） */
export function filterSshConfigText(text: string, aliases: string[] | null): string {
  if (aliases === null) return text
  const wanted = new Set(aliases.map((alias) => alias.toLowerCase()))
  const lines = linesOf(text)
  const blocks = findBlocks(lines)
  const keep = new Array<boolean>(lines.length).fill(false)
  // 块前的全局指令（Host 之前的 User/Port 等）在按别名导出时丢弃：它们对单台主机可能不适用
  for (const block of blocks) {
    if (block.kind !== 'host') continue
    if (!block.patterns.some((pattern) => wanted.has(pattern.toLowerCase()))) continue
    for (let index = block.startLine - 1; index <= block.endLine - 1; index += 1) keep[index] = true
  }
  const kept = lines
    .map((line, index) => ({ line: line.text, keep: keep[index] || line.text.trim() === '' }))
    .filter((item) => item.keep)
    .map((item) => item.line)
  // 连续空行压缩到一个，避免过滤后一堆空行
  const collapsed: string[] = []
  for (const line of kept) {
    if (line.trim() === '' && collapsed.length > 0 && collapsed[collapsed.length - 1]?.trim() === '') continue
    collapsed.push(line)
  }
  return collapsed.join('\n')
}

/**
 * 行级 diff（unified 风格的简化版）。
 * 只用于 UI 预览与 `sshConfigWriteResult.diff`，所以不做重命名检测；
 * 超大文件（>4000 行）退化成「只报改动块的行号范围」，避免 O(n²) LCS 卡住主进程。
 */
export function diffTexts(before: string, after: string, contextLines = 3): string {
  if (before === after) return ''
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length > 4_000 || b.length > 4_000) {
    return `--- before (${a.length} lines)\n+++ after (${b.length} lines)\n@@ full-file rewrite @@\n`
  }

  const lcs = longestCommonSubsequence(a, b)
  const out: string[] = []
  let ai = 0
  let bi = 0
  for (const [matchA, matchB] of lcs) {
    appendHunk(out, a, ai, matchA, b, bi, matchB, contextLines)
    ai = matchA + 1
    bi = matchB + 1
  }
  appendHunk(out, a, ai, a.length, b, bi, b.length, contextLines)
  return out.join('')
}

function appendHunk(
  out: string[],
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number,
  contextLines: number
): void {
  if (aStart === aEnd && bStart === bEnd) return
  const contextBefore = a.slice(Math.max(0, aStart - contextLines), aStart)
  out.push(`@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bEnd - bStart} @@\n`)
  for (const line of contextBefore) out.push(` ${line}\n`)
  for (let index = aStart; index < aEnd; index += 1) out.push(`-${a[index] ?? ''}\n`)
  for (let index = bStart; index < bEnd; index += 1) out.push(`+${b[index] ?? ''}\n`)
}

function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

/** 根据主机字段生成一个全新块的文本（用于导出/写入不存在的 alias） */
export function buildHostBlock(alias: string, fields: Record<string, string | null>): string {
  const body = Object.entries(fields)
    .filter(([, value]) => value !== null && String(value).trim() !== '')
    .map(([keyword, value]) => `${INDENT}${keyword} ${value}`)
  return [`Host ${alias}`, ...body].join('\n')
}
