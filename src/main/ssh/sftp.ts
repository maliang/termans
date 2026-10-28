import { posix as pathPosix } from 'node:path'
import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2'
import { SshError } from './errors'

/**
 * SFTP 基础操作（list / stat / mkdir / rename / rm / upload / download / chmod）。
 *
 * 三个刻意的选择：
 * 1. **所有远程路径都先 realpath**：`~`、相对路径、软链接目录在不同服务器上行为不一致，
 *    先归一化再操作，`path` 字段返回的才是用户能复制的绝对路径。
 * 2. **上传默认 0644、目录默认 0755**：这是最不意外的权限。用 fastPut 传 `mode`，
 *    让权限在 OPEN 那一刻就正确——先建 0600 再 chmod 会有一个短暂窗口，
 *    而且 chmod 失败时文件已经在那儿了（半成品）。
 * 3. **错误统一成 `sftp-failed`**：调用方（UI/AI）需要的是「哪个路径、什么操作、怎么修」，
 *    而不是 SFTP 的 13 种 status code。原始 code 放 details 里保留可诊断性。
 */

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface SftpEntry {
  name: string
  /** 绝对路径（已 realpath 归一） */
  path: string
  type: SftpEntryType
  size: number
  /** 原始 mode（含文件类型位） */
  mode: number
  /** 权限位，形如 `0644` */
  modeOctal: string
  mtimeMs: number
  uid: number
  gid: number
}

export interface SftpStat extends Omit<SftpEntry, 'name'> {
  name: string
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFREG = 0o100000
const S_IFLNK = 0o120000

export function typeFromMode(mode: number): SftpEntryType {
  const kind = mode & S_IFMT
  if (kind === S_IFDIR) return 'directory'
  if (kind === S_IFREG) return 'file'
  if (kind === S_IFLNK) return 'symlink'
  return 'other'
}

/** 权限位 → `0644` 形式。带类型位也可以（`0o100644` → `0644`） */
export function modeToOctal(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`
}

function wrapError(error: unknown, op: string, path: string): SshError {
  if (error instanceof SshError) return error
  const message = (error as Error)?.message ?? String(error)
  const sftpCode = (error as { code?: unknown }).code
  const hint =
    typeof sftpCode === 'number' && sftpCode === 2
      ? 'No such file or directory on the server. Check the path (remote paths are case-sensitive).'
      : typeof sftpCode === 'number' && sftpCode === 3
        ? 'Permission denied. Check the remote file mode/owner or use a user with write access.'
        : undefined
  return new SshError('sftp-failed', `SFTP ${op} failed for ${path}: ${message}`, {
    details: { op, path, sftpCode: typeof sftpCode === 'number' ? sftpCode : null },
    cause: error,
    hint
  })
}

export interface SftpClientOptions {
  /** 上传/下载并行度（默认 8；64 在慢链路上容易把对端 sftp-server 打满） */
  concurrency?: number
  chunkSize?: number
}

export class SftpClient {
  private readonly wrapper: SFTPWrapper
  private readonly options: Required<SftpClientOptions>
  private closed = false

  constructor(wrapper: SFTPWrapper, options: SftpClientOptions = {}) {
    this.wrapper = wrapper
    this.options = {
      concurrency: options.concurrency ?? 8,
      chunkSize: options.chunkSize ?? 32 * 1024
    }
  }

  /** 在已认证的连接上打开 SFTP 子系统 */
  static open(client: Client, options: SftpClientOptions = {}): Promise<SftpClient> {
    return new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) {
          reject(
            new SshError('sftp-failed', `Cannot open SFTP subsystem: ${error.message}`, {
              cause: error,
              hint: 'The server may have disabled the SFTP subsystem (sshd_config Subsystem sftp).'
            })
          )
          return
        }
        resolve(new SftpClient(sftp, options))
      })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.wrapper.end()
    } catch {
      /* 连接已经断了，无需再报 */
    }
  }

  async realpath(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.wrapper.realpath(path, (error, resolved) => {
        if (error) reject(wrapError(error, 'realpath', path))
        else resolve(resolved)
      })
    })
  }

  private async resolvePath(path: string): Promise<string> {
    if (path.startsWith('/')) return pathPosix.normalize(path)
    try {
      return await this.realpath(path)
    } catch {
      // 远端不支持 REALPATH 时不阻塞操作（部分极简 server 会拒绝），退回原路径
      return path
    }
  }

  async list(path = '.'): Promise<SftpEntry[]> {
    const dir = await this.resolvePath(path)
    const entries = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
      this.wrapper.readdir(dir, (error, list) => {
        if (error) reject(wrapError(error, 'list', dir))
        else resolve(list)
      })
    })
    return entries
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => {
        // readdir 的 longname 里带类型标记，但 attrs.mode 才是权威
        const mode = entry.attrs.mode
        return {
          name: entry.filename,
          path: pathPosix.join(dir, entry.filename),
          type: typeFromMode(mode),
          size: entry.attrs.size,
          mode,
          modeOctal: modeToOctal(mode),
          mtimeMs: (entry.attrs.mtime ?? 0) * 1000,
          uid: entry.attrs.uid,
          gid: entry.attrs.gid
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async stat(path: string): Promise<SftpStat> {
    const target = await this.resolvePath(path)
    const stats = await new Promise<Stats>((resolve, reject) => {
      this.wrapper.stat(target, (error, value) => {
        if (error) reject(wrapError(error, 'stat', target))
        else resolve(value)
      })
    })
    return toStat(target, stats)
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path)
      return true
    } catch {
      return false
    }
  }

  /** mkdir -p：已存在不算错（多页签同时建目录是常见竞态） */
  async mkdir(path: string, mode = 0o755): Promise<void> {
    const target = pathPosix.normalize(path).replace(/\/+$/, '')
    if (target === '' || target === '/') return
    try {
      await this.mkdirOnce(target, mode)
      return
    } catch (error) {
      const parent = pathPosix.dirname(target)
      if (parent === target) throw error
      await this.mkdir(parent, mode)
      await this.mkdirOnce(target, mode)
    }
  }

  private async mkdirOnce(path: string, mode: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.wrapper.mkdir(path, { mode }, (error) => {
        if (error) reject(wrapError(error, 'mkdir', path))
        else resolve()
      })
    }).catch(async (error: unknown) => {
      // OpenSSH 对「已存在」只回 SFTP Failure（没有 EEXIST 语义），
      // 所以 -p 的幂等只能靠再 stat 一次确认：是目录就算成功，否则照原错误抛。
      const existing = await this.stat(path).catch(() => null)
      if (existing?.type === 'directory') return
      throw error
    })
  }

  async rename(from: string, to: string): Promise<void> {
    const source = await this.resolvePath(from)
    const dest = await this.resolvePath(to)
    await new Promise<void>((resolve, reject) => {
      this.wrapper.rename(source, dest, (error) => {
        if (error) reject(wrapError(error, 'rename', `${source} → ${dest}`))
        else resolve()
      })
    })
  }

  async chmod(path: string, mode: number): Promise<void> {
    const target = await this.resolvePath(path)
    await new Promise<void>((resolve, reject) => {
      this.wrapper.chmod(target, mode, (error) => {
        if (error) reject(wrapError(error, 'chmod', target))
        else resolve()
      })
    })
  }

  /**
   * 删除。目录默认**不递归**（rm -r 是危险动作，必须显式请求）：
   * 默认走 rmdir，非空目录会失败并提示「目录非空」——这比「悄悄删掉整棵树」安全得多。
   */
  async remove(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = await this.resolvePath(path)
    const info = await this.stat(target)
    if (info.type === 'directory') {
      if (options.recursive) {
        const children = await this.list(target)
        for (const child of children) {
          await this.remove(child.path, { recursive: true })
        }
      }
      await new Promise<void>((resolve, reject) => {
        this.wrapper.rmdir(target, (error) => {
          if (error) reject(wrapError(error, 'rmdir', target))
          else resolve()
        })
      })
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.wrapper.unlink(target, (error) => {
        if (error) reject(wrapError(error, 'rm', target))
        else resolve()
      })
    })
  }

  async upload(
    localPath: string,
    remotePath: string,
    options: { mode?: number } = {}
  ): Promise<{ path: string; mode: string }> {
    const target = await this.resolvePath(remotePath)
    const mode = options.mode ?? 0o644
    await new Promise<void>((resolve, reject) => {
      this.wrapper.fastPut(
        localPath,
        target,
        { mode, concurrency: this.options.concurrency, chunkSize: this.options.chunkSize },
        (error) => {
          if (error) reject(wrapError(error, 'upload', `${localPath} → ${target}`))
          else resolve()
        }
      )
    })
    return { path: target, mode: modeToOctal(mode) }
  }

  async download(remotePath: string, localPath: string): Promise<{ path: string; bytes: number }> {
    const target = await this.resolvePath(remotePath)
    const info = await this.stat(target)
    await new Promise<void>((resolve, reject) => {
      this.wrapper.fastGet(
        target,
        localPath,
        { concurrency: this.options.concurrency, chunkSize: this.options.chunkSize },
        (error) => {
          if (error) reject(wrapError(error, 'download', `${target} → ${localPath}`))
          else resolve()
        }
      )
    })
    return { path: target, bytes: info.size }
  }

  /** 直接写一段内容（配置下发、注入脚本用） */
  async writeFile(remotePath: string, data: Buffer | string, mode = 0o644): Promise<{ path: string; bytes: number }> {
    const target = await this.resolvePath(remotePath)
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    await new Promise<void>((resolve, reject) => {
      this.wrapper.writeFile(target, buffer, { mode }, (error) => {
        if (error) reject(wrapError(error, 'writeFile', target))
        else resolve()
      })
    })
    return { path: target, bytes: buffer.length }
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const target = await this.resolvePath(remotePath)
    return new Promise<Buffer>((resolve, reject) => {
      this.wrapper.readFile(target, (error, data) => {
        if (error) reject(wrapError(error, 'readFile', target))
        else resolve(data)
      })
    })
  }
}

function toStat(path: string, stats: Stats): SftpStat {
  return {
    name: pathPosix.basename(path),
    path,
    type: typeFromMode(stats.mode),
    size: stats.size,
    mode: stats.mode,
    modeOctal: modeToOctal(stats.mode),
    mtimeMs: (stats.mtime ?? 0) * 1000,
    uid: stats.uid,
    gid: stats.gid
  }
}
