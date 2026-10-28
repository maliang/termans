import { describe, expect, it } from 'vitest'
import {
  NdjsonDecoder,
  SseDecoder,
  isDoneSentinel,
  parseJsonPayload,
  type StreamChunk
} from '../src/main/ai/stream'
import { createDecoder, interpretChunk, resolveStreamFormat } from '../src/main/ai/adapters'
import type { AiProvider } from '@shared/models/ai'

/**
 * 流式解析器测试（task t5 明确要求四类用例）：
 * 正常 / 半包 / 异常断开 / 多字节 UTF-8 截断。
 *
 * 这些用例的价值在于：真实网络里分片边界是随机的，解析器只要在某个边界上吐不出内容，
 * 用户看到的就是「AI 回答到一半卡住」——而本机（同机房）测试永远复现不了。
 */

const encoder = new TextEncoder()

function sseText(events: Array<{ event?: string; data: string }>): string {
  return events
    .map((item) => `${item.event ? `event: ${item.event}\n` : ''}data: ${item.data}\n\n`)
    .join('')
}

function feed(decoder: SseDecoder, text: string, sliceSize: number): StreamChunk[] {
  const bytes = encoder.encode(text)
  const out: StreamChunk[] = []
  for (let offset = 0; offset < bytes.length; offset += sliceSize) {
    out.push(...decoder.push(bytes.slice(offset, offset + sliceSize)))
  }
  return out
}

describe('SseDecoder', () => {
  it('正常流：多个事件 + [DONE] + 注释行被忽略', () => {
    const decoder = new SseDecoder()
    const text =
      sseText([{ data: '{"choices":[{"delta":{"content":"你"}}]}' }]) +
      ': keep-alive\n\n' +
      sseText([{ data: '{"choices":[{"delta":{"content":"好"}}]}' }, { data: '[DONE]' }])
    const chunks = decoder.push(text)
    expect(chunks).toHaveLength(3)
    expect(chunks[0].data).toContain('你')
    expect(chunks[2].data).toBe('[DONE]')
    expect(decoder.incomplete).toBe(false)
    expect(decoder.flush()).toHaveLength(0)
  })

  it('半包：任意切分边界都得到同样的事件序列', () => {
    const text = sseText([
      { event: 'message_start', data: '{"type":"message_start","message":{"usage":{"input_tokens":12}}}' },
      { event: 'content_block_delta', data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"第一步"}}' },
      { event: 'content_block_delta', data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"第二步"}}' },
      { event: 'message_stop', data: '{"type":"message_stop"}' }
    ])
    const expected = feed(new SseDecoder(), text, text.length * 4)
    for (const slice of [1, 2, 3, 7, 13, 64]) {
      const decoder = new SseDecoder()
      const actual = feed(decoder, text, slice)
      expect(actual).toEqual(expected)
      expect(decoder.incomplete).toBe(false)
    }
    expect(expected).toHaveLength(4)
    expect(expected[0].event).toBe('message_start')
  })

  it('多字节 UTF-8 在字节中间被切断时不出现乱码/丢字', () => {
    const text = sseText([
      { data: '{"choices":[{"delta":{"content":"终端上下文注入"}}]}' },
      { data: '{"choices":[{"delta":{"content":"✅ 完成"}}]}' }
    ])
    // 逐字节喂入：每个汉字的 3 字节必然会被切开
    const decoder = new SseDecoder()
    const chunks = feed(decoder, text, 1)
    expect(chunks).toHaveLength(2)
    expect(JSON.parse(chunks[0].data).choices[0].delta.content).toBe('终端上下文注入')
    expect(JSON.parse(chunks[1].data).choices[0].delta.content).toBe('✅ 完成')
  })

  it('异常断开：没有结束标记时 flush 尽力交付且标记 incomplete，不抛异常', () => {
    const decoder = new SseDecoder()
    const first = decoder.push('data: {"a":1}\n\n')
    expect(first).toHaveLength(1)
    // 半截 JSON，且没有末尾空行（连接被掐断）
    expect(() => decoder.push('data: {"choices":[{"delta":{"cont')).not.toThrow()
    const tail = decoder.flush()
    expect(decoder.incomplete).toBe(true)
    expect(tail).toHaveLength(1)
    // 残缺帧解析成 undefined，而不是让上层崩掉
    expect(parseJsonPayload(tail[0].data)).toBeUndefined()
  })

  it('CRLF 与 BOM 容错', () => {
    const decoder = new SseDecoder()
    const chunks = decoder.push('\uFEFFdata: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n')
    expect(chunks).toHaveLength(2)
    expect(chunks[0].data).toBe('{"a":1}')
  })
})

describe('NdjsonDecoder（Ollama）', () => {
  it('逐行交付，半包等待换行', () => {
    const decoder = new NdjsonDecoder()
    expect(decoder.push('{"message":{"content":"a"}}')).toHaveLength(0)
    // 上一行补上换行后交付；当前这行仍无换行，继续等待
    expect(decoder.push('\n{"message":{"content":"b"}}')).toHaveLength(1)
    const tail = decoder.push('\n{"done":true}\n')
    expect(tail).toHaveLength(2)
    expect(parseJsonPayload(tail[1].data)).toEqual({ done: true })
  })

  it('多字节字符跨分片', () => {
    const decoder = new NdjsonDecoder()
    const bytes = encoder.encode('{"message":{"content":"中文"}}\n')
    const cut = bytes.length - 4
    expect(decoder.push(bytes.slice(0, cut))).toHaveLength(0)
    const out = decoder.push(bytes.slice(cut))
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0].data).message.content).toBe('中文')
  })

  it('末尾无换行：完整 JSON 不算残缺，半截 JSON 才算', () => {
    const complete = new NdjsonDecoder()
    complete.push('{"done":tru')
    complete.push('e}')
    expect(complete.flush()).toHaveLength(1)
    expect(complete.incomplete).toBe(false)

    const broken = new NdjsonDecoder()
    broken.push('{"done":')
    expect(broken.flush()).toHaveLength(1)
    expect(broken.incomplete).toBe(true)
  })
})

describe('interpretChunk：各供应商差异', () => {
  const openai = { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' } as AiProvider
  const anthropic = { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' } as AiProvider
  const gemini = { kind: 'openai-compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' } as AiProvider
  const ollama = { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' } as AiProvider

  it('resolveStreamFormat 按 kind/URL 选格式', () => {
    expect(resolveStreamFormat(openai)).toBe('sse-openai')
    expect(resolveStreamFormat(anthropic)).toBe('sse-anthropic')
    expect(resolveStreamFormat(gemini)).toBe('sse-gemini')
    expect(resolveStreamFormat(ollama)).toBe('ndjson-ollama')
    expect(createDecoder('ndjson-ollama')).toBeInstanceOf(NdjsonDecoder)
  })

  it('OpenAI：delta.content 与末尾 usage', () => {
    const delta = interpretChunk('sse-openai', {
      event: null,
      data: JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })
    })
    expect(delta.delta).toBe('hi')
    const usage = interpretChunk('sse-openai', {
      event: null,
      data: JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })
    })
    expect(usage.usage).toEqual({ promptTokens: 11, completionTokens: 7 })
    expect(isDoneSentinel('[DONE]')).toBe(true)
  })

  it('Anthropic：message_start 的 input_tokens、text_delta、message_delta 的 output_tokens', () => {
    const start = interpretChunk('sse-anthropic', {
      event: 'message_start',
      data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 21 } } })
    })
    expect(start.usage?.promptTokens).toBe(21)
    const text = interpretChunk('sse-anthropic', {
      event: 'content_block_delta',
      data: JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'abd' } })
    })
    expect(text.delta).toBe('abd')
    const delta = interpretChunk('sse-anthropic', {
      event: 'message_delta',
      data: JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })
    })
    expect(delta.usage?.completionTokens).toBe(9)
    const stop = interpretChunk('sse-anthropic', {
      event: 'message_stop',
      data: JSON.stringify({ type: 'message_stop' })
    })
    expect(stop.done).toBe(true)
  })

  it('Anthropic：error 事件被识别为帧错误，而不是静默结束', () => {
    const error = interpretChunk('sse-anthropic', {
      event: 'error',
      data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })
    })
    expect(error.error).toBeTruthy()
    expect(error.error).toContain('Overloaded')
  })

  it('Gemini：数组形式的 chunk 与 usageMetadata', () => {
    const chunk = interpretChunk('sse-gemini', {
      event: null,
      data: JSON.stringify([
        {
          candidates: [{ content: { parts: [{ text: '你好' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 }
        }
      ])
    })
    expect(chunk.delta).toBe('你好')
    expect(chunk.usage).toEqual({ promptTokens: 5, completionTokens: 3 })
  })

  it('Ollama：message.content 与最终 prompt_eval_count/eval_count', () => {
    const chunk = interpretChunk('ndjson-ollama', {
      event: null,
      data: JSON.stringify({ message: { role: 'assistant', content: 'abc' }, done: false })
    })
    expect(chunk.delta).toBe('abc')
    const final = interpretChunk('ndjson-ollama', {
      event: null,
      data: JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 6 })
    })
    expect(final.done).toBe(true)
    expect(final.usage).toEqual({ promptTokens: 4, completionTokens: 6 })
  })
})
