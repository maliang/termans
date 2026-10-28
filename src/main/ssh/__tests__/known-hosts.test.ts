import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_HOST_PUBLIC } from './helpers/keys'
import {
  JsonKnownHostsGateway,
  MemoryKnownHostsGateway,
  fingerprintSha256FromKey,
  formatKnownHostHost,
  hashKnownHostHost,
  matchesHostPattern,
  needsUserConfirmation,
  parseKnownHostsLine,
  verifyHostKey
} from '../known-hosts'

/**
 * known_hosts 的「地基」：指纹算法、host 匹配（含 hashed）、落盘语义。
 *
 * 指纹格式必须和 `ssh-keygen -lf` 完全一致——否则用户拿 ssh-keygen 对不上，会以为客户端算错了。
 * 这里直接调本机 ssh-keygen 做交叉验证（没有该命令时跳过，不静默通过）。
 */

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

/**
 * 返回公钥 blob（ssh 线格式）与 authorized_keys 单行（供 ssh-keygen 交叉验证）。
 * 用夹具里钉死的公钥：`generateKeyPairSync` 在 ssh2 1.17 上约 1/256 会产出坏密钥（详见 helpers/keys.ts）。
 */
function keyPair(): { publicKeyBlob: Buffer; publicKeyLine: string } {
  const parsed = utils.parseKey(FIXTURE_HOST_PUBLIC)
  if (parsed instanceof Error) throw parsed
  return { publicKeyBlob: parsed.getPublicSSH(), publicKeyLine: FIXTURE_HOST_PUBLIC }
}

describe('指纹', () => {
  it('SHA256 指纹 = ssh-keygen -lf 的输出（无 padding）', async () => {
    const { publicKeyBlob, publicKeyLine } = keyPair()
    const dir = await mkdtemp(join(tmpdir(), 'termans-kh-'))
    tempDirs.push(dir)
    const file = join(dir, 'id_ed25519.pub')
    await writeFile(file, `${publicKeyLine}\n`)

    let sshKeygenPrint: string | null = null
    try {
      sshKeygenPrint = execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' })
    } catch {
      sshKeygenPrint = null
    }
    const ours = fingerprintSha256FromKey(publicKeyBlob)
    expect(ours).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)

    if (sshKeygenPrint === null) {
      // 没有 ssh-keygen 的机器上至少验证「与 base64(sha256) 去 padding 一致」
      expect(ours).toBe(`SHA256:${createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')}`)
      return
    }
    expect(sshKeygenPrint).toContain(ours)
  })

  it('known_hosts 行可以解析（含 [host]:port 与 hashed）', () => {
    const { publicKeyBlob } = keyPair()
    const blob = publicKeyBlob.toString('base64')

    const plain = parseKnownHostsLine(`example.com ssh-ed25519 ${blob}`)
    expect(plain?.patterns).toEqual(['example.com'])
    expect(plain?.hashed).toBe(false)
    expect(plain?.keyType).toBe('ssh-ed25519')
    expect(plain?.fingerprintSha256).toBe(fingerprintSha256FromKey(publicKeyBlob))

    const multiple = parseKnownHostsLine(`a.example.com,b.example.com ssh-ed25519 ${blob}`)
    expect(multiple?.patterns).toEqual(['a.example.com', 'b.example.com'])

    const hashed = parseKnownHostsLine(`${hashKnownHostHost('example.com', 2222)} ssh-ed25519 ${blob}`)
    expect(hashed?.hashed).toBe(true)
    expect(matchesHostPattern(hashed!.patterns[0], 'example.com', 2222)).toBe(true)

    expect(parseKnownHostsLine('')).toBeNull()
    expect(parseKnownHostsLine('# comment')).toBeNull()
    expect(parseKnownHostsLine('only-two-fields')).toBeNull()
  })
})

describe('host 模式匹配', () => {
  it('端口 22 用裸 host，非 22 用 [host]:port', () => {
    expect(formatKnownHostHost('a.com', 22)).toBe('a.com')
    expect(formatKnownHostHost('a.com', 2222)).toBe('[a.com]:2222')

    // 裸主机名只比主机名；端口隔离由 KnownHostEntry.port 精确判定（见下一条）
    expect(matchesHostPattern('a.com', 'a.com', 22)).toBe(true)
    expect(matchesHostPattern('a.com', 'a.com', 2222)).toBe(true)
    // 带端口的模式必须端口也匹配（导入 known_hosts 文件时靠这条）
    expect(matchesHostPattern('[a.com]:2222', 'a.com', 2222)).toBe(true)
    expect(matchesHostPattern('[a.com]:2222', 'a.com', 22)).toBe(false)
  })

  it('端口隔离：22 端口的记录不能给 2222 端口作保（同主机不同端口是不同信任域）', async () => {
    const entry = {
      id: '6f1b1b1e-2222-4222-8222-222222222222',
      host: 'a.com',
      port: 22,
      keyType: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:AAA',
      hashed: false,
      addedAt: '2026-01-01T00:00:00.000Z',
      sourceFile: null
    }
    const gateway = new MemoryKnownHostsGateway([entry])
    expect(gateway.find('a.com', 2222)).toHaveLength(0)
    const verdict = await verifyHostKey(gateway, {
      host: 'a.com',
      port: 2222,
      keyType: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:AAA'
    })
    expect(verdict.status).toBe('unknown')
  })

  it('通配符与逗号列表', () => {
    expect(matchesHostPattern('*.example.com', 'db.example.com', 22)).toBe(true)
    expect(matchesHostPattern('*.example.com', 'example.com', 22)).toBe(false)
    expect(matchesHostPattern('a.com,b.com', 'b.com', 22)).toBe(true)
    expect(matchesHostPattern('db?.example.com', 'db1.example.com', 22)).toBe(true)
  })

  it('hashed 条目用 HMAC-SHA1 匹配（主机名不落明文）', () => {
    const hashed = hashKnownHostHost('secret.internal', 22)
    expect(hashed.startsWith('|1|')).toBe(true)
    expect(hashed).not.toContain('secret.internal')
    expect(matchesHostPattern(hashed, 'secret.internal', 22)).toBe(true)
    expect(matchesHostPattern(hashed, 'other.internal', 22)).toBe(false)
  })
})

describe('verifyHostKey：三种判定', () => {
  const entry = (fingerprint: string, keyType = 'ssh-ed25519') => ({
    id: '6f1b1b1e-1111-4111-8111-111111111111',
    host: 'a.com',
    port: 22,
    keyType,
    fingerprintSha256: fingerprint,
    hashed: false,
    addedAt: '2026-01-01T00:00:00.000Z',
    sourceFile: null
  })

  it('同类型同指纹 = trusted', async () => {
    const gateway = new MemoryKnownHostsGateway([entry('SHA256:AAA')])
    const verdict = await verifyHostKey(gateway, { host: 'a.com', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:AAA' })
    expect(verdict.status).toBe('trusted')
    expect(verdict.entry?.fingerprintSha256).toBe('SHA256:AAA')
  })

  it('同类型不同指纹 = mismatch（带旧记录，供 UI 对比）', async () => {
    const gateway = new MemoryKnownHostsGateway([entry('SHA256:AAA')])
    const verdict = await verifyHostKey(gateway, { host: 'a.com', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:BBB' })
    expect(verdict.status).toBe('mismatch')
    expect(verdict.entry?.fingerprintSha256).toBe('SHA256:AAA')
  })

  it('只有别的密钥类型 = unknown（服务器换 key 类型不算中间人）', async () => {
    const gateway = new MemoryKnownHostsGateway([entry('SHA256:AAA', 'ssh-rsa')])
    const verdict = await verifyHostKey(gateway, { host: 'a.com', port: 22, keyType: 'ssh-ed25519', fingerprintSha256: 'SHA256:BBB' })
    expect(verdict.status).toBe('unknown')
  })
})

describe('needsUserConfirmation：策略矩阵', () => {
  it('mismatch 永远要用户处理（任何策略都不能静默接受）', () => {
    for (const policy of ['strict', 'accept-new', 'ask'] as const) {
      expect(needsUserConfirmation(policy, 'mismatch')).toBe(true)
    }
  })

  it('trusted 只在 ask 时再确认', () => {
    expect(needsUserConfirmation('strict', 'trusted')).toBe(false)
    expect(needsUserConfirmation('accept-new', 'trusted')).toBe(false)
    expect(needsUserConfirmation('ask', 'trusted')).toBe(true)
  })

  it('unknown 只在 accept-new 时静默记录', () => {
    expect(needsUserConfirmation('strict', 'unknown')).toBe(true)
    expect(needsUserConfirmation('ask', 'unknown')).toBe(true)
    expect(needsUserConfirmation('accept-new', 'unknown')).toBe(false)
  })
})

describe('JsonKnownHostsGateway：落盘语义', () => {
  async function dir(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'termans-kh-json-'))
    tempDirs.push(value)
    return value
  }

  const trustRequest = (fingerprint: string) => ({
    host: 'a.com',
    port: 22,
    keyType: 'ssh-ed25519',
    fingerprintSha256: fingerprint,
    replaceExisting: false
  })

  it('信任后写文件，新实例能读回（重启不丢）', async () => {
    const base = await dir()
    const first = new JsonKnownHostsGateway({ dir: base })
    first.trust(trustRequest('SHA256:AAA'))

    const second = new JsonKnownHostsGateway({ dir: base })
    expect(second.list()).toHaveLength(1)
    expect(second.find('a.com', 22)[0].fingerprintSha256).toBe('SHA256:AAA')
  })

  it('重复信任同一指纹：幂等，不产生重复行、不刷新 addedAt', async () => {
    const base = await dir()
    let clock = new Date('2026-01-01T00:00:00.000Z')
    const gateway = new JsonKnownHostsGateway({ dir: base, now: () => clock })
    const first = gateway.trust(trustRequest('SHA256:AAA'))
    clock = new Date('2026-02-02T00:00:00.000Z')
    const second = gateway.trust(trustRequest('SHA256:AAA'))

    expect(gateway.list()).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(second.addedAt).toBe(first.addedAt)
  })

  it('同类型不同指纹且未 replaceExisting：拒绝写入（绝不静默覆盖）', async () => {
    const gateway = new JsonKnownHostsGateway({ dir: await dir() })
    gateway.trust(trustRequest('SHA256:AAA'))
    expect(() => gateway.trust(trustRequest('SHA256:BBB'))).toThrowError(/already trusted/i)
    expect(gateway.find('a.com', 22)[0].fingerprintSha256).toBe('SHA256:AAA')
  })

  it('replaceExisting=true：替换指纹但保留 id（用户手动确认过才走这条）', async () => {
    const gateway = new JsonKnownHostsGateway({ dir: await dir() })
    const first = gateway.trust(trustRequest('SHA256:AAA'))
    const replaced = gateway.trust({ ...trustRequest('SHA256:BBB'), replaceExisting: true })

    expect(replaced.id).toBe(first.id)
    expect(gateway.find('a.com', 22)[0].fingerprintSha256).toBe('SHA256:BBB')
    expect(gateway.list()).toHaveLength(1)
  })

  it('remove 返回是否真的删掉了（UI 要区分「删了」和「本来没有」）', async () => {
    const gateway = new JsonKnownHostsGateway({ dir: await dir() })
    gateway.trust(trustRequest('SHA256:AAA'))
    expect(gateway.remove({ host: 'a.com', port: 22 })).toBe(true)
    expect(gateway.remove({ host: 'a.com', port: 22 })).toBe(false)
    expect(gateway.list()).toHaveLength(0)
  })

  it('损坏的条目被丢弃，而不是让整个文件读不出来（一个坏行不能毁掉 known_hosts）', async () => {
    const base = await dir()
    const gateway = new JsonKnownHostsGateway({ dir: base })
    gateway.trust(trustRequest('SHA256:AAA'))
    const { writeFile: write } = await import('node:fs/promises')
    await write(
      gateway.filePath,
      JSON.stringify({ schemaVersion: 1, entries: [{ bogus: true }, { id: 'not-a-uuid' }] })
    )

    const reopened = new JsonKnownHostsGateway({ dir: base })
    expect(reopened.list()).toHaveLength(0)
  })
})
