import { describe, expect, it } from 'vitest'
import { MIN_PASSPHRASE_LENGTH, assessPassphrase } from './passphrase'
import {
  RECOVERY_CODE_CHARS,
  RECOVERY_CODE_BYTES,
  formatRecoveryCode,
  generateRecoveryCode,
  normalizeRecoveryCode
} from './recovery-code'

describe('口令强度：挡住三类真实事故', () => {
  it('太短直接不可接受（<12 位）', () => {
    const short = assessPassphrase('Ab1!x'.padEnd(MIN_PASSPHRASE_LENGTH - 1, 'z'))
    expect(short.length).toBe(MIN_PASSPHRASE_LENGTH - 1)
    expect(short.acceptable).toBe(false)
    expect(short.warnings).toContain('too-short')
    expect(short.requiresConfirmation).toBe(false)
  })

  it('下限 8 位（主人 2026-11-02 定）：8 位可用、7 位拒绝', () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(8)
    expect(assessPassphrase('aB3$efg7').acceptable).toBe(true)
    const seven = assessPassphrase('aB3$efg')
    expect(seven.acceptable).toBe(false)
    expect(seven.warnings).toContain('too-short')
  })

  it('字符类型只建议不强制：纯小写 8 位可用，只是被提示 low-variety 且需二次确认', () => {
    const onlyLower = assessPassphrase('mypasswd')
    expect(onlyLower.acceptable, '不许因为“没有大写/数字/符号”直接拒绝').toBe(true)
    expect(onlyLower.warnings).toContain('low-variety')
    expect(onlyLower.requiresConfirmation, '弱口令走二次确认而不是拒绝').toBe(true)
    // 对照：同样长度但混了类型 → 不再提示 low-variety
    expect(assessPassphrase('MyPassw0rd').warnings).not.toContain('low-variety')
  })

  it('长口令（多词）判 strong，无需二次确认', () => {
    const strong = assessPassphrase('correct horse battery staple')
    expect(strong.acceptable).toBe(true)
    expect(strong.strength).toBe('strong')
    expect(strong.requiresConfirmation).toBe(false)
    expect(strong.entropyBits).toBeGreaterThanOrEqual(80)
  })

  it('凑长度的重复字符判 weak → 需要二次确认', () => {
    const repeated = assessPassphrase('aaaaaaaaaaaaaaaa')
    expect(repeated.acceptable).toBe(true)
    expect(repeated.strength).toBe('weak')
    expect(repeated.warnings).toContain('repeated-character')
    expect(repeated.requiresConfirmation).toBe(true)
  })

  it('常见口令与键盘序列都判 weak', () => {
    expect(assessPassphrase('password1234').warnings).toContain('common-pattern')
    expect(assessPassphrase('qwertyuiopas').warnings).toContain('keyboard-sequence')
    expect(assessPassphrase('iloveyouiloveyou').strength).toBe('weak')
  })

  it('中文口令按码点算长度，不会因为 UTF-16 代理对而误判', () => {
    const cn = assessPassphrase('主人家的猫今天很开心在窗台上')
    expect(cn.length).toBe(14)
    expect(cn.acceptable).toBe(true)
  })
})

describe('恢复码', () => {
  it('20 字节 = 160 bit，编码后 32 位 + 7 个分隔符', () => {
    const code = generateRecoveryCode()
    expect(RECOVERY_CODE_CHARS).toBe(32)
    expect(RECOVERY_CODE_BYTES * 8).toBeGreaterThanOrEqual(128)
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/)
    expect(code).toHaveLength(39)
  })

  it('归一化容错：小写、空格、易混字符 O→0 / I,L→1', () => {
    const code = generateRecoveryCode()
    const digits = code.replace(/-/g, '')
    expect(normalizeRecoveryCode(code)).toBe(digits)
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(digits)
    expect(normalizeRecoveryCode(`  ${formatRecoveryCode(code)}  `)).toBe(digits)
    const ambiguous = digits.replace(/0/g, 'O').replace(/1/g, 'l')
    expect(normalizeRecoveryCode(ambiguous)).toBe(digits)
  })

  it('长度不对或含非法字符 → null（不拿脏字符串去跑 scrypt）', () => {
    expect(normalizeRecoveryCode('ABC')).toBeNull()
    expect(normalizeRecoveryCode('U'.repeat(RECOVERY_CODE_CHARS))).toBeNull()
    expect(normalizeRecoveryCode('')).toBeNull()
  })

  it('formatRecoveryCode 幂等（重复格式化不会再次切分）', () => {
    const code = generateRecoveryCode()
    expect(formatRecoveryCode(code)).toBe(code)
    expect(formatRecoveryCode(code.replace(/-/g, ''))).toBe(code)
  })
})
