import { randomUUID } from 'node:crypto'
import {
  groupInputSchema,
  hostInputSchema,
  type GroupInput,
  type GroupRecord,
  type HostInput,
  type HostLibrary,
  type HostRecord,
  type HostSortUpdate,
  type KnownHostEntry,
  type KnownHostRemoveRequest,
  type KnownHostTrustRequest
} from '@shared'
import { vaultFail } from './errors'
import { toHostLibrary, type VaultPayload, type VaultSecret, type VaultSnippet } from './model'

/**
 * 主机库的纯函数操作层：只改 `payload`（内存对象），不做任何 IO、不碰加密。
 *
 * 拆出来的目的：加密/落盘/git 都是副作用，而这层可以单测到「引用完整性」这种细节
 * （删分组后主机归零、删主机后跳板引用断开、指纹冲突不许静默覆盖）。
 */

function rejectInput(label: string, issues: { path: PropertyKey[]; message: string }[]): never {
  throw vaultFail('E_INVALID_ARGUMENT', `${label} is invalid`, {
    reason: 'invalid-payload',
    issues: issues.slice(0, 12).map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
  })
}

export function parseHostInput(input: unknown): HostInput {
  const parsed = hostInputSchema.safeParse(input)
  if (!parsed.success) rejectInput('host', parsed.error.issues)
  return parsed.data
}

export function parseGroupInput(input: unknown): GroupInput {
  const parsed = groupInputSchema.safeParse(input)
  if (!parsed.success) rejectInput('group', parsed.error.issues)
  return parsed.data
}

export function nextSortIndex(items: { sortIndex: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.sortIndex + 1), 0)
}

/** 引用完整性：分组必须存在、跳板机必须存在、不能自己跳自己、跳板链不能成环 */
export function assertHostReferences(payload: VaultPayload, input: HostInput, selfId?: string): void {
  if (input.groupId !== null && !payload.groups.some((group) => group.id === input.groupId)) {
    throw vaultFail('E_INVALID_ARGUMENT', `group not found: ${input.groupId}`, {
      reason: 'not-found',
      field: 'groupId',
      id: input.groupId
    })
  }
  if (input.jumpHostId === null) return
  if (selfId !== undefined && input.jumpHostId === selfId) {
    throw vaultFail('E_INVALID_ARGUMENT', 'a host cannot jump through itself', {
      reason: 'invalid-payload',
      field: 'jumpHostId'
    })
  }
  if (!payload.hosts.some((host) => host.id === input.jumpHostId)) {
    throw vaultFail('E_INVALID_ARGUMENT', `jump host not found: ${input.jumpHostId}`, {
      reason: 'not-found',
      field: 'jumpHostId',
      id: input.jumpHostId
    })
  }

  // 跳板链成环会让连接逻辑无限递归，必须在这里拦住
  const byId = new Map(payload.hosts.map((host) => [host.id, host]))
  const seen = new Set<string>()
  let cursor: string | null = input.jumpHostId
  while (cursor !== null) {
    if (cursor === selfId) {
      throw vaultFail('E_INVALID_ARGUMENT', 'jump host chain would form a cycle', {
        reason: 'invalid-payload',
        field: 'jumpHostId',
        chain: [...seen, cursor]
      })
    }
    if (seen.has(cursor)) break
    seen.add(cursor)
    cursor = byId.get(cursor)?.jumpHostId ?? null
  }
}

export function createHostRecord(payload: VaultPayload, rawInput: HostInput, now: string): HostRecord {
  const input = parseHostInput(rawInput)
  assertHostReferences(payload, input)
  const record: HostRecord = {
    ...input,
    id: randomUUID(),
    sortIndex: nextSortIndex(payload.hosts.filter((host) => host.groupId === input.groupId)),
    createdAt: now,
    updatedAt: now
  }
  payload.hosts.push(record)
  return record
}

export function updateHostRecord(payload: VaultPayload, hostId: string, rawInput: HostInput, now: string): HostRecord {
  const index = payload.hosts.findIndex((host) => host.id === hostId)
  if (index < 0) {
    throw vaultFail('E_NOT_FOUND', `host not found: ${hostId}`, { reason: 'not-found', field: 'hostId', id: hostId })
  }
  const existing = payload.hosts[index]!
  const input = parseHostInput(rawInput)
  assertHostReferences(payload, input, hostId)

  const movedGroup = existing.groupId !== input.groupId
  const record: HostRecord = {
    ...input,
    id: existing.id,
    sortIndex: movedGroup
      ? nextSortIndex(payload.hosts.filter((host) => host.groupId === input.groupId && host.id !== hostId))
      : existing.sortIndex,
    createdAt: existing.createdAt,
    updatedAt: now
  }
  payload.hosts[index] = record
  return record
}

export function deleteHostRecord(payload: VaultPayload, hostId: string): void {
  const index = payload.hosts.findIndex((host) => host.id === hostId)
  if (index < 0) {
    throw vaultFail('E_NOT_FOUND', `host not found: ${hostId}`, { reason: 'not-found', field: 'hostId', id: hostId })
  }
  payload.hosts.splice(index, 1)
  // 其它主机把它当跳板机的，引用断到 null（否则下次编辑就报「跳板机不存在」，用户找不到原因）
  for (const host of payload.hosts) {
    if (host.jumpHostId === hostId) host.jumpHostId = null
  }
  // 别名映射里指向这台机的条目一并清掉，避免 ssh_config 导出出现悬空别名
  for (const [alias, id] of Object.entries(payload.sshConfig.aliasMap)) {
    if (id === hostId) delete payload.sshConfig.aliasMap[alias]
  }
  pruneOrphanSecrets(payload)
  delete payload.hostNotes[hostId]
}

export function reorderHosts(payload: VaultPayload, updates: HostSortUpdate[]): HostLibrary {
  const byId = new Map(payload.hosts.map((host) => [host.id, host]))
  for (const update of updates) {
    const host = byId.get(update.id)
    if (!host) {
      throw vaultFail('E_NOT_FOUND', `host not found: ${update.id}`, { reason: 'not-found', field: 'hostId', id: update.id })
    }
    if (update.groupId !== null && !payload.groups.some((group) => group.id === update.groupId)) {
      throw vaultFail('E_INVALID_ARGUMENT', `group not found: ${update.groupId}`, {
        reason: 'not-found',
        field: 'groupId',
        id: update.groupId
      })
    }
  }
  for (const update of updates) {
    const host = byId.get(update.id)!
    host.sortIndex = update.sortIndex
    host.groupId = update.groupId
  }
  return toHostLibrary(payload)
}

export function createGroupRecord(payload: VaultPayload, rawInput: GroupInput, now: string): GroupRecord {
  const input = parseGroupInput(rawInput)
  assertGroupParent(payload, input.parentId, null)
  const record: GroupRecord = {
    ...input,
    id: randomUUID(),
    sortIndex: nextSortIndex(payload.groups.filter((group) => group.parentId === input.parentId)),
    createdAt: now,
    updatedAt: now
  }
  payload.groups.push(record)
  return record
}

export function updateGroupRecord(payload: VaultPayload, groupId: string, rawInput: GroupInput, now: string): GroupRecord {
  const index = payload.groups.findIndex((group) => group.id === groupId)
  if (index < 0) {
    throw vaultFail('E_NOT_FOUND', `group not found: ${groupId}`, { reason: 'not-found', field: 'groupId', id: groupId })
  }
  const existing = payload.groups[index]!
  const input = parseGroupInput(rawInput)
  assertGroupParent(payload, input.parentId, groupId)
  const record: GroupRecord = {
    ...input,
    id: existing.id,
    sortIndex: existing.parentId === input.parentId
      ? existing.sortIndex
      : nextSortIndex(payload.groups.filter((group) => group.parentId === input.parentId && group.id !== groupId)),
    createdAt: existing.createdAt,
    updatedAt: now
  }
  payload.groups[index] = record
  return record
}

export function deleteGroupRecord(payload: VaultPayload, groupId: string): void {
  const index = payload.groups.findIndex((group) => group.id === groupId)
  if (index < 0) {
    throw vaultFail('E_NOT_FOUND', `group not found: ${groupId}`, { reason: 'not-found', field: 'groupId', id: groupId })
  }
  const [removed] = payload.groups.splice(index, 1)
  // 子分组挂到被删分组的父级（而不是一起删掉）；主机落到「未分组」
  for (const group of payload.groups) {
    if (group.parentId === groupId) group.parentId = removed?.parentId ?? null
  }
  for (const host of payload.hosts) {
    if (host.groupId === groupId) host.groupId = null
  }
}

function assertGroupParent(payload: VaultPayload, parentId: string | null, selfId: string | null): void {
  if (parentId === null) return
  if (parentId === selfId) {
    throw vaultFail('E_INVALID_ARGUMENT', 'a group cannot be its own parent', {
      reason: 'invalid-payload',
      field: 'parentId'
    })
  }
  if (!payload.groups.some((group) => group.id === parentId)) {
    throw vaultFail('E_INVALID_ARGUMENT', `parent group not found: ${parentId}`, {
      reason: 'not-found',
      field: 'parentId',
      id: parentId
    })
  }
  // 环形分组同样会让树渲染无限递归
  const byId = new Map(payload.groups.map((group) => [group.id, group]))
  const seen = new Set<string>()
  let cursor: string | null = parentId
  while (cursor !== null) {
    if (cursor === selfId) {
      throw vaultFail('E_INVALID_ARGUMENT', 'group hierarchy would form a cycle', {
        reason: 'invalid-payload',
        field: 'parentId'
      })
    }
    if (seen.has(cursor)) break
    seen.add(cursor)
    cursor = byId.get(cursor)?.parentId ?? null
  }
}

/** 凭据条目：key = host.credentialRef，值 = 明文密码/passphrase（整体被 vault.enc 加密） */
export function setSecret(
  payload: VaultPayload,
  reference: string,
  patch: { password?: string | null; passphrase?: string | null },
  now: string
): VaultSecret {
  const existing = payload.secrets[reference]
  const next: VaultSecret = {
    password: patch.password === undefined ? (existing?.password ?? null) : patch.password,
    passphrase: patch.passphrase === undefined ? (existing?.passphrase ?? null) : patch.passphrase,
    updatedAt: now
  }
  if (next.password === null && next.passphrase === null) {
    delete payload.secrets[reference]
    return next
  }
  payload.secrets[reference] = next
  return next
}

export function getSecret(payload: VaultPayload, reference: string): VaultSecret | null {
  return payload.secrets[reference] ?? null
}

export function clearSecret(payload: VaultPayload, reference: string): void {
  delete payload.secrets[reference]
}

/** 没有任何主机引用的凭据条目必须清掉（否则删掉的主机密码会一直留在密文里） */
export function pruneOrphanSecrets(payload: VaultPayload): string[] {
  const referenced = new Set(payload.hosts.map((host) => host.credentialRef).filter((ref): ref is string => ref !== null))
  const removed: string[] = []
  for (const reference of Object.keys(payload.secrets)) {
    if (!referenced.has(reference)) {
      delete payload.secrets[reference]
      removed.push(reference)
    }
  }
  return removed
}

export function listKnownHosts(payload: VaultPayload): KnownHostEntry[] {
  return [...payload.knownHosts].sort((a, b) => (a.host + a.port).localeCompare(b.host + b.port))
}

/**
 * 信任一条主机指纹。
 *
 * **指纹不一致且 `replaceExisting=false` 时必须报冲突，绝不静默覆盖** ——
 * 这是中间人攻击最典型的入口，静默覆盖等于把防护作废。
 */
export function trustKnownHost(payload: VaultPayload, request: KnownHostTrustRequest, now: string): KnownHostEntry {
  const existing = payload.knownHosts.find((entry) => entry.host === request.host && entry.port === request.port)
  if (existing) {
    if (existing.fingerprintSha256 === request.fingerprintSha256 && existing.keyType === request.keyType) {
      return existing
    }
    if (!request.replaceExisting) {
      throw vaultFail('E_CONFLICT', `host key for ${request.host}:${request.port} does not match the trusted one`, {
        reason: 'conflict',
        host: request.host,
        port: request.port,
        expected: existing.fingerprintSha256,
        received: request.fingerprintSha256
      })
    }
    existing.keyType = request.keyType
    existing.fingerprintSha256 = request.fingerprintSha256
    existing.addedAt = now
    return existing
  }
  const entry: KnownHostEntry = {
    id: randomUUID(),
    host: request.host,
    port: request.port,
    keyType: request.keyType,
    fingerprintSha256: request.fingerprintSha256,
    hashed: false,
    addedAt: now,
    sourceFile: null
  }
  payload.knownHosts.push(entry)
  return entry
}

export function removeKnownHost(payload: VaultPayload, request: KnownHostRemoveRequest): void {
  const before = payload.knownHosts.length
  payload.knownHosts = payload.knownHosts.filter(
    (entry) => !(entry.host === request.host && entry.port === request.port)
  )
  if (payload.knownHosts.length === before) {
    throw vaultFail('E_NOT_FOUND', `known host not found: ${request.host}:${request.port}`, {
      reason: 'not-found',
      host: request.host,
      port: request.port
    })
  }
}

export function upsertSnippet(
  payload: VaultPayload,
  input: { id?: string; label: string; command: string; tags?: string[] },
  now: string
): VaultSnippet {
  const trimmedLabel = input.label.trim()
  const trimmedCommand = input.command.trim()
  if (trimmedLabel.length === 0 || trimmedCommand.length === 0) {
    throw vaultFail('E_INVALID_ARGUMENT', 'snippet label and command are required', { reason: 'invalid-payload' })
  }
  const existing = input.id === undefined ? undefined : payload.snippets.find((snippet) => snippet.id === input.id)
  if (existing) {
    existing.label = trimmedLabel
    existing.command = trimmedCommand
    existing.tags = input.tags ?? existing.tags
    existing.updatedAt = now
    return existing
  }
  const snippet: VaultSnippet = {
    id: input.id ?? randomUUID(),
    label: trimmedLabel,
    command: trimmedCommand,
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now
  }
  payload.snippets.push(snippet)
  return snippet
}

export function deleteSnippet(payload: VaultPayload, snippetId: string): void {
  const before = payload.snippets.length
  payload.snippets = payload.snippets.filter((snippet) => snippet.id !== snippetId)
  if (payload.snippets.length === before) {
    throw vaultFail('E_NOT_FOUND', `snippet not found: ${snippetId}`, { reason: 'not-found', id: snippetId })
  }
}
