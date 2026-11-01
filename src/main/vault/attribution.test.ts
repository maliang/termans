/**
 * `attribution.ts` 的穷举单测（AC-1 / AC-2 / AC-3）。
 *
 * 断言口径（重要，别改成子串匹配）：
 * - 四分类的"互斥且不落空"用穷举组合证明，而不是挑几个例子；
 * - "0 命中"一律走**结构解析**：先把文本切成 token 集合 / 用形状正则扫输出，
 *   再断言集合为空。直接对整段做 `toContain` 属于子串自匹配（本项目踩过：数字 id 被
 *   时长串 `20m0s` 命中），SENSITIVE_SHAPES + tokenSet 就是为避开它而写的。
 * - 每条 0 命中断言都配一条**可分辨性**断言（同一判据在未脱敏的原文上必须非空），
 *   否则"脱敏函数把文本抹成空串"这种错误实现也会全绿。
 */
import { describe, expect, it } from 'vitest'
import type { UnlockFailureClass } from '@shared/models/vault'
import type { VaultFailureReason } from './errors'
import {
  UNLOCK_FAILURE_CLASSES,
  classifyUnlockFailure,
  describeUnlockFailure,
  redactForLog,
  type ClassifyInput
} from './attribution'

/** 允许在日志里出现的敏感"形状"：路径 / IP / 用户名@主机 / .local 主机名 */
const SENSITIVE_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['posix-path', /(?:^|[\s"'(=])\/(?:[\w.@+-]+\/)+/],
  ['drive-path', /\b[A-Za-z]:\\/],
  ['ipv4', /\b\d{1,3}(?:\.\d{1,3}){3}\b/],
  ['at-target', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/],
  ['lan-host', /\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|internal|home)\b/i]
]

function shapeHits(text: string): string[] {
  return SENSITIVE_SHAPES.filter(([, re]) => re.test(text)).map(([name]) => name)
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  )
}

function sensitiveTokenHits(text: string, needles: string[]): string[] {
  const tokens = tokenSet(text)
  return needles.filter((needle) => tokens.has(needle.toLowerCase()))
}

function input(partial: Partial<ClassifyInput>): ClassifyInput {
  return {
    reason: null,
    currentFingerprint: null,
    recordedFingerprint: null,
    driftRecorded: false,
    ...partial
  }
}

const FPR_A = 'a1b2c3d4'
const FPR_B = '0f9e8d7c'

describe('classifyUnlockFailure：四分类与优先级', () => {
  it('throttled 优先于一切（含指纹不一致），且剩余秒数向上取整', () => {
    const base = { currentFingerprint: FPR_B, recordedFingerprint: FPR_A, driftRecorded: true }
    expect(classifyUnlockFailure(input({ ...base, reason: 'throttled', retryAfterMs: 1 }))).toEqual({
      class: 'throttled',
      retryAfterSeconds: 1
    })
    // 1201ms → 2s：显示 1s 会让用户在第 1 秒末尾又点一次，反倒把退避拉长
    expect(classifyUnlockFailure(input({ ...base, reason: 'throttled', retryAfterMs: 1201 }))).toEqual({
      class: 'throttled',
      retryAfterSeconds: 2
    })
    expect(classifyUnlockFailure(input({ ...base, reason: 'throttled', retryAfterMs: 0 }))).toEqual({
      class: 'throttled',
      retryAfterSeconds: 0
    })
  })

  it('throttled 漏传 retryAfterMs 时仍给数字 0，不返回 undefined（否则倒计时渲染成 NaN）', () => {
    const failure = classifyUnlockFailure(input({ reason: 'throttled' }))
    expect(failure.class).toBe('throttled')
    expect(failure.retryAfterSeconds).toBe(0)
    expect(Number.isInteger(failure.retryAfterSeconds)).toBe(true)
  })

  it('两指纹不等 → slot-record-mismatch，且优先于 corrupt', () => {
    expect(
      classifyUnlockFailure(input({ reason: 'bad-passphrase', currentFingerprint: FPR_B, recordedFingerprint: FPR_A }))
    ).toEqual({ class: 'slot-record-mismatch' })
    // corrupt 同样让位：指纹能解释现场时，"本机记录对不上"比"数据坏了"更具体（AC-2 措辞只到这一层）
    expect(
      classifyUnlockFailure(input({ reason: 'corrupt', currentFingerprint: FPR_B, recordedFingerprint: FPR_A }))
    ).toEqual({ class: 'slot-record-mismatch' })
    // 大小写归一后仍算"相等"，不制造假的 mismatch
    expect(
      classifyUnlockFailure(
        input({ reason: 'bad-passphrase', currentFingerprint: 'A1B2C3D4', recordedFingerprint: FPR_A })
      ).class
    ).toBe('bad-passphrase')
  })

  it('本机无指纹记录时不判 mismatch（AC-2：老库升级后第一次失败只能置未知）', () => {
    const noRecord = { reason: 'bad-passphrase' as const, currentFingerprint: FPR_B, recordedFingerprint: null }
    expect(classifyUnlockFailure(input(noRecord))).toEqual({ class: 'bad-passphrase' })
    // 同一现场但 reason=corrupt：不能借"无记录"把损坏洗成 mismatch，应如实报 corrupt
    expect(classifyUnlockFailure(input({ ...noRecord, reason: 'corrupt' }))).toEqual({ class: 'corrupt' })
  })

  it('当前槽指纹缺失时不判 mismatch（读不出槽 = 没有可比证据）', () => {
    expect(
      classifyUnlockFailure(input({ reason: 'bad-passphrase', currentFingerprint: null, recordedFingerprint: FPR_A }))
    ).toEqual({ class: 'bad-passphrase' })
  })

  it('指纹相等时不判 mismatch（回到 reason 归因）', () => {
    const same = { currentFingerprint: FPR_A, recordedFingerprint: FPR_A }
    expect(classifyUnlockFailure(input({ ...same, reason: 'bad-passphrase' }))).toEqual({ class: 'bad-passphrase' })
    expect(classifyUnlockFailure(input({ ...same, reason: 'corrupt' }))).toEqual({ class: 'corrupt' })
  })

  it('corrupt 家族不谎称口令错（corrupt / unsupported-format / invalid-payload）', () => {
    for (const reason of ['corrupt', 'unsupported-format', 'invalid-payload'] as const) {
      expect(classifyUnlockFailure(input({ reason })), reason).toEqual({ class: 'corrupt' })
    }
  })

  it('driftRecorded 只是旁证：单独存在不判 mismatch，两指纹不等时也不因它降级', () => {
    // 旁证 + 无指纹 → 仍是未知（AC-2 明确不许据旁证判该类）
    expect(classifyUnlockFailure(input({ reason: 'bad-passphrase', driftRecorded: true }))).toEqual({
      class: 'bad-passphrase'
    })
    // 有指纹证据时它就是证据，driftRecorded 取不取值都一样（说明它非权威，权威是本机记录）
    const both = { reason: 'bad-passphrase' as const, currentFingerprint: FPR_B, recordedFingerprint: FPR_A }
    expect(classifyUnlockFailure(input({ ...both, driftRecorded: true }))).toEqual({ class: 'slot-record-mismatch' })
    expect(classifyUnlockFailure(input({ ...both, driftRecorded: false }))).toEqual({ class: 'slot-record-mismatch' })
  })

  it('穷举 reason × 指纹 × drift 组合：结果恒落在四类之一，且秒数只在 throttled 出现', () => {
    const reasons: Array<VaultFailureReason | null> = [
      null,
      'bad-passphrase',
      'bad-recovery-code',
      'corrupt',
      'unsupported-format',
      'invalid-payload',
      'bad-params',
      'locked',
      'uninitialized',
      'already-exists',
      'weak-passphrase',
      'too-short',
      'throttled',
      'stale-session',
      'not-found',
      'conflict',
      'git',
      'slot-record-mismatch',
      'slot-drift',
      'name-taken'
    ]
    const fingerprints: Array<string | null> = [null, FPR_A, FPR_B]
    const seen = new Set<UnlockFailureClass>()
    let cases = 0
    for (const reason of reasons) {
      for (const currentFingerprint of fingerprints) {
        for (const recordedFingerprint of fingerprints) {
          for (const driftRecorded of [true, false]) {
            for (const retryAfterMs of [undefined, 0, 999, 30_000]) {
              const failure = classifyUnlockFailure(
                input({ reason, currentFingerprint, recordedFingerprint, driftRecorded, retryAfterMs })
              )
              cases += 1
              expect(UNLOCK_FAILURE_CLASSES).toContain(failure.class)
              seen.add(failure.class)
              if (failure.class === 'throttled') {
                expect(Number.isInteger(failure.retryAfterSeconds)).toBe(true)
                expect(failure.retryAfterSeconds ?? -1).toBeGreaterThanOrEqual(0)
              } else {
                // 非 throttled 不许带秒数：带着会让渲染层误开倒计时
                expect(failure.retryAfterSeconds).toBeUndefined()
              }
            }
          }
        }
      }
    }
    expect(cases).toBe(reasons.length * fingerprints.length * fingerprints.length * 2 * 4)
    // 四类都被覆盖到：穷举必须能"碰到"全部四类，否则等于只在测一条分支
    expect([...seen].sort()).toEqual([...UNLOCK_FAILURE_CLASSES].sort())
  })
})

describe('describeUnlockFailure：一行日志（AC-3）', () => {
  it('null → unlock=ok；throttled 必带秒数；其余只含 class', () => {
    expect(describeUnlockFailure(null)).toBe('unlock=ok')
    expect(describeUnlockFailure({ class: 'throttled', retryAfterSeconds: 7 })).toBe('unlock=throttled retryAfter=7s')
    // 契约里 retryAfterSeconds 是 optional：缺了也要写出数字，不能出现 "undefineds"
    expect(describeUnlockFailure({ class: 'throttled' })).toBe('unlock=throttled retryAfter=0s')
    for (const cls of ['bad-passphrase', 'slot-record-mismatch', 'corrupt'] as const) {
      const line = describeUnlockFailure({ class: cls })
      expect(line).toBe(`unlock=${cls}`)
      expect(line).toMatch(/^unlock=[a-z-]+$/)
    }
  })

  it('日志行不含任何路径 / IP / 主机名 / 用户名形状（结构断言）', () => {
    const samples = [
      describeUnlockFailure(null),
      describeUnlockFailure({ class: 'throttled', retryAfterSeconds: 30 }),
      describeUnlockFailure({ class: 'bad-passphrase' }),
      describeUnlockFailure({ class: 'slot-record-mismatch' }),
      describeUnlockFailure({ class: 'corrupt' })
    ]
    for (const line of samples) {
      expect(shapeHits(line), line).toEqual([])
    }
    // 可分辨性：同一形状判据在含敏感信息的原文上必须非空，否则上面那几条等于没测
    expect(shapeHits('open /Users/maliang/x/local.json from 192.168.1.20').length).toBeGreaterThan(0)
  })
})

describe('redactForLog：脱敏兜底（AC-3）', () => {
  it('抹掉 POSIX / Windows 路径、IP、用户名@主机、.local 主机名（结构断言 0 命中）', () => {
    const raw =
      'open failed for /Users/maliang/Documents/develop/termans/vault-local/local.json ' +
      '(agent root@mac-mini.local from 192.168.1.20:22, drive C:\\Users\\maliang\\AppData\\Roaming\\termans\\vault.enc)'
    // 可分辨性：未脱敏前判据必须全部命中，否则下面的 0 命中是假绿
    expect(shapeHits(raw).sort()).toEqual(['at-target', 'drive-path', 'ipv4', 'lan-host', 'posix-path'])

    const safe = redactForLog(raw)
    expect(shapeHits(safe)).toEqual([])
    // 用户名 / 主机名 / IP 作为独立 token 0 命中（不是对整段做子串匹配）
    // 注意 needles 里不能放 'local'：脱敏后仍保留短文件名 local.json，那是一个合法 token
    expect(sensitiveTokenHits(safe, ['maliang', 'mac-mini', '192', '168', 'termans', 'appdata'])).toEqual([])
    // 反面：脱敏不是"把整段抹空"——普通文案必须还在。注意文件名随所在路径一起被抹，
    // 这是有意的：`local.json` 前面的目录段本身就带用户名，留下半截反而更容易拼回来
    expect(safe).toContain('open failed')
    expect(safe).toContain('<path>')
    // 结构化的"保活"判据：非敏感实词一个不许少
    for (const word of ['open', 'failed', 'agent', 'drive']) expect(tokenSet(safe).has(word), word).toBe(true)
  })

  it('明文口令键值被抹掉（口令原文是 AC-3 的第一号泄漏面）', () => {
    const raw = 'unlock rejected: passphrase=Correct-Horse-Battery token=ghp_deadbeef credential: abc.def'
    expect(sensitiveTokenHits(raw, ['correct', 'horse', 'battery', 'gp_deadbeef'])).toEqual([
      'correct',
      'horse',
      'battery'
    ])

    const safe = redactForLog(raw)
    expect(sensitiveTokenHits(safe, ['correct', 'horse', 'battery', 'ghp', 'deadbeef', 'abc'])).toEqual([])
    expect(safe).toContain('passphrase=<redacted>')
    expect(safe).toContain('unlock rejected')
  })

  it('无敏感片段时保持原意，且压成一行并限长（日志按行消费）', () => {
    const benign = 'Incorrect master passphrase (attempt 2 of 5)'
    expect(redactForLog(benign)).toBe(benign)
    // 换行会把一条日志劈成两条记录
    expect(redactForLog('line one\nline two\r\n')).toBe('line one line two')
    // 超长输入截断：上限 400 字符 + 省略号，防止整段 payload 灌进日志
    const long = `prefix ${'x'.repeat(5000)}`
    const capped = redactForLog(long)
    expect(capped.endsWith('…')).toBe(true)
    expect(capped.length).toBe(401)
    expect(redactForLog('')).toBe('')
  })
})
