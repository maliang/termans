import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

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
  /** 请求路径，如 `/v1/chat/completions` */
  path: string
  /** 解析后的 JSON body（解析失败为原始字符串） */
  body: unknown
  /** Authorization 头（断言「key 确实被带上了」用；值为脱敏后的尾 4 位，不落明文） */
  authorization: string | null
}

export interface MockAiServer {
  /** 形如 `http://127.0.0.1:53211/v1`，直接填进「Base URL」 */
  baseUrl: string
  requests: MockAiRequest[]
  /** 下一次请求回什么：纯文本（会被切成多帧流式返回）还是 HTTP 错误 */
  setReply(reply: { text: string } | { status: number; message: string }): void
  stop(): Promise<void>
}

export async function startMockAiServer(
  initial: { text: string } = { text: 'ok' }
): Promise<MockAiServer> {
  let reply: { text: string } | { status: number; message: string } = initial
  const requests: MockAiRequest[] = []

  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      let raw = ''
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8')
      })
      req.on('end', () => {
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {
          body = raw
        }
        requests.push({
          path: req.url ?? '',
          body,
          authorization: typeof req.headers.authorization === 'string' ? `***${req.headers.authorization.slice(-4)}` : null
        })
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
      })
      return
    }
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
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
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
}
