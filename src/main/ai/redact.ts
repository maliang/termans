/**
 * AI 模块的密钥脱敏工具。
 *
 * 硬性约束（见 docs/ai-providers.md「安全模型」）：
 * 1. API key 只允许出现在两个地方：加密包（vault）里、以及发往供应商的 HTTP 请求头里。
 * 2. 任何日志、IPC 回包、错误消息、对话历史都不得包含 key 原文。
 * 3. UI 只能看到 `apiKeyRef` 里的尾 4 位掩码。
 *
 * 因此所有「可能带上 provider 错误原文」的字符串（HTTP 错误体、异常 message）
 * 都必须先过本模块的 `Redactor`，再去 emit 或记日志。
 */

/** 掩码前缀：与 UI 展示保持一致（`••••abcd`） */
export const MASK_PREFIX = '••••'

/** 少于该长度的 secret 不做「原文整体替换」，避免误伤（例如 4 位数字） */
const MIN_SECRET_LENGTH = 8

/** 常见供应商 key 的形态特征，兜底拦截「evd 里没见过」的 key（如 provider 回显） */
const KEY_SHAPE_PATTERNS: ReadonlyArray<RegExp> = [
  // OpenAI / DeepSeek / Moonshot / OpenRouter / 自建：sk-.*、sk-or-v1-*、sk-ant-*
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  // Anthropic
  /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
  // Google / Gemini
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // 阿里云 DashScope
  /\bsk-[A-Za-z0-9]{20,}/g,
  // 通用 "Authorization: Bearer xxx"
  /\bBearer\s+[A-Za-z0-9._\-+/=]{12,}/gi,
  // JSON/查询串里的 api_key / apiKey / access_token 字段
  /\b(api[_-]?key|apikey|access[_-]?token|secret[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]{12,}["']?/gi,
  // URL 查询串 ?key=xxx
  /([?&](?:key|api_key|apiKey|access_token)=)[A-Za-z0-9._\-]{12,}/g
]

/** 把已登记的明文 secret 换成掩码（保留尾 4 位，便于用户核对） */
export function maskSecret(secret: string | null | undefined, visible = 4): string {
  if (!secret) return ''
  // 短于「尾号 + 掩码」的串直接全掩：否则 key 只有 5 位时等于把 4 位明文印在 UI 上
  if (visible <= 0 || secret.length <= visible + MASK_PREFIX.length) return MASK_PREFIX
  return `${MASK_PREFIX}${secret.slice(-visible)}`
}

/** 生成写进 `apiKeyRef` 的指针：`vault:ai-key:<providerId>:<last4>` */
export function buildApiKeyRef(providerId: string, apiKey: string): string {
  return `vault:ai-key:${providerId}:${apiKey.slice(-4)}`
}

/** 从 `apiKeyRef` 里取尾 4 位（无效 ref 返回空串，绝不回退成明文） */
export function apiKeyTailFromRef(ref: string | null | undefined): string {
  if (!ref) return ''
  const parts = ref.split(':')
  const tail = parts[parts.length - 1] ?? ''
  return /^[A-Za-z0-9_-]{1,8}$/.test(tail) ? tail : ''
}

/**
 * 从「额外请求头」里挑出需要当 secret 对待的值。
 *
 * 为什么需要：用户可能把鉴权放进自定义头（`api-key: xxx`、`x-tenant-token: xxx`）。
 * 这些值必须和 API key 同等待遇——供应商把它们回显在错误体里时也要掩码。
 *
 * 过滤规则（避免把 `application/json` 这类普通值掩码，反而污染错误消息）：
 * - 值长度 ≥ 8；
 * - 不是常见非密钥值；
 * - 头名本身像鉴权（`*-key`/`*-token`/`*-secret`/`authorization`/`cookie`/`x-api-*`）时不过滤长度。
 */
const NON_SECRET_HEADER_VALUES = new Set([
  'application/json',
  'application/x-www-form-urlencoded',
  'text/event-stream',
  'text/plain',
  'utf-8',
  'gzip, deflate',
  '*/*',
  'termans',
  'https://termans.app'
])

const SECRET_HEADER_NAME = /(?:^|-)(?:key|token|secret|password|credential|auth|signature)s?(?:$|-)|^authorization$|^cookie$|^x-api/

export function headerSecretValues(headers: Record<string, string> | undefined | null): string[] {
  if (!headers) return []
  const values: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed.length === 0) continue
    if (NON_SECRET_HEADER_VALUES.has(trimmed.toLowerCase())) continue
    const looksSecret = SECRET_HEADER_NAME.test(name.trim().toLowerCase())
    if (looksSecret || trimmed.length >= 8) values.push(trimmed)
  }
  return values
}

/** 一次请求要登记的全部 secret：API key + 自定义头里的疑似密钥值 */
export function providerSecretValues(
  apiKey: string | null | undefined,
  headers?: Record<string, string> | null
): string[] {
  const secrets = headerSecretValues(headers)
  if (typeof apiKey === 'string' && apiKey.trim().length > 0) secrets.push(apiKey.trim())
  return secrets
}

/** 仅用于测试/诊断的共享 redactor（生产代码用 `createRedactor()` 自建实例） */
const GLOBAL_REDACTOR = createRedactor()

/**
 * 创建一个带「已知 secret 集合」的脱敏器。
 * 先做精确替换（同一 key 在错误体里被原样回显时能判定），再做形态匹配兜底。
 */
export function createRedactor(initial: readonly string[] = []) {
  const secrets = new Set<string>()
  for (const secret of initial) add(secret)

  function add(secret: string | null | undefined): void {
    if (typeof secret === 'string' && secret.trim().length >= MIN_SECRET_LENGTH) {
      secrets.add(secret.trim())
    }
  }

  function redactText(input: string): string {
    if (!input) return ''
    let out = input
    // 长的先替换，避免短 key 是长 key 子串时留下残片
    const ordered = [...secrets].sort((a, b) => b.length - a.length)
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(maskSecret(secret))
    }
    for (const pattern of KEY_SHAPE_PATTERNS) {
      out = out.replace(pattern, (match, prefix?: string) => {
        // ?key=xxx 这类保留参数名，只掩码值
        if (typeof prefix === 'string' && prefix.length > 0 && match.startsWith(prefix)) {
          return `${prefix}${maskSecret(match.slice(prefix.length))}`
        }
        return maskSecret(match)
      })
    }
    return out
  }

  /** 结构化脱敏：深度遍历字符串字段（用于 IPC 回包/日志 payload） */
  function redactDeep<T>(value: T, depth = 0): T {
    if (depth > 8) return value
    if (typeof value === 'string') return redactText(value) as unknown as T
    if (Array.isArray(value)) {
      return value.map((item) => redactDeep(item, depth + 1)) as unknown as T
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // 字段名本身是 key 的，直接掩码（例如 { apiKey: 'xxx' }）
        if (/^(api[_-]?key|apikey|authorization|access[_-]?token|secret)$/i.test(key)) {
          out[key] = typeof item === 'string' && item.length > 0 ? maskSecret(item) : item
          continue
        }
        out[key] = redactDeep(item, depth + 1)
      }
      return out as unknown as T
    }
    return value
  }

  /** 异常 → 可安全输出的一行文本 */
  function redactError(error: unknown): string {
    if (error instanceof Error) return redactText(error.message)
    if (typeof error === 'string') return redactText(error)
    try {
      return redactText(JSON.stringify(error))
    } catch {
      return '[unserializable error]'
    }
  }

  /** 断言辅助：判断文本里是否还残留任何已知 secret（测试用） */
  function leaksAnySecret(input: string): boolean {
    for (const secret of secrets) if (input.includes(secret)) return true
    return false
  }

  return {
    add,
    redactText,
    redactDeep,
    redactError,
    leaksAnySecret,
    get size() {
      return secrets.size
    }
  }
}

export type Redactor = ReturnType<typeof createRedactor>

/** 便捷函数：进程级默认脱敏器（生产代码建议自建，便于按 provider 登记 key） */
export function redact(input: string): string {
  return GLOBAL_REDACTOR.redactText(input)
}

/** 便捷函数：把 secret 登记进进程级脱敏器（provider key 读取后调用） */
export function registerSecret(secret: string | null | undefined): void {
  GLOBAL_REDACTOR.add(secret)
}
