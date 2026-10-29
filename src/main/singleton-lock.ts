import { readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Electron 单实例锁的「陈旧锁」自愈。
 *
 * 背景：应用被强杀或崩溃后，`<userData>` 下会残留三个符号链接：
 * - `SingletonLock`   → 目标形如 `<hostname>-<pid>`；
 * - `SingletonSocket` → 指向本实例的 unix socket；
 * - `SingletonCookie` → 指向 socket 的 cookie。
 *
 * 此时 `app.requestSingleInstanceLock()` 可能返回 false 而实际没有任何活实例，
 * 主进程若直接 `app.quit()`，用户看到的就是「双击图标毫无反应：进程 0、无窗口、无报错、退出码 0」。
 * 实测就发生过一次（lock 指向已不存在的 pid，socket 落在已被删除的临时目录里）。
 *
 * 这里的策略很克制：**只有锁里那个 pid 确实已经死了**才清理，活实例（包括 `EPERM` 探测不到的
 * 其他用户进程）一律不动，单实例语义不受影响。
 */

const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'] as const

export interface SingletonLockDeps {
  readlink?: (path: string) => string
  remove?: (path: string) => void
  isAlive?: (pid: number) => boolean
  warn?: (message: string) => void
}

/** 读 `SingletonLock` 的 readlink 目标并解析出 pid；不是 `<host>-<pid>` 形态就返回 null */
export function readSingletonLock(
  userDataDir: string,
  readlink: (path: string) => string = readlinkSync,
): { target: string; pid: number } | null {
  try {
    const target = readlink(join(userDataDir, 'SingletonLock'))
    const match = /-(\d+)$/.exec(target)
    if (!match) return null
    const pid = Number(match[1])
    return Number.isInteger(pid) && pid > 0 ? { target, pid } : null
  } catch {
    // 不存在 / 不是符号链接 / 平台不支持（Windows 用别的机制）——统一按「读不出」处理
    return null
  }
}

/**
 * pid 是否还活着。`process.kill(pid, 0)` 不发信号，只做存在性探测：
 * - 成功  → 活着；
 * - EPERM → 进程存在但当前用户无权探测（不同用户/系统进程）→ 按活着算，绝不删锁；
 * - ESRCH → 进程不存在 → 陈旧锁。
 */
export function isProcessAlive(
  pid: number,
  kill: (pid: number, signal?: number) => true = process.kill,
): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 判定并清理陈旧单实例锁：只有「锁指向的 pid 确实已死」才动手。
 *
 * @returns 是否真的清理过——真有活实例时永远返回 false。
 */
export function clearStaleSingletonLock(
  userDataDir: string,
  deps: SingletonLockDeps = {},
): boolean {
  const readlink = deps.readlink ?? readlinkSync
  const remove = deps.remove ?? ((path: string) => rmSync(path, { force: true }))
  const isAlive = deps.isAlive ?? ((pid: number) => isProcessAlive(pid))
  const warn = deps.warn ?? ((message: string) => console.warn(message))

  const lock = readSingletonLock(userDataDir, readlink)
  if (!lock) return false
  if (isAlive(lock.pid)) return false

  for (const name of SINGLETON_FILES) {
    try {
      remove(join(userDataDir, name))
    } catch {
      // 删不掉也别中断：调用方随后还会重试一次抢锁，真抢不到再退出
    }
  }

  // 不许静默清理：崩溃残留是「双击没反应」类问题的头号嫌疑，必须留下可追溯的一行
  warn(
    `[main] 发现陈旧 SingletonLock（${lock.target}，pid ${lock.pid} 已不存在），已清理并重试单实例锁`,
  )
  return true
}
