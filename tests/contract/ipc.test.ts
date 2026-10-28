import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_EVENTS, IPC_INVOKE_CHANNELS } from '@shared'

/**
 * IPC 契约的结构测试。
 *
 * 这些断言挡的是「静默不一致」：加了通道忘了白名单、通道名拼写风格漂移、
 * preload 误引桶文件导致沙箱里加载失败（表现为 window.termans 消失）。
 */
const repoRoot = resolve(__dirname, '../..')

describe('IPC 通道清单', () => {
  it('通道名全部符合 <domain>:<verb> 规范', () => {
    for (const channel of IPC_INVOKE_CHANNELS) {
      expect(channel).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]+$/)
    }
  })

  it('通道不重复，且扁平列表与分组定义一一对应', () => {
    expect(new Set(IPC_INVOKE_CHANNELS).size).toBe(IPC_INVOKE_CHANNELS.length)
    const grouped = Object.values(IPC_CHANNELS).flatMap((group) => Object.values(group as Record<string, string>))
    expect(grouped.length).toBe(IPC_INVOKE_CHANNELS.length)
    expect(new Set(grouped)).toEqual(new Set(IPC_INVOKE_CHANNELS))
  })

  it('契约覆盖全部领域（回归：删通道要在这里显式改断言）', () => {
    const required = [
      // app / settings
      'app:info',
      'settings:get',
      'settings:update',
      // 主机与分组 CRUD
      'hosts:list',
      'hosts:create',
      'hosts:update',
      'hosts:delete',
      'hosts:reorder',
      'groups:create',
      'groups:update',
      'groups:delete',
      // 凭据（safeStorage）
      'credentials:set',
      'credentials:clear',
      // 连接生命周期 + 终端数据/resize
      'ssh:connect',
      'ssh:input',
      'ssh:resize',
      'ssh:disconnect',
      'ssh:answer-host-key',
      // ssh_config 双向
      'ssh-config:parse',
      'ssh-config:write',
      'ssh-config:import',
      'ssh-config:export',
      // known_hosts 指纹
      'known-hosts:list',
      'known-hosts:trust',
      'known-hosts:remove',
      // 加密包：解锁/锁定/轮换/恢复码
      'vault:status',
      'vault:create',
      'vault:unlock',
      'vault:lock',
      'vault:rotate',
      'vault:recover',
      // 同步状态与冲突选择 + 双机迁移
      'sync:status',
      'sync:bootstrap',
      'sync:pull',
      'sync:push',
      'sync:conflicts',
      'sync:resolve',
      // AI 流式对话
      'ai:chat',
      'ai:cancel',
      'ai:list-providers',
      'ai:save-provider',
      'ai:set-api-key',
      // 主题与语言（语言走 settings:update，主题走 theme:*）
      'theme:list',
      'theme:save',
      'theme:delete'
    ]
    for (const channel of required) {
      expect(IPC_INVOKE_CHANNELS).toContain(channel)
    }
  })

  it('事件名不重复且与通道命名空间不冲突', () => {
    const events = Object.values(IPC_EVENTS)
    expect(new Set(events).size).toBe(events.length)
    for (const event of events) {
      expect(event).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]+$/)
      expect(IPC_INVOKE_CHANNELS).not.toContain(event)
    }
  })
})

describe('preload 白名单实现', () => {
  const source = readFileSync(resolve(repoRoot, 'src/preload/index.ts'), 'utf8')

  it('白名单来自 shared 的通道清单，而不是手写字符串', () => {
    expect(source).toContain('IPC_INVOKE_CHANNELS')
    expect(source).toContain('IPC_EVENTS')
    expect(source).toMatch(/new Set<string>\(IPC_INVOKE_CHANNELS\)/)
  })

  it('不 import @shared 桶文件（否则 zod 会被 require，沙箱 preload 直接加载失败）', () => {
    // 只允许从 '../shared/ipc' 与类型文件取值
    expect(source).not.toMatch(/from ['"]@shared['"]/)
    expect(source).not.toMatch(/from ['"]\.\.\/shared\/index['"]/)
  })

  it('通过 contextBridge 暴露且校验未登记通道', () => {
    expect(source).toContain("contextBridge.exposeInMainWorld('termans'")
    expect(source).toContain('invokable.has(channel)')
    expect(source).toContain('subscribable.has(event)')
  })
})

describe('主进程接线入口', () => {
  const mainIpc = readFileSync(resolve(repoRoot, 'src/main/ipc/index.ts'), 'utf8')
  const registry = readFileSync(resolve(repoRoot, 'src/main/ipc/registry.ts'), 'utf8')

  it('只有 registry 调用 ipcMain.handle（其余模块必须走封装）', () => {
    expect(registry).toContain('ipcMain.handle')
    // 注释里可以提到它，代码里不行 —— 先去掉注释再断言
    const mainIpcCode = mainIpc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    expect(mainIpcCode).not.toContain('ipcMain.handle')
  })

  it('index.ts 在注册末尾补未实现通道的桩', () => {
    expect(mainIpc).toContain('installPlaceholders()')
  })

  it('handler 结果统一包成 IpcResult 信封', () => {
    expect(registry).toContain('{ ok: true, data }')
    expect(registry).toContain("code: 'E_INVALID_ARGUMENT'")
  })
})
