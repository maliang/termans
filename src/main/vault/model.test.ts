import { describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import { DEFAULT_SETTINGS } from '@shared/models/settings'
import {
  VAULT_SCHEMA_VERSION,
  countItems,
  emptyPayload,
  isIsoTimestamp,
  migratePayload,
  parsePayload,
  serializePayload,
  toHostLibrary
} from './model'
import { hostInput, payload as makePayload } from './test-fixtures'

const NOW = '2026-01-01T00:00:00.000Z'

function expectIpcError(fn: () => unknown, code: string, reason?: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(IpcCallError)
    const ipc = error as IpcCallError
    expect(ipc.code).toBe(code)
    if (reason !== undefined) expect((ipc.details as { reason?: string } | undefined)?.reason).toBe(reason)
    return
  }
  throw new Error(`expected IpcCallError(${code}/${reason ?? '-'})`)
}

describe('payload 模型', () => {
  it('空 payload 带全默认值（settings 用 DEFAULT_SETTINGS，ssh_config 为空文本）', () => {
    const empty = emptyPayload(NOW)
    expect(empty.schemaVersion).toBe(VAULT_SCHEMA_VERSION)
    expect(empty.hosts).toEqual([])
    expect(empty.settings).toEqual(DEFAULT_SETTINGS)
    expect(empty.sshConfig).toEqual({ text: '', aliasMap: {}, sourcePath: null })
    expect(empty.integrations).toEqual({ gitToken: null, aiApiKeys: {}, aiProvidersConfig: null })
    expect(empty.hostNotes).toEqual({})
    expect(empty.secrets).toEqual({})
    expect(empty.updatedAt).toBe(NOW)
  })

  it('serializePayload 是稳定键序：同一逻辑内容 → 同一份 JSON', () => {
    const a = makePayload()
    const second = { ...hostInput({ label: 'b-host' }) }
    a.hosts = [
      { ...hostInput({ label: 'a-host' }), id: 'b0000000-0000-4000-8000-000000000002', sortIndex: 1, createdAt: NOW, updatedAt: NOW },
      { ...hostInput({ label: 'a-host' }), id: 'b0000000-0000-4000-8000-000000000001', sortIndex: 0, createdAt: NOW, updatedAt: NOW }
    ]
    const b = structuredClone(a)
    b.hosts.reverse()
    b.secrets = { z: { password: 'x', passphrase: null, updatedAt: NOW }, a: { password: 'y', passphrase: null, updatedAt: NOW } }
    a.secrets = { a: { password: 'y', passphrase: null, updatedAt: NOW }, z: { password: 'x', passphrase: null, updatedAt: NOW } }
    expect(serializePayload(a)).toBe(serializePayload(b))
    expect(second.label).toBe('b-host')
  })

  it('parsePayload 往返一致，JSON 坏 → invalid-payload', () => {
    const empty = emptyPayload(NOW)
    expect(serializePayload(parsePayload(serializePayload(empty)))).toBe(serializePayload(empty))
    expectIpcError(() => parsePayload('{not json'), 'E_INVALID_ARGUMENT', 'invalid-payload')
  })

  it('迁移：v0（没有 schemaVersion、hosts 没有 sortIndex）补全到 v1', () => {
    const migrated = migratePayload({
      hosts: [{ ...hostInput(), id: 'c0000000-0000-4000-8000-000000000001', createdAt: NOW, updatedAt: NOW }],
      groups: [],
      settings: { locale: 'zh-CN' }
    })
    expect(migrated.schemaVersion).toBe(VAULT_SCHEMA_VERSION)
    expect(migrated.hosts[0]?.sortIndex).toBe(0)
    expect(migrated.settings.locale).toBe('zh-CN')
    // 缺失的 section 用默认值补齐（withDefaults 逐字段容错）
    expect(migrated.settings.terminal.fontSize).toBe(DEFAULT_SETTINGS.terminal.fontSize)
    expect(migrated.knownHosts).toEqual([])
    expect(migrated.sshConfig.aliasMap).toEqual({})
    expect(isIsoTimestamp(migrated.updatedAt)).toBe(true)
  })

  it('未来版本 → unsupported-format（不猜语义，不静默丢数据）', () => {
    expectIpcError(
      () => migratePayload({ ...emptyPayload(NOW), schemaVersion: VAULT_SCHEMA_VERSION + 5 }),
      'E_INVALID_ARGUMENT',
      'unsupported-format'
    )
  })

  it('脏数据拒绝：端口 0 / 缺 label / tags 超长都给 invalid-payload + issues', () => {
    const build = (host: unknown) => ({
      ...emptyPayload(NOW),
      hosts: [{ ...(host as object), id: 'd0000000-0000-4000-8000-000000000001', sortIndex: 0, createdAt: NOW, updatedAt: NOW }]
    })
    for (const broken of [{ ...hostInput(), port: 0 }, { ...hostInput(), label: '' }, { ...hostInput(), tags: ['x'.repeat(41)] }]) {
      try {
        migratePayload(build(broken))
        throw new Error('expected rejection')
      } catch (error) {
        const ipc = error as IpcCallError
        expect(ipc.code).toBe('E_INVALID_ARGUMENT')
        expect((ipc.details as { reason?: string }).reason).toBe('invalid-payload')
        expect(Array.isArray((ipc.details as { issues?: unknown }).issues)).toBe(true)
      }
    }
  })

  it('itemCounts / toHostLibrary 按 sortIndex 排序', () => {
    const data = makePayload()
    data.hosts = [
      { ...hostInput({ label: 'second' }), id: 'e0000000-0000-4000-8000-000000000002', sortIndex: 2, createdAt: NOW, updatedAt: NOW },
      { ...hostInput({ label: 'first' }), id: 'e0000000-0000-4000-8000-000000000001', sortIndex: 1, createdAt: NOW, updatedAt: NOW }
    ]
    expect(toHostLibrary(data).hosts.map((host) => host.label)).toEqual(['first', 'second'])
    expect(countItems(data, 3)).toMatchObject({ hosts: 2, groups: 0, themes: 3 })
  })
})
