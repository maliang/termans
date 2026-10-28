import { describe, expect, it } from 'vitest'
import { createMemoryLogger, createRedactingLogger, redactPatterns, redactText, type SshLogger } from '../redact'

/**
 * 脱敏。
 *
 * 这是「日志里绝不出现密码/私钥/token」这条硬约束的唯一实现点，
 * 所以断言写成「明文一定不在输出里」——把任一分支改坏都会红。
 */

const OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB0ZXN0a2V5dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleQ==
-----END OPENSSH PRIVATE KEY-----`

describe('redactPatterns', () => {
  it('password=/passphrase:/token= 只替换值，保留键名（可诊断）', () => {
    expect(redactPatterns('connect with password=hunter2 failed')).toBe('connect with password=[redacted] failed')
    expect(redactPatterns('passphrase: "my secret phrase" rejected')).toContain('passphrase=[redacted]')
    expect(redactPatterns('token=abc123&foo=bar')).toBe('token=[redacted]&foo=bar')
    expect(redactPatterns('apiKey=sk-live-1234')).toBe('apiKey=[redacted]')
    expect(redactPatterns('Authorization: Bearer abc.def.ghi')).toContain('[redacted]')
  })

  it('私钥块整段消失（不是只替换头部）', () => {
    const out = redactPatterns(`parsing failed:\n${OPENSSH_KEY}\nretry`)
    expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjEA')
    expect(out).toContain('parsing failed')
    expect(out).toContain('retry')
  })

  it('普通文本不被改动（避免脱敏把日志打成筛子）', () => {
    const text = 'connected to db.internal:22 as deploy in 42ms'
    expect(redactPatterns(text)).toBe(text)
  })
})

describe('redactText', () => {
  it('按值脱敏：登记过的 secret 精确消失，哪怕出现在自由文本里', () => {
    expect(redactText('auth with s3cr3t-pass failed', ['s3cr3t-pass'])).toBe('auth with [redacted] failed')
    expect(redactText('s3cr3t-pass s3cr3t-pass', ['s3cr3t-pass'])).toBe('[redacted] [redacted]')
  })

  it('过短/空 secret 被跳过（否则 "-" 会把日志打烂）', () => {
    expect(redactText('a-b-c-d', ['-'])).toBe('a-b-c-d')
    expect(redactText('abc', [''])).toBe('abc')
  })

  it('按值 + 按模式叠加：没登记的形态也能兜住', () => {
    const out = redactText('password=hunter2 key=s3cr3t-pass', ['s3cr3t-pass'])
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('s3cr3t-pass')
  })
})

describe('createRedactingLogger', () => {
  it('secret getter 用「此刻」的列表（密码是连接时才解密的，不能在启动时快照）', () => {
    const captured: string[] = []
    const base: SshLogger = (_level, message) => captured.push(message)
    let secrets: string[] = []
    const logger = createRedactingLogger(base, () => secrets)

    logger('info', 'using password=hunter2')
    expect(captured[0]).not.toContain('hunter2') // 模式兜住了

    secrets = ['late-secret']
    logger('info', 'agent token late-secret')
    expect(captured[1]).not.toContain('late-secret')
  })

  it('meta 里键名为 password/passphrase/privateKey/token 的字段直接不输出内容', () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const base: SshLogger = (_level, _message, meta) => captured.push(meta)
    const logger = createRedactingLogger(base, () => ['top-secret'])

    logger('info', 'connect', {
      host: 'db.internal',
      password: 'top-secret',
      nested: { passphrase: 'p', apiKey: 'k', keep: 'v' },
      privateKey: OPENSSH_KEY
    })

    const meta = captured[0]!
    expect(meta.host).toBe('db.internal')
    expect(meta.password).toBe('[redacted]')
    expect(meta.privateKey).toBe('[redacted]')
    const nested = meta.nested as Record<string, unknown>
    expect(nested.passphrase).toBe('[redacted]')
    expect(nested.apiKey).toBe('[redacted]')
    expect(nested.keep).toBe('v')
    expect(JSON.stringify(meta)).not.toContain('top-secret')
  })

  it('深层嵌套被截断（避免日志对象爆炸）', () => {
    const captured: Array<Record<string, unknown> | undefined> = []
    const base: SshLogger = (_level, _message, meta) => captured.push(meta)
    const logger = createRedactingLogger(base, () => [])

    const deep = { a: { b: { c: { d: { e: { f: 'far' } } } } } }
    logger('debug', 'deep', deep)
    expect(JSON.stringify(captured[0])).toContain('[deep]')
  })

  it('消息里拼接的私钥同样被抹掉（ssh2 解析错误可能回显密钥内容）', () => {
    const captured: string[] = []
    const base: SshLogger = (_level, message) => captured.push(message)
    const logger = createRedactingLogger(base, () => [])
    logger('error', `parse failed: ${OPENSSH_KEY}`)
    expect(captured[0]).not.toContain('BEGIN OPENSSH PRIVATE KEY')
  })
})

describe('createMemoryLogger', () => {
  it('收集 level + message + meta，供用例断言', () => {
    const { logger, lines } = createMemoryLogger()
    logger('warn', 'reconnect attempt failed', { attempt: 2 })
    expect(lines).toEqual(['warn reconnect attempt failed {"attempt":2}'])
  })
})
