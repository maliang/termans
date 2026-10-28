import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from '../../src/main/store/json-store'

/**
 * 自写 JSON 存储的行为测试。
 *
 * 为什么不用 electron-store：它必须在 Electron 进程里跑，构造函数会摸 `app`，
 * 单测根本起不来；自写版本把目录作为参数注入，node 环境直接可测。
 */
interface Sample {
  counter: number
  items: string[]
}

const defaults = (): Sample => ({ counter: 0, items: [] })

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termans-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('JsonStore', () => {
  it('文件不存在时返回默认值，且不创建文件', () => {
    const store = new JsonStore<Sample>({ dir, fileName: 'sample.json', defaults })
    expect(store.read()).toEqual({ counter: 0, items: [] })
    expect(readdirSync(dir)).toEqual([])
  })

  it('写入后能读回，并被格式化成可 diff 的 JSON', () => {
    const store = new JsonStore<Sample>({ dir, fileName: 'sample.json', defaults })
    store.write({ counter: 3, items: ['a'] })
    const onDisk = readFileSync(join(dir, 'sample.json'), 'utf8')
    expect(onDisk).toContain('\n  "counter": 3')
    expect(onDisk.endsWith('\n')).toBe(true)
    expect(store.read()).toEqual({ counter: 3, items: ['a'] })
  })

  it('update 基于当前值修改并落盘', () => {
    const store = new JsonStore<Sample>({ dir, fileName: 'sample.json', defaults })
    store.update((current) => ({ ...current, counter: current.counter + 1 }))
    store.update((current) => ({ ...current, items: [...current.items, 'x'] }))
    expect(JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf8'))).toEqual({ counter: 1, items: ['x'] })
  })

  it('normalize 在读取时补齐历史缺字段', () => {
    writeFileSync(join(dir, 'sample.json'), JSON.stringify({ counter: 7 }))
    const store = new JsonStore<Sample>({
      dir,
      fileName: 'sample.json',
      defaults,
      normalize: (raw, fallback) => ({ ...fallback, ...(raw as Partial<Sample>) })
    })
    expect(store.read()).toEqual({ counter: 7, items: [] })
  })

  it('损坏文件被备份并以默认值启动（不抛，避免整个 App 起不来）', () => {
    writeFileSync(join(dir, 'sample.json'), '{not json')
    const store = new JsonStore<Sample>({ dir, fileName: 'sample.json', defaults })
    expect(store.read()).toEqual({ counter: 0, items: [] })
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
    expect(backups.length).toBe(1)
    expect(readFileSync(join(dir, backups[0] as string), 'utf8')).toBe('{not json')
  })

  it('reset 恢复到默认值', () => {
    const store = new JsonStore<Sample>({ dir, fileName: 'sample.json', defaults })
    store.write({ counter: 9, items: ['z'] })
    store.reset()
    expect(store.read()).toEqual({ counter: 0, items: [] })
  })
})
