import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  aiCommandSuggestionSchema,
  aiListModelsRequestSchema,
  aiListModelsResultSchema,
  aiSettingsSchema,
  hostInputSchema,
  hostLibrarySchema,
  settingsPatchSchema,
  settingsSchema,
  sshConfigFieldUpdateSchema,
  terminalSizeSchema,
  unlockFailureClassSchema,
  vaultContentPolicySchema,
  vaultLibraryCreateRequestSchema,
  vaultLibraryMetaSchema,
  vaultLibrarySwitchRequestSchema,
  vaultStatusSchema,
  vaultUnlockFailureSchema,
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

describe('AI 思考强度与模型清单契约', () => {
  it('aiSettingsSchema 允许缺省 reasoningEffort 且拒绝非法值', () => {
    expect(DEFAULT_SETTINGS.ai.reasoningEffort).toBe('medium')
    // 旧配置文件里没有这个字段：只补它自己，其余字段照旧保留（不许整份回退成默认值）
    const merged = withDefaults({ ai: { enabled: true, contextLines: 321 } })
    expect(merged.ai.reasoningEffort).toBe('medium')
    expect(merged.ai.enabled).toBe(true)
    expect(merged.ai.contextLines).toBe(321)

    expect(aiSettingsSchema.partial().parse({ reasoningEffort: 'high' }).reasoningEffort).toBe('high')
    expect(() => aiSettingsSchema.parse({ ...DEFAULT_SETTINGS.ai, reasoningEffort: 'ultra' })).toThrow()
    // 设置补丁也必须认这一档（设置页改它走的就是 patch 通道）
    expect(settingsPatchSchema.parse({ ai: { reasoningEffort: 'low' } }).ai?.reasoningEffort).toBe('low')
  })

  it('aiListModelsRequestSchema 拒绝同时传 providerId 与 draft', () => {
    const draft = { kind: 'openai' as const, baseUrl: 'https://api.example.com/v1' }
    expect(aiListModelsRequestSchema.parse({ providerId: 'p1' })).toEqual({ providerId: 'p1' })
    expect(aiListModelsRequestSchema.parse({ draft })).toEqual({ draft })
    // 两个都传时无法判断该用谁的 key / baseUrl，必须在 IPC 边界就拒绝（strict 二选一）
    expect(() => aiListModelsRequestSchema.parse({ providerId: 'p1', draft })).toThrow()
    expect(() => aiListModelsRequestSchema.parse({})).toThrow()
    expect(() => aiListModelsRequestSchema.parse({ draft: { ...draft, bogus: 1 } })).toThrow()
  })

  it('aiListModelsResultSchema 允许 failure 为 null', () => {
    expect(aiListModelsResultSchema.parse({ models: ['gpt-4o'], error: null, failure: null }).failure).toBeNull()
    const failure = { kind: 'http' as const, status: 401, message: 'Invalid API key' }
    expect(aiListModelsResultSchema.parse({ models: [], error: 'x', failure }).failure).toEqual(failure)
    // kind 只认五种：UI 只为这五套文案准备了 i18n
    expect(() =>
      aiListModelsResultSchema.parse({ models: [], error: null, failure: { kind: 'unknown', status: null, message: '' } })
    ).toThrow()
  })
})

describe('加密包解锁归因与多库契约（r3）', () => {
  /** 一份形状合法的 VaultStatus：用来逐字段证明「五个新字段必填」 */
  const validStatus = {
    state: 'locked' as const,
    cipher: 'aes-256-gcm' as const,
    kdf: { name: 'scrypt' as const, N: 16384, r: 8, p: 1 },
    recoveryAvailable: true,
    keychainBacked: false,
    repo: null,
    policy: { secretsExcluded: true as const, privateKeysExcluded: true as const, plaintextHostnamesInRepo: false as const },
    itemCounts: null,
    createdAt: '2026-11-01T09:00:00.000Z',
    lastUnlockedAt: null,
    lastSyncedAt: null,
    revision: 3,
    slotFingerprint: 'a1b2c3d4',
    libraries: [{ id: 'default', name: null, createdAt: '2026-11-01T09:00:00.000Z', lastUnlockedAt: null, isCurrent: true }],
    unlockFailure: { class: 'bad-passphrase' as const },
    variantNotice: null
  }

  it('四分类只认四个词（渲染层靠 class 归因，不靠 reason 反推）', () => {
    for (const cls of ['bad-passphrase', 'throttled', 'slot-record-mismatch', 'corrupt']) {
      expect(unlockFailureClassSchema.parse(cls)).toBe(cls)
    }
    // 词表外的任何值都必须拒绝：多一个词就等于多一套没人写文案的失败态
    expect(() => unlockFailureClassSchema.parse('password-wrong')).toThrow()
    expect(() => unlockFailureClassSchema.parse('')).toThrow()
    expect(unlockFailureClassSchema.options).toHaveLength(4)
  })

  it('retryAfterSeconds 只在 throttled 有意义，且必须是整秒非负', () => {
    expect(vaultUnlockFailureSchema.parse({ class: 'throttled', retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30)
    // 非限流失败不带倒计时（UI 那行 mono 倒计时只在 throttled 出现）
    expect(vaultUnlockFailureSchema.parse({ class: 'bad-passphrase' }).retryAfterSeconds).toBeUndefined()
    expect(() => vaultUnlockFailureSchema.parse({ class: 'throttled', retryAfterSeconds: -1 })).toThrow()
    expect(() => vaultUnlockFailureSchema.parse({ class: 'throttled', retryAfterSeconds: 1.5 })).toThrow()
  })

  it('库列表条目：name 可空、isCurrent 必填，且不携带任何路径', () => {
    const meta = vaultLibraryMetaSchema.parse({
      id: 'lib-1',
      name: null,
      createdAt: null,
      lastUnlockedAt: '2026-11-01T09:00:00.000Z',
      isCurrent: false,
      // 主进程就算手滑把路径塞进来，契约层也必须把它剔掉（扩香不出去：路径=用户名泄露）
      repoDir: '/Users/me/Library/Application Support/termans/vaults/lib-1/repo'
    }) as Record<string, unknown>
    expect('repoDir' in meta).toBe(false)
    expect(meta.name).toBeNull()
    expect(() => vaultLibraryMetaSchema.parse({ id: 'lib-1', name: null, createdAt: null, lastUnlockedAt: null })).toThrow()
  })

  it('新建/切换库请求是 strict：多一个字段就拒（AC-14 判重前应先过契约）', () => {
    expect(vaultLibraryCreateRequestSchema.parse({ name: '工作库', rememberWithKeychain: false })).toEqual({
      name: '工作库',
      rememberWithKeychain: false
    })
    expect(() => vaultLibraryCreateRequestSchema.parse({ name: '', rememberWithKeychain: false })).toThrow()
    expect(() => vaultLibraryCreateRequestSchema.parse({ name: 'x'.repeat(65), rememberWithKeychain: false })).toThrow()
    expect(() => vaultLibraryCreateRequestSchema.parse({ name: '工作库' })).toThrow()
    expect(() => vaultLibraryCreateRequestSchema.parse({ name: '工作库', rememberWithKeychain: false, path: '/tmp/x' })).toThrow()
    expect(vaultLibrarySwitchRequestSchema.parse({ id: 'default' }).id).toBe('default')
    expect(() => vaultLibrarySwitchRequestSchema.parse({})).toThrow()
    expect(() => vaultLibrarySwitchRequestSchema.parse({ id: 'default', force: true })).toThrow()
  })

  it('VaultStatus 的五个新字段都是必填（漏一个就等于诊断区少一项证据）', () => {
    const parsed = vaultStatusSchema.parse(validStatus)
    expect(parsed.revision).toBe(3)
    expect(parsed.slotFingerprint).toBe('a1b2c3d4')
    expect(parsed.libraries).toHaveLength(1)
    expect(parsed.unlockFailure?.class).toBe('bad-passphrase')
    expect(parsed.variantNotice).toBeNull()

    for (const key of ['revision', 'slotFingerprint', 'libraries', 'unlockFailure', 'variantNotice']) {
      const without = { ...validStatus } as Record<string, unknown>
      delete without[key]
      expect(() => vaultStatusSchema.parse(without), `缺 ${key} 必须判不合格`).toThrow()
    }
  })

  it('slotFingerprint 只认 8 位小写 hex；无记录用 null（不填 0、不填当前时间）', () => {
    expect(vaultStatusSchema.parse({ ...validStatus, slotFingerprint: null }).slotFingerprint).toBeNull()
    expect(() => vaultStatusSchema.parse({ ...validStatus, slotFingerprint: 'A1B2C3D4' })).toThrow()
    expect(() => vaultStatusSchema.parse({ ...validStatus, slotFingerprint: 'a1b2c3d' })).toThrow()
    expect(() => vaultStatusSchema.parse({ ...validStatus, slotFingerprint: 'a1b2c3d4e5' })).toThrow()
    expect(() => vaultStatusSchema.parse({ ...validStatus, slotFingerprint: 0 })).toThrow()
  })

  it('AC-7 告知条只认三种受控变体，且必须带时间戳', () => {
    for (const variant of ['nfkc', 'trim', 'strip-zero-width'] as const) {
      const notice = vaultStatusSchema.parse({
        ...validStatus,
        variantNotice: { variant, at: '2026-11-01T09:00:00.000Z' }
      }).variantNotice
      expect(notice?.variant).toBe(variant)
    }
    expect(() => vaultStatusSchema.parse({ ...validStatus, variantNotice: { variant: 'latin', at: '2026-11-01T09:00:00.000Z' } })).toThrow()
    expect(() => vaultStatusSchema.parse({ ...validStatus, variantNotice: { variant: 'nfkc' } })).toThrow()
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
