/**
 * 增量流式解析器：把 HTTP 响应体切成「一条一条的负载」（SSE 事件 / NDJSON 行）。
 *
 * 设计要求（对应 tests/unit/ai-stream.test.ts）：
 * - **半包**：TCP/HTTP 分片可在任意字节处切断，解析器必须自行粘包。
 * - **多字节 UTF-8 截断**：一个汉字的 3 个字节可能分属两个分片，必须用
 *   `TextDecoder({stream:true})` 保留半字节，绝不能对每片单独 `toString()`。
 * - **异常断开**：流在没有结束标记时被切断，解析器不得抛异常；上层通过
 *   `incomplete` 判断「最后一帧是否残缺」，再决定报错还是收尾。
 * - **Anthropic event 流**：`event:` 行与 `data:` 行需要成对交付，
 *   `event` 字段原样带出（Anthropic 的 data 里也有 type，双保险）。
 * - **NDJSON / Ollama**：每行一个 JSON。
 */

/** 一个待解析的负载单元 */
export interface StreamChunk {
  /** SSE 的 `event:` 名（NDJSON 为 null） */
  event: string | null
  /** SSE 的 `data:` 内容（多行 data 用 \n 连接）或 NDJSON 的一行 */
  data: string
}

export interface StreamDecoder {
  /** 喂入任意分片（字节或已解码文本），返回本次可交付的完整负载 */
  push(chunk: Uint8Array | string): StreamChunk[]
  /** 流结束时调用：尽最大努力交付尾部完整负载 */
  flush(): StreamChunk[]
  /** 结束时是否残留「残缺帧」（未闭合的行 / 未闭合的 SSE 事件） */
  readonly incomplete: boolean
}

const SSE_BOM = '\uFEFF'

/** SSE 解析器（OpenAI 兼容 / Anthropic Messages / Gemini alt=sse 都用它） */
export class SseDecoder implements StreamDecoder {
  private readonly textDecoder = new TextDecoder('utf-8')
  private buffer = ''
  private atStart = true
  private eventName: string | null = null
  private dataLines: string[] = []
  private eventId: string | null = null
  private truncated = false

  push(chunk: Uint8Array | string): StreamChunk[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.textDecoder.decode(chunk, { stream: true })
    if (this.atStart && this.buffer.length > 0) {
      this.atStart = false
      if (this.buffer.startsWith(SSE_BOM)) this.buffer = this.buffer.slice(SSE_BOM.length)
    }
    return this.drain(false)
  }

  flush(): StreamChunk[] {
    // 冲掉 TextDecoder 内部残留字节（不完整的 UTF-8 序列会变成替换符，但仍算残缺帧）
    const rest = this.textDecoder.decode()
    if (rest) this.buffer += rest
    const out = this.drain(true)
    // 最后一行没有换行符 → 内容仍可能完整（很多服务端省略末尾空行），按「不完整」标记
    if (this.buffer.trim().length > 0) {
      this.truncated = true
      // 尽力交付：把残留行喂进当前事件再派发
      this.consumeLine(this.buffer)
      this.buffer = ''
      const tail = this.dispatch()
      if (tail) out.push(tail)
    }
    if (this.dataLines.length > 0) {
      this.truncated = true
      const tail = this.dispatch()
      if (tail) out.push(tail)
    }
    return out
  }

  get incomplete(): boolean {
    return this.truncated
  }

  private drain(atEnd: boolean): StreamChunk[] {
    const out: StreamChunk[] = []
    let cursor = this.buffer.indexOf('\n')
    while (cursor !== -1) {
      const line = this.buffer.slice(0, cursor)
      this.buffer = this.buffer.slice(cursor + 1)
      const complete = this.consumeLine(line)
      if (complete) out.push(complete)
      cursor = this.buffer.indexOf('\n')
    }
    if (atEnd && this.buffer.length > 0) {
      const line = this.buffer
      this.buffer = ''
      const complete = this.consumeLine(line)
      if (complete) out.push(complete)
    }
    return out
  }

  /** 处理一行；遇到空行即派发事件，返回本次派发的事件（若有） */
  private consumeLine(rawLine: string): StreamChunk | null {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length === 0) return this.dispatch()
    if (line.startsWith(':')) return null // SSE 注释 / keep-alive
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'event':
        this.eventName = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      case 'id':
        this.eventId = value
        break
      default:
        // retry / 未知字段按规范忽略
        break
    }
    return null
  }

  private dispatch(): StreamChunk | null {
    if (this.dataLines.length === 0) {
      this.eventName = null
      this.eventId = null
      return null
    }
    const chunk: StreamChunk = { event: this.eventName, data: this.dataLines.join('\n') }
    this.dataLines = []
    this.eventName = null
    this.eventId = null
    return chunk
  }

  /** 最近一次事件的 id（OpenAI 无用，Anthropic 的 message_id 走 data 字段） */
  get lastEventId(): string | null {
    return this.eventId
  }
}

/** NDJSON 解析器（Ollama 的 /api/chat 是逐行 JSON，不是 SSE） */
export class NdjsonDecoder implements StreamDecoder {
  private readonly textDecoder = new TextDecoder('utf-8')
  private buffer = ''
  private atStart = true
  private truncated = false

  push(chunk: Uint8Array | string): StreamChunk[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.textDecoder.decode(chunk, { stream: true })
    if (this.atStart && this.buffer.length > 0) {
      this.atStart = false
      if (this.buffer.startsWith(SSE_BOM)) this.buffer = this.buffer.slice(SSE_BOM.length)
    }
    return this.drainLines(false)
  }

  flush(): StreamChunk[] {
    const rest = this.textDecoder.decode()
    if (rest) this.buffer += rest
    // 末尾没有换行符：可能是服务端省略了最后一个 \n（合法），也可能是被掐断（残缺）。
    // 判据是「这一行能否解析成 JSON」——解析不出来才算残缺，避免把正常收尾误报成中断。
    const residual = this.buffer.trim()
    const out = this.drainLines(true)
    if (residual.length > 0 && parseJsonPayload(residual) === undefined) this.truncated = true
    return out
  }

  get incomplete(): boolean {
    return this.truncated
  }

  private drainLines(atEnd: boolean): StreamChunk[] {
    const out: StreamChunk[] = []
    let cursor = this.buffer.indexOf('\n')
    while (cursor !== -1) {
      const line = this.buffer.slice(0, cursor)
      this.buffer = this.buffer.slice(cursor + 1)
      const trimmed = line.trim()
      if (trimmed.length > 0) out.push({ event: null, data: trimmed })
      cursor = this.buffer.indexOf('\n')
    }
    if (atEnd && this.buffer.trim().length > 0) {
      out.push({ event: null, data: this.buffer.trim() })
      this.buffer = ''
    }
    return out
  }
}

/** 无分隔符契约（例如某些网关返回单个 JSON 体）：整包在 flush 时交付 */
export class WholeBodyDecoder implements StreamDecoder {
  private readonly textDecoder = new TextDecoder('utf-8')
  private buffer = ''
  private truncated = false

  push(chunk: Uint8Array | string): StreamChunk[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.textDecoder.decode(chunk, { stream: true })
    return []
  }

  flush(): StreamChunk[] {
    const rest = this.textDecoder.decode()
    if (rest) this.buffer += rest
    const body = this.buffer.trim()
    this.buffer = ''
    if (body.length === 0) return []
    return [{ event: null, data: body }]
  }

  get incomplete(): boolean {
    return this.truncated
  }
}

/** 安全 JSON.parse：解析失败返回 undefined（残缺帧由上层判定为「中断」） */
export function parseJsonPayload<T = unknown>(data: string): T | undefined {
  const trimmed = data.trim()
  if (trimmed.length === 0) return undefined
  try {
    return JSON.parse(trimmed) as T
  } catch {
    return undefined
  }
}

/** 是否为 OpenAI 流结束哨兵 `[DONE]` */
export function isDoneSentinel(data: string): boolean {
  return data.trim() === '[DONE]'
}
