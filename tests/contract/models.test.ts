import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  aiCommandSuggestionSchema,
  aiSettingsSchema,
  hostInputSchema,
  hostLibrarySchema,
  settingsPatchSchema,
  settingsSchema,
  sshConfigFieldUpdateSchema,
  terminalSizeSchema,
  vaultContentPolicySchema,
  withDefaults
} from '@shared'

/**
 * 契约模型测试：这里断言的是「类型层必须守住的业务不变量」，
 * 尤其是那些一旦放行就会变成安全事故的字段（明文密码、私钥同步、AI 免确认执行）。
 */

const validHost = {
  label: 'prod-web-1',
  groupId: null,
  hostname: '10.0.0.11',
  port: 22,
  username: 'deploy',
  authMethod: 'publickey' as const,
  privateKeyPath: '/Users/me/.ssh/id_ed25519',
  credentialRef: null,
  jumpHostId: null,
  forwardAgent: false,
  keepaliveSeconds: 30,
  terminalProfileId: null,
  startupCommand: null,
  env: {},
  tags: [],
  color: null,
  portForwards: [],
  sshConfigOrigin: null
}

describe('主机模型', () => {
  it('接受合法主机并保留关键字段', () => {
    const parsed = hostInputSchema.parse(validHost)
    expect(parsed.hostname).toBe('10.0.0.11')
    expect(parsed.privateKeyPath).toBe('/Users/me/.ssh/id_ed25519')
  })

  it('不接受明文密码字段（凭据只能存 safeStorage，用 credentialRef 引用）', () => {
    const parsed = hostInputSchema.parse({ ...validHost, password: 'hunter2' }) as Record<string, unknown>
    expect('password' in parsed).toBe(false)
  })

  it('拒绝非法端口与非法主机名', () => {
    expect(() => hostInputSchema.parse({ ...validHost, port: 0 })).toThrow()
    expect(() => hostInputSchema.parse({ ...validHost, port: 70000 })).toThrow()
    expect(() => hostInputSchema.parse({ ...validHost, hostname: '' })).toThrow()
    expect(() => hostInputSchema.parse({ ...validHost, hostname: 'has space' })).toThrow()
  })

  it('主机库 schemaVersion 固定为 1', () => {
    expect(() => hostLibrarySchema.parse({ schemaVersion: 2, hosts: [], groups: [] })).toThrow()
    expect(hostLibrarySchema.parse({ schemaVersion: 1, hosts: [], groups: [] }).hosts).toEqual([])
  })
})

describe('加密包内容策略', () => {
  it('默认策略禁止私钥与明文主机名进入仓库', () => {
    const policy = vaultContentPolicySchema.parse({
      secretsExcluded: true,
      privateKeysExcluded: true,
      plaintextHostnamesInRepo: false
    })
    expect(policy.privateKeysExcluded).toBe(true)
  })

  it('任何把私钥/明文放进仓库的配置都会被拒绝（不是警告）', () => {
    expect(() =>
      vaultContentPolicySchema.parse({ secretsExcluded: true, privateKeysExcluded: false, plaintextHostnamesInRepo: false })
    ).toThrow()
    expect(() =>
      vaultContentPolicySchema.parse({ secretsExcluded: true, privateKeysExcluded: true, plaintextHostnamesInRepo: true })
    ).toThrow()
  })
})

describe('设置模型', () => {
  it('缺字段时用默认值补齐，且只补缺的部分', () => {
    expect(withDefaults({})).toEqual(DEFAULT_SETTINGS)
    const merged = withDefaults({ ui: { sidebarWidth: 300 } })
    expect(merged.ui.sidebarWidth).toBe(300)
    expect(merged.ui.aiPanelWidth).toBe(DEFAULT_SETTINGS.ui.aiPanelWidth)
    expect(merged.locale).toBe(DEFAULT_SETTINGS.locale)
  })

  it('AI 命令必须二次确认（字段是字面量 true）', () => {
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, commandConfirmation: false } })).toThrow()
  })

  it('终端上下文默认 200 行、上限 500 行（与 AI 模块常量一致）', () => {
    expect(DEFAULT_SETTINGS.ai.contextLines).toBe(200)
    const parsed = aiSettingsSchema.parse({ ...DEFAULT_SETTINGS.ai, contextLines: 500 })
    expect(parsed.contextLines).toBe(500)
    expect(() => aiSettingsSchema.parse({ ...DEFAULT_SETTINGS.ai, contextLines: 501 })).toThrow()
    expect(aiSettingsSchema.parse({ ...DEFAULT_SETTINGS.ai, contextLines: 0 }).contextLines).toBe(0)
  })

  it('补丁 schema 只接受已知字段与已知小节', () => {
    expect(settingsPatchSchema.parse({ locale: 'zh-CN' }).locale).toBe('zh-CN')
    expect(() => settingsPatchSchema.parse({ bogus: 1 })).toThrow()
    expect(() => settingsPatchSchema.parse({ ui: { bogus: 1 } })).toThrow()
    expect(() => settingsPatchSchema.parse({ locale: 'fr' })).toThrow()
  })

  it('越界数值被拒绝（字号/侧栏宽度）', () => {
    expect(() => settingsPatchSchema.parse({ terminal: { fontSize: 4 } })).toThrow()
    expect(() => settingsPatchSchema.parse({ ui: { sidebarWidth: 900 } })).toThrow()
  })
})

describe('其余契约', () => {
  it('AI 命令建议始终要求确认', () => {
    expect(aiCommandSuggestionSchema.parse({ command: 'ls', explanation: 'list', requiresConfirmation: true }).requiresConfirmation).toBe(true)
    expect(() => aiCommandSuggestionSchema.parse({ command: 'ls', explanation: 'list', requiresConfirmation: false })).toThrow()
  })

  it('终端尺寸有上下界', () => {
    expect(terminalSizeSchema.parse({ cols: 80, rows: 24 }).rows).toBe(24)
    expect(() => terminalSizeSchema.parse({ cols: 0, rows: 24 })).toThrow()
    expect(() => terminalSizeSchema.parse({ cols: 80, rows: 1 })).toThrow()
  })

  it('ssh_config 写回允许用 null 表示删除字段', () => {
    const update = sshConfigFieldUpdateSchema.parse({ alias: 'prod', fields: { Port: null, User: 'deploy' } })
    expect(update.fields['Port']).toBeNull()
    expect(update.fields['User']).toBe('deploy')
  })
})
