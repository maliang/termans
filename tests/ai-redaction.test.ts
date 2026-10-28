import { describe, expect, it } from 'vitest'
import type { IpcEventMap, IpcEventName } from '@shared'
import type { AiChatRequest, AiProviderInput } from '@shared/models/ai'
import { DEFAULT_SETTINGS } from '@shared/models/settings'
import { AiService } from '../src/main/ai/service'
import { ConversationStore } from '../src/main/ai/conversations'
import { ProviderRepository } from '../src/main/ai/provider-store'
import { apiKeyTailFromRef, buildApiKeyRef, createRedactor, maskSecret } from '../src/main/ai/redact'
import { createInMemoryAiVault } from '../src/main/ai/vault-port'

/**
 * key 脱敏测试（task t5 明确要求：断言日志与 IPC 回包不含 key）。
 *
 * 威胁模型很具体：AI 客户端最常见的泄漏不是被黑客拖库，而是
 * **key 出现在一行日志 / 一个错误提示 / 一次事件回包里**，然后被截图、被贴进 issue。
 * 因此这里对「日志」「事件」「invoke 回包」三条出口各断言一次。
 */

const TEST_KEY = 'sk-termans-test-0123456789abcdef-SECRET'
const TEST_KEY_TAIL = 'CRET'

function providerInput(overrides: Partial<AiProviderInput> = {}): AiProviderInput {
  return {
    id: 'new',
    name: 'DeepSeek 测试',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyRef: null,
    temperature: 0.2,
    maxTokens: 1024,
    enabled: true,
    ...overrides
  }
}

interface Harness {
  service: AiService
  providers: ProviderRepository
  vault: ReturnType<typeof createInMemoryAiVault>
  events: Array<{ event: string; payload: unknown }>
  logs: string[]
}

async function createHarness(
  fetchImpl: typeof fetch,
  settingsOverride: Partial<typeof DEFAULT_SETTINGS.ai> = {}
): Promise<Harness> {
  const vault = createInMemoryAiVault()
  const providers = new ProviderRepository({ vault })
  const conversations = new ConversationStore()
  const events: Array<{ event: string; payload: unknown }> = []
  const logs: string[] = []
  const service = new AiService({
    providers,
    conversations,
    getSettings: () => ({ ...DEFAULT_SETTINGS.ai, enabled: true, ...settingsOverride }),
    emit: <E extends IpcEventName>(event: E, payload: IpcEventMap[E]) => {
      events.push({ event, payload })
    },
    fetchImpl,
    sleep: async () => undefined,
    log: (line) => logs.push(line)
  })
  return { service, providers, vault, events, logs }
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index]))
      index += 1
    }
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function chatRequest(providerId: string, requestId = 'req-1'): AiChatRequest {
  return {
    requestId,
    conversationId: 'conv-1',
    providerId,
    messages: [{ role: 'user', content: '看一下磁盘占用' }],
    context: null
  }
}

function collectText(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

describe('maskSecret / apiKeyRef', () => {
  it('只露出尾 4 位，且极短的 key 不整串暴露', () => {
    expect(maskSecret(TEST_KEY)).toBe(`••••${TEST_KEY_TAIL}`)
    expect(maskSecret('ab')).toBe('••••')
    // 空 key 显示空串：UI 用它区分「未配置」与「已配置」
    expect(maskSecret('')).toBe('')
  })

  it('apiKeyRef 是可回读尾号的指针（UI 靠它显示掩码，契约里没有明文位）', () => {
    const ref = buildApiKeyRef('p1', TEST_KEY)
    expect(ref).toBe('vault:ai-key:p1:CRET')
    expect(ref).not.toContain('0123456789abcdef')
    expect(apiKeyTailFromRef(ref)).toBe('CRET')
    expect(apiKeyTailFromRef(null)).toBe('')
  })
})

describe('createRedactor：常见泄漏形态', () => {
  it('整串 key / sk- 形态 / Authorization / 查询参数都被替换', () => {
    const redactor = createRedactor([TEST_KEY])
    const samples = [
      `Authorization: Bearer ${TEST_KEY}`,
      `{"api_key":"${TEST_KEY}"}`,
      `https://api.example.com/v1/models?key=${TEST_KEY}`,
      '上游报错：Incorrect API key provided: sk-proj-abcdef123456',
      'token sk-ant-api03-ZZZZZZZZZZZZ 无效',
      'Google key AIzaSy_FAKE_TEST_KEY_0000000000000000'
    ]
    for (const sample of samples) {
      const output = redactor.redactText(sample)
      expect(output).not.toContain(TEST_KEY)
      expect(output).not.toContain('sk-proj-abcdef123456')
      expect(output).not.toContain('sk-ant-api03-ZZZZZZZZZZZZ')
      expect(output).not.toContain('AIzaSy_FAKE_TEST_KEY_0000000000000000')
    }
    // 保留可读上下文（否则用户不知道哪一步出错）
    expect(redactor.redactText(samples[3])).toContain('Incorrect API key provided')
    // 查询参数保留参数名，值被掩码
    expect(redactor.redactText(samples[2])).toContain('key=')
  })

  it('redactDeep 处理嵌套对象（事件回包常是对象）', () => {
    const redactor = createRedactor([TEST_KEY])
    const payload = redactor.redactDeep({ headers: { Authorization: `Bearer ${TEST_KEY}` }, nested: [TEST_KEY] })
    expect(JSON.stringify(payload)).not.toContain(TEST_KEY)
    expect(redactor.leaksAnySecret(JSON.stringify(payload))).toBe(false)
    expect(redactor.leaksAnySecret(`x ${TEST_KEY} y`)).toBe(true)
  })
})

describe('key 不进明文配置、不进日志、不进回包', () => {
  it('保存后：vault 里存明文 key，供应商文档与 list 回包里只有尾号', async () => {
    const harness = await createHarness(async () => jsonResponse({}))
    const saved = await harness.service.saveProvider(providerInput(), { apiKey: TEST_KEY })

    expect(saved.apiKeyRef).toBe('vault:ai-key:' + saved.id + ':' + TEST_KEY_TAIL)
    // ① provider 文档（会落进加密包）不含明文 key
    const doc = await harness.providers.serializeDoc()
    expect(doc).not.toContain(TEST_KEY)
    expect(doc).toContain(TEST_KEY_TAIL)
    // ② key 确实在 vault 里（否则等于没保存，用户会以为配置成功）
    expect(harness.vault.containsText(TEST_KEY)).toBe(true)
    // ③ invoke 回包（UI 拿到的就是它）不含明文 key
    const listed = await harness.service.listProviders()
    expect(collectText(listed)).not.toContain(TEST_KEY)
    expect(collectText(listed)).toContain(TEST_KEY_TAIL)
  })

  it('流式对话成功：日志与所有事件里都没有 key / Authorization', async () => {
    const captured: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured.push({ url: String(url), headers: init.headers as Record<string, string> })
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"磁盘"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"还好"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n'
      ])
    }) as unknown as typeof fetch

    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), { apiKey: TEST_KEY })
    await harness.service.chat(chatRequest(provider.id), {})
    await harness.service.whenSettled('req-1')

    // 请求确实带上了 key（否则功能是坏的），但它只在请求头里
    expect(captured[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    // ① 日志
    expect(harness.logs.length).toBeGreaterThan(0)
    for (const line of harness.logs) {
      expect(line).not.toContain(TEST_KEY)
      expect(line.toLowerCase()).not.toContain('authorization')
    }
    // ② 事件回包
    const serialized = collectText(harness.events)
    expect(serialized).not.toContain(TEST_KEY)
    expect(serialized.toLowerCase()).not.toContain('authorization')
    // ③ 流式增量确实分多帧交付（用户能看到逐步输出）
    const deltas = harness.events.filter((item) => item.event === 'ai:stream-delta')
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    const done = harness.events.find((item) => item.event === 'ai:stream-done')
    expect(done).toBeTruthy()
    expect(collectText(done?.payload)).toContain('磁盘还好')
  })

  it('供应商把 key 回显在错误体里时，错误事件与日志都被脱敏', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          error: { message: `Incorrect API key provided: ${TEST_KEY}`, type: 'invalid_request_error' }
        }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      )) as unknown as typeof fetch

    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), { apiKey: TEST_KEY })
    await harness.service.chat(chatRequest(provider.id), {})
    await harness.service.whenSettled('req-1')

    const error = harness.events.find((item) => item.event === 'ai:stream-error')
    expect(error).toBeTruthy()
    const payload = collectText(error?.payload)
    expect(payload).not.toContain(TEST_KEY)
    // 供应商原文仍然可读（用户要能自己判断该改什么）
    expect(payload).toContain('401')
    expect(harness.logs.join('\n')).not.toContain(TEST_KEY)
  })

  it('测试连接失败：透出供应商错误原文，但不含 key', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: `bad key ${TEST_KEY}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch

    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), { apiKey: TEST_KEY })
    const result = await harness.service.testProvider(provider.id)

    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
    expect(result.message).not.toContain(TEST_KEY)
    expect(collectText(result)).not.toContain(TEST_KEY)
    expect(harness.logs.join('\n')).not.toContain(TEST_KEY)
  })

  it('测试连接成功：提示模型是否在返回列表里（最常见的配置错误）', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] })) as unknown as typeof fetch
    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), { apiKey: TEST_KEY })
    const result = await harness.service.testProvider(provider.id)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('deepseek-chat 可用')
    expect(result.message).not.toContain(TEST_KEY)
  })

  it('未配置 key 时不发请求，直接给出可操作的提示', async () => {
    let called = 0
    const fetchImpl = (async () => {
      called += 1
      return jsonResponse({})
    }) as unknown as typeof fetch
    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), {})
    const result = await harness.service.testProvider(provider.id)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('API key')
    expect(called).toBe(0)
  })
})

describe('自定义请求头里的 token：与 key 同等待遇', () => {
  const HEADER_NAME = 'x-api-token'
  const HEADER_TOKEN = 'tok-termans-header-abcdef-SECRET'

  it('存在加密包文档里（与 provider 同一份密文），不进日志、不进错误消息', async () => {
    // 供应商把自定义头的值原样回显（真实网关常这么干，例如 Cloudflare 回显 token）
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: `invalid token: ${HEADER_TOKEN}` }), {
        status: 401,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch

    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), {
      apiKey: TEST_KEY,
      headers: { [HEADER_NAME]: HEADER_TOKEN }
    })

    // ① 落盘位置：与供应商配置同一个加密包文档（vault.writeDoc），不是明文文件
    const writes = harness.vault.writeLog()
    expect(writes.some((entry) => entry.key === 'ai/providers.json')).toBe(true)
    expect(Object.keys(harness.vault.snapshot())).toContain('ai/providers.json')
    expect(harness.vault.containsText(HEADER_TOKEN)).toBe(true)

    // ② 对外视图：list() 不含 header 值（只有 listStored 内部用）
    const listed = JSON.stringify(await harness.service.listProviders())
    expect(listed).not.toContain(HEADER_TOKEN)

    // ③ 错误消息与日志都脱敏，但错误原因仍可读
    const result = await harness.service.testProvider(provider.id)
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain(HEADER_TOKEN)
    expect(result.message).toContain('401')
    expect(harness.logs.join('\n')).not.toContain(HEADER_TOKEN)
    expect(harness.vault.containsText(HEADER_TOKEN)).toBe(true)
  })

  it('普通头（content-type 之类）不会被误掩码，错误消息保持可读', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'model not found: nope' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' }
      })) as unknown as typeof fetch
    const harness = await createHarness(fetchImpl)
    const provider = await harness.service.saveProvider(providerInput(), {
      apiKey: TEST_KEY,
      headers: { 'x-tenant-id': 'team-a', accept: 'application/json' }
    })
    const result = await harness.service.testProvider(provider.id)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('model not found: nope')
    expect(result.message).toContain('404')
  })
})
