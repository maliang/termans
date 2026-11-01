import type { AppInfo } from './models/app'
import type {
  AiChatRequest,
  AiConversation,
  AiListModelsRequest,
  AiListModelsResult,
  AiProvider,
  AiProviderInput,
  AiStreamDelta,
  AiStreamDone,
  AiStreamError
} from './models/ai'
import type { GroupInput, GroupRecord, HostInput, HostLibrary, HostRecord, HostSortUpdate } from './models/host'
import type { KnownHostEntry, KnownHostRemoveRequest, KnownHostTrustRequest } from './models/known-host'
import type { Settings, SettingsPatch } from './models/settings'
import type {
  SshConfigImportRequest,
  SshConfigImportResult,
  SshConfigParseRequest,
  SshConfigParseResult,
  SshConfigWriteRequest,
  SshConfigWriteResult
} from './models/ssh-config'
import type {
  HostKeyChallenge,
  HostKeyDecision,
  SshClosedEvent,
  SshConnectRequest,
  SshConnectResult,
  SshDataEvent,
  SshSession,
  SshStateEvent,
  TerminalSize
} from './models/terminal'
import type {
  SyncBootstrapRequest,
  SyncConflict,
  SyncResolveRequest,
  SyncStatus,
  VaultCreateResult,
  VaultLibraryCreateRequest,
  VaultLibraryMeta,
  VaultLibrarySwitchRequest,
  VaultRecoveryRequest,
  VaultRotateRequest,
  VaultStatus
} from './models/vault'
import type { ThemeDefinition } from './theme'

/**
 * ============================================================================
 * IPC 契约总表 —— 全项目唯一的通道清单。
 * ============================================================================
 *
 * 三条纪律（写在这里，是因为这里最容易被跨文件改动打破）：
 *
 * 1. **只走 `invoke`/事件，不用 `remote` 模块**。
 *    preload 暴露一个白名单桥（`window.termans`），通道名只能来自 IPC_CHANNELS。
 *    渲染层拿不到 ipcRenderer 本体，也就没有任意通道调用面。
 *
 * 2. **每个 invoke 都返回信封** `IpcResult<T>`（见 errors.ts），不靠 throw 传错误码。
 *    Electron 会把 handler 抛出的错误序列化成 "Error invoking remote method ..."，code 全丢。
 *
 * 3. **通道与契约必须一一对应**：文件底部的 `_AssertEveryChannelHasContract` /
 *    `_AssertNoOrphanContract` 两个类型断言在编译期强制这一点——
 *    加了通道忘记写类型，或写了类型忘加通道，`pnpm typecheck` 直接失败。
 *
 * 命名规范：`<domain>:<verb>`，域名 = app/settings/theme/hosts/groups/credentials/
 * ssh/ssh-config/known-hosts/vault/sync/ai；事件统一 `<domain>:<past-tense>`。
 */

export const IPC_CHANNELS = {
  app: {
    info: 'app:info',
    openExternal: 'app:open-external'
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
    reset: 'settings:reset'
  },
  theme: {
    list: 'theme:list',
    save: 'theme:save',
    delete: 'theme:delete'
  },
  hosts: {
    list: 'hosts:list',
    create: 'hosts:create',
    update: 'hosts:update',
    delete: 'hosts:delete',
    reorder: 'hosts:reorder'
  },
  groups: {
    create: 'groups:create',
    update: 'groups:update',
    delete: 'groups:delete'
  },
  credentials: {
    set: 'credentials:set',
    clear: 'credentials:clear'
  },
  ssh: {
    connect: 'ssh:connect',
    input: 'ssh:input',
    resize: 'ssh:resize',
    disconnect: 'ssh:disconnect',
    listSessions: 'ssh:list-sessions',
    answerHostKey: 'ssh:answer-host-key'
  },
  sshConfig: {
    defaultPaths: 'ssh-config:default-paths',
    parse: 'ssh-config:parse',
    write: 'ssh-config:write',
    import: 'ssh-config:import',
    export: 'ssh-config:export'
  },
  knownHosts: {
    list: 'known-hosts:list',
    trust: 'known-hosts:trust',
    remove: 'known-hosts:remove'
  },
  vault: {
    status: 'vault:status',
    create: 'vault:create',
    unlock: 'vault:unlock',
    lock: 'vault:lock',
    rotate: 'vault:rotate',
    recover: 'vault:recover',
    /** 多库（r3）：列表 / 新建 / 切换 —— 一次只活一个 manager，切库即换 VaultHub 当前库 */
    libraries: 'vault:libraries',
    libraryCreate: 'vault:library-create',
    librarySwitch: 'vault:library-switch'
  },
  sync: {
    status: 'sync:status',
    bootstrap: 'sync:bootstrap',
    pull: 'sync:pull',
    push: 'sync:push',
    conflicts: 'sync:conflicts',
    resolve: 'sync:resolve'
  },
  ai: {
    listProviders: 'ai:list-providers',
    saveProvider: 'ai:save-provider',
    deleteProvider: 'ai:delete-provider',
    setApiKey: 'ai:set-api-key',
    clearApiKey: 'ai:clear-api-key',
    testProvider: 'ai:test-provider',
    /** 读取供应商真实可用的模型列表（t53）：与「测试连接」同一条 GET /models */
    listModels: 'ai:list-models',
    chat: 'ai:chat',
    cancel: 'ai:cancel',
    listConversations: 'ai:list-conversations'
  }
} as const

type LeafValues<T> = { [K in keyof T]: T[K] extends string ? T[K] : LeafValues<T[K]> }[keyof T]

/** 所有 invoke 通道的联合类型（由 IPC_CHANNELS 推导，不要手写） */
export type IpcInvokeChannel = LeafValues<typeof IPC_CHANNELS>

/**
 * 运行时白名单（preload 用它决定哪些通道可以透传）。
 * 只支持两层结构：domain -> { verb: channel }，新增层级要同时改这个函数。
 */
export const IPC_INVOKE_CHANNELS: readonly IpcInvokeChannel[] = Object.values(IPC_CHANNELS).flatMap((group) =>
  Object.values(group as Record<string, string>)
) as IpcInvokeChannel[]

/* -------------------------------------------------------------------------- */
/* invoke 契约：通道 -> 请求/响应类型                                          */
/* -------------------------------------------------------------------------- */

export interface IpcInvokeContract {
  /* app */
  'app:info': { request: void; response: AppInfo }
  'app:open-external': { request: { url: string }; response: { opened: boolean } }

  /* settings */
  'settings:get': { request: void; response: Settings }
  'settings:update': { request: SettingsPatch; response: Settings }
  'settings:reset': { request: void; response: Settings }

  /* theme */
  'theme:list': { request: void; response: { themes: ThemeDefinition[] } }
  'theme:save': { request: { theme: ThemeDefinition }; response: { theme: ThemeDefinition } }
  'theme:delete': { request: { themeId: string }; response: void }

  /* hosts & groups */
  'hosts:list': { request: void; response: HostLibrary }
  'hosts:create': { request: { host: HostInput }; response: HostRecord }
  'hosts:update': { request: { hostId: string; patch: HostInput }; response: HostRecord }
  'hosts:delete': { request: { hostId: string }; response: void }
  'hosts:reorder': { request: HostSortUpdate; response: HostLibrary }
  'groups:create': { request: { group: GroupInput }; response: GroupRecord }
  'groups:update': { request: { groupId: string; patch: GroupInput }; response: GroupRecord }
  'groups:delete': { request: { groupId: string }; response: void }

  /* credentials（本机 SecretBox：safeStorage 优先，退化文件密钥。主机密码/passphrase 不在这里——它们随
     vault.enc 的 payload.secrets 同步；这里放 git:token 首次 clone 兜底与会话密钥。明文只进不出） */
  'credentials:set': { request: { reference: string; secret: string }; response: { reference: string } }
  'credentials:clear': { request: { reference: string }; response: void }

  /* ssh */
  'ssh:connect': { request: SshConnectRequest; response: SshConnectResult }
  'ssh:input': { request: { sessionId: string; data: string }; response: void }
  'ssh:resize': { request: { sessionId: string; size: TerminalSize }; response: void }
  'ssh:disconnect': { request: { sessionId: string }; response: void }
  'ssh:list-sessions': { request: void; response: { sessions: SshSession[] } }
  'ssh:answer-host-key': { request: HostKeyDecision; response: void }

  /* ssh_config 双向 */
  'ssh-config:default-paths': { request: void; response: { paths: string[] } }
  'ssh-config:parse': { request: SshConfigParseRequest; response: SshConfigParseResult }
  'ssh-config:write': { request: SshConfigWriteRequest; response: SshConfigWriteResult }
  'ssh-config:import': { request: SshConfigImportRequest; response: SshConfigImportResult }
  'ssh-config:export': { request: { path: string; aliases: string[] | null }; response: SshConfigWriteResult }

  /* known_hosts */
  'known-hosts:list': { request: void; response: { entries: KnownHostEntry[] } }
  'known-hosts:trust': { request: KnownHostTrustRequest; response: KnownHostEntry }
  'known-hosts:remove': { request: KnownHostRemoveRequest; response: void }

  /* vault（加密包） */
  'vault:status': { request: void; response: VaultStatus }
  'vault:create': { request: { passphrase: string }; response: VaultCreateResult }
  'vault:unlock': { request: { passphrase: string; rememberWithKeychain: boolean }; response: VaultStatus }
  'vault:lock': { request: void; response: VaultStatus }
  'vault:rotate': { request: VaultRotateRequest; response: VaultCreateResult }
  'vault:recover': { request: VaultRecoveryRequest; response: VaultStatus }
  /**
   * 多库（r3，AC-10..AC-14）。三条通道只做「列表 / 新建 / 切换」，切换后统一回 `VaultStatus`：
   * 渲染层的库徽标、诊断区、归因块都从同一份状态读，避免切库后各面板各拿一个副本。
   */
  'vault:libraries': { request: void; response: { libraries: VaultLibraryMeta[] } }
  'vault:library-create': { request: VaultLibraryCreateRequest; response: VaultCreateResult }
  'vault:library-switch': { request: VaultLibrarySwitchRequest; response: VaultStatus }

  /* sync（Git 同步） */
  'sync:status': { request: void; response: SyncStatus }
  'sync:bootstrap': { request: SyncBootstrapRequest; response: SyncStatus }
  'sync:pull': { request: void; response: SyncStatus }
  'sync:push': { request: void; response: SyncStatus }
  'sync:conflicts': { request: void; response: { conflicts: SyncConflict[] } }
  'sync:resolve': { request: SyncResolveRequest; response: SyncStatus }

  /* ai */
  'ai:list-providers': { request: void; response: { providers: AiProvider[] } }
  'ai:save-provider': { request: { provider: AiProviderInput }; response: AiProvider }
  'ai:delete-provider': { request: { providerId: string }; response: void }
  'ai:set-api-key': { request: { providerId: string; apiKey: string }; response: void }
  'ai:clear-api-key': { request: { providerId: string }; response: void }
  'ai:test-provider': { request: { providerId: string }; response: { ok: boolean; message: string } }
  /**
   * 读取供应商真实可用的模型列表（t53）。
   * 请求二选一：`{providerId}` 用已保存供应商（key 从 vault 取）；
   * `{draft}` 用编辑器里的未保存配置（key 明文只在这趟 IPC 里存在，绝不落盘）——AC-1。
   * 响应里 `error` 保留给人看的整句（向后兼容），`failure` 给结构化原因（AC-3）。
   */
  'ai:list-models': { request: AiListModelsRequest; response: AiListModelsResult }
  'ai:chat': { request: AiChatRequest; response: { requestId: string } }
  'ai:cancel': { request: { requestId: string }; response: void }
  'ai:list-conversations': { request: void; response: { conversations: AiConversation[] } }
}

export type IpcRequestOf<C extends IpcInvokeChannel> = IpcInvokeContract[C]['request']
export type IpcResponseOf<C extends IpcInvokeChannel> = IpcInvokeContract[C]['response']

/* -------------------------------------------------------------------------- */
/* 事件契约：main -> renderer 单向推送                                          */
/* -------------------------------------------------------------------------- */

export const IPC_EVENTS = {
  sshData: 'ssh:data',
  sshState: 'ssh:state-changed',
  sshClosed: 'ssh:closed',
  sshHostKeyChallenge: 'ssh:host-key-challenge',
  aiDelta: 'ai:stream-delta',
  aiDone: 'ai:stream-done',
  aiError: 'ai:stream-error',
  vaultState: 'vault:state-changed',
  syncStatus: 'sync:status-changed',
  settingsChanged: 'settings:changed',
  menuCommand: 'app:menu-command'
} as const

export type IpcEventName = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

/** 原生菜单 / 快捷键触发的命令，渲染层订阅后自己做路由 */
export type MenuCommand =
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'open-settings'
  | 'open-host-form'
  | 'import-ssh-config'
  | 'sync-now'
  | 'lock-vault'
  | 'toggle-ai-panel'
  | 'find-in-terminal'

export interface IpcEventMap {
  'ssh:data': SshDataEvent
  'ssh:state-changed': SshStateEvent
  'ssh:closed': SshClosedEvent
  'ssh:host-key-challenge': HostKeyChallenge
  'ai:stream-delta': AiStreamDelta
  'ai:stream-done': AiStreamDone
  'ai:stream-error': AiStreamError
  'vault:state-changed': VaultStatus
  'sync:status-changed': SyncStatus
  'settings:changed': Settings
  'app:menu-command': { command: MenuCommand }
}

/* -------------------------------------------------------------------------- */
/* 编译期完备性断言 —— 通道与契约必须互相覆盖                                  */
/* -------------------------------------------------------------------------- */

/** 只用来做「必须是 never」的断言：传入非 never 联合会在编译期报错 */
type ExpectNever<T extends never> = T

export type _AssertEveryChannelHasContract = ExpectNever<Exclude<IpcInvokeChannel, keyof IpcInvokeContract>>
export type _AssertNoOrphanContract = ExpectNever<Exclude<keyof IpcInvokeContract, IpcInvokeChannel>>
export type _AssertEveryEventHasPayload = ExpectNever<Exclude<IpcEventName, keyof IpcEventMap>>
export type _AssertNoOrphanEventPayload = ExpectNever<Exclude<keyof IpcEventMap, IpcEventName>>
