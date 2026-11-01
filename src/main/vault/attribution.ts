/**
 * 解锁失败的**归因层**（r3，AC-1 / AC-2 / AC-3）。
 *
 * 为什么单独成文件而不是塞进 `manager.ts`：归因是本轮最需要穷举单测的部分
 * （四类互斥、无记录不判 mismatch、脱敏 0 命中），放在 1200 行的状态机里永远测不透。
 * 本模块**零 IO**：不读磁盘、不读 settings、不看时钟 —— 所有原料都由调用方（manager）传入。
 *
 * 词表纪律：`errors.ts` 的 `reason` 是主进程内部词表，`VaultUnlockFailure.class` 是
 * 进程边界的四分类词表。本模块是**唯一**把前者翻成后者的地方；渲染层只认 class，
 * 不许用 `details.reason` 反推（两套词表各管一段，混用会让四分类出现第二个实现）。
 */
import { unlockFailureClassSchema, type UnlockFailureClass, type VaultUnlockFailure } from '@shared/models/vault'
import type { VaultFailureReason } from './errors'

/**
 * 四分类的**唯一**取值来源（从 zod 契约派生，不在本文件重抄一份）。
 * 渲染层文案表与 e2e 的 `data-class` 都对着同一份枚举。
 */
export const UNLOCK_FAILURE_CLASSES: readonly UnlockFailureClass[] = unlockFailureClassSchema.options

export interface ClassifyInput {
  /** `errors.ts` 的 reason；`null` 表示拿不到原因（例如同步路径直接抛的普通错误） */
  reason: VaultFailureReason | null
  /** 仅限流时由 `assertNotThrottled` 带上（`manager.ts` 的 `lockedUntilMs - now()`） */
  retryAfterMs?: number
  /** 磁盘上**现在**的口令槽密文指纹（`envelope.ts:slotFingerprint` 单点算出） */
  currentFingerprint: string | null
  /** `local.json.slot?.fingerprint`：本机上次成功解锁时记录的指纹 */
  recordedFingerprint: string | null
  /**
   * `local.json.slotDrift != null`：manager 在锁定态发现指纹不一致、却无法重封时留下的旁证。
   * **它是旁证不是证据**（AC-2）：单独存在不成立 mismatch，有指纹时也不改变分类。
   */
  driftRecorded: boolean
}

/**
 * 优先级：**throttled > slot-record-mismatch > corrupt > bad-passphrase**。
 *
 * 顺序不是随便排的，每条都有理由：
 * 1. `throttled` 最先 —— 被限流时"口令对不对"根本还没被判定，此时给出任何其它结论都是臆断；
 * 2. `slot-record-mismatch` 先于 `corrupt` —— 指纹能解释的现场（本机记录对不上）比"数据坏了"更具体，
 *    而 AC-2 明确它的措辞只能到"与本机记录不一致"，不许升级成"损坏/被改"；
 * 3. `corrupt` 先于 `bad-passphrase` —— GCM 先失败在口令槽上，所以**槽坏了也表现为"口令错误"**，
 *    这正是本轮 bug 的症状；只要 reason 说 corrupt 就不能再谎称口令错（AC-1）；
 * 4. 兜底 `bad-passphrase` —— 没有证据指向别处时，唯一诚实的结论是"口令不符"。
 */
export function classifyUnlockFailure(input: ClassifyInput): VaultUnlockFailure {
  const { reason, retryAfterMs } = input

  // 1) 限流：必须带秒数（AC-1「throttled 必须显示剩余秒数」）。主进程漏传时给 0 而不是 undefined，
  //    否则渲染层的倒计时会渲染成 NaN —— 契约里该字段是 optional，但 throttled 语义上必须有值。
  if (reason === 'throttled') {
    const ms = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0
    // 剩余时间向上取整：剩 1.2s 也要显示 2s，显示 1s 会让用户在第 1 秒末尾又点一次
    return { class: 'throttled', retryAfterSeconds: Math.ceil(ms / 1000) }
  }

  // 2) 槽指纹对账（AC-2）：证据只有"本机记录"这一份（F1：没有旧库副本），
  //    所以**任一侧缺失即「未知」，一律不判 mismatch**；driftRecorded 是旁证，不能顶替指纹。
  if (recordedFingerprintDiffers(input)) return { class: 'slot-record-mismatch' }

  // 3) 数据本身坏了：重试没有意义。`unsupported-format` / `invalid-payload` 同属这一类 ——
  //    把它们归到 bad-passphrase 就等于对用户说"口令错了"，是 AC-1 禁止的假归因。
  if (isCorruptReason(reason)) return { class: 'corrupt' }

  // 4) 兜底：口令不符（用户可重试）
  return { class: 'bad-passphrase' }
}

/**
 * 指纹是否构成"不一致"的**有效证据**。
 *
 * 抽成独立函数是为了让 AC-2 的两条否定规则有唯一定义点：
 * - 本机无记录（`recordedFingerprint === null`，典型是刚升级的老库）→ 未知，不判；
 * - 当前槽指纹读不出来（`currentFingerprint === null`）→ 未知，不判；
 * - 两者相等 → 与本机记录一致，不判。
 */
function recordedFingerprintDiffers(input: ClassifyInput): boolean {
  const current = input.currentFingerprint
  const recorded = input.recordedFingerprint
  // 缺任一侧 = 没有可比证据（AC-2「本机无指纹记录时不得判为该分类，置未知」）
  if (current === null || recorded === null) return false
  // 大小写归一后再比：指纹在生产里恒为小写 hex（契约正则已限），这里只防御手写/旧数据
  return normalizeFingerprint(current) !== normalizeFingerprint(recorded)
}

function normalizeFingerprint(value: string): string {
  return value.trim().toLowerCase()
}

/** 需要报"损坏"（重试无意义）的 reason 集合；其余一律落到 bad-passphrase */
function isCorruptReason(reason: VaultFailureReason | null): boolean {
  return reason === 'corrupt' || reason === 'unsupported-format' || reason === 'invalid-payload'
}

/**
 * AC-3：日志用的一行脱敏描述，**只含** class 与剩余秒数。
 *
 * 不给它传指纹/路径的原因：日志是 AC-3 的判红现场之一（路径里就带用户名），
 * 这一行只回答"哪一类失败、还要等多久"，多一个字段就多一个泄密面。
 * null 表示上一次解锁成功/没有失败 —— 显式写 `ok` 而不是空串，方便 grep。
 */
export function describeUnlockFailure(failure: VaultUnlockFailure | null): string {
  if (failure === null) return 'unlock=ok'
  if (failure.class === 'throttled') {
    // 秒数必出（AC-1）：即使调用方给了 undefined 也写 0，不让日志出现 "retryAfter=undefineds"
    const seconds = failure.retryAfterSeconds ?? 0
    return `unlock=throttled retryAfter=${seconds}s`
  }
  return `unlock=${failure.class}`
}

/** 日志行/错误 message 的长度上限：防止把整段 payload 或超长 base64 灌进日志 */
const MAX_LOG_TEXT = 400
/** 抹除前先截断输入，避免超长文本上的正则回溯 */
const MAX_INPUT_TEXT = 4_000

const REDACTED_PATH = '<path>'
const REDACTED_IP = '<ip>'
const REDACTED_HOST = '<host>'
const REDACTED_TARGET = '<target>'
const REDACTED_SECRET = '<redacted>'

/** 已知的「用户主目录/系统目录」前缀：这类路径里几乎必然带用户名 */
const PATH_ROOTS = 'Users|home|root|var|tmp|private|opt|etc|mnt|media|Volumes|Applications'

/**
 * AC-3 兜底：把任意字符串里的**类路径片段、IP、主机名/用户名@主机、以及 `passphrase=…` 这类
 * 明文键值**抹掉，用于错误 message 落日志之前。
 *
 * 设计取舍：宁可多抹（日志不需要路径才能读懂），不许漏抹 —— 一旦 `/Users/<用户名>/…`
 * 进了日志，AC-3 的"用户名 0 命中"就判红。所以这里按"形状"抹，不靠白名单。
 * 无命中时原样返回（不改动普通文案，避免日志失去可读性）。
 */
export function redactForLog(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  const input = text.length > MAX_INPUT_TEXT ? text.slice(0, MAX_INPUT_TEXT) : text

  let out = input
    // 1) 明文凭据键值：passphrase=xxx / password: xxx / token=xxx（口令原文最常见的泄漏面）
    .replace(/\b(pass(?:phrase|word)|secret|token|api[_-]?key|credential)\s*[:=]\s*[^\s,;)]+/gi, `$1=${REDACTED_SECRET}`)
    // 2) Windows 盘符路径（含反斜杠，必须在 POSIX 规则之前做）
    .replace(/\b[A-Za-z]:\\[^\s"']*/g, REDACTED_PATH)
    // 3) file:// URL
    .replace(/file:\/\/[^\s"']*/gi, REDACTED_PATH)
    // 4) POSIX 绝对路径：前置边界 + 已知根目录（如 /Users/u/…、/home/u/…）
    .replace(new RegExp(`(^|[\\s"'(=:\\[])(${PATH_ROOTS})/[^\\s"'<>)\\]]*`, 'g'), `$1${REDACTED_PATH}`)
    // 5) POSIX 绝对路径：多段路径（无已知根也抹，如 /srv/custom/x.json）
    .replace(/(^|[\s"'(=:])(\/[\w.@+-]+(?:\/[\w.@+-]*)+)/g, (_match, prefix: string) => `${prefix}${REDACTED_PATH}`)
    // 6) 用户名@主机（SSH 目标 / 邮箱）：本身既是用户名也是主机名
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, REDACTED_TARGET)
    // 7) `.local` / `.lan` / `.internal` / `.home` 形态的主机名
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|internal|home)\b/gi, REDACTED_HOST)
    // 8) IPv4（含可选端口）
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, REDACTED_IP)
    // 9) 方括号 IPv6
    .replace(/\[[0-9a-f:]{2,}\]/gi, REDACTED_IP)

  // 10) 压成一行并限长：日志按行消费，换行会把一条记录劈成两半
  out = out.replace(/\s+/g, ' ').trim()
  return out.length > MAX_LOG_TEXT ? `${out.slice(0, MAX_LOG_TEXT)}…` : out
}
