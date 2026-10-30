import { z } from 'zod'
import { LOCALES } from '../i18n'
import { knownHostsPolicySchema } from './known-host'
import { conflictStrategySchema } from './vault'

/**
 * 应用设置契约。
 *
 * 设置只存「可同步的偏好」：不含任何密钥/密码/指纹内容（主机密码与 AI key 在 vault.enc 密文包里；
 * 本机 SecretBox 只放会话密钥与 git:token 兜底）。
 * 所有字段都必须有 DEFAULT_SETTINGS 兜底，渲染层读设置永远不用做 undefined 判断。
 * 新增字段流程：加 schema → 加 default → 旧配置文件靠 `settings:migrate` 补默认值（缺失即补）。
 */

export const localeSchema = z.enum(LOCALES)
export type LocaleCode = z.infer<typeof localeSchema>

export const terminalSettingsSchema = z.object({
  fontFamily: z.string().min(1),
  fontSize: z.number().int().min(8).max(40),
  lineHeight: z.number().min(0.8).max(2.5),
  cursorStyle: z.enum(['block', 'underline', 'bar']),
  cursorBlink: z.boolean(),
  scrollback: z.number().int().min(100).max(200_000),
  copyOnSelect: z.boolean(),
  /** 终端响铃：none 静音、visual 闪烁、sound 蜂鸣 */
  bellStyle: z.enum(['none', 'visual', 'sound'])
})
export type TerminalSettings = z.infer<typeof terminalSettingsSchema>

export const sshSettingsSchema = z.object({
  defaultPort: z.number().int().min(1).max(65_535),
  connectTimeoutMs: z.number().int().min(1_000).max(120_000),
  keepaliveSeconds: z.number().int().min(0).max(3_600),
  knownHostsPolicy: knownHostsPolicySchema,
  /** 断线后自动重连次数（0 = 不自动重连） */
  autoReconnectAttempts: z.number().int().min(0).max(10)
})
export type SshSettings = z.infer<typeof sshSettingsSchema>

export const syncSettingsSchema = z.object({
  enabled: z.boolean(),
  autoSync: z.boolean(),
  intervalSeconds: z.number().int().min(30).max(3_600),
  defaultConflictStrategy: conflictStrategySchema
})
export type SyncSettings = z.infer<typeof syncSettingsSchema>

export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  /** 是否把终端最近输出作为上下文发送给供应商（默认关，用户显式开启） */
  autoContext: z.boolean(),
  /** 注入终端上下文的行数上限 500；默认值见 DEFAULT_SETTINGS.ai.contextLines（200，与上下文模块默认一致） */
  contextLines: z.number().int().min(0).max(500),
  defaultProviderId: z.string().nullable(),
  /** 硬约束：AI 产出的命令必须二次确认后才写入终端，不可配置为 false */
  commandConfirmation: z.literal(true)
})
export type AiSettings = z.infer<typeof aiSettingsSchema>

export const securitySettingsSchema = z.object({
  /** 闲置多少分钟后自动锁定加密包；0 = 不自动锁 */
  autoLockMinutes: z.number().int().min(0).max(240),
  /** 窗口失焦即锁定（共享屏幕/会议场景用） */
  lockOnBlur: z.boolean(),
  /** 启动时必须输入主口令（不走 keychain 快速解锁） */
  requirePassphraseOnLaunch: z.boolean(),
  /** 复制到剪贴板多少秒后清空；0 = 不清 */
  clipboardClearSeconds: z.number().int().min(0).max(300)
})
export type SecuritySettings = z.infer<typeof securitySettingsSchema>

export const uiSettingsSchema = z.object({
  sidebarWidth: z.number().int().min(180).max(560),
  aiPanelWidth: z.number().int().min(240).max(720),
  aiPanelVisible: z.boolean(),
  showHostTree: z.boolean(),
  /** 关闭有活动连接的页签时二次确认 */
  confirmOnCloseTab: z.boolean(),
  /**
   * 「未分组」这一栏的显示名。null = 用 i18n 的默认文案。
   * 「未分组」是虚拟分组（= `groupId === null` 的主机），没有自己的记录，
   * 所以改名只影响显示，不写进主机库、也不影响同步语义。
   */
  ungroupedLabel: z.string().trim().min(1).max(40).nullable().default(null)
})
export type UiSettings = z.infer<typeof uiSettingsSchema>

export const settingsSchema = z.object({
  locale: localeSchema,
  /** 主题 id；必须存在于 theme:list（内置 termans-dark / termans-light 恒存在） */
  themeId: z.string().min(1),
  terminal: terminalSettingsSchema,
  ssh: sshSettingsSchema,
  sync: syncSettingsSchema,
  ai: aiSettingsSchema,
  security: securitySettingsSchema,
  ui: uiSettingsSchema
})
export type Settings = z.infer<typeof settingsSchema>

/** 局部更新：每个 section 可只给要改的字段 */
export const settingsPatchSchema = z
  .object({
    locale: localeSchema.optional(),
    themeId: z.string().min(1).optional(),
    terminal: terminalSettingsSchema.partial().strict().optional(),
    ssh: sshSettingsSchema.partial().strict().optional(),
    sync: syncSettingsSchema.partial().strict().optional(),
    ai: aiSettingsSchema.partial().strict().optional(),
    security: securitySettingsSchema.partial().strict().optional(),
    ui: uiSettingsSchema.partial().strict().optional()
  })
  .strict()
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export const DEFAULT_SETTINGS: Settings = {
  locale: 'en',
  themeId: 'termans-dark',
  terminal: {
    fontFamily: 'var(--ts-font-mono)',
    fontSize: 13,
    lineHeight: 1.25,
    cursorStyle: 'bar',
    cursorBlink: true,
    scrollback: 10_000,
    copyOnSelect: false,
    bellStyle: 'none'
  },
  ssh: {
    defaultPort: 22,
    connectTimeoutMs: 15_000,
    keepaliveSeconds: 30,
    knownHostsPolicy: 'strict',
    autoReconnectAttempts: 0
  },
  sync: {
    enabled: false,
    autoSync: false,
    intervalSeconds: 300,
    defaultConflictStrategy: 'duplicate'
  },
  ai: {
    enabled: false,
    autoContext: false,
    contextLines: 200,
    defaultProviderId: null,
    commandConfirmation: true
  },
  security: {
    autoLockMinutes: 15,
    lockOnBlur: false,
    requirePassphraseOnLaunch: false,
    clipboardClearSeconds: 0
  },
  ui: {
    sidebarWidth: 264,
    aiPanelWidth: 360,
    aiPanelVisible: false,
    showHostTree: true,
    confirmOnCloseTab: true,
    ungroupedLabel: null
  }
}

/** 把任意（可能残缺/过期的）配置对象补成完整 Settings，用于读取旧配置文件 */
/** 单字段校验：一个坏字段只回退它自己，不要把整份设置打回默认值 */
function pickSection<S extends z.ZodObject<z.ZodRawShape>>(schema: S, value: unknown): Partial<z.infer<S>> {
  const result = schema.partial().safeParse(value ?? {})
  return (result.success ? result.data : {}) as Partial<z.infer<S>>
}

export function withDefaults(raw: unknown): Settings {
  const candidate = (raw ?? {}) as Record<string, unknown>
  const locale = localeSchema.safeParse(candidate['locale'])
  const themeId = candidate['themeId']
  return {
    locale: locale.success ? locale.data : DEFAULT_SETTINGS.locale,
    themeId: typeof themeId === 'string' && themeId.length > 0 ? themeId : DEFAULT_SETTINGS.themeId,
    terminal: { ...DEFAULT_SETTINGS.terminal, ...pickSection(terminalSettingsSchema, candidate['terminal']) },
    ssh: { ...DEFAULT_SETTINGS.ssh, ...pickSection(sshSettingsSchema, candidate['ssh']) },
    sync: { ...DEFAULT_SETTINGS.sync, ...pickSection(syncSettingsSchema, candidate['sync']) },
    ai: { ...DEFAULT_SETTINGS.ai, ...pickSection(aiSettingsSchema, candidate['ai']) },
    security: { ...DEFAULT_SETTINGS.security, ...pickSection(securitySettingsSchema, candidate['security']) },
    ui: { ...DEFAULT_SETTINGS.ui, ...pickSection(uiSettingsSchema, candidate['ui']) }
  }
}
