import { describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import {
  assertHostReferences,
  clearSecret,
  createGroupRecord,
  createHostRecord,
  deleteGroupRecord,
  deleteHostRecord,
  deleteSnippet,
  getSecret,
  listKnownHosts,
  pruneOrphanSecrets,
  removeKnownHost,
  reorderHosts,
  setSecret,
  trustKnownHost,
  updateGroupRecord,
  updateHostRecord,
  upsertSnippet
} from './library'
import { groupInput, hostInput, payload } from './test-fixtures'

const NOW = '2026-01-01T00:00:00.000Z'

function codeOf(fn: () => unknown): { code: string; details?: Record<string, unknown> } {
  try {
    fn()
  } catch (error) {
    const ipc = error as IpcCallError
    return { code: ipc.code, details: ipc.details as Record<string, unknown> | undefined }
  }
  throw new Error('expected an IpcCallError')
}

describe('主机库：主机', () => {
  it('创建时按分组分配 sortIndex，分组内递增', () => {
    const data = payload()
    const group = createGroupRecord(data, groupInput(), NOW)
    const a = createHostRecord(data, hostInput({ groupId: group.id }), NOW)
    const b = createHostRecord(data, hostInput({ groupId: group.id, label: 'second' }), NOW)
    const ungrouped = createHostRecord(data, hostInput({ label: 'ungrouped' }), NOW)
    expect(a.sortIndex).toBe(0)
    expect(b.sortIndex).toBe(1)
    expect(ungrouped.sortIndex).toBe(0)
  })

  it('换分组会重算 sortIndex，并保留 id/createdAt', () => {
    const data = payload()
    const group = createGroupRecord(data, groupInput(), NOW)
    const created = createHostRecord(data, hostInput(), NOW)
    const moved = updateHostRecord(data, created.id, hostInput({ groupId: group.id, label: 'renamed' }), '2026-02-02T00:00:00.000Z')
    expect(moved.id).toBe(created.id)
    expect(moved.createdAt).toBe(NOW)
    expect(moved.updatedAt).toBe('2026-02-02T00:00:00.000Z')
    expect(moved.sortIndex).toBe(0)
  })

  it('不存在的 groupId / 自己跳自己 / 跳板机不存在 / 跳板链成环 全部拒绝', () => {
    const data = payload()
    const missingGroup = 'a0000000-0000-4000-8000-00000000000f'
    expect(codeOf(() => createHostRecord(data, hostInput({ groupId: missingGroup }), NOW)).code).toBe('E_INVALID_ARGUMENT')

    const jump = createHostRecord(data, hostInput({ label: 'jump' }), NOW)
    const missingJump = 'a0000000-0000-4000-8000-00000000000e'
    expect(codeOf(() => createHostRecord(data, hostInput({ jumpHostId: missingJump }), NOW)).code).toBe('E_INVALID_ARGUMENT')

    const behind = createHostRecord(data, hostInput({ label: 'behind', jumpHostId: jump.id }), NOW)
    expect(codeOf(() => updateHostRecord(data, jump.id, hostInput({ label: 'jump', jumpHostId: jump.id }), NOW)).code).toBe(
      'E_INVALID_ARGUMENT'
    )
    // jump → behind → jump 成环
    const cycle = codeOf(() => updateHostRecord(data, jump.id, hostInput({ label: 'jump', jumpHostId: behind.id }), NOW))
    expect(cycle.code).toBe('E_INVALID_ARGUMENT')
    expect(cycle.details?.field).toBe('jumpHostId')
  })

  it('删除主机：引用它的跳板关系断开、ssh_config 映射清掉、孤儿凭据被回收', () => {
    const data = payload()
    const jump = createHostRecord(data, hostInput({ label: 'jump', credentialRef: 'ref-jump' }), NOW)
    setSecret(data, 'ref-jump', { password: 'jump-pw' }, NOW)
    createHostRecord(data, hostInput({ label: 'behind', jumpHostId: jump.id }), NOW)
    data.sshConfig.aliasMap = { 'jump-alias': jump.id, 'other-alias': 'someone-else' }

    deleteHostRecord(data, jump.id)

    expect(data.hosts).toHaveLength(1)
    expect(data.hosts[0]?.jumpHostId).toBeNull()
    expect(data.sshConfig.aliasMap).toEqual({ 'other-alias': 'someone-else' })
    expect(getSecret(data, 'ref-jump')).toBeNull()
    expect(codeOf(() => deleteHostRecord(data, jump.id)).code).toBe('E_NOT_FOUND')
  })

  it('reorderHosts 改写 sortIndex/分组并返回新排序', () => {
    const data = payload()
    const a = createHostRecord(data, hostInput({ label: 'a' }), NOW)
    const b = createHostRecord(data, hostInput({ label: 'b' }), NOW)
    const library = reorderHosts(data, [
      { id: a.id, sortIndex: 1, groupId: null },
      { id: b.id, sortIndex: 0, groupId: null }
    ])
    expect(library.hosts.map((host) => host.label)).toEqual(['b', 'a'])
  })

  it('assertHostReferences 可单独用于「导入前的预检」', () => {
    const data = payload()
    expect(() => assertHostReferences(data, hostInput())).not.toThrow()
  })
})

describe('主机库：分组', () => {
  it('删组把子组挂到被删组的父级，组内主机升到根', () => {
    const data = payload()
    const top = createGroupRecord(data, groupInput({ name: 'top' }), NOW)
    const child = createGroupRecord(data, groupInput({ name: 'child', parentId: top.id }), NOW)
    const host = createHostRecord(data, hostInput({ groupId: top.id }), NOW)

    deleteGroupRecord(data, top.id)

    expect(data.groups.find((group) => group.id === child.id)?.parentId).toBeNull()
    expect(data.hosts.find((item) => item.id === host.id)?.groupId).toBeNull()
  })

  it('分组不能自引用，parent 必须存在，父子链不能成环', () => {
    const data = payload()
    const a = createGroupRecord(data, groupInput({ name: 'a' }), NOW)
    const b = createGroupRecord(data, groupInput({ name: 'b', parentId: a.id }), NOW)
    expect(codeOf(() => updateGroupRecord(data, a.id, groupInput({ name: 'a', parentId: a.id }), NOW)).code).toBe(
      'E_INVALID_ARGUMENT'
    )
    expect(codeOf(() => updateGroupRecord(data, a.id, groupInput({ name: 'a', parentId: b.id }), NOW)).code).toBe(
      'E_INVALID_ARGUMENT'
    )
    expect(
      codeOf(() => createGroupRecord(data, groupInput({ name: 'x', parentId: 'a0000000-0000-4000-8000-00000000000d' }), NOW)).code
    ).toBe('E_INVALID_ARGUMENT')
  })
})

describe('主机库：凭据条目', () => {
  it('setSecret 合并字段，两字段都清空则删除条目', () => {
    const data = payload()
    setSecret(data, 'ref-1', { password: 'pw' }, NOW)
    setSecret(data, 'ref-1', { passphrase: 'pp' }, NOW)
    expect(getSecret(data, 'ref-1')).toMatchObject({ password: 'pw', passphrase: 'pp' })
    setSecret(data, 'ref-1', { password: null, passphrase: null }, NOW)
    expect(getSecret(data, 'ref-1')).toBeNull()
  })

  it('pruneOrphanSecrets 只保留被主机引用的条目', () => {
    const data = payload()
    createHostRecord(data, hostInput({ credentialRef: 'kept' }), NOW)
    setSecret(data, 'kept', { password: 'x' }, NOW)
    setSecret(data, 'orphan', { password: 'y' }, NOW)
    expect(pruneOrphanSecrets(data)).toEqual(['orphan'])
    expect(clearSecret(data, 'kept')).toBeUndefined()
    expect(getSecret(data, 'kept')).toBeNull()
  })
})

describe('主机库：known_hosts（中间人防护）', () => {
  const request = {
    host: '10.20.30.40',
    port: 22,
    keyType: 'ssh-ed25519',
    fingerprintSha256: 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    replaceExisting: false
  }

  it('首次信任写入，同指纹重复信任是幂等的', () => {
    const data = payload()
    const first = trustKnownHost(data, request, NOW)
    const again = trustKnownHost(data, request, NOW)
    expect(again.id).toBe(first.id)
    expect(listKnownHosts(data)).toHaveLength(1)
  })

  it('指纹变了且 replaceExisting=false → E_CONFLICT（绝不静默覆盖）', () => {
    const data = payload()
    trustKnownHost(data, request, NOW)
    const conflict = codeOf(() =>
      trustKnownHost(data, { ...request, fingerprintSha256: 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, NOW)
    )
    expect(conflict.code).toBe('E_CONFLICT')
    expect(conflict.details).toMatchObject({ host: request.host, port: request.port })
    expect(listKnownHosts(data)[0]?.fingerprintSha256).toBe(request.fingerprintSha256)
  })

  it('replaceExisting=true 才允许替换；remove 不存在 → E_NOT_FOUND', () => {
    const data = payload()
    trustKnownHost(data, request, NOW)
    const next = 'SHA256:ccccccccccccccccccccccccccccccccccccccccccc'
    trustKnownHost(data, { ...request, fingerprintSha256: next, replaceExisting: true }, NOW)
    expect(listKnownHosts(data)[0]?.fingerprintSha256).toBe(next)
    removeKnownHost(data, { host: request.host, port: request.port })
    expect(listKnownHosts(data)).toHaveLength(0)
    expect(codeOf(() => removeKnownHost(data, { host: request.host, port: request.port })).code).toBe('E_NOT_FOUND')
  })
})

describe('主机库：snippets', () => {
  it('新建/更新/删除，id 稳定', () => {
    const data = payload()
    const created = upsertSnippet(data, { label: 'disk', command: 'df -h', tags: ['ops'] }, NOW)
    const updated = upsertSnippet(data, { id: created.id, label: 'disk', command: 'df -hT' }, NOW)
    expect(updated.id).toBe(created.id)
    expect(data.snippets[0]?.command).toBe('df -hT')
    deleteSnippet(data, created.id)
    expect(data.snippets).toHaveLength(0)
    expect(codeOf(() => deleteSnippet(data, created.id)).code).toBe('E_NOT_FOUND')
  })
})
