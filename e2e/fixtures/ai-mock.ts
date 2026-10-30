import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * 离线 AI 供应商：一个本地 HTTP 服务，冒充 OpenAI 兼容端点（`POST /v1/chat/completions`）。
 *
 * 为什么不用真 API：e2e 要在无网络、无 key 的机器上跑，而且我们要断言的是
 * **「发出去的内容到底长什么样」**——真模型每次都不同，断言只能写得很虚。
 * 这里的服务把所有请求体原样记下来，供用例对账（比如「没点确认之前，命令不能进终端」）。
 *
 * 注意：主进程用 `fetch` 直连，没有 CORS 限制，所以这里不需要预检处理。
 */
export interface MockAiRequest {
  /** 请求路径，如 `/v1/chat/completions`、`/v1/models` */
  path: string
  /** 解析后的 JSON body（GET 请求没有 body，为 null；解析失败为原始字符串） */
  body: unknown
  /** Authorization 头（断言「key 确实被带上了」用；值为脱敏后的尾 4 位，不落明文） */
  authorization: string | null
}

/** `GET /v1/models` 的返回形态：正常清单 / HTTP 错误 / 网关非 JSON / 挂住不响应 */
export type MockModelsReply =
  | { kind: 'list'; models: string[] }
  | { kind: 'status'; status: number; message: string }
  | { kind: 'raw'; body: string; status?: number }
  | { kind: 'timeout' }

export interface MockAiServer {
  /** 形如 `http://127.0.0.1:53211/v1`，直接填进「Base URL」 */
  baseUrl: string
  requests: MockAiRequest[]
  /** 下一次请求回什么：纯文本（会被切成多帧流式返回）还是 HTTP 错误 */
  setReply(reply: { text: string } | { status: number; message: string }): void
  /**
   * 下一次 `GET /v1/models` 回什么。默认 `{kind:'list', models:['mock-model']}`，
   * 与改造前逐字一致（既有 ai-assist 用例的隐式依赖）。
   */
  setModelsReply(reply: MockModelsReply): void
  stop(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    req.on('end', () => {
      if (!raw) {
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(raw)
      }
    })
  })
}

function authTail(req: IncomingMessage): string | null {
  return typeof req.headers.authorization === 'string' ? `***${req.headers.authorization.slice(-4)}` : null
}

export async function startMockAiServer(
  initial: { text: string } = { text: 'ok' }
): Promise<MockAiServer> {
  let reply: { text: string } | { status: number; message: string } = initial
  let modelsReply: MockModelsReply = { kind: 'list', models: ['mock-model'] }
  const requests: MockAiRequest[] = []

  const sendChat = (res: ServerResponse): void => {
    if ('status' in reply) {
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: reply.message } }))
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    // 切成若干帧：既验证流式拼接，也让「逐字出现」的过程可断言
    const text = reply.text
    const step = Math.max(1, Math.ceil(text.length / 4))
    for (let index = 0; index < text.length; index += step) {
      const piece = text.slice(index, index + step)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  }

  const sendModels = (res: ServerResponse): void => {
    switch (modelsReply.kind) {
      case 'timeout':
        // 故意不响应（也不关连接）：让主进程的「读取响应超时」分支被真实触发。
        // 用例拿不到响应时靠 expect 超时收场，因此这条分支不进 e2e 主路径。
        return
      case 'status':
        res.writeHead(modelsReply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: modelsReply.message } }))
        return
      case 'raw':
        // 网关挂掉时常见的「200 但正文是 HTML 登录页」，用来验证「非 JSON」提示
        res.writeHead(modelsReply.status ?? 200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(modelsReply.body)
        return
      case 'list':
      default:
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: modelsReply.models.map((id) => ({ id })) }))
        return
    }
  }

  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      void readBody(req).then((body) => {
        requests.push({ path: url, body, authorization: authTail(req) })
        sendChat(res)
      })
      return
    }
    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      void readBody(req).then(() => {
        // 草稿读模型的断言材料：「请求确实带上了草稿里的 key」只在这里能证明
        requests.push({ path: url, body: null, authorization: authTail(req) })
        sendModels(res)
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `mock-ai: 不认识的路径 ${req.method} ${req.url}` } }))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setReply(next) {
      reply = next
    },
    setModelsReply(next) {
      modelsReply = next
    },
    async stop() {
      // 挂住的连接会让 close() 永不回调：timeout 分支下强制断开，避免用例卡死
      server.closeAllConnections?.()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}
