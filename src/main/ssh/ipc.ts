import { z } from 'zod'
import { IpcCallError, hostKeyDecisionSchema, sshConnectRequestSchema, terminalSizeSchema } from '@shared'
import { asSshError } from './errors'
import { handle } from '../ipc/registry'
import type { SshManager } from './manager'

/**
 * ssh:* 六个通道的注册。
 *
 * 注意这里**没有** known-hosts:* —— known_hosts 的持久化归 vault-sync
 * （`src/main/known-hosts/`）；本引擎只定义 `KnownHostsGateway` 接口并自带一个明文 JSON 兜底实现，
 * 加密存储落地后由调用方注入替换，引擎代码不改。
 */

export interface SshHandlerDeps {
  manager: SshManager
}

const sessionIdSchema = z.string().min(1).max(200)

const inputRequestSchema = z.object({
  sessionId: sessionIdSchema,
  // 单次写入上限 1MB：粘贴大文件靠多次写入，单帧过大没有意义还会卡住 IPC
  data: z.string().max(1_000_000)
})

const resizeRequestSchema = z.object({
  sessionId: sessionIdSchema,
  size: terminalSizeSchema
})

const disconnectRequestSchema = z.object({
  sessionId: sessionIdSchema
})

/**
 * 把引擎内部错误翻译成带 `code`/`details` 的 IPC 错误。
 *
 * 不这么做的话 renderer 只会拿到 `E_UNKNOWN` + 原始 message，分不清「密码错」和「主机密钥变了」——
 * 而后者必须弹红框阻断，不能被当成可重试错误。
 */
function rethrowIpc(error: unknown): never {
  throw new IpcCallError(asSshError(error).toIpcError())
}

export function registerSshHandlers(deps: SshHandlerDeps): void {
  handle(
    'ssh:connect',
    async (request) => {
      try {
        return await deps.manager.connect(request)
      } catch (error) {
        rethrowIpc(error)
      }
    },
    sshConnectRequestSchema
  )

  handle(
    'ssh:input',
    (request) => {
      try {
        deps.manager.write(request.sessionId, request.data)
      } catch (error) {
        rethrowIpc(error)
      }
    },
    inputRequestSchema
  )

  handle(
    'ssh:resize',
    (request) => {
      try {
        deps.manager.resize(request.sessionId, request.size)
      } catch (error) {
        rethrowIpc(error)
      }
    },
    resizeRequestSchema
  )

  handle(
    'ssh:disconnect',
    async (request) => {
      try {
        await deps.manager.disconnect(request.sessionId)
      } catch (error) {
        rethrowIpc(error)
      }
    },
    disconnectRequestSchema
  )

  handle('ssh:list-sessions', () => deps.manager.listSessions())

  handle(
    'ssh:answer-host-key',
    (request) => {
      try {
        deps.manager.answerHostKey(request)
      } catch (error) {
        rethrowIpc(error)
      }
    },
    hostKeyDecisionSchema
  )
}
