import { mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearStaleSingletonLock, isProcessAlive, readSingletonLock } from '../singleton-lock'

const dirs: string[] = []
function makeUserDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'termans-lock-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('readSingletonLock', () => {
  it('没有 SingletonLock 时返回 null（首次启动的常态）', () => {
    expect(readSingletonLock(makeUserDataDir())).toBeNull()
  })

  it('解析 <hostname>-<pid> 形态', () => {
    const dir = makeUserDataDir()
    symlinkSync('maliangdeMacBook-Pro.local-48836', join(dir, 'SingletonLock'))
    expect(readSingletonLock(dir)).toEqual({
      target: 'maliangdeMacBook-Pro.local-48836',
      pid: 48836,
    })
  })

  it('目标不是 <host>-<pid> 形态（例如被替换成普通文件内容）时返回 null', () => {
    const dir = makeUserDataDir()
    writeFileSync(join(dir, 'SingletonLock'), 'garbage-without-pid')
    expect(readSingletonLock(dir)).toBeNull()
  })

  it('pid 为 0 或非数字时返回 null', () => {
    const dir = makeUserDataDir()
    symlinkSync('host-0', join(dir, 'SingletonLock'))
    expect(readSingletonLock(dir)).toBeNull()
  })
})

describe('isProcessAlive', () => {
  it('kill(pid,0) 成功 → 活着', () => {
    expect(isProcessAlive(1)).toBe(true)
  })

  it('ESRCH → 已死', () => {
    const err = Object.assign(new Error('no such process'), { code: 'ESRCH' })
    expect(isProcessAlive(99999, () => { throw err })).toBe(false)
  })

  it('EPERM → 探测不到但进程存在，按活着算（绝不能删锁）', () => {
    const err = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    expect(isProcessAlive(1, () => { throw err })).toBe(true)
  })
})

describe('clearStaleSingletonLock', () => {
  it('锁主已死 → 清掉三个伴随文件、warn 一次、返回 true', () => {
    const dir = makeUserDataDir()
    // 真实形态：SingletonLock 是符号链接，另外两个也是链接（这里只关心「被删掉」）
    symlinkSync('maliangdeMacBook-Pro.local-48836', join(dir, 'SingletonLock'))
    writeFileSync(join(dir, 'SingletonSocket'), '/tmp/dead-socket')
    writeFileSync(join(dir, 'SingletonCookie'), '42')
    const warn = vi.fn()
    expect(clearStaleSingletonLock(dir, { isAlive: () => false, warn })).toBe(true)
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      expect(existsSync(join(dir, name))).toBe(false)
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('陈旧 SingletonLock')
  })

  it('锁主还活着 → 一个文件都不动、不 warn、返回 false', () => {
    const dir = makeUserDataDir()
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      writeFileSync(join(dir, name), name)
    }
    const warn = vi.fn()
    const remove = vi.fn()
    expect(clearStaleSingletonLock(dir, { isAlive: () => true, warn, remove })).toBe(false)
    expect(remove).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      expect(existsSync(join(dir, name))).toBe(true)
    }
  })

  it('只有部分伴随文件存在时也能清理（残缺残留是常见形态）', () => {
    const dir = makeUserDataDir()
    symlinkSync('host-4242', join(dir, 'SingletonLock'))
    const warn = vi.fn()
    expect(clearStaleSingletonLock(dir, { isAlive: () => false, warn })).toBe(true)
    expect(existsSync(join(dir, 'SingletonLock'))).toBe(false)
  })

  it('删不掉文件时不抛异常（仍返回 true，由调用方重试抢锁决定最终结果）', () => {
    const dir = makeUserDataDir()
    symlinkSync('host-777', join(dir, 'SingletonLock'))
    const remove = vi.fn(() => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    })
    const warn = vi.fn()
    expect(clearStaleSingletonLock(dir, { isAlive: () => false, remove, warn })).toBe(true)
  })
})
