import { DEFAULT_SETTINGS, type HostInput, type HostLibrary, type HostRecord } from '@shared'
import { call } from '@renderer/platform/ipc'

/**
 * 页签的「主机来源」适配层。
 *
 * 为什么多这一层：页签条需要「选主机新建」和「快速连接」，而连接本身由 `features/terminal`
 * 负责（它才知道 xterm 尺寸与 transport）。页签条如果直接 import 终端模块就会形成环
 * （terminal → tabs 取 store，tabs → terminal 取连接），所以这里只定义**数据获取**接口，
 * 连接动作通过 `subscribeTabEvents` 的事件交给 terminal 侧，方向始终是 tabs ← terminal。
 *
 * 契约约束：`SshConnectRequest` 只能按 `hostId`（uuid）连接，没有「按地址连接」的通道。
 * 因此「快速连接」= 先 `hosts:create` 落一条主机记录，再按它返回的 id 开页签
 * （Termius 的 Quick Connect 不落库，要做到那一步必须先扩展 shared 契约，不在本任务范围）。
 */

export interface HostOption {
  id: string
  label: string
  hostname: string
  port: number
  username: string
  color: string | null
  groupName: string | null
}

export interface QuickConnectInput {
  hostname: string
  port: number
  username: string
  label?: string
}

export interface TabBackend {
  readonly kind: 'ipc' | 'mock'
  listHosts(): Promise<HostOption[]>
  /** 快速连接：建一条主机记录并返回可连接的主机；失败必须抛错（由 UI 展示原因） */
  createQuickHost(input: QuickConnectInput): Promise<HostOption>
}

/** 把 `hosts:list` 的库快照拍平成页签选择器要的扁平列表（纯函数，单测覆盖） */
export function toHostOptions(library: HostLibrary): HostOption[] {
  const groupNames = new Map(library.groups.map((group) => [group.id, group.name]))
  return [...library.hosts]
    .sort((left, right) => left.sortIndex - right.sortIndex || left.label.localeCompare(right.label))
    .map((host) => ({
      id: host.id,
      label: host.label,
      hostname: host.hostname,
      port: host.port,
      username: host.username,
      color: host.color,
      groupName: host.groupId ? groupNames.get(host.groupId) ?? null : null
    }))
}

export function toHostOption(record: HostRecord): HostOption {
  return {
    id: record.id,
    label: record.label,
    hostname: record.hostname,
    port: record.port,
    username: record.username,
    color: record.color,
    groupName: null
  }
}

/**
 * 快速连接 → `HostInput`。
 * 只填必要字段，其余走契约默认值；`credentialRef` 留空（密码走后端保存流程，绝不出现在这里）。
 */
export function buildQuickHostInput(input: QuickConnectInput): HostInput {
  const label = input.label?.trim() || `${input.username}@${input.hostname}`
  return {
    label,
    groupId: null,
    hostname: input.hostname.trim(),
    port: input.port,
    username: input.username.trim(),
    authMethod: 'password',
    privateKeyPath: null,
    credentialRef: null,
    jumpHostId: null,
    forwardAgent: false,
    keepaliveSeconds: DEFAULT_SETTINGS.ssh.keepaliveSeconds,
    terminalProfileId: null,
    startupCommand: null,
    env: {},
    tags: ['quick-connect'],
    color: null,
    portForwards: [],
    sshConfigOrigin: null
  }
}

export const ipcTabBackend: TabBackend = {
  kind: 'ipc',
  async listHosts() {
    const library = await call('hosts:list')
    return toHostOptions(library)
  },
  async createQuickHost(input) {
    const record = await call('hosts:create', { host: buildQuickHostInput(input) })
    return toHostOption(record)
  }
}

let activeBackend: TabBackend = ipcTabBackend

/** 测试/开发注入用（生产路径始终是 ipcTabBackend） */
export function registerTabBackend(backend: TabBackend): void {
  activeBackend = backend
}

export function resetTabBackend(): void {
  activeBackend = ipcTabBackend
}

export function getTabBackend(): TabBackend {
  return activeBackend
}
