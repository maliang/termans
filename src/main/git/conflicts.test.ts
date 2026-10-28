import { describe, expect, it } from 'vitest'
import type { SyncConflict } from '@shared'
import { emptyPayload, type VaultPayload } from '../vault/model'
import { createMemorySecretBox } from '../vault/secret-box'
import type { HostRecord } from '@shared'
import {
  applyStrategy,
  clearConflictState,
  loadConflictState,
  mergePayloads,
  readPath,
  saveConflictState,
  writePath,
  type MergeConflict
} from './conflicts'

const NOW = '2026-01-01T00:00:00.000Z'
const HOST_A = '11111111-1111-4111-8111-111111111111'
const HOST_B = '22222222-2222-4222-8222-222222222222'

function host(id: string, patch: Partial<HostRecord> = {}): HostRecord {
  return {
    id,
    label: 'web',
    groupId: null,
    hostname: '10.20.30.40',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    privateKeyPath: null,
    credentialRef: 'ref-web',
    jumpHostId: null,
    forwardAgent: false,
    keepaliveSeconds: 30,
    terminalProfileId: null,
    startupCommand: null,
    env: {},
    tags: [],
    color: null,
    portForwards: [],
    sshConfigOrigin: null,
    sortIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch
  }
}

function base(): VaultPayload {
  const payload = emptyPayload(NOW)
  payload.hosts = [host(HOST_A)]
  return payload
}

describe('三方合并：不静默覆盖', () => {
  it('不同字段的改动自动合并（本地一个字段、远端另一个字段）', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.hosts[0]!.port = 2222
    remote.hosts[0]!.hostname = '10.20.30.41'
    const result = mergePayloads(b, local, remote)
    expect(result.conflicts).toHaveLength(0)
    expect(result.merged.hosts[0]).toMatchObject({ port: 2222, hostname: '10.20.30.41' })
    expect(result.autoApplied).toBeGreaterThan(0)
  })

  it('同一字段两边都改 → 产出该字段的冲突，merged 里不替用户选（保留本地值，等策略）', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.hosts[0]!.port = 2222
    remote.hosts[0]!.port = 2200
    const result = mergePayloads(b, local, remote)
    expect(result.conflicts).toHaveLength(1)
    const conflict = result.conflicts[0] as MergeConflict
    expect(conflict.path).toBe(`hosts.${HOST_A}.port`)
    expect(conflict.kind).toBe('host')
    expect(conflict.localValue).toBe(2222)
    expect(conflict.remoteValue).toBe(2200)
    expect(conflict.id).toMatch(/^[0-9a-f]{24}$/)
    expect(conflict.localSummary).toContain('2222')
  })

  it('两边都改 updatedAt 不产生冲突（元数据不该让用户选），取较新的一份', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.hosts[0]!.port = 2222
    local.hosts[0]!.updatedAt = '2026-02-01T00:00:00.000Z'
    remote.hosts[0]!.hostname = '10.9.9.9'
    remote.hosts[0]!.updatedAt = '2026-03-01T00:00:00.000Z'
    const result = mergePayloads(b, local, remote)
    expect(result.conflicts.map((conflict) => conflict.path)).not.toContain(`hosts.${HOST_A}.updatedAt`)
    expect(result.merged.hosts[0]?.updatedAt).toBe('2026-03-01T00:00:00.000Z')
  })

  it('一边删除、另一边修改 → presence 冲突（路径是实体本身）', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.hosts = []
    remote.hosts[0]!.username = 'root'
    const result = mergePayloads(b, local, remote)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.path).toBe(`hosts.${HOST_A}`)
    expect(result.conflicts[0]?.localSummary).toBe('∅')
  })

  it('密码冲突的摘要必须打码，冲突对象里绝不能出现密码原文', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.secrets['ref-web'] = { password: 'local-secret', passphrase: null, updatedAt: NOW }
    remote.secrets['ref-web'] = { password: 'remote-secret', passphrase: null, updatedAt: NOW }
    b.secrets['ref-web'] = { password: 'base-secret', passphrase: null, updatedAt: NOW }
    const result = mergePayloads(b, local, remote)
    const paths = result.conflicts.map((conflict) => conflict.path)
    expect(paths).toContain('secrets.ref-web.password')
    // 摘要必须打码
    const secretConflict = result.conflicts.find((conflict) => conflict.path === 'secrets.ref-web.password')
    expect(secretConflict?.remoteSummary).toMatch(/[•—]/)
    expect(secretConflict?.localSummary).toMatch(/[•—]/)
    // 渲染层拿到的视图（SyncConflict）里绝不能有密码原文
    const view: SyncConflict[] = result.conflicts.map((conflict) => ({
      id: conflict.id,
      kind: conflict.kind,
      entityId: conflict.entityId,
      label: conflict.label,
      path: conflict.path,
      localUpdatedAt: conflict.localUpdatedAt,
      remoteUpdatedAt: conflict.remoteUpdatedAt,
      localSummary: conflict.localSummary,
      remoteSummary: conflict.remoteSummary
    }))
    const serialized = JSON.stringify(view)
    expect(serialized).not.toContain('local-secret')
    expect(serialized).not.toContain('remote-secret')
    expect(serialized).not.toContain('base-secret')
  })

  it('settings 与 ssh_config 逐键合并；ssh_config.text 整体一格（不做行级合并）', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.settings.security.autoLockMinutes = 5
    remote.settings.terminal.fontSize = 15
    local.sshConfig.text = 'Host a\n    User u\n'
    remote.sshConfig.text = 'Host a\n    User root\n'
    const result = mergePayloads(b, local, remote)
    expect(result.merged.settings.security.autoLockMinutes).toBe(5)
    expect(result.merged.settings.terminal.fontSize).toBe(15)
    const sshConflicts = result.conflicts.filter((conflict) => conflict.path === 'sshConfig.text')
    expect(sshConflicts).toHaveLength(1)
    expect(sshConflicts[0]?.localSummary).toContain('lines')
  })

  it('只在远端新增的实体自动落地；只在本地新增的也保留（并集）', () => {
    const b = base()
    const local = structuredClone(b)
    const remote = structuredClone(b)
    local.hosts.push(host(HOST_B, { label: 'local-only', sortIndex: 1 }))
    const remoteHost = '33333333-3333-4333-8333-333333333333'
    remote.hosts.push(host(remoteHost, { label: 'remote-only', sortIndex: 1 }))
    const result = mergePayloads(b, local, remote)
    expect(result.conflicts).toHaveLength(0)
    expect(result.merged.hosts.map((item) => item.label).sort()).toEqual(['local-only', 'remote-only', 'web'])
  })

  it('没有 base 时无法判断谁改过 → 字段不一致必须产出冲突（宁可问一次，也不静默覆盖）', () => {
    const local = base()
    const remote = structuredClone(local)
    remote.hosts[0]!.port = 2222
    const result = mergePayloads(null, local, remote)
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([`hosts.${HOST_A}.port`])
    // 冲突未解决前 merged 保留本地值，等用户选边
    expect(result.merged.hosts[0]?.port).toBe(22)
  })

  it('没有 base 且只有一边有该实体 → 视为新增，不打扰用户', () => {
    const local = base()
    const remote = structuredClone(local)
    remote.hosts.push(host(HOST_B, { label: 'remote-only', sortIndex: 1 }))
    const result = mergePayloads(null, local, remote)
    expect(result.conflicts).toHaveLength(0)
    expect(result.merged.hosts.map((item) => item.label).sort()).toEqual(['remote-only', 'web'])
  })
})

describe('冲突解决策略', () => {
  function conflictOf(local: VaultPayload, remote: VaultPayload): { merged: VaultPayload; conflict: MergeConflict } {
    const result = mergePayloads(base(), local, remote)
    return { merged: result.merged, conflict: result.conflicts[0]! }
  }

  function bothEdited(): { local: VaultPayload; remote: VaultPayload } {
    const local = base()
    const remote = base()
    local.hosts[0]!.port = 2222
    remote.hosts[0]!.port = 2200
    return { local, remote }
  }

  it('keep local / keep remote 写回对应值', () => {
    const { local, remote } = bothEdited()
    const a = conflictOf(local, remote)
    applyStrategy(a.merged, a.conflict, 'local')
    expect(a.merged.hosts[0]?.port).toBe(2222)

    const b = conflictOf(local, remote)
    applyStrategy(b.merged, b.conflict, 'remote')
    expect(b.merged.hosts[0]?.port).toBe(2200)
  })

  it('keep both：复制成本地新实体（新 uuid + label 加 (copy)），本字段取远端', () => {
    const { local, remote } = bothEdited()
    const { merged, conflict } = conflictOf(local, remote)
    applyStrategy(merged, conflict, 'duplicate')
    expect(merged.hosts).toHaveLength(2)
    const original = merged.hosts.find((item) => item.id === HOST_A)
    const copy = merged.hosts.find((item) => item.id !== HOST_A)
    expect(original?.port).toBe(2200)
    expect(copy?.port).toBe(2222)
    expect(copy?.label).toContain('(copy)')
    expect(copy?.id).not.toBe(HOST_A)
  })

  it('删除 vs 修改：keep local 删掉，keep remote 保留远端版本', () => {
    const b = base()
    const local = structuredClone(b)
    local.hosts = []
    const remote = structuredClone(b)
    remote.hosts[0]!.username = 'root'
    const result = mergePayloads(b, local, remote)
    const conflict = result.conflicts[0] as MergeConflict
    const merged = structuredClone(result.merged)
    applyStrategy(merged, conflict, 'local')
    expect(merged.hosts).toHaveLength(0)
  })
})

describe('冲突快照持久化', () => {
  it('saveConflictState/loadConflictState 往返（密文落盘），clear 后读不到', () => {
    const box = createMemorySecretBox()
    const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'termans-conf-'))
    const local = base()
    const remote = base()
    local.hosts[0]!.port = 2222
    remote.hosts[0]!.port = 2200
    const result = mergePayloads(base(), local, remote)
    const state = {
      version: 1 as const,
      createdAt: NOW,
      localCommit: 'aaa',
      remoteCommit: 'bbb',
      baseAvailable: true,
      merged: result.merged,
      conflicts: result.conflicts as MergeConflict[]
    }
    saveConflictState(dir, box, state)
    const loaded = loadConflictState(dir, box)
    expect(loaded?.conflicts.map((conflict) => conflict.path)).toEqual([`hosts.${HOST_A}.port`])
    expect(loaded?.merged.hosts[0]?.port).toBe(2222)
    clearConflictState(dir)
    expect(loadConflictState(dir, box)).toBeNull()
    require('node:fs').rmSync(dir, { recursive: true, force: true })
  })
})

describe('readPath / writePath', () => {
  it('settings 段与 sshConfig.text 可读写；实体 presence 用 null', () => {
    const payload = base()
    expect(readPath(payload, 'settings.security.autoLockMinutes')).toBe(15)
    writePath(payload, 'settings.security.autoLockMinutes', 30)
    expect(payload.settings.security.autoLockMinutes).toBe(30)

    expect(readPath(payload, 'sshConfig.text')).toBe('')
    writePath(payload, 'sshConfig.text', 'Host x\n')
    expect(payload.sshConfig.text).toBe('Host x\n')

    expect(readPath(payload, `hosts.${HOST_A}`)).toMatchObject({ id: HOST_A })
    writePath(payload, `hosts.${HOST_A}`, null)
    expect(payload.hosts).toHaveLength(0)
  })

  it('未知路径读出 null、写入被忽略（不炸在前端展示路径上）', () => {
    const payload = base()
    expect(readPath(payload, 'nope.whatever')).toBeNull()
    expect(() => writePath(payload, 'nope.whatever', 1)).not.toThrow()
  })
})

describe('SyncConflict 视图字段（渲染层契约）', () => {
  it('冲突条目自带 kind/entityId/label/path/时间戳，可直接喂给 UI', () => {
    const local = base()
    const remote = base()
    local.hosts[0]!.port = 2222
    remote.hosts[0]!.port = 2200
    const conflict = mergePayloads(base(), local, remote).conflicts[0]!
    const view: SyncConflict = {
      id: conflict.id,
      kind: conflict.kind,
      entityId: conflict.entityId,
      label: conflict.label,
      path: conflict.path,
      localUpdatedAt: conflict.localUpdatedAt,
      remoteUpdatedAt: conflict.remoteUpdatedAt,
      localSummary: conflict.localSummary,
      remoteSummary: conflict.remoteSummary
    }
    expect(view.kind).toBe('host')
    expect(view.label).toContain('web')
    expect(view.localUpdatedAt).toBe(NOW)
  })
})
