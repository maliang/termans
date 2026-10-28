import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { type ConnectConfig, type ParsedKey, utils } from 'ssh2'
import { SshError } from './errors'
import type { SshCredential, SshEngineDeps, SshTarget } from './types'

/**
 * 认证配置构造。
 *
 * 覆盖四种 authMethod：
 * - password              → config.password
 * - publickey             → 读私钥文件 → ssh2.utils.parseKey（OpenSSH/PEM 都能解析）→ config.privateKey
 * - agent                 → config.agent = SSH_AUTH_SOCK 或注入的 BaseAgent（不读私钥）
 * - keyboard-interactive  → config.tryKeyboard + client.on('keyboard-interactive') 应答（PAM 密码/OTP）
 *
 * 两条安全纪律：
 * 1. 明文密码只在 ConnectConfig 里存在一次，不写进 target、不缓存、不进日志；
 * 2. 私钥内容只从本地文件读，**永不下载**（S-21：换机器后私钥缺失必须是明确报错，
 *    而不是悄悄退回密码或去服务端拉一份）。
 */

export interface KeyboardPrompt {
  prompt: string
  echo: boolean
}

export interface AuthBuildResult {
  config: ConnectConfig
  /** 需要按值脱敏的字符串（密码/passphrase/私钥原文） */
  secrets: string[]
  /** 非 null 表示这次连接需要应答 keyboard-interactive 提示 */
  keyboardAnswers: ((prompts: KeyboardPrompt[]) => string[]) | null
  /** 私钥文件路径（日志/诊断用；不是凭据） */
  privateKeyPath: string | null
}

export interface BuildAuthOptions {
  target: SshTarget
  credential: SshCredential | null
  deps: Pick<SshEngineDeps, 'readPrivateKey' | 'createAgent' | 'env'>
  /** 覆盖默认应答策略（UI 交互式输入 OTP 时用） */
  answerKeyboardInteractive?: (name: string, instructions: string, prompts: KeyboardPrompt[]) => string[]
}

/** `~` 只在开头有意义；不做 shell 变量展开（那会引入注入面） */
export function expandHomePath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === '~') return env.HOME ?? homedir()
  if (path.startsWith('~/')) return resolvePath(env.HOME ?? homedir(), path.slice(2))
  return isAbsolute(path) ? path : path
}

export function readPrivateKeyFile(
  target: SshTarget,
  deps: Pick<SshEngineDeps, 'readPrivateKey' | 'env'>
): { text: string; path: string } {
  if (!target.privateKeyPath) {
    throw new SshError('auth-no-method', `Host ${target.label} uses publickey auth but has no private key configured`, {
      details: { host: target.hostname, port: target.port }
    })
  }
  const path = expandHomePath(target.privateKeyPath, deps.env ?? process.env)
  try {
    const text = deps.readPrivateKey ? deps.readPrivateKey(path) : readFileSync(path, 'utf8')
    return { text, path }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') {
      // S-21：换机器后私钥缺失 → 明确提示「私钥不在本机」，引导用户本地补齐，绝不联网下载
      throw new SshError('key-missing', `Private key not found: ${path}`, {
        details: { path, host: target.hostname, port: target.port }
      })
    }
    throw new SshError('key-invalid', `Cannot read private key ${path}: ${(error as Error).message}`, {
      details: { path },
      cause: error
    })
  }
}

/**
 * 解析私钥。错误分类必须精确：
 * - 加密但没给 passphrase → key-encrypted（用户要填 passphrase，而不是换格式）
 * - 格式不认识 → key-invalid（提示支持 OpenSSH 与 PEM）
 * 这两类在 UI 上的下一步动作完全不同，不能都报「连接失败」。
 */
export function parsePrivateKey(text: string, passphrase?: string): ParsedKey {
  let parsed: ParsedKey | Error
  try {
    parsed = utils.parseKey(text, passphrase && passphrase.length > 0 ? passphrase : undefined)
  } catch (error) {
    throw new SshError('key-invalid', `Cannot parse private key: ${(error as Error).message}`, { cause: error })
  }
  if (parsed instanceof Error) {
    const message = parsed.message
    if (/passphrase|encrypted|decrypt/i.test(message)) {
      throw new SshError('key-encrypted', `Private key needs a passphrase: ${message}`, { cause: parsed })
    }
    throw new SshError('key-invalid', `Cannot parse private key: ${message}`, { cause: parsed })
  }
  return parsed
}

function resolveAgent(
  target: SshTarget,
  deps: Pick<SshEngineDeps, 'createAgent' | 'env'>
): NonNullable<ConnectConfig['agent']> {
  const custom = deps.createAgent?.((deps.env ?? process.env) as NodeJS.ProcessEnv & Record<string, string>)
  if (custom) return custom
  if (deps.createAgent) {
    // 显式注入了工厂却返回 null：调用方（测试/集成）明确说「没有 agent」，不要偷偷回退到环境变量
    throw new SshError('agent-unavailable', `No ssh-agent available for host ${target.label}`, {
      details: { host: target.hostname, port: target.port, sshAuthSock: null }
    })
  }
  const socket = (deps.env ?? process.env).SSH_AUTH_SOCK
  if (!socket) {
    throw new SshError('agent-unavailable', `No ssh-agent available for host ${target.label}`, {
      details: { host: target.hostname, port: target.port, sshAuthSock: null }
    })
  }
  return socket
}

/**
 * keyboard-interactive 的默认应答策略：
 * - 非回显提示（密码类）→ 用已存凭据；
 * - 回显提示（OTP/2FA/用户名）→ 空字符串，绝不把密码填进 OTP 输入框
 *   （把密码当 OTP 发出去，一是必然失败，二是把密码写进了服务端 auth 日志）。
 */
export function defaultKeyboardAnswers(credential: SshCredential | null): (prompts: KeyboardPrompt[]) => string[] {
  return (prompts) => prompts.map((prompt) => (prompt.echo ? '' : (credential?.password ?? '')))
}

/**
 * 构造 ssh2 的 ConnectConfig。只包含认证相关字段；hostVerifier / readyTimeout /
 * keepalive 由 session 层叠加（它们与「这次连接的生命周期」绑定，而不是与认证绑定）。
 */
export function buildAuthConfig(options: BuildAuthOptions): AuthBuildResult {
  const { target, credential, deps } = options
  const secrets: string[] = []
  const config: ConnectConfig = {
    host: target.hostname,
    port: target.port,
    username: target.username,
    agentForward: target.forwardAgent
  }
  let keyboardAnswers: AuthBuildResult['keyboardAnswers'] = null
  let privateKeyPath: string | null = null

  switch (target.authMethod) {
    case 'password': {
      if (!credential?.password) {
        throw new SshError('auth-no-method', `No password stored for host ${target.label}`, {
          details: { host: target.hostname, port: target.port, authMethod: target.authMethod }
        })
      }
      config.password = credential.password
      secrets.push(credential.password)
      break
    }
    case 'publickey': {
      const { text, path } = readPrivateKeyFile(target, deps)
      // 先自己解析一次：拿到「缺 passphrase / 格式坏」的精确错误（ssh2 抛的是同一类问题，
      // 但它在 socket 层，消息里没有文件路径与提示）。真正交给 ssh2 的是原文 + passphrase。
      parsePrivateKey(text, credential?.passphrase)
      config.privateKey = text
      if (credential?.passphrase) config.passphrase = credential.passphrase
      privateKeyPath = path
      // 私钥原文也登记进脱敏列表：万一某条错误消息回显了片段，也不会进日志
      secrets.push(text)
      if (credential?.passphrase) secrets.push(credential.passphrase)
      break
    }
    case 'agent': {
      config.agent = resolveAgent(target, deps)
      break
    }
    case 'keyboard-interactive': {
      config.tryKeyboard = true
      keyboardAnswers = options.answerKeyboardInteractive
        ? (prompts) => options.answerKeyboardInteractive?.(target.hostname, '', prompts) ?? []
        : defaultKeyboardAnswers(credential)
      if (credential?.password) secrets.push(credential.password)
      break
    }
    default: {
      const exhaustive: never = target.authMethod
      throw new SshError('auth-no-method', `Unsupported auth method: ${String(exhaustive)}`)
    }
  }

  return { config, secrets, keyboardAnswers, privateKeyPath }
}
