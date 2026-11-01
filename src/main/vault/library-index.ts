import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * 多库索引与目录判重（AC-10..AC-14 的**纯函数层**）。
 *
 * 为什么把这份「路径事实」关进一个独立的纯函数模块，而不是直接写在 hub 里：
 *
 * 1. **老安装零迁移（AC-18）** 的全部要求可以压缩成一句「默认库的 repoDir/localDir 与现状逐字相同」
 *    —— `userData/vault` + `userData/vault-local`。这句话写成常量 + 单测才能被钉住；散在 hub 的
 *    拼字符串里，一次重构就可能悄悄变成 `userData/vaults/default/repo`，那等于把老用户的主机库
 *    从眼皮底下搬走（用户看到的是"库空了"）。
 * 2. **AC-14 的「前后文件数与 sha256 不变」** 要求所有校验**前置于任何 mkdir/写盘**。把校验做成
 *    返回 `{ok:false}` 的纯判定（不抛异常、不建目录、不写文件），调用方就只能在拿到 `ok:true` 之后
 *    才动文件系统 —— 顺序由类型强制，而不是靠"记得先校验"。
 * 3. 名称判重口径（`trim()` + `toLowerCase()`）与目录判重口径（`existsSync`）必须**单点定义**：
 *    hub 负责编排，不负责判断。
 *
 * 目录布局（与 TECHNICAL §4.4 对齐，索引文件本身不进 Git）：
 *
 *     <userDataDir>/libraries.json                    索引（本机私有）
 *     <userDataDir>/vault/                            默认库的仓库区（manifest.json / vault.enc / themes）
 *     <userDataDir>/vault-local/                      默认库的本机私有区（local.json / session.json / …）
 *     <userDataDir>/vaults/<id>/repo/                 新库的仓库区
 *     <userDataDir>/vaults/<id>/local/                新库的本机私有区
 *
 * 索引里存的是**相对 userDataDir 的路径**，绝对路径由 `resolveLibraryPaths` 现场拼出来：
 * 这样 userDataDir 变化（换机、便携模式）时索引不需要重写，也不会把 `/Users/<用户名>/...`
 * 这类可识别信息写进任何可能被同步/贴进 issue 的文件。
 */

export const LIBRARY_INDEX_FILE = 'libraries.json'

/** 新库所在的父目录（相对 userDataDir） */
export const LIBRARIES_DIR = 'vaults'

/** 默认库 id。老安装没有索引文件时惰性返回的那一条记录用的就是它 */
export const DEFAULT_LIBRARY_ID = 'default'

/** 默认库的路径**必须与现状逐字相同**（AC-18）：`ipc/index.ts` 里的 `join(userDataDir,'vault')` */
const DEFAULT_REPO_DIR = 'vault'
const DEFAULT_LOCAL_DIR = 'vault-local'

/** 名称上限；与 `vaultLibraryCreateRequestSchema` 的 `.max(64)` 保持一致 */
const NAME_MAX_LENGTH = 64

/**
 * 新库 id 的**唯一合法形状**：`lib-<8hex>`（可读、可 grep、不含路径分隔符）。
 * 严到这个程度是故意的：id 会被拼进目录名，放宽成"任意不含分隔符的字符串"就等于允许
 * `lib-..` / `lib-0000000` 这类手工 id 与生成器的产物混在一起，日后没人说得清哪些库是
 * 程序建的、哪些是手改的；而 `default` 由 RESERVED_IDS 单独保留给老库。
 */
const LIBRARY_ID_PATTERN = /^lib-[0-9a-f]{8}$/

/** 允许出现在 id 里的字符集；`default` 保留给老库，禁止被当成新库 id 复用 */
const RESERVED_IDS: readonly string[] = [DEFAULT_LIBRARY_ID]

export interface LibraryPaths {
  /** 绝对路径：仓库区（进 Git 的那一半） */
  repoDir: string
  /** 绝对路径：本机私有区（绝不进 Git） */
  localDir: string
}

/** 索引里的一条库记录。`name === null` 表示默认库（渲染层用 i18n 兜底名，不把中文写进数据） */
export interface LibraryEntry {
  id: string
  name: string | null
  /** 相对 userDataDir */
  repoDir: string
  /** 相对 userDataDir */
  localDir: string
  createdAt: string | null
  lastUnlockedAt: string | null
}

export interface LibraryIndexFile {
  version: 1
  current: string
  libraries: LibraryEntry[]
}

/** 惰性默认索引：**不写盘**（AC-18：老安装升级后看到的就是这一条，索引文件等第一次真正变更时才落） */
function lazyDefaultIndex(): LibraryIndexFile {
  return {
    version: 1,
    current: DEFAULT_LIBRARY_ID,
    libraries: [defaultEntry()]
  }
}

function defaultEntry(): LibraryEntry {
  return {
    id: DEFAULT_LIBRARY_ID,
    name: null,
    repoDir: DEFAULT_REPO_DIR,
    localDir: DEFAULT_LOCAL_DIR,
    createdAt: null,
    lastUnlockedAt: null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(raw: unknown): LibraryEntry | null {
  if (!isRecord(raw)) return null
  const { id, repoDir, localDir } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof repoDir !== 'string' || repoDir.length === 0) return null
  if (typeof localDir !== 'string' || localDir.length === 0) return null
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : null
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : null
  const lastUnlockedAt = typeof raw.lastUnlockedAt === 'string' ? raw.lastUnlockedAt : null
  return { id, name, repoDir, localDir, createdAt, lastUnlockedAt }
}

/**
 * 把任意磁盘内容收敛成一份**可用的**索引。
 *
 * 收敛方向永远是"保住用户已有的库"：解析不出来的记录直接丢，但**默认库一定补回来**——
 * 索引坏掉/被手工删掉一条时，最坏结果是用户看到列表里少了一个新库，绝不能是"默认库不见了"，
 * 那会让老用户以为主机库被清空了（AC-18 / anti-goal）。
 */
function normalizeIndex(raw: unknown): LibraryIndexFile {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.libraries)) return lazyDefaultIndex()
  const libraries: LibraryEntry[] = []
  const seen = new Set<string>()
  for (const item of raw.libraries) {
    const entry = parseEntry(item)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    libraries.push(entry)
  }
  if (!seen.has(DEFAULT_LIBRARY_ID)) libraries.unshift(defaultEntry())
  const current = typeof raw.current === 'string' && libraries.some((entry) => entry.id === raw.current)
    ? raw.current
    : DEFAULT_LIBRARY_ID
  return { version: 1, current, libraries }
}

/**
 * 读索引。**不写盘**：文件不存在 ⇒ 返回惰性默认（老安装零迁移，AC-18）；
 * 文件损坏 ⇒ 同样返回惰性默认（宁可少显示一个库，也不能让解锁屏起不来）。
 */
export function readLibraryIndex(userDataDir: string): LibraryIndexFile {
  const indexPath = join(userDataDir, LIBRARY_INDEX_FILE)
  if (!existsSync(indexPath)) return lazyDefaultIndex()
  try {
    return normalizeIndex(JSON.parse(readFileSync(indexPath, 'utf8')))
  } catch {
    return lazyDefaultIndex()
  }
}

/**
 * 原子写索引：同目录 `.tmp` + rename。**不做任何校验**——校验属于 `validateLibraryName` /
 * `ensureLibraryDirFree`，必须在调用本函数之前完成（AC-14：失败路径一个字节都不写）。
 */
export function writeLibraryIndex(userDataDir: string, index: LibraryIndexFile): void {
  mkdirSync(userDataDir, { recursive: true })
  const indexPath = join(userDataDir, LIBRARY_INDEX_FILE)
  const tmpPath = `${indexPath}.tmp`
  const body = `${JSON.stringify(normalizeIndex(index), null, 2)}\n`
  try {
    writeFileSync(tmpPath, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, indexPath)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}

/**
 * 相对路径 → 绝对路径。索引是用户可以手改的本机文件，所以这里做一次**逃逸断言**：
 * 解析结果必须落在 userDataDir 之内且不等于 userDataDir 本身，否则直接抛——把一个
 * `../../../` 的 repoDir 交给 hub 的后果是"切库时写坏别人的目录"，比启动失败严重得多。
 */
function resolveInside(userDataDir: string, relative: string): string {
  const root = resolve(userDataDir)
  const target = resolve(root, relative)
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`library path must stay inside userData: ${relative}`)
  }
  return target
}

export function resolveLibraryPaths(userDataDir: string, entry: LibraryEntry): LibraryPaths {
  return {
    repoDir: resolveInside(userDataDir, entry.repoDir),
    localDir: resolveInside(userDataDir, entry.localDir)
  }
}

/** 新库的目录布局（相对 userDataDir）：`vaults/<id>/{repo,local}`，与默认库物理隔离（AC-12） */
function newLibraryDirs(id: string): Pick<LibraryEntry, 'repoDir' | 'localDir'> {
  return { repoDir: `${LIBRARIES_DIR}/${id}/repo`, localDir: `${LIBRARIES_DIR}/${id}/local` }
}

/**
 * 造一条新库记录（id/name 均由调用方先行校验）。**只造对象，不碰磁盘**——
 * 目录创建属于 `hub.createLibrary` 的编排步骤，且必须在所有校验通过之后。
 */
export function newLibraryEntry(id: string, name: string): LibraryEntry {
  return { id, name, ...newLibraryDirs(id), createdAt: null, lastUnlockedAt: null }
}

/**
 * 生成新库 id：`lib-<8hex>`。刻意**不用 randomUUID**——id 会出现在目录名、诊断区与日志里，
 * 36 位 uuid 既不可读也看不出"这是个库"；8 位十六进制在"本机几个库"这个量级下碰撞概率可忽略，
 * 且这里仍然对 `existing` 做了去重循环，不靠概率。
 */
export function newLibraryId(existing: string[]): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `lib-${randomBytes(4).toString('hex')}`
    if (!existing.includes(id) && !RESERVED_IDS.includes(id)) return id
  }
  /* istanbul ignore next: 1000 次 32 位随机都撞车，说明随机源坏了，抛出比返回重复 id 安全 */
  throw new Error('could not allocate a unique library id')
}

/**
 * 名称判重（AC-14）。返回 `{ok:false, field:'name'}` 时**调用方不许落盘**。
 * 口径：`trim()` 后非空、≤64 字符、与既有库名按 `toLowerCase()` 全等比较
 * （"Work" 与 "work " 视为同名——否则下拉里会出现两条看起来一样的库）。
 */
export function validateLibraryName(
  name: string,
  existing: LibraryEntry[]
): { ok: true; name: string } | { ok: false; field: 'name' } {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (trimmed.length === 0 || trimmed.length > NAME_MAX_LENGTH) return { ok: false, field: 'name' }
  const folded = trimmed.toLowerCase()
  const taken = existing.some((entry) => entry.name !== null && entry.name.trim().toLowerCase() === folded)
  if (taken) return { ok: false, field: 'name' }
  return { ok: true, name: trimmed }
}

/**
 * 目录判重（AC-14）：`vaults/<id>` 已存在就拒绝。
 *
 * 为什么不检查 `vaults/<id>/repo`：父目录的存在性是更强的判据（子目录存在 ⇒ 父目录必然存在），
 * 而反过来"父目录在、子目录不在"说明上一次创建崩在中途——那种半成品目录同样不能被复用
 * （它会带着上一轮的残留文件被当成新库），所以按父目录判。
 */
export function ensureLibraryDirFree(
  userDataDir: string,
  id: string
): { ok: true } | { ok: false; field: 'dir' } {
  if (!LIBRARY_ID_PATTERN.test(id) || RESERVED_IDS.includes(id)) return { ok: false, field: 'dir' }
  const dir = join(resolve(userDataDir), LIBRARIES_DIR, id)
  if (existsSync(dir)) return { ok: false, field: 'dir' }
  return { ok: true }
}
