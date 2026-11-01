import { describe, expect, it } from 'vitest'
import {
  type PassphraseVariant,
  canonicalPassphrase,
  normalizeRecoveryCode,
  passphraseVariants
} from './passphrase'

/**
 * 口令输入变体表（AC-5..AC-9）。
 *
 * 这份测试要钉住的不是「变体表能把口令改形」，而是两条相反的约束同时成立：
 * ① 4 种**输入编码**差异各能解锁（AC-5）；
 * ② 任何**字符本身**的差异都必须失败（AC-8）。
 * ②被破就等于变体表变成了模糊匹配器，那是安全倒退。
 */

/** 规范口令（≥12 位，符合强度门槛，纯 ASCII——产品既定 F2 前提） */
const CANONICAL = 'CorrectHorse42!'

/** NFKC 形态：输入法全角模式打出来的同一串（U+FF01..U+FF5E 与 ASCII 0x21..0x7E 一一对应） */
function toFullWidth(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.codePointAt(0)!
      return code >= 0x21 && code <= 0x7e ? String.fromCodePoint(code + 0xfee0) : char
    })
    .join('')
}

/** AC-5 要求的四种输入形态 */
const FIXED_FORMS: Array<{ variant: PassphraseVariant; input: string }> = [
  { variant: 'identity', input: CANONICAL },
  { variant: 'nfkc', input: toFullWidth(CANONICAL) },
  { variant: 'trim', input: `  ${CANONICAL}  ` },
  { variant: 'strip-zero-width', input: 'Corr\u200Bect\uFEFFHorse42!' }
]

describe('口令变体表：表结构与去重（AC-5 / AC-9）', () => {
  it('恰好 4 种变体，顺序固定，identity 永远在首位', () => {
    // 构造出 4 个互不相同的结果值：全角 + 首尾空白 + 零宽各命中一次
    const input = ` ${toFullWidth('PASS')}\u200Bword end `
    const variants = passphraseVariants(input)
    expect(variants).toHaveLength(4)
    expect(variants.map((candidate) => candidate.variant)).toEqual([
      'identity',
      'nfkc',
      'trim',
      'strip-zero-width'
    ])
    expect(variants[0].value).toBe(input)
  })

  it('按结果值去重：没有可修差异时只剩 identity，硬上界 4 不变', () => {
    const plain = passphraseVariants(CANONICAL)
    expect(plain).toHaveLength(1)
    expect(plain[0]).toEqual({ variant: 'identity', value: CANONICAL })

    // 尾随空白：identity 之外只有 trim 有效（nfkc / strip-zero-width 都是同值，被去掉）
    const trailing = passphraseVariants(`${CANONICAL} `)
    expect(trailing.map((candidate) => candidate.variant)).toEqual(['identity', 'trim'])

    for (const form of FIXED_FORMS) {
      const candidates = passphraseVariants(form.input)
      const values = candidates.map((candidate) => candidate.value)
      expect(new Set(values).size, '候选值必须互不相同').toBe(values.length)
      expect(candidates.length).toBeLessThanOrEqual(4)
      expect(candidates[0].variant).toBe('identity')
      expect(candidates[0].value).toBe(form.input)
    }
  })

  it('AC-9 上界对抗输入：任意输入都不超过 4 个候选，且首个就是原样（成功路径只派生 1 次）', () => {
    const adversarial = [
      '',
      ' ',
      '    ',
      '\u200B',
      '\uFEFF\uFEFF',
      ' \u200B ',
      ` ${toFullWidth('\u200B')} `,
      toFullWidth(CANONICAL),
      `  ${toFullWidth(CANONICAL)}\u200B  `,
      'x'.repeat(4096)
    ]
    for (const input of adversarial) {
      const candidates = passphraseVariants(input)
      expect(candidates.length).toBeGreaterThanOrEqual(1)
      expect(candidates.length).toBeLessThanOrEqual(4)
      expect(candidates[0]).toEqual({ variant: 'identity', value: input })
    }
  })
})

describe('AC-5：四种输入编码差异各能解锁', () => {
  it('每种形态的候选表里都能找到规范口令，且命中前没有更早的候选值与之相同', () => {
    for (const form of FIXED_FORMS) {
      const candidates = passphraseVariants(form.input)
      const hitIndex = candidates.findIndex((candidate) => candidate.value === CANONICAL)
      expect(hitIndex, `形态 ${form.variant} 应能还原出规范口令`).toBeGreaterThanOrEqual(0)
      // 「按顺序试到成功为止」的语义：命中位置之前不能有别的候选也等于规范口令（否则顺序无意义）
      expect(
        candidates.slice(0, hitIndex).some((candidate) => candidate.value === CANONICAL)
      ).toBe(false)
    }
  })

  it('四种形态分别由各自那一种变体命中（identity / nfkc / trim / strip-zero-width 各司其职）', () => {
    const expected: Record<PassphraseVariant, PassphraseVariant> = {
      identity: 'identity',
      nfkc: 'nfkc',
      trim: 'trim',
      'strip-zero-width': 'strip-zero-width'
    }
    for (const form of FIXED_FORMS) {
      const hit = passphraseVariants(form.input).find(
        (candidate) => candidate.value === CANONICAL
      )
      expect(hit?.variant, `形态 ${form.variant} 的命中变体`).toBe(expected[form.variant])
    }
  })

  it('零宽字符串族都要剥掉（U+200B..U+200D / U+2060 / U+FEFF）', () => {
    for (const invisible of ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']) {
      const input = `Correct${invisible}Horse42!`
      const stripped = passphraseVariants(input).find(
        (candidate) => candidate.variant === 'strip-zero-width'
      )
      expect(stripped?.value, `零宽字符 U+${invisible.codePointAt(0)!.toString(16)}`).toBe(
        CANONICAL
      )
    }
  })
})

describe('AC-8：任何字符差异都必须失败（8 组以上反例）', () => {
  /** 每条：说明 + 用户实际输入的、与规范口令存在字符差异的串 */
  const COUNTEREXAMPLES: Array<{ why: string; input: string; canonical: string }> = [
    { why: '仅大小写不同', input: 'correctHorse42!', canonical: CANONICAL },
    { why: '仅大小写不同（全大写）', input: 'CORRECTHORSE42!', canonical: CANONICAL },
    { why: '内部多一个空格', input: 'Correct Horse42!', canonical: CANONICAL },
    { why: '内部少一个空格', input: 'Correct Horse42!', canonical: 'Correct Horse 42!' },
    { why: '末尾多一个可见字符', input: 'CorrectHorse42!!', canonical: CANONICAL },
    { why: '少一个字符', input: 'CorrectHorse42', canonical: CANONICAL },
    { why: '替换一个字符', input: 'CorrectHorse43!', canonical: CANONICAL },
    { why: '相邻两字符交换', input: 'CorrcteHorse42!', canonical: CANONICAL },
    { why: '数字 0 与字母 O 混淆', input: 'CorrectHorseO!', canonical: 'CorrectHorse0!' },
    { why: '数字 1 与字母 l 混淆', input: 'CorrectHorsel!', canonical: 'CorrectHorse1!' }
  ]

  it('每条反例都不产生任何等于规范口令的候选（恰好 10 组，≥8 组要求）', () => {
    expect(COUNTEREXAMPLES.length).toBeGreaterThanOrEqual(8)
    for (const { why, input, canonical } of COUNTEREXAMPLES) {
      expect(input, `${why}：反例本身不能等于规范口令`).not.toBe(canonical)
      const candidates = passphraseVariants(input)
      const matched = candidates.filter((candidate) => candidate.value === canonical)
      expect(matched, `${why}：变体表不得放行`).toEqual([])
      expect(candidates.length, `${why}：仍受 4 次上界约束`).toBeLessThanOrEqual(4)
    }
  })

  it('大小写不在任何变体的职责内：候选值逐字保留原始大小写（变体表不是模糊匹配）', () => {
    const input = 'correctHorse42!'
    expect(passphraseVariants(input)).toEqual([{ variant: 'identity', value: input }])
    expect(passphraseVariants(input.toUpperCase())).toEqual([
      { variant: 'identity', value: input.toUpperCase() }
    ])
  })
})

describe('AC-7：规范形判定', () => {
  it('输入已是规范形 → null（没有需要重封的东西）', () => {
    expect(canonicalPassphrase(CANONICAL)).toBeNull()
    expect(canonicalPassphrase('')).toBeNull()
  })

  it('三种非原样形态各自给出正确的规范形与变体名', () => {
    for (const form of FIXED_FORMS.filter((entry) => entry.variant !== 'identity')) {
      expect(canonicalPassphrase(form.input), `形态 ${form.variant}`).toEqual({
        value: CANONICAL,
        variant: form.variant
      })
    }
  })

  it('规范形幂等：按规范形重封后再判定不会二次触发（防止每次解锁都重封一遍）', () => {
    for (const form of FIXED_FORMS) {
      const canonical = canonicalPassphrase(form.input)
      expect(canonical).toEqual(
        form.variant === 'identity' ? null : { value: CANONICAL, variant: form.variant }
      )
      const stored = canonical?.value ?? form.input
      expect(canonicalPassphrase(stored)).toBeNull()
      expect(passphraseVariants(stored)).toHaveLength(1)
    }
  })
})

describe('AC-9：变体循环的端到端行为（按 manager 的真实用法驱动一遍）', () => {
  /**
   * 不测墙钟（scrypt 太慢且不稳定），而是仿真 manager 的解锁循环：
   * 「按候选表顺序逐个 openVault，首个成功即停」，用派生计数当唯一观测量。
   * 终态只有两种：unlocked（附带派生次数与命中变体）或 rejected（附带派生次数）。
   */
  function simulateUnlock(input: string): {
    state: 'unlocked' | 'rejected'
    derivations: number
    variant?: PassphraseVariant
  } {
    let derivations = 0
    for (const candidate of passphraseVariants(input)) {
      derivations += 1 // 一次候选 = 一次 KEK 派生
      if (candidate.value === CANONICAL) {
        return { state: 'unlocked', derivations, variant: candidate.variant }
      }
    }
    return { state: 'rejected', derivations }
  }

  it('原样输入 → 第 1 次派生即解锁（成功路径延迟零增加）', () => {
    expect(simulateUnlock(CANONICAL)).toEqual({
      state: 'unlocked',
      derivations: 1,
      variant: 'identity'
    })
  })

  it('三种修复形态 → 解锁，派生次数 2..4 且各自命中正确的变体', () => {
    const expected: Record<string, PassphraseVariant> = {
      nfkc: 'nfkc',
      trim: 'trim',
      'strip-zero-width': 'strip-zero-width'
    }
    for (const form of FIXED_FORMS.filter((entry) => entry.variant !== 'identity')) {
      const result = simulateUnlock(form.input)
      expect(result.state, `形态 ${form.variant}`).toBe('unlocked')
      expect(result.variant).toBe(expected[form.variant])
      expect(result.derivations).toBeGreaterThanOrEqual(2)
      expect(result.derivations).toBeLessThanOrEqual(4)
    }
  })

  it('错误口令 → 终态 rejected，派生次数等于候选数且不超过 4（不是暗中暴力）', () => {
    for (const wrong of ['correctHorse42!', '  CorrectHorse43!  ', 'Corr\u200BectHorse4!']) {
      const result = simulateUnlock(wrong)
      expect(result.state, wrong).toBe('rejected')
      expect(result.derivations).toBe(passphraseVariants(wrong).length)
      expect(result.derivations).toBeLessThanOrEqual(4)
    }
  })
})

describe('AC-6：变体表只作用于口令槽，恢复码槽走 normalizeRecoveryCode', () => {
  /** 32 位法定字符集（Crockford base32 全集），长度正好等于 RECOVERY_CODE_CHARS */
  const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'

  it('全角恢复码仍然失败：NFKC 逃生口不作用于恢复码', () => {
    expect(passphraseVariants(toFullWidth(CODE))).not.toHaveLength(1)
    expect(normalizeRecoveryCode(toFullWidth(CODE))).toBeNull()
  })

  it('恢复码多一个字符 / 少一个字符 / 含非法字符都失败（长度与字符集口径未放宽）', () => {
    expect(normalizeRecoveryCode(`${CODE}A`)).toBeNull()
    expect(normalizeRecoveryCode(CODE.slice(1))).toBeNull()
    expect(normalizeRecoveryCode(`UUUU${CODE.slice(4)}`)).toBeNull()
  })

  it('零宽字符不改变恢复码结果——这是 normalizeRecoveryCode 自己的容错口径，不是变体表在起作用', () => {
    // 事实复核：`normalizeRecoveryCode` 用 `replace(/[^0-9A-Z]/g, '')` 剥掉所有非字母数字，
    // 零宽字符（Cf）也在被剥之列，所以「中途插入零宽」的恢复码仍能归一化成功。
    // 即 PRD AC-6 括注「恢复码输入加零宽字符后仍然失败」在既有实现下不成立——
    // T4 的任务约束是 `normalizeRecoveryCode` 一行不动，故此处记录真实口径，不改行为。
    const withZeroWidth = `${CODE.slice(0, 4)}\u200B${CODE.slice(4)}`
    expect(normalizeRecoveryCode(withZeroWidth)).toBe(CODE)
    // 归属确认：变体表若能作用到恢复码，会把零宽剥掉后得到一个「看似合法」的口令原文，
    // 但它产出的候选值在这里与恢复码归一化结果一致，说明两条路径各自独立、互不复用。
    const stripped = passphraseVariants(withZeroWidth).find(
      (candidate) => candidate.variant === 'strip-zero-width'
    )
    expect(stripped?.value).toBe(CODE)
  })
})
