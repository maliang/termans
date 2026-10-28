import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKOFF, computeBackoffDelay } from '../backoff'

/**
 * 指数退避。
 *
 * 断言直接对着公式的数值：base * factor^(attempt-1)，上限封顶，jitter 只在开启时生效。
 * 把 factor 写死成 1、把 attempt 从 0 开始、把上限漏掉，都会让这里红。
 */

describe('computeBackoffDelay', () => {
  const policy = { ...DEFAULT_BACKOFF, baseDelayMs: 100, factor: 2, maxDelayMs: 500, maxAttempts: 10, jitterRatio: 0 }

  it('第 n 次 = base * factor^(n-1)', () => {
    expect(computeBackoffDelay(1, policy)).toBe(100)
    expect(computeBackoffDelay(2, policy)).toBe(200)
    expect(computeBackoffDelay(3, policy)).toBe(400)
  })

  it('达到 maxDelayMs 后不再增长（不能退避到几分钟）', () => {
    expect(computeBackoffDelay(4, policy)).toBe(500)
    expect(computeBackoffDelay(10, policy)).toBe(500)
  })

  it('attempt<=0 视为「无需等待」', () => {
    expect(computeBackoffDelay(0, policy)).toBe(0)
    expect(computeBackoffDelay(-3, policy)).toBe(0)
  })

  it('jitter：random=0.5 落在基础值上，区间是 ±jitterRatio/2（即 ±10% 当 ratio=0.2）', () => {
    const jittered = { ...policy, jitterRatio: 0.2 }
    expect(computeBackoffDelay(2, jittered, () => 0.5)).toBe(200)
    // spread = 200 * 0.2 / 2 = 20 → 下界 180、上界 220（把 spread 写成 capped*ratio 会红）
    expect(computeBackoffDelay(2, jittered, () => 0)).toBe(180)
    expect(computeBackoffDelay(2, jittered, () => 0.999999)).toBe(220)
    // 抖动不会把等待压成 0 或越过 maxDelayMs 太多
    expect(computeBackoffDelay(10, jittered, () => 0)).toBe(450)
    expect(computeBackoffDelay(10, jittered, () => 0.999999)).toBe(550)
  })

  it('jitterRatio=0 时随机源被忽略（默认行为可复现，测试不需要 mock 随机数）', () => {
    expect(computeBackoffDelay(3, policy, () => 0.13)).toBe(400)
    expect(computeBackoffDelay(3, policy, () => 0.97)).toBe(400)
  })

  it('默认策略：500ms 起、2 倍增长、30 秒封顶', () => {
    expect(DEFAULT_BACKOFF).toMatchObject({ baseDelayMs: 500, factor: 2, maxDelayMs: 30_000, jitterRatio: 0 })
    expect(computeBackoffDelay(1, DEFAULT_BACKOFF)).toBe(500)
    expect(computeBackoffDelay(7, DEFAULT_BACKOFF)).toBe(30_000)
  })
})
