import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 极小的原子 JSON 存储（替代 electron-store）。
 *
 * 为什么自己写而不用 electron-store：
 * - 只需要「读一次、改几次、写回」，不需要 schema/migration/watch 那一整套；
 * - 构造函数接收目录而不是读 `app.getPath('userData')`，**这样能在 vitest 里用临时目录直测**；
 * - 只有约 70 行，行为完全可读：写临时文件 → fsync 由 rename 保证原子替换，进程被杀不会留半截 JSON。
 *
 * 注意：所有方法都是同步的。设置项只有几 KB，异步会引入「并发写互相覆盖」的时序问题。
 */
export interface JsonStoreOptions<T> {
  /** 所在目录（不存在会自动创建） */
  dir: string
  /** 文件名，如 `settings.json` */
  fileName: string
  /** 文件不存在 / 损坏时的兜底值；传工厂函数可避免多个 store 共享同一个可变对象 */
  defaults: T | (() => T)
  /** 可选校验/规范化：读到的数据不合法时走默认值（并备份损坏文件） */
  normalize?: (raw: unknown, fallback: T) => T
}

export class JsonStore<T> {
  readonly filePath: string
  private readonly options: JsonStoreOptions<T>
  private cache: T | null = null

  constructor(options: JsonStoreOptions<T>) {
    this.options = options
    this.filePath = join(options.dir, options.fileName)
  }

  /** 读当前值（内存缓存，首次读盘） */
  read(): T {
    if (this.cache === null) this.cache = this.load()
    return this.cache
  }

  /** 覆盖写入 */
  write(value: T): T {
    mkdirSync(this.options.dir, { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${process.pid}`
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, this.filePath)
    this.cache = value
    return value
  }

  /** 读-改-写；`mutate` 返回值即新状态 */
  update(mutate: (current: T) => T): T {
    return this.write(mutate(this.read()))
  }

  /** 重置为默认值并落盘 */
  reset(): T {
    return this.write(this.resolveDefaults())
  }

  /** 兜底值：允许传工厂函数，保证每次拿到的都是干净对象 */
  private resolveDefaults(): T {
    const { defaults } = this.options
    return typeof defaults === 'function' ? (defaults as () => T)() : defaults
  }

  private load(): T {
    const defaults = this.resolveDefaults()
    const { normalize } = this.options
    if (!existsSync(this.filePath)) return defaults
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      return normalize ? normalize(raw, defaults) : (raw as T)
    } catch (error) {
      // 损坏文件不静默删除：改名留档，用户/开发者还能捞回内容
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`
      try {
        renameSync(this.filePath, backupPath)
        console.warn(`[json-store] ${this.filePath} unreadable (${String(error)}); backed up to ${backupPath}`)
      } catch (renameError) {
        console.warn(`[json-store] ${this.filePath} unreadable and could not be backed up: ${String(renameError)}`)
      }
      return defaults
    }
  }
}
