/**
 * 指数退避。
 *
 * 为什么单独成文件：重连策略是「可测的策略」而不是「散在循环里的 setTimeout」。
 * maxAttempts 走策略而不是设置项，是因为设置项只暴露次数（0 = 不重连），
 * 曲线由引擎决定，避免用户在设置里调出「每次都 0ms 重连」的雪崩行为。
 */

export interface BackoffPolicy {
  /** 第一次重试前等多久 */
  baseDelayMs: number
  /** 每次乘以多少 */
  factor: number
  /** 单次等待上限（防止 factor^attempt 溢出成天文数字） */
  maxDelayMs: number
  /** 最多重试几次；0 = 不重连 */
  maxAttempts: number
  /**
   * 抖动比例 0..1：实际等待 = delay * (1 ± jitterRatio/2 * random)。
   * 默认 0 —— 单机客户端不需要用它削峰，而确定性的等待让测试与日志可预测。
   */
  jitterRatio: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 30_000,
  maxAttempts: 3,
  jitterRatio: 0
}

/**
 * attempt 从 1 开始（第 1 次重试）。返回该次重试的等待毫秒数。
 * 上界是 `maxDelayMs`，且**先取幂再 clamping**，所以 baseDelayMs > maxDelayMs 时也守约。
 */
export function computeBackoffDelay(
  attempt: number,
  policy: BackoffPolicy,
  random: () => number = Math.random
): number {
  if (attempt < 1) return 0
  const raw = policy.baseDelayMs * policy.factor ** (attempt - 1)
  const capped = Math.min(raw, policy.maxDelayMs)
  if (policy.jitterRatio <= 0) return capped
  const spread = (capped * policy.jitterRatio) / 2
  // random() 半开区间 [0,1)：映射到 [-spread, +spread)
  const offset = (random() * 2 - 1) * spread
  return Math.max(0, Math.round(capped + offset))
}
