export { RECOVERY_CODE_CHARS, formatRecoveryCode, generateRecoveryCode, normalizeRecoveryCode } from './recovery-code'

/**
 * 主口令强度评估 + 恢复码编解码 + 口令输入变体表。
 *
 * 目标不是「密码学意义上的熵」，而是**挡住三类真实事故**：
 * 1. 用户拿 `123456` 保护整个 SSH 主机库（长度门槛）；
 * 2. 用户拿 `aaaaaaaaaaaa` 凑长度（重复字符惩罚）；
 * 3. 用户拿 `password1234` 或 `qwertyuiopas` 凑长度（常见口令/键盘序列）。
 *
 * 判定分三档：`weak` 需要二次确认才允许提交（任务书要求），`fair` 只提示，`strong` 直接过。
 * 长度不足直接拒绝（`acceptable=false`），与 SPEC S-02 一致。
 *
 * 2026-11-02 主人定：**下限 8 位**（原 12 位太苛刻），**字符类型只建议不强制**——
 * 单类字符（只有小写等）只产生 `low-variety` 提示并把强度压到 weak（需二次确认），
 * 绝不因为「没有大写/数字/符号」直接拒绝。真正会硬拒的只有「短于下限」这一条。
 */

export const MIN_PASSPHRASE_LENGTH = 8
/** 「强」的门槛：估算熵 ≥ 80bit */
export const STRONG_ENTROPY_BITS = 80
/** 「可接受」的门槛：估算熵 ≥ 50bit */
export const FAIR_ENTROPY_BITS = 50

export type PassphraseWarning =
  | 'too-short'
  | 'low-entropy'
  | 'common-pattern'
  | 'repeated-character'
  | 'keyboard-sequence'
  | 'low-variety'

export interface PassphraseAssessment {
  length: number
  /** 粗估熵（bit）：字符集大小 × 长度 − 惩罚项 */
  entropyBits: number
  strength: 'weak' | 'fair' | 'strong'
  warnings: PassphraseWarning[]
  /** false = 硬拒绝（长度不足），上层必须回 E_INVALID_ARGUMENT */
  acceptable: boolean
  /** true = 弱口令，必须二次确认（上层用「同口令再提交一次」协议实现） */
  requiresConfirmation: boolean
}

/** 常见弱口令/项目相关词；命中直接压到弱档（不需要完整字典，挡典型情况就够） */
const COMMON_PATTERNS = [
  'password',
  'passwd',
  'qwerty',
  'asdfgh',
  'zxcvbn',
  'iloveyou',
  'letmein',
  'welcome',
  'admin123',
  'root123',
  'termans',
  'termius',
  'changeme',
  'secret',
  '123456',
  '000000',
  '111111'
]

/** 键盘序列（同一行连续 6 个以上键位） */
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890', 'abcdefghijklmnopqrstuvwxyz']

function charsetSize(value: string): number {
  let size = 0
  if (/[a-z]/.test(value)) size += 26
  if (/[A-Z]/.test(value)) size += 26
  if (/[0-9]/.test(value)) size += 10
  if (/[^A-Za-z0-9]/.test(value)) size += 33
  return size === 0 ? 26 : size
}

function hasKeyboardSequence(value: string): boolean {
  const lower = value.toLowerCase()
  for (const row of KEYBOARD_ROWS) {
    for (let index = 0; index + 6 <= row.length; index += 1) {
      if (lower.includes(row.slice(index, index + 6))) return true
    }
  }
  return false
}

export function assessPassphrase(value: string): PassphraseAssessment {
  const length = [...value].length
  const warnings: PassphraseWarning[] = []
  const size = charsetSize(value)
  let entropyBits = length > 0 ? length * Math.log2(size) : 0

  const lower = value.toLowerCase()
  if (COMMON_PATTERNS.some((pattern) => lower.includes(pattern))) {
    warnings.push('common-pattern')
    entropyBits = Math.min(entropyBits, 18)
  }

  const uniqueRatio = length > 0 ? new Set([...value]).size / length : 0
  if (length >= 8 && uniqueRatio < 0.4) {
    warnings.push('repeated-character')
    entropyBits = Math.min(entropyBits, 24)
  }

  if (hasKeyboardSequence(lower)) {
    warnings.push('keyboard-sequence')
    entropyBits = Math.min(entropyBits, 32)
  }

  if (length < MIN_PASSPHRASE_LENGTH) {
    warnings.push('too-short')
  }

  // 字符类型只建议不强制：只用了一类字符（例如全小写）时给出提示，并让强度落到 weak
  // → 上层走「同口令再提交一次」的二次确认，而不是拒绝。
  if (length > 0 && size <= 26) {
    warnings.push('low-variety')
  }

  if (entropyBits < FAIR_ENTROPY_BITS && !warnings.includes('too-short')) {
    warnings.push('low-entropy')
  }

  const strength: PassphraseAssessment['strength'] =
    entropyBits >= STRONG_ENTROPY_BITS && length >= MIN_PASSPHRASE_LENGTH
      ? 'strong'
      : entropyBits >= FAIR_ENTROPY_BITS && length >= MIN_PASSPHRASE_LENGTH
        ? 'fair'
        : 'weak'

  return {
    length,
    entropyBits: Math.round(entropyBits),
    strength,
    warnings,
    acceptable: length >= MIN_PASSPHRASE_LENGTH,
    requiresConfirmation: strength === 'weak' && length >= MIN_PASSPHRASE_LENGTH
  }
}

/* ------------------------------------------------------------------------- *
 * 口令输入变体表（AC-5 / AC-6 / AC-7 / AC-8 / AC-9）
 *
 * 存在的唯一理由是「输入编码差异」不是「口令错误」：输入法把 ASCII 打成全角、
 * 复制粘贴带上首尾空白或不间断零宽字符，都已经让用户觉得「我明明输对了」。
 * 变体表负责把这三种形态还原成用户本意，**绝不放宽字符本身的比较**
 * （大小写、增删改一个可见字符都必须失败，AC-8）。
 *
 * 三条硬约束，改这个文件前先读：
 * 1. 变体表在本文件**唯一实现**（AC-5）：渲染层与主进程不得各写一份，
 *    全仓 grep 变体表函数名，只应命中本文件与 manager 的调用点。
 * 2. 顺序固定且 `identity` 永远在首位：第一次尝试必须是与输入逐字相同的形态，
 *    这样「口令本来就对」的成功路径派生次数仍是 1、延迟零增加（AC-9）。
 * 3. 只作用于**口令槽**。恢复码槽继续走 `normalizeRecoveryCode`（AC-6），
 *    那条路径有自己的容错口径（大小写/分隔符/手抄歧义），不要在这里掺和。
 * ------------------------------------------------------------------------- */

export type PassphraseVariant = 'identity' | 'nfkc' | 'trim' | 'strip-zero-width'

export interface PassphraseCandidate {
  variant: PassphraseVariant
  /** 该变体还原出的输入形态；调用方直接拿它做一次 KEK 派生 */
  value: string
}

/**
 * 零宽字符族（Cf 格式字符）：U+200B..U+200D 零宽空格/非连接/连接符、U+2060 词连接符、U+FEFF BOM。
 * 它们不可见却参与逐字节比较，是「看着一模一样但打不开」的最常见来源。
 * 注意 `trim()` 不会去掉它们（不是 Unicode White_Space），所以必须单独一个变体。
 */
const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\u2060\uFEFF]/g

/**
 * 口令输入的全部候选形态：固定顺序 `identity` → `nfkc` → `trim` → `strip-zero-width`，
 * 按**结果值**去重后 ≤4 个（AC-9 的「单次解锁最多 4 次 KEK 派生」是硬上界，不是建议）。
 *
 * 不做变体的组合（例如「全角 + 零宽」同时出现），因为 AC-5 只要求这 4 种形态各能解锁，
 * 而每多一种组合就多一次 scrypt 派生，直接违背 AC-9 的世界钟约束。
 */
export function passphraseVariants(input: string): PassphraseCandidate[] {
  const candidates: PassphraseCandidate[] = [
    { variant: 'identity', value: input },
    { variant: 'nfkc', value: input.normalize('NFKC') },
    { variant: 'trim', value: input.trim() },
    { variant: 'strip-zero-width', value: input.replace(ZERO_WIDTH_PATTERN, '') }
  ]

  const seen = new Set<string>()
  const unique: PassphraseCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.value)) continue
    seen.add(candidate.value)
    unique.push(candidate)
  }
  return unique
}

/**
 * AC-7 的「规范形」：输入命中某个非 `identity` 变体时，应当被重封进槽的那个值。
 *
 * 语义是「变体表里第一个能改动输入的候选」——因为候选顺序固定、且调用方是
 * 「按顺序试到成功为止」，所以第一个改动了输入的候选就正是刚刚命中的那一个。
 * 输入本身已是规范形（候选表里只有 `identity`）时返回 `null`：没什么要修的。
 */
export function canonicalPassphrase(
  input: string
): { value: string; variant: PassphraseVariant } | null {
  const [first, ...rest] = passphraseVariants(input)
  if (!first) return null
  const canonical = rest.find((candidate) => candidate.value !== input)
  if (!canonical) return null
  return { value: canonical.value, variant: canonical.variant }
}
