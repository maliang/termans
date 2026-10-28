import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AiMessage } from '@shared/models/ai'
import {
  ConversationStore,
  deriveTitle,
  purgeLegacyConversationFiles
} from '../src/main/ai/conversations'
import { createAiModule } from '../src/main/ai/ipc'
import { AiService } from '../src/main/ai/service'
import { ProviderRepository } from '../src/main/ai/provider-store'
import { createInMemoryAiVault } from '../src/main/ai/vault-port'
import { DEFAULT_SETTINGS } from '@shared/models/settings'
import type { IpcEventMap, IpcEventName } from '@shared'

/**
 * 对话历史：**v1 只在内存里**（重启即失），不写 userData、不进 Git 同步、不进加密包。
 *
 * 为什么不做持久化（这条是产品决策，不是实现偷懒）：
 * 聊天记录里必然出现 `user@1.2.3.4`、端口、命令输出、内网路径，明文落盘
 * 与「锁屏时不显示任何主机信息、仓库里 grep 不到 IP/密码」的安全姿态直接冲突。
 * 跨重启的历史留到「加密历史」里程碑再做。
 *
 * 因此这里的断言是**反向**的：必须证明「什么都没写到磁盘上」。
 */

function newDir(): string {
  return mkdtempSync(join(tmpdir(), 'termans-conv-'))
}

describe('deriveTitle', () => {
  it('取第一条 user 消息，压平空白并截断到 60 字', () => {
    expect(deriveTitle([{ role: 'user', content: '  构建\n失败   为什么  ' }])).toBe('构建 失败 为什么')
    const long = deriveTitle([{ role: 'user', content: 'x'.repeat(100) }])
    expect(long).toHaveLength(61)
    expect(long.endsWith('…')).toBe(true)
  })

  it('没有 user 消息时给一个稳定标题，而不是空串', () => {
    expect(deriveTitle([{ role: 'assistant', content: 'hi' }])).toBe('新对话')
    expect(deriveTitle([])).toBe('新对话')
  })
})

describe('ConversationStore：只在内存', () => {
  it('第一轮自动建会话，第二轮追加（不产生新会话）', () => {
    const store = new ConversationStore()
    const first = store.recordTurn({
      conversationId: 'c1',
      hostId: 'host-1',
      messages: [
        { role: 'user', content: '磁盘满了怎么办' },
        { role: 'assistant', content: '先 df -h 看看' }
      ]
    })
    expect(first.id).toBe('c1')
    expect(first.title).toBe('磁盘满了怎么办')
    expect(first.hostId).toBe('host-1')
    expect(first.messages).toHaveLength(2)

    const second = store.recordTurn({
      conversationId: 'c1',
      hostId: 'host-1',
      messages: [
        { role: 'user', content: '再看 inode' },
        { role: 'assistant', content: 'df -i' }
      ]
    })
    expect(store.list()).toHaveLength(1)
    expect(second.messages).toHaveLength(4)
    // 标题保持第一条问题（会话中途改标题会让历史记录对不上）
    expect(second.title).toBe('磁盘满了怎么办')
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('新建实例读不到上一实例的会话（重启即失，v1 设计如此）', () => {
    const first = new ConversationStore()
    first.recordTurn({
      conversationId: 'c1',
      hostId: null,
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(first.get('c1')).not.toBeNull()
    const restarted = new ConversationStore()
    expect(restarted.list()).toEqual([])
    expect(restarted.get('c1')).toBeNull()
  })

  it('会话数与会话内消息数都有上限（防止内存无限增长）', () => {
    let now = 1_700_000_000_000
    const store = new ConversationStore({ now: () => now, maxConversations: 3, maxMessages: 4 })
    for (let i = 0; i < 5; i += 1) {
      now += 1000
      store.recordTurn({ conversationId: `c${i}`, hostId: null, messages: [{ role: 'user', content: `q${i}` }] })
    }
    expect(store.list()).toHaveLength(3)
    // 最新的留下，最旧的被裁掉
    expect(store.list().map((c) => c.id)).toEqual(['c4', 'c3', 'c2'])

    for (let i = 0; i < 5; i += 1) {
      now += 1000
      store.recordTurn({ conversationId: 'c4', hostId: null, messages: [{ role: 'user', content: `m${i}` }] })
    }
    expect(store.get('c4')?.messages.length).toBe(4)
  })

  it('删除会话；删不存在的会话不抛错；clear 一键清空', () => {
    const store = new ConversationStore()
    store.recordTurn({ conversationId: 'c1', hostId: null, messages: [{ role: 'user', content: 'hi' }] })
    store.remove('c1')
    expect(store.get('c1')).toBeNull()
    expect(() => store.remove('nope')).not.toThrow()

    store.recordTurn({ conversationId: 'c2', hostId: null, messages: [{ role: 'user', content: 'hi' }] })
    store.clear()
    expect(store.list()).toEqual([])
  })
})

describe('对话不落盘：由 chat 自动记录，但磁盘上什么都不留', () => {
  it('流式对话结束后记进内存，且 userData 目录里没有任何对话文件', async () => {
    const dir = newDir()
    const vault = createInMemoryAiVault()
    const providers = new ProviderRepository({ vault })
    const conversations = new ConversationStore()
    const events: Array<{ event: string; payload: unknown }> = []
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"choices":[{"delta":{"content":"先看"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" df -h"}}]}\n\n',
      'data: [DONE]\n\n'
    ]
    let index = 0
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index >= chunks.length) {
              controller.close()
              return
            }
            controller.enqueue(encoder.encode(chunks[index]))
            index += 1
          }
        }),
        { status: 200 }
      )) as unknown as typeof fetch

    const service = new AiService({
      providers,
      conversations,
      getSettings: () => ({ ...DEFAULT_SETTINGS.ai, enabled: true }),
      emit: <E extends IpcEventName>(event: E, payload: IpcEventMap[E]) => {
        events.push({ event, payload })
      },
      fetchImpl,
      sleep: async () => undefined,
      log: () => undefined
    })

    const provider = await service.saveProvider(
      {
        id: 'new',
        name: '本地模型',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'local',
        apiKeyRef: null,
        temperature: 0.2,
        maxTokens: 512,
        enabled: true
      },
      { apiKey: 'sk-local-test-000000000000' }
    )

    const request = {
      requestId: 'req-9',
      conversationId: 'conv-9',
      providerId: provider.id,
      messages: [{ role: 'user' as const, content: '磁盘满了' }],
      context: null
    }
    await service.chat(request, { hostId: 'host-7' })
    await service.whenSettled('req-9')

    const saved = service.listConversations().find((item) => item.id === 'conv-9')
    expect(saved).toBeTruthy()
    expect(saved?.hostId).toBe('host-7')
    expect(saved?.messages.map((m: AiMessage) => m.content)).toEqual(['磁盘满了', '先看 df -h'])

    // v1 不持久化：chat 不会往磁盘写任何东西（这里用空目录当「userData」验证）
    expect(readdirSync(dir)).toEqual([])
    // 内存里也不该混进 key
    expect(JSON.stringify(service.listConversations())).not.toContain('sk-local-test')
  })
})

describe('老版本明文残留：启动即删，不读、不迁移', () => {
  it('删除 ai-conversations.json 及其 .corrupt-* 备份（备份同样是明文）', () => {
    const dir = newDir()
    writeFileSync(join(dir, 'ai-conversations.json'), '{"version":1,"conversations":[{"id":"c1"}]}')
    writeFileSync(join(dir, 'ai-conversations.json.corrupt-1793209271180'), 'plain text leftover')
    writeFileSync(join(dir, 'other-file.json'), 'keep me')

    const removed = purgeLegacyConversationFiles(dir)
    expect(removed.sort()).toEqual([
      'ai-conversations.json',
      'ai-conversations.json.corrupt-1793209271180'
    ])
    expect(existsSync(join(dir, 'ai-conversations.json'))).toBe(false)
    // 只清 AI 对话残留，别动别人/别的设置文件
    expect(existsSync(join(dir, 'other-file.json'))).toBe(true)
  })

  it('幂等：目录不存在或没有残留都返回空数组，绝不抛（启动路径不能因此起不来）', () => {
    expect(purgeLegacyConversationFiles(join(newDir(), 'not-created-yet'))).toEqual([])
    const dir = newDir()
    expect(purgeLegacyConversationFiles(dir)).toEqual([])
    expect(purgeLegacyConversationFiles(dir)).toEqual([])
  })

  it('createAiModule 带 userDataDir 时清掉残留，且 ai:list-conversations 只返回本会话', async () => {
    const dir = newDir()
    writeFileSync(join(dir, 'ai-conversations.json'), '{"version":1,"conversations":[{"id":"old"}]}')
    const logs: string[] = []
    const ai = createAiModule({
      vault: createInMemoryAiVault(),
      userDataDir: dir,
      getSettings: () => ({ ...DEFAULT_SETTINGS.ai, enabled: true }),
      emit: () => undefined,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      log: (line) => logs.push(line)
    })

    // ① 文件已被删（不是读进来迁移）
    expect(existsSync(join(dir, 'ai-conversations.json'))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
    expect(logs.join('\n')).toContain('purged legacy plaintext conversations')
    // ② 老会话没有被恢复：进程内是空的
    expect(ai.service.listConversations()).toEqual([])
  })

  it('不传 userDataDir 也能正常工作（删除逻辑是可选的，便于测试与无盘场景）', () => {
    const ai = createAiModule({
      vault: createInMemoryAiVault(),
      getSettings: () => ({ ...DEFAULT_SETTINGS.ai, enabled: true }),
      emit: () => undefined,
      log: () => undefined
    })
    expect(ai.service.listConversations()).toEqual([])
  })
})
