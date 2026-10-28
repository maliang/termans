export { RECOVERY_CODE_CHARS, formatRecoveryCode, generateRecoveryCode, normalizeRecoveryCode } from './recovery-code'

/**
 * 主口令强度评估 + 恢复码编解码。
 *
 * 目标不是「密码学意义上的熵」，而是**挡住三类真实事故**：
 * 1. 用户拿 `123456` 保护整个 SSH 主机库（长度门槛）；
 * 2. 用户拿 `aaaaaaaaaaaa` 凑长度（重复字符惩罚）；
 * 3. 用户拿 `password1234` 或 `qwertyuiopas` 凑长度（常见口令/键盘序列）。
 *
 * 判定分三档：`weak` 需要二次确认才允许提交（任务书要求），`fair` 只提示，`strong` 直接过。
 * 长度不足直接拒绝（`acceptable=false`），与 SPEC S-02 一致。
 */

export const MIN_PASSPHRASE_LENGTH = 12
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
