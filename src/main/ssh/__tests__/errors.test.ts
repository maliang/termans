import { describe, expect, it } from 'vitest'
import { SshError, asSshError, normalizeSshError, type SshErrorCode } from '../errors'

/**
 * ssh2 的错误是「Node 网络错误 + level 字段 + 英文自由文本」的混合体。
 * 这一层是把它们收敛成可判定、可翻译、带「下一步」的错误码。
 * 每条断言都盯着「改错就红」：例如把 client-authentication 当 network 处理，第一条就会挂。
 */

function rawError(fields: Record<string, unknown>): Error & Record<string, unknown> {
  return Object.assign(new Error(String(fields.message ?? 'boom')), fields)
}

describe('normalizeSshError：认证失败', () => {
  it('level=client-authentication → auth-failed / E_SSH（不是 E_NETWORK）', () => {
    const error = normalizeSshError(
      rawError({ message: 'All configured authentication methods failed', level: 'client-authentication' })
    )
    expect(error.code).toBe('auth-failed')
    expect(error.ipc).toBe('E_SSH')
    expect(error.hint).toMatch(/username, password or key/i)
  })

  it('只有消息文本也能识别（某些路径 ssh2 不带 level）', () => {
    const error = normalizeSshError(new Error('All configured authentication methods failed'))
    expect(error.code).toBe('auth-failed')
  })
})

describe('normalizeSshError：网络/超时/DNS 可区分', () => {
  it('ENOTFOUND → dns（提示域名/DNS，而不是「网络不通」）', () => {
    const error = normalizeSshError(rawError({ message: 'getaddrinfo ENOTFOUND nope.invalid', code: 'ENOTFOUND' }))
    expect(error.code).toBe('dns')
    expect(error.ipc).toBe('E_NETWORK')
    expect(error.hint).toMatch(/resolve|DNS/i)
    expect(error.details.errno).toBe('ENOTFOUND')
  })

  it('level=client-dns → dns', () => {
    expect(normalizeSshError(rawError({ message: 'lookup failed', level: 'client-dns' })).code).toBe('dns')
  })

  it('ECONNREFUSED → network（端口没开，不是认证问题）', () => {
    const error = normalizeSshError(rawError({ message: 'connect ECONNREFUSED 127.0.0.1:9', code: 'ECONNREFUSED' }))
    expect(error.code).toBe('network')
    expect(error.ipc).toBe('E_NETWORK')
  })

  it('level=client-timeout 与 Keepalive timeout → timeout', () => {
    expect(normalizeSshError(rawError({ message: 'Timed out while waiting for handshake', level: 'client-timeout' })).code).toBe(
      'timeout'
    )
    expect(normalizeSshError(rawError({ message: 'Keepalive timeout' })).code).toBe('timeout')
    expect(normalizeSshError(rawError({ message: 'x', code: 'ETIMEDOUT' })).code).toBe('timeout')
  })

  it('level=client-socket 的 ECONNRESET → network', () => {
    expect(normalizeSshError(rawError({ message: 'read ECONNRESET', code: 'ECONNRESET', level: 'client-socket' })).code).toBe(
      'network'
    )
  })

  it('握手失败 → protocol（提示算法/版本，而不是网络）', () => {
    const error = normalizeSshError(rawError({ message: 'Handshake failed: unsupported kex', level: 'handshake' }))
    expect(error.code).toBe('protocol')
    expect(error.ipc).toBe('E_SSH')
  })

  it('agent 相关 → agent-unavailable（提示启动 ssh-agent）', () => {
    expect(normalizeSshError(rawError({ message: 'failed to connect to agent', level: 'agent' })).code).toBe(
      'agent-unavailable'
    )
  })
})

describe('normalizeSshError：密钥与主机密钥', () => {
  it('加密私钥缺 passphrase → key-encrypted（提示补 passphrase，而不是「密钥坏」）', () => {
    const error = normalizeSshError(new Error('Encrypted private OpenSSH key detected, but no passphrase given'))
    expect(error.code).toBe('key-encrypted')
    expect(error.hint).toMatch(/passphrase/i)
  })

  it('坏格式私钥 → key-invalid（提示支持 OpenSSH/PEM 两种）', () => {
    const error = normalizeSshError(new Error('Cannot parse privateKey: Unsupported key format'))
    expect(error.code).toBe('key-invalid')
    expect(error.hint).toMatch(/OpenSSH|PEM/i)
  })

  it('Host denied (verification failed) → host-key-unverified', () => {
    expect(normalizeSshError(new Error('Host denied (verification failed)')).code).toBe('host-key-unverified')
  })

  it('未识别错误保留 fallback，但 IPC 码不退化到 E_UNKNOWN', () => {
    const error = normalizeSshError(new Error('something odd happened'))
    expect(error.code).toBe('unknown')
    expect(error.ipc).toBe('E_SSH')
  })

  it('context 带上 host/port/phase，便于日志与 UI 定位', () => {
    const error = normalizeSshError(rawError({ message: 'x', code: 'ECONNREFUSED' }), {
      host: 'db.internal',
      port: 2222,
      phase: 'connecting'
    })
    expect(error.details).toMatchObject({ host: 'db.internal', port: 2222, phase: 'connecting' })
  })
})

describe('SshError → IpcError', () => {
  it('每个码的 IPC 信封码是固定的（UI 靠它决定弹什么）', () => {
    const cases: Array<[SshErrorCode, string]> = [
      ['auth-failed', 'E_SSH'],
      ['host-key-mismatch', 'E_HOST_KEY_UNVERIFIED'],
      ['host-key-unverified', 'E_HOST_KEY_UNVERIFIED'],
      ['timeout', 'E_NETWORK'],
      ['dns', 'E_NETWORK'],
      ['network', 'E_NETWORK'],
      ['sftp-failed', 'E_IO'],
      ['session-not-found', 'E_NOT_FOUND'],
      ['pty-failed', 'E_SSH'],
      ['agent-unavailable', 'E_SSH']
    ]
    for (const [code, ipc] of cases) {
      const error = new SshError(code, 'msg')
      expect(error.ipc).toBe(ipc)
      expect(error.toIpcError().code).toBe(ipc)
    }
  })

  it('details 永远带 sshCode 与 hint（渲染层能本地化，不依赖英文消息）', () => {
    const error = new SshError('timeout', 'timed out', { details: { timeoutMs: 250 } })
    expect(error.details).toMatchObject({ sshCode: 'timeout', timeoutMs: 250 })
    expect(typeof error.details.hint).toBe('string')
    expect(String(error.details.hint).length).toBeGreaterThan(10)
  })

  it('消息里的密码/token 在跨 IPC 前被脱敏（日志与 UI 都不该看到明文）', () => {
    const error = new SshError('auth-failed', 'login failed with password=hunter2 and Bearer abcdef123456')
    const message = error.toIpcError().message
    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('abcdef123456')
    expect(message).toContain('[redacted]')
  })

  it('asSshError 保留已有 SshError 的 code/details（不重新分类、不丢上下文）', () => {
    const original = new SshError('host-key-mismatch', 'changed', {
      details: { previousFingerprintSha256: 'SHA256:old', fingerprintSha256: 'SHA256:new' }
    })
    const again = asSshError(original)
    expect(again).toBe(original)
    expect(again.details.previousFingerprintSha256).toBe('SHA256:old')
  })

  it('asSshError 会归一化非 SshError（例如 string 抛出物）', () => {
    const error = asSshError('weird')
    expect(error).toBeInstanceOf(SshError)
    expect(error.code).toBe('unknown')
    expect(error.message).toContain('weird')
  })

  it('cause 被保留（排查时能看到 ssh2 的原始错误对象）', () => {
    const cause = new Error('underlying')
    const error = new SshError('network', 'wrapped', { cause })
    expect((error as { cause?: unknown }).cause).toBe(cause)
  })
})
