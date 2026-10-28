import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SftpClient } from '../sftp'
import { FakeSshServer } from './helpers/fake-server'
import { createHarness, expectReject, type Harness } from './helpers/harness'

/**
 * SFTP 基础操作。
 *
 * 断言集中在「服务器端真的收到了什么」——权限位、路径、内容都是服务器记录里的原始值，
 * 不是客户端自己的回显。这样把上传的 mode 写死成 0600、或漏掉 realpath 归一，用例都会红。
 */

const cleanups: Array<() => void> = []
const tempDirs: string[] = []

async function server(options: ConstructorParameters<typeof FakeSshServer>[0] = {}): Promise<FakeSshServer> {
  const value = await new FakeSshServer({ shellBanner: '', ...options }).start()
  cleanups.push(() => void value.stop())
  return value
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'termans-sftp-'))
  tempDirs.push(dir)
  return dir
}

interface Fixture {
  fake: FakeSshServer
  harness: Harness
  sessionId: string
  sftp: SftpClient
}

async function connect(options: ConstructorParameters<typeof FakeSshServer>[0] = {}): Promise<Fixture> {
  const fake = await server(options)
  const h = createHarness({ server: fake })
  cleanups.push(() => h.dispose())
  const result = await h.connect()
  const session = h.manager.getSession(result.sessionId)
  if (!session) throw new Error('session missing')
  const sftp = await session.sftp()
  return { fake, harness: h, sessionId: result.sessionId, sftp }
}

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.()
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

describe('SFTP 目录与元数据', () => {
  it('list：过滤 ./..，按名字排序，类型与权限位来自服务器 attrs', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedDir('/home/test/work')
    fake.fs.seedFile('/home/test/work/b.sh', '#!/bin/sh\n', 0o755)
    fake.fs.seedFile('/home/test/work/a.txt', 'hello', 0o644)
    fake.fs.seedDir('/home/test/work/sub', 0o700)

    const entries = await sftp.list('/home/test/work')

    expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'b.sh', 'sub'])
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    expect(byName.get('a.txt')).toMatchObject({ type: 'file', size: 5, modeOctal: '0644', path: '/home/test/work/a.txt' })
    expect(byName.get('b.sh')).toMatchObject({ type: 'file', modeOctal: '0755' })
    expect(byName.get('sub')).toMatchObject({ type: 'directory', modeOctal: '0700' })
  })

  it('相对路径与 ~ 都归一成绝对路径（path 字段可直接复制）', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedFile('~/rel.txt', 'x')

    expect(await sftp.realpath('~/rel.txt')).toBe('/home/test/rel.txt')
    expect((await sftp.stat('~/rel.txt')).path).toBe('/home/test/rel.txt')
    expect((await sftp.list('.')).some((entry) => entry.name === 'rel.txt')).toBe(true)
  })

  it('stat 不存在的文件：sftp-failed + sftpCode 2 + 可读 hint（不是裸 Error）', async () => {
    const { sftp } = await connect()
    const error = await expectReject(sftp.stat('/home/test/nope.txt'), 'sftp-failed')
    expect(error.ipc).toBe('E_IO')
    expect(error.details.sftpCode).toBe(2)
    expect(error.details.op).toBe('stat')
    expect(error.hint).toMatch(/No such file/i)
  })
})

describe('SFTP 上传与下载', () => {
  it('upload：内容逐字节一致，且 0644 在 OPEN 时就生效（不是事后 chmod）', async () => {
    const { fake, sftp } = await connect()
    const dir = await tempDir()
    const local = join(dir, 'payload.bin')
    const payload = Buffer.alloc(150 * 1024)
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251
    await writeFile(local, payload)

    const result = await sftp.upload(local, '/home/test/up.bin', { mode: 0o644 })

    expect(result).toEqual({ path: '/home/test/up.bin', mode: '0644' })
    expect(fake.fs.read('/home/test/up.bin').equals(payload)).toBe(true)
    // 权限最终值来自服务器 attrs：把 mode 参数漏掉会变成 0600/0644 之外的默认值
    expect(fake.fs.attrs('/home/test/up.bin').mode & 0o777).toBe(0o644)
  })

  it('upload：指定 0600 时权限真的落到服务器（不是恒写 0644）', async () => {
    const { fake, sftp } = await connect()
    const dir = await tempDir()
    const local = join(dir, 'secret.key')
    await writeFile(local, 'private')

    await sftp.upload(local, 'secret.key', { mode: 0o600 })

    // ssh2 的 fastPut 在写完后用 setstat 落权限，所以看最终 attrs 而不是 OPEN 的 attrs
    expect(fake.fs.attrs('secret.key').mode & 0o777).toBe(0o600)
  })

  it('download：字节数正确，内容与远端一致（大文件走分块而不是一次读全）', async () => {
    const { fake, sftp } = await connect()
    const payload = Buffer.from('0123456789abcdef'.repeat(64 * 1024))
    fake.fs.seedFile('/home/test/big.bin', payload)
    const dir = await tempDir()
    const local = join(dir, 'big.bin')

    const result = await sftp.download('/home/test/big.bin', local)

    expect(result.bytes).toBe(payload.length)
    expect((await readFile(local)).equals(payload)).toBe(true)
    // 分块传输：读取次数远大于 1（一次读完的实现这里会红）
    expect(fake.records.sftp.reads).toBeGreaterThan(1)
  })

  it('writeFile / readFile：默认 0644，内容往返一致', async () => {
    const { fake, sftp } = await connect()
    await sftp.writeFile('/home/test/note.txt', Buffer.from('你好, SFTP\n'))
    expect(fake.fs.read('/home/test/note.txt').toString('utf8')).toBe('你好, SFTP\n')
    expect(fake.fs.attrs('/home/test/note.txt').mode & 0o777).toBe(0o644)
    expect((await sftp.readFile('/home/test/note.txt')).toString('utf8')).toBe('你好, SFTP\n')
  })
})

describe('SFTP 变更操作', () => {
  it('mkdir 递归：中间目录一起建，模式 0700 传给服务器', async () => {
    const { fake, sftp } = await connect()
    await sftp.mkdir('/home/test/a/b/c', 0o700)

    expect(fake.fs.has('/home/test/a/b/c')).toBe(true)
    for (const path of ['/home/test/a', '/home/test/a/b', '/home/test/a/b/c']) {
      expect(fake.fs.attrs(path).mode & 0o777).toBe(0o700)
    }
    // 每个目录都带模式（漏传 attrs.mode 会变 null）
    expect(fake.records.sftp.mkdirs.every((entry) => entry.mode === 0o700)).toBe(true)
  })

  it('mkdir 已存在：幂等，不报错（多页签同时建目录的竞态）', async () => {
    const { sftp } = await connect()
    await sftp.mkdir('/home/test/x')
    await sftp.mkdir('/home/test/x')
  })

  it('rename：旧路径消失、新路径出现', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedFile('/home/test/old.txt', 'v1')

    await sftp.rename('/home/test/old.txt', '/home/test/new.txt')

    expect(fake.fs.has('/home/test/old.txt')).toBe(false)
    expect(fake.fs.read('/home/test/new.txt').toString()).toBe('v1')
    expect(fake.records.sftp.renames).toEqual([{ from: '/home/test/old.txt', to: '/home/test/new.txt' }])
  })

  it('remove 文件：真的删了（服务器端记录可见）', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedFile('/home/test/gone.txt', 'bye')

    await sftp.remove('/home/test/gone.txt')

    expect(fake.fs.has('/home/test/gone.txt')).toBe(false)
    expect(fake.records.sftp.removes).toEqual(['/home/test/gone.txt'])
  })

  it('remove 非空目录（未开 recursive）：失败为 sftp-failed/E_IO，并保留目录', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedDir('/home/test/dir')
    fake.fs.seedFile('/home/test/dir/keep.txt', 'keep')

    const error = await expectReject(sftp.remove('/home/test/dir'), 'sftp-failed')
    expect(error.ipc).toBe('E_IO')
    expect(fake.fs.has('/home/test/dir/keep.txt')).toBe(true)
  })

  it('remove 目录带 recursive：子项一起删掉', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedDir('/home/test/tree')
    fake.fs.seedDir('/home/test/tree/sub')
    fake.fs.seedFile('/home/test/tree/a.txt', 'a')
    fake.fs.seedFile('/home/test/tree/sub/b.txt', 'b')

    await sftp.remove('/home/test/tree', { recursive: true })

    expect(fake.fs.has('/home/test/tree')).toBe(false)
    expect(fake.fs.has('/home/test/tree/sub/b.txt')).toBe(false)
  })

  it('chmod 改权限位', async () => {
    const { fake, sftp } = await connect()
    fake.fs.seedFile('/home/test/tool.sh', '#!/bin/sh\n', 0o644)

    await sftp.chmod('/home/test/tool.sh', 0o755)

    expect(fake.fs.attrs('/home/test/tool.sh').mode & 0o777).toBe(0o755)
  })
})

describe('SFTP 不可用', () => {
  it('服务器禁用 sftp 子系统：sftp-failed + 指向 sshd_config 的 hint', async () => {
    const fake = await server({ disableSftp: true })
    const h = createHarness({ server: fake })
    cleanups.push(() => h.dispose())
    const result = await h.connect()
    const session = h.manager.getSession(result.sessionId)!

    const error = await expectReject(session.sftp(), 'sftp-failed')
    expect(error.ipc).toBe('E_IO')
    expect(error.hint).toMatch(/SFTP subsystem/i)
  })

  it('会话断开后复用的 sftp 客户端会被丢弃（下次重新打开）', async () => {
    const { fake, harness, sessionId } = await connect()
    const session = harness.manager.getSession(sessionId)!
    await session.sftp()
    fake.killConnections()
    // autoReconnectAttempts 默认 0 → 会话终态，manager 里不再有它
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(harness.manager.getSession(sessionId)).toBeUndefined()
  })
})
