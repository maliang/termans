import type { IpcError, IpcErrorCode } from '@shared'
import { redactText } from './redact'

/**
 * SSH 错误归一化。
 *
 * 为什么需要这一层：ssh2 抛出来的是「Node 网络错误 + 自定义 level 字段」的混合体，
 * 消息是英文自由文本（`All configured authentication methods failed` / `Keepalive timeout` /
 * `Error while looking up IPv4 address for 'x': ...`）。渲染层要给出「可操作的下一步」，
 * 就必须把自由文本收敛成有限的、可判定、可翻译的错误码。
 *
 * 约定：
 * - `code` 是引擎内部码（比 IPC 码细），通过 `details.sshCode` 传给渲染层做 i18n；
 * - `ipc` 是 IPC 信封码，作为**下界**——任何未识别的情况也不会退化成 E_UNKNOWN，
 *   而是留在 SSH 语义里（认证失败是协议层错误 E_SSH，指纹类必须能被 UI 单独识别）。
 * - `hint` 永远是「用户下一步能做什么」，不是复述错误。
 */

export type SshErrorCode =
  | 'auth-failed'
  | 'auth-no-method'
  | 'host-key-unverified'
  | 'host-key-mismatch'
  | 'timeout'
  | 'dns'
  | 'network'
  | 'protocol'
  | 'pty-failed'
  | 'exec-failed'
  | 'sftp-failed'
  | 'jump-invalid'
  | 'jump-not-found'
  | 'jump-unsupported'
  | 'jump-failed'
  | 'agent-unavailable'
  | 'key-missing'
  | 'key-invalid'
  | 'key-encrypted'
  | 'cancelled'
  | 'closed'
  | 'session-not-found'
  | 'unknown'

interface ErrorProfile {
  /** IPC 信封码 */
  ipc: IpcErrorCode
  /** 用户下一步 */
  hint: string
}

/**
 * 码 → (IPC 码, 提示)。集中在一张表里，避免「同一个码在不同调用点给出不同 hint」。
 */
const PROFILES: Record<SshErrorCode, ErrorProfile> = {
  'auth-failed': {
    ipc: 'E_SSH',
    hint: 'Check the username, password or key. If the account enforces 2FA, use keyboard-interactive or agent auth.'
  },
  'auth-no-method': {
    ipc: 'E_SSH',
    hint: 'No usable credential for this host. Store a password/private key first (agent auth needs a running ssh-agent).'
  },
  'host-key-unverified': {
    ipc: 'E_HOST_KEY_UNVERIFIED',
    hint: 'The host key was not confirmed. Review the fingerprint in the host-key dialog and accept it to continue.'
  },
  'host-key-mismatch': {
    ipc: 'E_HOST_KEY_UNVERIFIED',
    hint: 'The host key changed since last time — this can be a man-in-the-middle attack. Verify the fingerprint on the server side before trusting it again.'
  },
  timeout: {
    ipc: 'E_NETWORK',
    hint: 'The connection timed out. Check the host/port, firewall and that sshd is running; try raising the connect timeout in settings.'
  },
  dns: {
    ipc: 'E_NETWORK',
    hint: 'The hostname could not be resolved. Check the spelling or your DNS/VPN.'
  },
  network: {
    ipc: 'E_NETWORK',
    hint: 'The network connection failed or dropped. Check connectivity and whether the server is reachable.'
  },
  protocol: {
    ipc: 'E_SSH',
    hint: 'The SSH handshake or channel request failed. The server may use an unsupported algorithm or version.'
  },
  'pty-failed': {
    ipc: 'E_SSH',
    hint: 'The server refused to allocate a pseudo-terminal. Try "no PTY" mode or a server-side check of sshd_config (PermitTTY).'
  },
  'exec-failed': {
    ipc: 'E_SSH',
    hint: 'The command could not be started on the server. Check the command and the account shell.'
  },
  'sftp-failed': {
    ipc: 'E_IO',
    hint: 'The file operation failed on the server. Check the path, permissions and whether the SFTP subsystem is enabled.'
  },
  'jump-invalid': {
    ipc: 'E_INVALID_ARGUMENT',
    hint: 'The jump host must be a different machine than the target host. Clear the jump host field to connect directly.'
  },
  'jump-not-found': {
    ipc: 'E_NOT_FOUND',
    hint: 'The jump host saved on this host no longer exists. Pick another jump host or clear the field, then reconnect.'
  },
  'jump-unsupported': {
    ipc: 'E_SSH',
    hint: 'Only one jump level is supported for now. Point this host at a jump host that can reach it directly (no chained jumps).'
  },
  'jump-failed': {
    ipc: 'E_SSH',
    hint: 'The jump host could not open a TCP tunnel to the target. Check that the jump host can reach the target host:port (firewall, sshd, allowtcpforwarding).'
  },
  'agent-unavailable': {
    ipc: 'E_SSH',
    hint: 'No ssh-agent is available (SSH_AUTH_SOCK is not set or the agent is not running). Start the agent, add your key, or switch this host to password/private key auth.'
  },
  'key-missing': {
    ipc: 'E_SSH',
    hint: 'The configured private key file does not exist on this machine. Private keys are never synced or downloaded — copy it locally and fix the host settings.'
  },
  'key-invalid': {
    ipc: 'E_SSH',
    hint: 'The private key file could not be parsed. Supported formats: OpenSSH (BEGIN OPENSSH PRIVATE KEY) and PEM (BEGIN RSA/EC/PRIVATE KEY).'
  },
  'key-encrypted': {
    ipc: 'E_SSH',
    hint: 'The private key is passphrase-protected but no passphrase is stored for this host. Add the passphrase in the host settings.'
  },
  cancelled: { ipc: 'E_SSH', hint: 'The connection attempt was cancelled.' },
  closed: { ipc: 'E_SSH', hint: 'The connection was closed.' },
  'session-not-found': { ipc: 'E_NOT_FOUND', hint: 'This terminal session no longer exists. Reconnect the host.' },
  unknown: { ipc: 'E_SSH', hint: 'The SSH connection failed for an unknown reason. See the application log for details.' }
}

export class SshError extends Error {
  readonly code: SshErrorCode
  readonly hint: string
  readonly ipc: IpcErrorCode
  readonly details: Record<string, unknown>

  constructor(
    code: SshErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown; hint?: string } = {}
  ) {
    super(message)
    this.name = 'SshError'
    this.code = code
    this.ipc = PROFILES[code].ipc
    this.hint = options.hint ?? PROFILES[code].hint
    this.details = { sshCode: code, hint: this.hint, ...(options.details ?? {}) }
    if (options.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }

  toIpcError(): IpcError {
    return {
      code: this.ipc,
      message: redactText(this.message),
      details: this.details
    }
  }
}

export function isSshError(value: unknown): value is SshError {
  return value instanceof SshError
}

/** 把任意抛出物收敛成 SshError（已是 SshError 则原样返回，保留原始 code/details） */
export function asSshError(value: unknown, fallbackCode: SshErrorCode = 'unknown'): SshError {
  if (value instanceof SshError) return value
  return normalizeSshError(value, undefined, fallbackCode)
}

interface Ssh2LikeError {
  message?: unknown
  code?: unknown
  level?: unknown
  errno?: unknown
  syscall?: unknown
  hostname?: unknown
}

const NETWORK_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'EAI_AGAIN'
])

const DNS_ERRNO = new Set(['ENOTFOUND', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA'])

/** 私有键解析失败时 ssh2 的原文前缀 → 具体码 */
function classifyKeyError(message: string): SshErrorCode | null {
  if (/no passphrase given|encrypted|bad passphrase|passphrase/i.test(message)) return 'key-encrypted'
  if (/Cannot parse privateKey|Unsupported key format|Malformed|invalid key/i.test(message)) return 'key-invalid'
  return null
}

/**
 * 归一化。第二个参数是「出错阶段」，用于修正 ssh2 把不同问题都塞进同一个 level 的情况：
 * 例如握手阶段的 EPIPE 是网络问题，而认证阶段的 EPIPE 也是网络问题——
 * 但认证阶段的 `client-authentication` 一定是「凭据不对」，两者提示完全不同。
 */
export function normalizeSshError(
  error: unknown,
  context: { host?: string; port?: number; phase?: string } = {},
  fallbackCode: SshErrorCode = 'unknown'
): SshError {
  const raw = (error ?? {}) as Ssh2LikeError
  const message = typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : String(error)
  const details: Record<string, unknown> = {}
  if (context.host !== undefined) details.host = context.host
  if (context.port !== undefined) details.port = context.port
  if (context.phase !== undefined) details.phase = context.phase
  if (typeof raw.level === 'string') details.level = raw.level
  if (typeof raw.code === 'string') details.errno = raw.code

  const keyIssue = classifyKeyError(message)
  if (keyIssue) return new SshError(keyIssue, message, { details, cause: error })

  const level = typeof raw.level === 'string' ? raw.level : ''
  const errno = typeof raw.code === 'string' ? raw.code : ''

  if (level === 'client-authentication' || /All configured authentication methods failed/i.test(message)) {
    return new SshError('auth-failed', message, { details, cause: error })
  }
  if (DNS_ERRNO.has(errno) || level === 'client-dns') {
    return new SshError('dns', message, { details, cause: error })
  }
  if (
    level === 'client-timeout' ||
    errno === 'ETIMEDOUT' ||
    // ssh2 的 keepalive 超时是自由的 'Keepalive timeout'（不带 level/code），必须按文本兜住
    /Timed out while waiting|keepalive timeout/i.test(message)
  ) {
    return new SshError('timeout', message, { details, cause: error })
  }
  if (NETWORK_ERRNO.has(errno) || level === 'client-socket') {
    return new SshError('network', message, { details, cause: error })
  }
  if (level === 'agent' || /agent/i.test(message)) {
    return new SshError('agent-unavailable', message, { details, cause: error })
  }
  if (level === 'handshake' || /handshake/i.test(message)) {
    return new SshError('protocol', message, { details, cause: error })
  }
  if (/Host denied \(verification failed\)/i.test(message)) {
    return new SshError('host-key-unverified', message, { details, cause: error })
  }
  return new SshError(fallbackCode, message, { details, cause: error })
}
