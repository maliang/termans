/**
 * `library-index.ts` 的单测（AC-10..AC-14 中落在索引层的那部分）。
 *
 * 断言口径（重要，别改成"跑一遍没报错"）：
 * - AC-14 的判据是「失败前后**文件数与 sha256 完全不变**」，所以这里真的对目录做递归
 *   `relativePath → sha256` 快照并逐字节比对，而不是只断言返回值 `ok:false`。
 *   可分辨性：把 `ensureLibraryDirFree` 改成失败前顺手 `mkdirSync`，第 5 例会立刻红。
 * - AC-18 的判据是「默认库路径与现状**逐字相同**」，所以用 `join(root,'vault')` 这种
 *   现拼的期望值比字符串，而不是从被测模块里再取一个常量来自证。
 * - 「不写盘」一律用 `existsSync` 验证，不靠"没抛异常"。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_LIBRARY_ID,
  LIBRARY_INDEX_FILE,
  ensureLibraryDirFree,
  newLibraryEntry,
  newLibraryId,
  readLibraryIndex,
  resolveLibraryPaths,
  validateLibraryName,
  writeLibraryIndex,
  type LibraryEntry
} from './library-index'

const roots: string[] = []

function freshRoot(prefix = 'termans-lib-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** 目录快照：相对路径 → sha256（文件）/ '<dir>'（目录）。AC-14 的"文件数与 sha256 不变"就靠它 */
function snapshot(dir: string, base = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of readdirSync(join(dir, base)).sort()) {
    const relative = base === '' ? name : `${base}/${name}`
    const absolute = join(dir, relative)
    if (statSync(absolute).isDirectory()) {
      result[relative] = '<dir>'
      Object.assign(result, snapshot(dir, relative))
    } else {
      result[relative] = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    }
  }
  return result
}

function seedUserDataDir(root: string): void {
  mkdirSync(join(root, 'vault'), { recursive: true })
  writeFileSync(join(root, 'vault', 'manifest.json'), '{"version":1}\n')
}

function existingLibrary(name: string, id = 'lib-00000001'): LibraryEntry {
  return { ...newLibraryEntry(id, name) }
}

describe('多库索引：惰性默认库与路径解析（AC-18 老安装零迁移）', () => {
  it('索引不存在时返回默认库且一个字节都不写', () => {
    const root = freshRoot()
    const index = readLibraryIndex(root)

    expect(index.version).toBe(1)
    expect(index.current).toBe(DEFAULT_LIBRARY_ID)
    expect(index.libraries).toEqual([
      { id: DEFAULT_LIBRARY_ID, name: null, repoDir: 'vault', localDir: 'vault-local', createdAt: null, lastUnlockedAt: null }
    ])
    // AC-18：惰性建立 = 只在内存里，不落盘
    expect(existsSync(join(root, LIBRARY_INDEX_FILE))).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('默认库的两个目录与现状逐字相同（vault / vault-local）', () => {
    const root = freshRoot()
    const [entry] = readLibraryIndex(root).libraries
    const paths = resolveLibraryPaths(root, entry!)
    // 期望值现场拼，不从被测模块取常量自证
    expect(paths.repoDir).toBe(join(root, 'vault'))
    expect(paths.localDir).toBe(join(root, 'vault-local'))
  })

  it('新库落在 vaults/<id>/{repo,local}，与默认库物理隔离（AC-12）', () => {
    const root = freshRoot()
    const id = newLibraryId([])
    const entry = newLibraryEntry(id, '工作库')
    const paths = resolveLibraryPaths(root, entry)

    expect(entry.repoDir).toBe(`vaults/${id}/repo`)
    expect(entry.localDir).toBe(`vaults/${id}/local`)
    expect(paths.repoDir).toBe(join(root, 'vaults', id, 'repo'))
    expect(paths.localDir).toBe(join(root, 'vaults', id, 'local'))
    // 与默认库的目录互不包含
    expect(paths.repoDir.startsWith(join(root, 'vault') + '/')).toBe(false)
    expect(paths.localDir.startsWith(join(root, 'vault-local') + '/')).toBe(false)
  })

  it('索引里的逃逸路径被拒（索引是本机可手改文件）', () => {
    const root = freshRoot()
    const evil: LibraryEntry = { ...newLibraryEntry('lib-00000002', 'x'), repoDir: '../../etc' }
    expect(() => resolveLibraryPaths(root, evil)).toThrow(/must stay inside userData/)
  })
})

describe('多库索引：名称与目录判重（AC-14 拒绝覆盖）', () => {
  it('名称按 trim + 小写全等比较判重，默认库（name=null）不参与', () => {
    const root = freshRoot()
    const [lazy] = readLibraryIndex(root).libraries
    const existing: LibraryEntry[] = [lazy!, existingLibrary('Work')]

    expect(validateLibraryName(' work ', existing)).toEqual({ ok: false, field: 'name' })
    expect(validateLibraryName('WORK', existing)).toEqual({ ok: false, field: 'name' })
    expect(validateLibraryName('', existing)).toEqual({ ok: false, field: 'name' })
    expect(validateLibraryName('   ', existing)).toEqual({ ok: false, field: 'name' })
    expect(validateLibraryName('x'.repeat(65), existing)).toEqual({ ok: false, field: 'name' })
    // 正常名：返回 trim 后的值（落盘用的是这个值，不是原始输入）
    expect(validateLibraryName('  工作库  ', existing)).toEqual({ ok: true, name: '工作库' })
    expect(validateLibraryName('x'.repeat(64), existing)).toEqual({ ok: true, name: 'x'.repeat(64) })
  })

  it('目录已存在或 id 形状非法时拒绝，且不创建任何目录', () => {
    const root = freshRoot()
    const id = newLibraryId([])

    expect(ensureLibraryDirFree(root, id)).toEqual({ ok: true })
    expect(existsSync(join(root, 'vaults'))).toBe(false)

    mkdirSync(join(root, 'vaults', id), { recursive: true })
    expect(ensureLibraryDirFree(root, id)).toEqual({ ok: false, field: 'dir' })

    // 形状非法 / 复用保留 id：必须拒绝，否则会拼出路径穿越或覆盖老库目录
    for (const bad of [DEFAULT_LIBRARY_ID, '', '../evil', 'lib-0000000', 'lib-ZZZZZZZZ', 'a/b']) {
      expect(ensureLibraryDirFree(root, bad)).toEqual({ ok: false, field: 'dir' })
    }
    expect(existsSync(join(root, 'evil'))).toBe(false)
    expect(existsSync(join(root, 'a'))).toBe(false)
  })

  it('AC-14：两类拒绝都不改动任何字节（文件数 + sha256 快照前后相等）', () => {
    const root = freshRoot()
    // 造一份"已有老库 + 一个新库"的真实 userDataDir
    seedUserDataDir(root)
    writeFileSync(join(root, 'vault', 'vault.enc'), Buffer.from('cipher-bytes'))
    mkdirSync(join(root, 'vault', 'themes'), { recursive: true })
    writeFileSync(join(root, 'vault', 'themes', 'dark.json'), '{"name":"dark"}\n')
    mkdirSync(join(root, 'vault-local'), { recursive: true })
    writeFileSync(join(root, 'vault-local', 'local.json'), '{"version":2}\n')

    const taken = existingLibrary('Work', 'lib-abcdef01')
    mkdirSync(join(root, 'vaults', taken.id), { recursive: true })
    writeFileSync(join(root, 'vaults', taken.id, 'keep.txt'), 'keep\n')
    writeLibraryIndex(root, { version: 1, current: taken.id, libraries: [...readLibraryIndex(root).libraries, taken] })

    const before = snapshot(root)
    const index = readLibraryIndex(root)

    // 失败路径 1：同名
    const dupName = validateLibraryName('work', index.libraries)
    expect(dupName).toEqual({ ok: false, field: 'name' })
    // 失败路径 2：目录占用（真实流程里只有 ok:true 之后才会 mkdir / writeLibraryIndex）
    const dupDir = ensureLibraryDirFree(root, taken.id)
    expect(dupDir).toEqual({ ok: false, field: 'dir' })

    const after = snapshot(root)
    expect(Object.keys(after).length).toBe(Object.keys(before).length)
    expect(after).toEqual(before)
    // 额外钉一条：失败路径不许留下半成品（.tmp 残留 / 提前建出来的库目录）
    expect(existsSync(join(root, `${LIBRARY_INDEX_FILE}.tmp`))).toBe(false)
    expect(existsSync(join(root, 'vaults', newLibraryId([taken.id])))).toBe(false)
  })
})

describe('多库索引：读写往返与损坏容错', () => {
  it('写索引→读索引往返一致，且原子写不留 .tmp', () => {
    const root = freshRoot()
    const lazy = readLibraryIndex(root)
    const id = newLibraryId(lazy.libraries.map((entry) => entry.id))
    const entry = { ...newLibraryEntry(id, '工作库'), createdAt: '2026-11-01T00:00:00.000Z' }
    writeLibraryIndex(root, { version: 1, current: id, libraries: [...lazy.libraries, entry] })

    const read = readLibraryIndex(root)
    expect(read.current).toBe(id)
    expect(read.libraries).toEqual([...lazy.libraries, entry])
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(JSON.parse(readFileSync(join(root, LIBRARY_INDEX_FILE), 'utf8')).version).toBe(1)
  })

  it('索引损坏 / 缺默认库 / current 悬空都不掉库（AC-18 升级兼容）', () => {
    const root = freshRoot()
    const indexPath = join(root, LIBRARY_INDEX_FILE)

    writeFileSync(indexPath, '{"version":1, "libraries": [')
    expect(readLibraryIndex(root).libraries.map((entry) => entry.id)).toEqual([DEFAULT_LIBRARY_ID])

    writeFileSync(indexPath, 'null')
    expect(readLibraryIndex(root).current).toBe(DEFAULT_LIBRARY_ID)

    // 文件里没有 default 记录：读出来必须补回（否则老用户看到的是"库没了"）
    writeLibraryIndex(root, { version: 1, current: 'lib-11111111', libraries: [existingLibrary('A', 'lib-11111111')] })
    const repaired = readLibraryIndex(root)
    expect(repaired.libraries.map((entry) => entry.id)).toEqual([DEFAULT_LIBRARY_ID, 'lib-11111111'])
    expect(repaired.current).toBe('lib-11111111')

    // current 指向不存在的 id：回落默认库，列表仍完整
    writeFileSync(indexPath, JSON.stringify({ version: 1, current: 'nope', libraries: [] }))
    const fallen = readLibraryIndex(root)
    expect(fallen.current).toBe(DEFAULT_LIBRARY_ID)
    expect(fallen.libraries).toHaveLength(1)
  })
})

describe('多库索引：id 生成', () => {
  it('lib-<8hex>、互不重复、避开既有 id 与保留 id', () => {
    const ids: string[] = []
    for (let i = 0; i < 200; i += 1) {
      const id = newLibraryId(ids)
      expect(id).toMatch(/^lib-[0-9a-f]{8}$/)
      expect(id).not.toBe(DEFAULT_LIBRARY_ID)
      expect(ids).not.toContain(id)
      ids.push(id)
    }
    expect(new Set(ids).size).toBe(200)
    // 传进去的既有 id 一定被排除
    expect(newLibraryId([DEFAULT_LIBRARY_ID])).not.toBe(DEFAULT_LIBRARY_ID)
  })
})
