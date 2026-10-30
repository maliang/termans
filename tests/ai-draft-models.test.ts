import { describe, expect, it, vi } from 'vitest'
import type { IpcEventMap, IpcEventName } from '@shared'
import { DEFAULT_SETTINGS } from '@shared/models/settings'
import { AiService } from '../src/main/ai/service'
import { ConversationStore } from '../src/main/ai/conversations'
import { ProviderRepository } from '../src/main/ai/provider-store'
import { createInMemoryAiVault, type InMemoryAiVault } from '../src/main/ai/vault-port'

/**
 * 草稿读模型（AC-1）+ 失败结构化与脱敏（AC-3）。
 *
 * 关键断言不是「返回了模型列表」，而是**不写盘**：用 spy 正面证明 `providers.save`
 * 零调用、vault 写入条数不变。只看返回值会被实现骗过——它完全可以先保存再返回。
 *
 * 脱敏断言同样必须正面做：供应商 401 原文里通常会回显 key 片段，
 * `failure.message` / `error` 两条出口都不能把它带出去。
 */

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

const TEST_KEY = 'sk-draft-SECRET-0123456789'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface Harness {
  service: AiService
  providers: ProviderRepository
  vault: InMemoryAiVault
  requests: Captured[]
  logs: string[]
}

function createHarness(
  responder: (request: Captured) => Response | Promise<Response>,
  options: { connectTimeoutMs?: number } = {}
): Harness {
  const vault = createInMemoryAiVault()
  const providers = new ProviderRepository({ vault })
  const conversations = new ConversationStore()
  const requests: Captured[] = []
  const logs: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const captured: Captured = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: (init.body as string | undefined) ?? null
    }
    requests.push(captured)
    return responder(captured)
  }) as unknown as typeof fetch
  const service = new AiService({
    providers,
    conversations,
    getSettings: () => ({ ...DEFAULT_SETTINGS.ai, enabled: true }),
    emit: <E extends IpcEventName>(_event: E, _payload: IpcEventMap[E]) => undefined,
    fetchImpl,
    sleep: async () => undefined,
    log: (line) => logs.push(line),
    connectTimeoutMs: options.connectTimeoutMs
  })
  return { service, providers, vault, requests, logs }
}

describe('草稿读模型：不保存也能拉列表（AC-1）', () => {
  it('URL / 鉴权头 / headers 全部来自草稿，且 providers.save 与 vault 零写入', async () => {
    const h = createHarness(() => jsonResponse({ data: [{ id: 'gpt-4.1-mini' }, { id: 'o4-mini' }] }))
    const saveSpy = vi.spyOn(h.providers, 'save')
    const getSpy = vi.spyOn(h.providers, 'get')
    const writesBefore = h.vault.writeLog().length

    const result = await h.service.listModels({
      draft: {
        kind: 'openai-compatible',
        baseUrl: 'https://draft.example.com/v1',
        model: 'gpt-4.1-mini',
        apiKey: TEST_KEY,
        headers: { 'X-Tenant': 'acme' }
      }
    })

    expect(result.models).toEqual(['gpt-4.1-mini', 'o4-mini'])
    expect(result.error).toBeNull()
    expect(result.failure).toBeNull()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0].url).toBe('https://draft.example.com/v1/models')
    expect(h.requests[0].method).toBe('GET')
    expect(h.requests[0].headers.authorization).toBe(`Bearer ${TEST_KEY}`)
    // 草稿 headers 与保存路径同一条 sanitizeHeaders：字段名归一化成小写
    expect(h.requests[0].headers['x-tenant']).toBe('acme')

    // 正面证明「不落盘」：不是「返回里没有 id」而是「一条写入都没发生」
    expect(saveSpy).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
    expect(h.vault.writeLog()).toHaveLength(writesBefore)
    // key 明文只在这趟 IPC 里，不回传
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
    expect(h.logs.join('\n')).not.toContain(TEST_KEY)
  })

  it('草稿 headers 在主进程重跑 sanitizeHeaders：危险头与非法名一律丢弃', async () => {
    const h = createHarness(() => jsonResponse({ data: [{ id: 'm' }] }))
    await h.service.listModels({
      draft: {
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        model: 'm',
        apiKey: TEST_KEY,
        headers: { Host: 'evil.example.com', 'content-length': '9999', 'X-Ok': '1', 'bad header': 'x' }
      }
    })
    const sent = h.requests[0].headers
    expect(sent.host).toBeUndefined()
    expect(sent['content-length']).toBeUndefined()
    expect(sent['bad header']).toBeUndefined()
    expect(sent['x-ok']).toBe('1')
  })

  it('草稿没填 key（且该协议需要 key）→ no-key，且一次请求都不发', async () => {
    const h = createHarness(() => jsonResponse({ data: [] }))
    const result = await h.service.listModels({
      draft: { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm' }
    })
    expect(result.models).toEqual([])
    expect(result.failure).toEqual({ kind: 'no-key', status: null, message: '' })
    expect(result.error).toContain('API key')
    expect(h.requests).toHaveLength(0)
  })

  it('Ollama 草稿不需要 key（本地无鉴权），照常请求 /api/tags', async () => {
    const h = createHarness(() => jsonResponse({ models: [{ name: 'llama3.1' }, { model: 'qwen2.5' }] }))
    const result = await h.service.listModels({
      draft: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'llama3.1' }
    })
    expect(result.models).toEqual(['llama3.1', 'qwen2.5'])
    expect(result.failure).toBeNull()
    expect(h.requests[0].url).toBe('http://127.0.0.1:11434/api/tags')
    expect(h.requests[0].headers.authorization).toBeUndefined()
  })

  it('已保存供应商路径照旧：key 从 vault 取，草稿逻辑不影响它', async () => {
    const h = createHarness(() => jsonResponse({ data: [{ id: 'gpt-4o' }] }))
    const saved = await h.providers.save(
      {
        id: 'p-saved',
        name: 'saved',
        kind: 'openai',
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o',
        apiKeyRef: null,
        temperature: 0.2,
        maxTokens: 4096,
        enabled: true
      },
      { apiKey: 'sk-saved-0001' }
    )
    const writesBefore = h.vault.writeLog().length
    const result = await h.service.listModels({ providerId: saved.id })
    expect(result.models).toEqual(['gpt-4o'])
    expect(result.failure).toBeNull()
    expect(h.requests[0].headers.authorization).toBe('Bearer sk-saved-0001')
    expect(h.vault.writeLog()).toHaveLength(writesBefore)
  })
})

describe('读取模型失败的结构化分级（AC-3）', () => {
  it('HTTP 401：kind=http + status=401，且错误原文里的 key 被脱敏', async () => {
    const h = createHarness(() =>
      jsonResponse({ error: { message: `Invalid API key: ${TEST_KEY}` } }, 401)
    )
    const result = await h.service.listModels({
      draft: { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: TEST_KEY }
    })
    expect(result.models).toEqual([])
    expect(result.failure?.kind).toBe('http')
    expect(result.failure?.status).toBe(401)
    expect(result.failure?.message).toContain('Invalid API key')
    expect(result.failure?.message).not.toContain(TEST_KEY)
    // 整句 error 保留向后兼容，但同样必须脱敏
    expect(result.error).toContain('HTTP 401')
    expect(result.error).not.toContain(TEST_KEY)
  })

  it('空列表：kind=empty（配置看着对、端点其实是兼容层的典型症状）', async () => {
    const h = createHarness(() => jsonResponse({ data: [] }))
    const result = await h.service.listModels({
      draft: { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: TEST_KEY }
    })
    expect(result.models).toEqual([])
    expect(result.failure).toEqual({ kind: 'empty', status: null, message: '' })
    expect(result.error).toContain('空列表')
  })

  it('连接超时：kind=timeout', async () => {
    const h = createHarness(() => new Promise<Response>(() => undefined), { connectTimeoutMs: 20 })
    const result = await h.service.listModels({
      draft: { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: TEST_KEY }
    })
    expect(result.failure?.kind).toBe('timeout')
    expect(result.failure?.status).toBeNull()
    expect(result.models).toEqual([])
  })

  it('网络错误：kind=network', async () => {
    const h = createHarness(() => {
      throw new TypeError('fetch failed')
    })
    const result = await h.service.listModels({
      draft: { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: TEST_KEY }
    })
    expect(result.failure?.kind).toBe('network')
    expect(result.models).toEqual([])
  })

  it('日志只打 id / 状态 / 条数，不打 headers、不打 body', async () => {
    const h = createHarness(() => jsonResponse({ data: [{ id: 'm' }] }))
    await h.service.listModels({
      draft: { kind: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: TEST_KEY, headers: { 'X-Secret': 'v' } }
    })
    const joined = h.logs.join('\n')
    expect(joined).toContain('list models ok id=draft count=1')
    expect(joined).not.toContain(TEST_KEY)
    expect(joined).not.toContain('X-Secret')
    expect(joined).not.toContain('authorization')
  })
})
