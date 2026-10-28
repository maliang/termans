import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ConflictStrategy, SyncConflict } from '@shared'
import type { VaultPayload } from '../vault/model'
import { writePrivateFile, type SecretBox } from '../vault/secret-box'
import { sha256Hex } from '../crypto'

/**
 * 乐观锁冲突：**逐字段**三方合并（base / local / remote）。
 *
 * 为什么需要 base：密文没法做 git 的三路合并，但「谁改了什么」必须能算出来，
 * 否则「远端前进 + 本地有改动」只能二选一（静默覆盖）。
 * 所以每次同步成功都会把当时的密文存一份 `base.vault.enc`（本身就是密文，落盘安全）；
 * 冲突时用它做三方比较：
 *   - 只有一边改了 → 自动采纳（不打扰用户）；
 *   - 两边都改且不同 → 生成一条冲突，UI 逐字段选 local/remote/duplicate。
 *
 * 冲突路径语法（`applyStrategy` 与 `readPath/writePath` 共用）：
 *   - `hosts.<id>.<field>` / `hosts.<id>`（presence，值 null 表示删除）
 *   - `groups.*` / `knownHosts.*` / `themes.*` / `snippets.*` 同上
 *   - `settings.<section>.<key>`
 *   - `secrets.<ref>.<password|passphrase>` / `secrets.<ref>`
 *   - `integrations.gitToken` / `integrations.aiApiKeys.<providerId>`
 *   - `sshConfig.text` / `sshConfig.sourcePath` / `sshConfig.aliasMap.<alias>`
 */

export const CONFLICT_COLLECTIONS = ['hosts', 'groups', 'knownHosts', 'themes', 'snippets'] as const
type CollectionName = (typeof CONFLICT_COLLECTIONS)[number]

export interface MergeConflict extends SyncConflict {
  /** 本地/远端的具体值（只在本机内存与加密的冲突快照里存在，绝不进仓库） */
  localValue: unknown
  remoteValue: unknown
}

export interface MergeResult {
  merged: VaultPayload
  conflicts: MergeConflict[]
  /** 自动采纳的条数（用于 UI 提示「有 N 处远端改动已自动合并」） */
  autoApplied: number
}

export interface ConflictState {
  version: 1
  createdAt: string
  localCommit: string | null
  remoteCommit: string | null
  baseAvailable: boolean
  merged: VaultPayload
  conflicts: MergeConflict[]
}

/* -------------------------------------------------------------------------- */
/* 路径读写                                                                    */
/* -------------------------------------------------------------------------- */

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function collectionOf(payload: VaultPayload, name: CollectionName): Record<string, unknown>[] {
  return (payload as unknown as Record<CollectionName, Record<string, unknown>[]>)[name]
}

export function readPath(payload: VaultPayload, path: string): unknown {
  const segments = path.split('.')
  const [root, ...rest] = segments as [string, ...string[]]
  if ((CONFLICT_COLLECTIONS as readonly string[]).includes(root)) {
    const list = collectionOf(payload, root as CollectionName)
    if (rest.length === 0) return list
    const [id, ...tail] = rest
    const entity = list.find((item) => item.id === id)
    if (entity === undefined) return null
    if (tail.length === 0) return entity
    return readSegments(entity, tail)
  }
  const container = (payload as unknown as Json)[root]
  if (rest.length === 0) return container
  if (!isRecord(container)) return null
  return readSegments(container, rest)
}

function readSegments(value: unknown, segments: string[]): unknown {
  let current: unknown = value
  for (const segment of segments) {
    if (!isRecord(current)) return null
    current = current[segment]
  }
  return current === undefined ? null : current
}

export function writePath(payload: VaultPayload, path: string, value: unknown): void {
  const segments = path.split('.')
  const [root, ...rest] = segments as [string, ...string[]]
  if ((CONFLICT_COLLECTIONS as readonly string[]).includes(root)) {
    const list = collectionOf(payload, root as CollectionName)
    const [id, ...tail] = rest
    const index = list.findIndex((item) => item.id === id)
    if (tail.length === 0) {
      // presence 语义：null = 删除该实体
      if (value === null) {
        if (index >= 0) list.splice(index, 1)
        return
      }
      if (!isRecord(value)) return
      if (index >= 0) list[index] = value as Json
      else list.push(value as Json)
      return
    }
    if (index < 0) {
      if (value === null) return
      return
    }
    writeSegments(list[index] as Json, tail, value)
    return
  }
  const target = (payload as unknown as Json)[root]
  if (rest.length === 0) {
    ;(payload as unknown as Json)[root] = value
    return
  }
  if (!isRecord(target)) return
  writeSegments(target, rest, value)
}

function writeSegments(target: Json, segments: string[], value: unknown): void {
  let current: Json = target
  for (let index = 0; index < segments.length - 1; index += 1) {
    const key = segments[index]!
    const next = current[key]
    if (!isRecord(next)) {
      if (value === null) return
      current[key] = {}
    }
    current = current[key] as Json
  }
  const last = segments[segments.length - 1]!
  if (value === null) delete current[last]
  else current[last] = value
}

/* -------------------------------------------------------------------------- */
/* 三方合并                                                                    */
/* -------------------------------------------------------------------------- */

function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value ?? null))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (isRecord(value)) {
    const out: Json = {}
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key])
    return out
  }
  return value
}

function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b)
}

function conflictId(kind: SyncConflict['kind'], entityId: string, path: string): string {
  return sha256Hex(`${kind}|${entityId}|${path}`).slice(0, 24)
}

/** 摘要：**绝不**包含密钥/密码原文（secrets 一律显示掩码） */
function summarize(kind: SyncConflict['kind'], path: string, value: unknown): string {
  if (value === null || value === undefined) return '∅'
  if (path.startsWith('secrets.')) return '••••••'
  if (path === 'integrations.gitToken') return value === null ? '—' : '••••••'
  if (path.startsWith('integrations.aiApiKeys.')) return '••••••'
  if (path === 'sshConfig.text') return `${String(value).split('\n').length} lines`
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (isRecord(value)) return kind === 'theme' ? String(value.name ?? value.id ?? 'theme') : `{${Object.keys(value).length} fields}`
  return String(value)
}

function entityLabel(entity: unknown, entityId: string): string {
  if (isRecord(entity)) {
    for (const key of ['label', 'name', 'host', 'id']) {
      const value = entity[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return entityId
}

function updatedAtOf(entity: unknown): string | null {
  if (!isRecord(entity)) return null
  for (const key of ['updatedAt', 'addedAt', 'createdAt']) {
    const value = entity[key]
    if (typeof value === 'string') return value
  }
  return null
}

/**
 * 三方合并。
 * `base === null`（第一次同步就没有基线）时退化成两方比较：所有「两边不同」的字段都算冲突。
 */
export function mergePayloads(base: VaultPayload | null, local: VaultPayload, remote: VaultPayload): MergeResult {
  const merged = structuredClone(local)
  const conflicts: MergeConflict[] = []
  let autoApplied = 0

  for (const collection of CONFLICT_COLLECTIONS) {
    const kind = collectionKind(collection)
    const baseList = base === null ? [] : collectionOf(base, collection)
    const localList = collectionOf(local, collection)
    const remoteList = collectionOf(remote, collection)
    const baseMap = new Map(baseList.map((item) => [String(item.id), item]))
    const localMap = new Map(localList.map((item) => [String(item.id), item]))
    const remoteMap = new Map(remoteList.map((item) => [String(item.id), item]))
    const ids = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])

    for (const id of ids) {
      const b = baseMap.get(id) ?? null
      const l = localMap.get(id) ?? null
      const r = remoteMap.get(id) ?? null
      if (equal(l, r)) continue

      const path = `${collection}.${id}`
      const label = entityLabel(l ?? r ?? b, id)

      // 删除 vs 修改
      if (l === null || r === null) {
        const survivor = l ?? r
        // base 里没有这个实体 → 这是「新增」，不是「删一个改一个」：直接采纳新增方
        if (b === null) {
          if (survivor !== null && l === null) {
            collectionOf(merged, collection).push(structuredClone(survivor))
            autoApplied += 1
          } else {
            autoApplied += 1
          }
          continue
        }
        const changedOnSurvivingSide = !equal(survivor, b)
        const deletedSide = l === null ? 'local' : 'remote'
        if (!changedOnSurvivingSide) {
          // 一边删除、另一边没动过 → 删除生效，不打扰用户
          if (l === null) removeEntity(merged, collection, id)
          autoApplied += 1
          continue
        }
        conflicts.push({
          id: conflictId(kind, id, path),
          kind,
          entityId: id,
          label,
          path,
          localUpdatedAt: updatedAtOf(l),
          remoteUpdatedAt: updatedAtOf(r),
          localSummary: summarize(kind, path, l),
          remoteSummary: summarize(kind, path, r),
          localValue: l,
          remoteValue: r
        })
        if (deletedSide === 'remote') autoApplied += 0
        continue
      }

      // 两边都有：逐字段三方比较
      const fields = new Set<string>([...Object.keys(b ?? {}), ...Object.keys(l), ...Object.keys(r)])
      let touched = false
      for (const field of fields) {
        if (field === 'id') continue
        // `updatedAt` 是元数据：两边都改过时不该让用户「选一个时间戳」，取较新的那份即可
        if (field === 'updatedAt') {
          const later = String(l.updatedAt) >= String(r.updatedAt) ? l.updatedAt : r.updatedAt
          if (!equal(l.updatedAt, later)) {
            ;(merged as unknown as Record<string, Record<string, unknown>[]>)[collection]
            writePath(merged, `${path}.updatedAt`, later)
            autoApplied += 1
          }
          continue
        }
        const fieldPath = `${path}.${field}`
        const bv = b === null ? undefined : b[field]
        const lv = l[field]
        const rv = r[field]
        if (equal(lv, rv)) continue
        if (b !== null && equal(lv, bv)) {
          writePath(merged, fieldPath, rv ?? null)
          autoApplied += 1
          continue
        }
        if (b !== null && equal(rv, bv)) {
          autoApplied += 1
          continue
        }
        touched = true
        conflicts.push({
          id: conflictId(kind, id, fieldPath),
          kind,
          entityId: id,
          label,
          path: fieldPath,
          localUpdatedAt: updatedAtOf(l),
          remoteUpdatedAt: updatedAtOf(r),
          localSummary: summarize(kind, fieldPath, lv ?? null),
          remoteSummary: summarize(kind, fieldPath, rv ?? null),
          localValue: lv ?? null,
          remoteValue: rv ?? null
        })
      }
      if (touched && b === null) autoApplied += 0
    }
  }

  mergeObjectSection(merged, base?.settings ?? null, local.settings, remote.settings, 'settings', 'settings', conflicts, (count) => {
    autoApplied += count
  })
  mergeObjectSection(merged, base?.integrations ?? null, local.integrations, remote.integrations, 'integrations', 'settings', conflicts, (count) => {
    autoApplied += count
  })
  mergeObjectSection(merged, base?.sshConfig ?? null, local.sshConfig, remote.sshConfig, 'sshConfig', 'settings', conflicts, (count) => {
    autoApplied += count
  })
  mergeSecrets(merged, base, local, remote, conflicts, (count) => {
    autoApplied += count
  })

  return { merged, conflicts, autoApplied }
}

function collectionKind(collection: CollectionName): SyncConflict['kind'] {
  switch (collection) {
    case 'hosts':
      return 'host'
    case 'groups':
      return 'group'
    case 'knownHosts':
      return 'known-hosts'
    case 'themes':
      return 'theme'
    case 'snippets':
      return 'settings'
  }
}

function removeEntity(payload: VaultPayload, collection: CollectionName, id: string): void {
  const list = collectionOf(payload, collection)
  const index = list.findIndex((item) => item.id === id)
  if (index >= 0) list.splice(index, 1)
}

/**
 * 普通对象小节（settings / integrations / sshConfig）的两种策略：
 * - `settings`/`integrations`：逐叶子字段三方合并（值可能是对象，如 aiApiKeys）；
 * - `sshConfig`：`text` 整体作为一格（密文里的全文只能在整份取一侧），其余字段逐键合并。
 */
function mergeObjectSection(
  merged: VaultPayload,
  base: unknown,
  local: unknown,
  remote: unknown,
  section: string,
  kind: SyncConflict['kind'],
  conflicts: MergeConflict[],
  onAutoApplied: (count: number) => void
): void {
  if (!isRecord(local) || !isRecord(remote)) return
  const baseRecord = isRecord(base) ? base : null
  const keys = new Set<string>([...Object.keys(baseRecord ?? {}), ...Object.keys(local), ...Object.keys(remote)])
  let auto = 0

  for (const key of keys) {
    const path = `${section}.${key}`
    const bv = baseRecord?.[key]
    const lv = local[key]
    const rv = remote[key]
    if (equal(lv, rv)) continue

    if (section === 'sshConfig' && key === 'text') {
      if (baseRecord !== null && equal(lv, bv)) {
        writePath(merged, path, rv)
        auto += 1
        continue
      }
      if (baseRecord !== null && equal(rv, bv)) {
        auto += 1
        continue
      }
      conflicts.push({
        id: conflictId(kind, section, path),
        kind,
        entityId: section,
        label: 'ssh_config',
        path,
        localUpdatedAt: null,
        remoteUpdatedAt: null,
        localSummary: summarize(kind, path, lv),
        remoteSummary: summarize(kind, path, rv),
        localValue: lv ?? null,
        remoteValue: rv ?? null
      })
      continue
    }

    if (isRecord(lv) && isRecord(rv) && (baseRecord === null || isRecord(bv))) {
      mergeLeafMap(merged, path, baseRecord === null ? null : (bv as Json), lv, rv, kind, conflicts, (count) => {
        auto += count
      })
      continue
    }

    if (baseRecord !== null && equal(lv, bv)) {
      writePath(merged, path, rv)
      auto += 1
      continue
    }
    if (baseRecord !== null && equal(rv, bv)) {
      auto += 1
      continue
    }
    conflicts.push({
      id: conflictId(kind, section, path),
      kind,
      entityId: section,
      label: section,
      path,
      localUpdatedAt: null,
      remoteUpdatedAt: null,
      localSummary: summarize(kind, path, lv ?? null),
      remoteSummary: summarize(kind, path, rv ?? null),
      localValue: lv ?? null,
      remoteValue: rv ?? null
    })
  }
  onAutoApplied(auto)
}

function mergeLeafMap(
  merged: VaultPayload,
  basePath: string,
  base: Json | null,
  local: Json,
  remote: Json,
  kind: SyncConflict['kind'],
  conflicts: MergeConflict[],
  onAutoApplied: (count: number) => void
): void {
  const keys = new Set<string>([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote)])
  let auto = 0
  for (const key of keys) {
    const path = `${basePath}.${key}`
    const bv = base?.[key]
    const lv = local[key]
    const rv = remote[key]
    if (equal(lv, rv)) continue
    if (base !== null && equal(lv, bv)) {
      writePath(merged, path, rv ?? null)
      auto += 1
      continue
    }
    if (base !== null && equal(rv, bv)) {
      auto += 1
      continue
    }
    conflicts.push({
      id: conflictId(kind, basePath, path),
      kind,
      entityId: basePath,
      label: basePath,
      path,
      localUpdatedAt: null,
      remoteUpdatedAt: null,
      localSummary: summarize(kind, path, lv ?? null),
      remoteSummary: summarize(kind, path, rv ?? null),
      localValue: lv ?? null,
      remoteValue: rv ?? null
    })
  }
  onAutoApplied(auto)
}

function mergeSecrets(
  merged: VaultPayload,
  base: VaultPayload | null,
  local: VaultPayload,
  remote: VaultPayload,
  conflicts: MergeConflict[],
  onAutoApplied: (count: number) => void
): void {
  const baseSecrets = base?.secrets ?? {}
  const keys = new Set([...Object.keys(baseSecrets), ...Object.keys(local.secrets), ...Object.keys(remote.secrets)])
  let auto = 0
  for (const reference of keys) {
    const b = baseSecrets[reference]
    const l = local.secrets[reference]
    const r = remote.secrets[reference]
    for (const field of ['password', 'passphrase'] as const) {
      const bv = b?.[field] ?? null
      const lv = l?.[field] ?? null
      const rv = r?.[field] ?? null
      if (equal(lv, rv)) continue
      const path = `secrets.${reference}.${field}`
      if (base !== null && equal(lv, bv)) {
        writePath(merged, path, rv)
        auto += 1
        continue
      }
      if (base !== null && equal(rv, bv)) {
        auto += 1
        continue
      }
      conflicts.push({
        id: conflictId('host', reference, path),
        kind: 'host',
        entityId: reference,
        label: reference,
        path,
        localUpdatedAt: l?.updatedAt ?? null,
        remoteUpdatedAt: r?.updatedAt ?? null,
        localSummary: lv === null ? '—' : '••••••',
        remoteSummary: rv === null ? '—' : '••••••',
        localValue: lv,
        remoteValue: rv
      })
    }
  }
  onAutoApplied(auto)
}

/* -------------------------------------------------------------------------- */
/* 解决冲突                                                                    */
/* -------------------------------------------------------------------------- */

export function applyStrategy(payload: VaultPayload, conflict: MergeConflict, strategy: ConflictStrategy): void {
  if (strategy === 'duplicate') {
    duplicateEntity(payload, conflict)
    writePath(payload, conflict.path, conflict.remoteValue)
    return
  }
  writePath(payload, conflict.path, strategy === 'local' ? conflict.localValue : conflict.remoteValue)
}

/**
 * duplicate：把「本地这一份」另存为一个新实体（新 id），本字段取远端值。
 * 合同里策略叫「两边都留」，对逐字段冲突就是这样落地：主机/分组会多出一台副本，
 * 而本字段采用远端值，两边的东西都不丢。
 */
function duplicateEntity(payload: VaultPayload, conflict: MergeConflict): void {
  const [root, id] = conflict.path.split('.')
  if (root === undefined || id === undefined) return
  if (!(CONFLICT_COLLECTIONS as readonly string[]).includes(root)) return
  const collection = root as CollectionName
  const list = collectionOf(payload, collection)
  const source = conflict.localValue
  const entity = isRecord(source) ? source : list.find((item) => item.id === id)
  if (entity === undefined) return
  const copy = structuredClone(entity) as Json
  const newId = globalThis.crypto.randomUUID()
  copy.id = newId
  if (typeof copy.label === 'string') copy.label = `${copy.label} (copy)`
  if (typeof copy.name === 'string') copy.name = `${copy.name} (copy)`
  list.push(copy)
}

/* -------------------------------------------------------------------------- */
/* 冲突快照持久化（本机、加密）                                                 */
/* -------------------------------------------------------------------------- */

const conflictStateSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  localCommit: z.string().nullable(),
  remoteCommit: z.string().nullable(),
  baseAvailable: z.boolean(),
  merged: z.record(z.string(), z.unknown()),
  conflicts: z.array(z.record(z.string(), z.unknown()))
})

export function conflictsDir(localDir: string): string {
  const dir = join(localDir, 'conflicts')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function statePath(localDir: string): string {
  return join(conflictsDir(localDir), 'state.enc')
}

/**
 * 冲突状态（含合并中的明文 payload 与逐字段值）用 SecretBox 封起来再落盘：
 * 里面可能有密码，不能以 JSON 明文躺在 userData 里。
 */
export function saveConflictState(localDir: string, box: SecretBox, state: ConflictState): void {
  writePrivateFile(statePath(localDir), `${JSON.stringify({ version: 1, sealed: box.encrypt(JSON.stringify(state)) }, null, 2)}\n`)
}

export function loadConflictState(localDir: string, box: SecretBox): ConflictState | null {
  const path = statePath(localDir)
  if (!existsSync(path)) return null
  try {
    const wrapper = JSON.parse(readFileSync(path, 'utf8')) as { sealed?: unknown }
    if (typeof wrapper.sealed !== 'string') return null
    const raw = JSON.parse(box.decrypt(wrapper.sealed)) as unknown
    const parsed = conflictStateSchema.safeParse(raw)
    if (!parsed.success) return null
    return parsed.data as unknown as ConflictState
  } catch {
    return null
  }
}

export function clearConflictState(localDir: string): void {
  rmSync(statePath(localDir), { force: true })
  rmSync(join(conflictsDir(localDir), 'base.vault.enc'), { force: true })
}

/* -------------------------------------------------------------------------- */
/* 快照（「双方各存 conflict 快照」）                                            */
/* -------------------------------------------------------------------------- */

export interface ConflictSnapshot {
  dir: string
  localPath: string
  remotePath: string
}

export function writeConflictSnapshots(
  localDir: string,
  localEnc: Buffer | null,
  remoteEnc: Buffer | null,
  stamp: string
): ConflictSnapshot {
  const dir = join(conflictsDir(localDir), stamp)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const localPath = join(dir, 'local.vault.enc')
  const remotePath = join(dir, 'remote.vault.enc')
  if (localEnc !== null) writePrivateFile(localPath, localEnc.toString('utf8'))
  if (remoteEnc !== null) writePrivateFile(remotePath, remoteEnc.toString('utf8'))
  return { dir, localPath, remotePath }
}
