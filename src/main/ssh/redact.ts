/**
 * 日志脱敏。
 *
 * 硬约束（写在这里，改代码前先读）：
 * - 密码 / passphrase / 私钥内容 / agent token **永远不能进日志**，包括「拼接失败消息」这种间接路径；
 * - `ssh2` 的某些错误消息会把配置回显出来（例如解析私钥时的部分内容），所以
 *   `SshError.toIpcError()` 也会过一遍 `redactText`；
 * - 脱敏是「按值 + 按模式」两层：按值用调用方登记的 secret 列表（精确，无遗漏），
 *   按模式兜住 `password=...` / `Bearer ...` / `-----BEGIN ... PRIVATE KEY-----` 这类没人登记但一定会出现的形态。
 */

export type SshLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志器是函数而不是对象：注入/包裹都只需要一次闭包，测试里可以直接收集字符串数组 */
export type SshLogger = (level: SshLogLevel, message: string, meta?: Record<string, unknown>) => void

const REDACTED = '[redacted]'

const SECRET_PATTERNS: readonly RegExp[] = [
  // password=xxx / passphrase: xxx / token=xxx / api-key=xxx / authorization: xxx
  /\b(password|passphrase|passwd|secret|token|api[_-]?key|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  // 私钥块（OpenSSH 与 PEM 两种头都覆盖）
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
]

/** 按模式脱敏（不依赖调用方是否记得登记 secret） */
export function redactPatterns(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    // 保留键名，只替换值：`password=[redacted]` 比整段消失更有诊断价值
    out = out.replace(pattern, (match, key?: string) =>
      typeof key === 'string' && match.startsWith(key) ? `${key}=${REDACTED}` : REDACTED
    )
  }
  return out
}

/** 按值 + 按模式脱敏。secrets 里空串/过短值会被跳过（否则 `-` 这种值会把日志打成筛子） */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length < 3) continue
    out = out.split(secret).join(REDACTED)
  }
  return redactPatterns(out)
}

function redactMetaValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 4) return '[deep]'
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactMetaValue(item, secrets, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      // 键名本身就是凭据的，直接不透出内容（连长度都不给）
      out[key] = /password|passphrase|secret|token|api[_-]?key|privatekey/i.test(key)
        ? REDACTED
        : redactMetaValue(item, secrets, depth + 1)
    }
    return out
  }
  return value
}

export function createConsoleLogger(prefix = '[ssh]'): SshLogger {
  return (level, message, meta) => {
    const line = `${prefix} ${message}`
    if (level === 'error') console.error(line, meta ?? '')
    else if (level === 'warn') console.warn(line, meta ?? '')
    else if (level === 'debug') console.debug(line, meta ?? '')
    else console.info(line, meta ?? '')
  }
}

/**
 * 包一层脱敏日志器。`secrets` 用 getter 而不是数组快照：
 * 密码是连接时才解密出来的，日志器必须看到「此刻」的 secret 列表。
 */
export function createRedactingLogger(base: SshLogger, secrets: () => readonly string[]): SshLogger {
  return (level, message, meta) => {
    const list = secrets()
    base(level, redactText(message, list), meta === undefined ? undefined : (redactMetaValue(meta, list) as Record<string, unknown>))
  }
}

/** 便于测试/调试：把日志收进数组 */
export function createMemoryLogger(): { logger: SshLogger; lines: string[] } {
  const lines: string[] = []
  const logger: SshLogger = (level, message, meta) => {
    lines.push(`${level} ${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`)
  }
  return { logger, lines }
}
