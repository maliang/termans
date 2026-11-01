import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  SCRYPT_PRODUCTION,
  SCRYPT_TEST,
  VaultCryptoError,
  assertCostWithinBounds,
  assertIntegrity,
  assertKdfSalt,
  assertSlotBinding,
  createVault,
  estimateKdfMemoryBytes,
  keywrapDigest,
  openVault,
  parseEnvelope,
  payloadDigest,
  resealPassphraseSlot,
  resealPayload,
  rewrapVault,
  serializeEnvelope,
  sha256Hex,
  slotFingerprint,
  zeroize,
  type ScryptCost,
  type VaultManifest
} from './envelope'
import { generateRecoveryCode } from './passphrase'

/**
 * 加密核心的守门测试。
 *
 * 每一条断言对应一条威胁模型：
 * - 口令错 ≠ 数据损坏（两者的错误码不同，UI 提示也不同）；
 * - 篡改 1 bit 必须失败（GCM 认证 + 摘要双保险）；
 * - 仓库里不能出现明文（`vault.enc` / `manifest.json` 都不含 payload 片段）；
 * - 轮换口令后，**旧快照用旧口令仍然可解**（这正是「A 机轮换、B 机还在用旧副本」的语义）。
 */

const PAYLOAD = JSON.stringify({
  schemaVersion: 1,
  hosts: [{ id: 'h1', label: 'prod-web-01', hostname: '10.20.30.40', port: 22 }],
  note: 'plaintext-marker-下发给 B 机的明文 json'
})
const PASSPHRASE = 'correct horse battery staple'
const NEXT_PASSPHRASE = 'another very long passphrase 42'

function newVault(cost: ScryptCost = SCRYPT_TEST, recoveryCode = generateRecoveryCode()) {
  const created = createVault({ payload: PAYLOAD, passphrase: PASSPHRASE, recoveryCode, cost })
  return { ...created, recoveryCode }
}

function expectCryptoError(fn: () => unknown, reason: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(VaultCryptoError)
    expect((error as VaultCryptoError).reason).toBe(reason)
    return
  }
  throw new Error(`expected VaultCryptoError(${reason})`)
}

describe('envelope / createVault + openVault', () => {
  it('口令往返：解出的 payload 与内存里的完全一致', () => {
    const { manifest, encBytes } = newVault()
    const opened = openVault({ manifest, encBytes, credential: { passphrase: PASSPHRASE } })
    expect(opened.payload).toBe(PAYLOAD)
    expect(opened.slot).toBe('passphrase')
    expect(opened.vaultKey).toHaveLength(32)
    zeroize(opened.vaultKey)
  })

  it('恢复码也能解出同一个 VMK（同一份数据两个入口）', () => {
    const { manifest, encBytes, vaultKey, recoveryCode } = newVault()
    const opened = openVault({ manifest, encBytes, credential: { recoveryCode } })
    expect(opened.payload).toBe(PAYLOAD)
    expect(opened.slot).toBe('recovery')
    expect(opened.vaultKey.equals(vaultKey)).toBe(true)
    // 恢复码接受带分隔符/小写/易混字符的输入（Crockford base32 的 O→0、I/L→1）
    const sloppy = recoveryCode.replace(/-/g, '').toLowerCase()
    expect(openVault({ manifest, encBytes, credential: { recoveryCode: sloppy } }).payload).toBe(PAYLOAD)
  })

  it('口令错 → bad-passphrase（不是 corrupt）', () => {
    const { manifest, encBytes } = newVault()
    expectCryptoError(() => openVault({ manifest, encBytes, credential: { passphrase: 'wrong passphrase!!' } }), 'bad-passphrase')
  })

  it('恢复码错 → bad-recovery-code', () => {
    const { manifest, encBytes } = newVault()
    expectCryptoError(
      () => openVault({ manifest, encBytes, credential: { recoveryCode: generateRecoveryCode() } }),
      'bad-recovery-code'
    )
  })

  it('manifest 里没有任何明文 payload / 口令', () => {
    const { manifest, encBytes } = newVault()
    const manifestJson = JSON.stringify(manifest)
    const encJson = encBytes.toString('utf8')
    for (const needle of ['10.20.30.40', 'prod-web-01', PASSPHRASE, 'plaintext-marker']) {
      expect(manifestJson).not.toContain(needle)
      expect(encJson).not.toContain(needle)
    }
    // 结构本身就是「明文元数据 + 密文」，不该有 hosts 字段
    expect(manifestJson).not.toContain('hosts')
  })

  it('每次加密都用新 nonce（同 payload 两次密文不同）', () => {
    const a = createVault({ payload: PAYLOAD, passphrase: PASSPHRASE, recoveryCode: generateRecoveryCode(), cost: SCRYPT_TEST })
    const b = createVault({ payload: PAYLOAD, passphrase: PASSPHRASE, recoveryCode: generateRecoveryCode(), cost: SCRYPT_TEST })
    expect(a.encBytes.toString('utf8')).not.toBe(b.encBytes.toString('utf8'))
    expect(parseEnvelope(a.encBytes).nonce).not.toBe(parseEnvelope(b.encBytes).nonce)
  })
})

describe('envelope / 篡改与损坏必须失败', () => {
  it('vault.enc 改 1 bit → corrupt（摘要不符）', () => {
    const { manifest, encBytes } = newVault()
    const tampered = Buffer.from(encBytes)
    // 改在 base64 密文中间，保证 JSON 还能解析
    const idx = tampered.indexOf(Buffer.from('"ciphertext":"')) + 20
    tampered[idx] = tampered[idx] === 0x41 ? 0x42 : 0x41
    expectCryptoError(() => openVault({ manifest, encBytes: tampered, credential: { passphrase: PASSPHRASE } }), 'corrupt')
  })

  it('密文 D 改 1 bit 且摘要同步重算 → 仍然 corrupt（GCM 认证失败），绝不回退明文', () => {
    const { manifest, encBytes } = newVault()
    const envelope = parseEnvelope(encBytes)
    const raw = Buffer.from(envelope.ciphertext, 'base64')
    raw[0] ^= 0x01
    const forged = serializeEnvelope({ ...envelope, ciphertext: raw.toString('base64') })
    const forgedManifest: VaultManifest = { ...manifest, payload_sha256: payloadDigest(forged) }
    expectCryptoError(
      () => openVault({ manifest: forgedManifest, encBytes: forged, credential: { passphrase: PASSPHRASE } }),
      'corrupt'
    )
  })

  it('口令密钥槽改 1 bit → corrupt（keywrap 摘要不符），不会被误报成「口令错」', () => {
    const { manifest, encBytes } = newVault()
    const key = Buffer.from(manifest.passphraseKey.ciphertext, 'base64')
    key[0] ^= 0x01
    const forged: VaultManifest = {
      ...manifest,
      passphraseKey: { ...manifest.passphraseKey, ciphertext: key.toString('base64') }
    }
    expectCryptoError(() => openVault({ manifest: forged, encBytes, credential: { passphrase: PASSPHRASE } }), 'corrupt')
  })

  it('manifest 的 kdf 参数被改小（想降低爆破成本）→ corrupt（摘要覆盖 kdf）', () => {
    const { manifest, encBytes } = newVault()
    const forged: VaultManifest = { ...manifest, kdf: { ...manifest.kdf, N: manifest.kdf.N / 2 } }
    expectCryptoError(() => openVault({ manifest: forged, encBytes, credential: { passphrase: PASSPHRASE } }), 'corrupt')
  })

  it('manifest.kdf 与 vault.enc.kdf 不一致 → corrupt', () => {
    const { manifest, encBytes } = newVault()
    const envelope = parseEnvelope(encBytes)
    const flipped = serializeEnvelope({ ...envelope, kdf: { ...envelope.kdf, r: envelope.kdf.r + 1 } })
    const forgedManifest: VaultManifest = { ...manifest, payload_sha256: payloadDigest(flipped) }
    expectCryptoError(
      () => openVault({ manifest: forgedManifest, encBytes: flipped, credential: { passphrase: PASSPHRASE } }),
      'corrupt'
    )
  })

  it('scrypt 参数越界 → bad-params（防恶意仓库把 N 拉到 2^22 撑爆内存；新上限见下面两道闸门用例）', () => {
    const { manifest, encBytes } = newVault()
    const forgedCost: ScryptCost = { N: 1 << 22, r: 8, p: 1 }
    const envelope = parseEnvelope(encBytes)
    const huge = serializeEnvelope({ ...envelope, kdf: { name: 'scrypt', ...forgedCost, salt: envelope.kdf.salt } })
    const forgedManifest: VaultManifest = {
      ...manifest,
      kdf: { name: 'scrypt', ...forgedCost },
      payload_sha256: payloadDigest(huge)
    }
    forgedManifest.keywrap_sha256 = keywrapDigest(forgedManifest)
    expectCryptoError(
      () => openVault({ manifest: forgedManifest, encBytes: huge, credential: { passphrase: PASSPHRASE } }),
      'bad-params'
    )
  })

  /**
   * 伪造 manifest 的 DoS 场景（t27 / t10-F1）。
   *
   * 攻击面：kdf 参数来自**远端** `manifest.json`，而摘要都是公开算法 —— 攻击者可以
   * 用任意参数造一个「自洽」的仓库（重算 payload_sha256 / keywrap_sha256 不需要任何密钥），
   * 让受害者在自己机器上跑一次 4 GiB 的 scrypt。守门点：`assertIntegrity()` 在任何
   * 派生之前就按 128*N*r 判预算，所以下面这条必须**快速失败**而不是先分配再报错。
   */
  function poisonedVault(cost: ScryptCost) {
    const { manifest, encBytes } = newVault()
    const envelope = parseEnvelope(encBytes)
    const poisoned = serializeEnvelope({ ...envelope, kdf: { name: 'scrypt', ...cost, salt: envelope.kdf.salt } })
    const poisonedManifest: VaultManifest = {
      ...manifest,
      kdf: { name: 'scrypt', ...cost },
      payload_sha256: payloadDigest(poisoned)
    }
    poisonedManifest.keywrap_sha256 = keywrapDigest(poisonedManifest)
    return { manifest: poisonedManifest, encBytes: poisoned }
  }

  it('伪造 manifest 声明 N=2^20,r=32,p=8 → 在派生之前就以 bad-params 拒绝（不 OOM、不卡死）', () => {
    const { manifest, encBytes } = poisonedVault({ N: 1 << 20, r: 32, p: 8 })
    const before = process.memoryUsage().rss
    const startedAt = performance.now()
    expectCryptoError(() => openVault({ manifest, encBytes, credential: { passphrase: PASSPHRASE } }), 'bad-params')
    const elapsedMs = performance.now() - startedAt
    const rssGrowthMb = (process.memoryUsage().rss - before) / (1024 * 1024)
    // 真跑去派生的话：4 GiB 分配 + 数十秒 CPU；这里的判据是「根本没开始派生」
    expect(elapsedMs).toBeLessThan(100)
    // 不把 RSS 当硬断言（GC 抖动），但它必须远小于一次 4 GiB 分配
    expect(rssGrowthMb).toBeLessThan(256)
  })

  it('两道闸门的边界值：maxN / maxR / maxP 各过一档，以及「字段都在区间内但超内存预算」', () => {
    // 闸门 1：逐字段区间。刻意选「内存远低于预算」的组合，让这四条只可能被闸门 1 拒
    // （否则闸门 2 会顺手拦下，测不出 maxN/maxR/maxP 各自是否真的生效——变异自检时踩过）
    expect(estimateKdfMemoryBytes({ N: (1 << 18) * 2, r: 1 })).toBeLessThan(512 * 1024 * 1024)
    expectCryptoError(() => assertCostWithinBounds({ N: (1 << 18) * 2, r: 1, p: 1 }), 'bad-params')
    expectCryptoError(() => assertCostWithinBounds({ N: 1 << 14, r: 17, p: 1 }), 'bad-params')
    expectCryptoError(() => assertCostWithinBounds({ N: 1 << 14, r: 8, p: 5 }), 'bad-params')
    expectCryptoError(() => assertCostWithinBounds({ N: 1 << 13, r: 8, p: 1 }), 'bad-params')
    // 闸门 2：N=2^18、r=16 每个字段都合法，但 128*N*r = 512 MiB（> 预算），必须拒
    expect(estimateKdfMemoryBytes({ N: 1 << 18, r: 16 })).toBe(512 * 1024 * 1024)
    expectCryptoError(() => assertCostWithinBounds({ N: 1 << 18, r: 16, p: 1 }), 'bad-params')
    // 生产参数与测试参数必须都还在闸门内
    expect(() => assertCostWithinBounds(SCRYPT_PRODUCTION)).not.toThrow()
    expect(() => assertCostWithinBounds(SCRYPT_TEST)).not.toThrow()
    expect(() => assertCostWithinBounds({ N: 1 << 18, r: 8, p: 4 })).not.toThrow()
  })

  it('合法参数照常解锁（收紧上限不能误伤生产/测试参数）', () => {
    const { manifest, encBytes } = newVault()
    const opened = openVault({ manifest, encBytes, credential: { passphrase: PASSPHRASE } })
    expect(opened.payload).toBe(PAYLOAD)
    zeroize(opened.vaultKey)
  })

  it('未来版本 → unsupported-format（不猜语义）', () => {
    const { manifest, encBytes } = newVault()
    expectCryptoError(
      () =>
        openVault({
          manifest: { ...manifest, version: 99 } as unknown as VaultManifest,
          encBytes,
          credential: { passphrase: PASSPHRASE }
        }),
      'unsupported-format'
    )
  })

  it('vault.enc 不是 JSON → corrupt', () => {
    expectCryptoError(() => parseEnvelope(Buffer.from('not json at all')), 'corrupt')
  })

  it('assertIntegrity 单独可用来做「同步前一致性检查」', () => {
    const { manifest, encBytes } = newVault()
    expect(assertIntegrity(manifest, encBytes).nonce).toHaveLength(16)
    expectCryptoError(() => assertIntegrity(manifest, Buffer.from('{}')), 'corrupt')
  })
})

describe('envelope / 改数据与轮换', () => {
  it('resealPayload 换 payload 不动密钥槽与 salt（B 机旧口令照样能解）', () => {
    const { manifest, encBytes, vaultKey } = newVault()
    const envelope = parseEnvelope(encBytes)
    const salt = envelope.kdf.salt
    const next = JSON.stringify({ schemaVersion: 1, hosts: [], revision: 'second' })
    const resealed = resealPayload({
      manifest,
      envelope,
      expectedKdfSalt: salt,
      vaultKey,
      payload: next,
      revision: manifest.revision + 1
    })
    expect(resealed.manifest.revision).toBe(1)
    expect(resealed.manifest.passphraseKey).toEqual(manifest.passphraseKey)
    expect(resealed.envelope.kdf.salt).toBe(salt)
    expect(parseEnvelope(resealed.encBytes).kdf.salt).toBe(salt)
    // 只有一个真相：返回的信封必须就是落盘字节解析出来的那只
    expect(resealed.envelope).toEqual(parseEnvelope(resealed.encBytes))
    const opened = openVault({ manifest: resealed.manifest, encBytes: resealed.encBytes, credential: { passphrase: PASSPHRASE } })
    expect(opened.payload).toBe(next)
    // 旧密文也还在（快照语义）
    expect(openVault({ manifest, encBytes, credential: { passphrase: PASSPHRASE } }).payload).toBe(PAYLOAD)
    zeroize(vaultKey)
  })

  it('轮换口令：新口令可用、旧口令失效、VMK 不变、旧密文用旧口令仍然可解', () => {
    const { manifest, encBytes, vaultKey } = newVault()
    const rewrapped = rewrapVault({
      manifest,
      encBytes,
      vaultKey,
      passphrase: NEXT_PASSPHRASE,
      recoveryCode: generateRecoveryCode(),
      cost: SCRYPT_TEST,
      revision: manifest.revision + 1
    })

    const openedNew = openVault({
      manifest: rewrapped.manifest,
      encBytes: rewrapped.encBytes,
      credential: { passphrase: NEXT_PASSPHRASE }
    })
    expect(openedNew.payload).toBe(PAYLOAD)
    expect(openedNew.vaultKey.equals(vaultKey)).toBe(true)

    expectCryptoError(
      () => openVault({ manifest: rewrapped.manifest, encBytes: rewrapped.encBytes, credential: { passphrase: PASSPHRASE } }),
      'bad-passphrase'
    )

    // 轮换前落盘的旧快照（manifest+enc 都是旧的）用旧口令还能解 —— 这是刻意的：
    // 本机/远端历史快照是「旧口令加密的旧数据」，轮换不回溯重写历史。
    const old = openVault({ manifest, encBytes, credential: { passphrase: PASSPHRASE } })
    expect(old.payload).toBe(PAYLOAD)
    expect(old.vaultKey.equals(vaultKey)).toBe(true)

    zeroize(vaultKey)
    zeroize(openedNew.vaultKey)
    zeroize(old.vaultKey)
  })

  it('轮换后 salt 换了（同一口令在不同轮次不能复用派生结果）', () => {
    const { manifest, encBytes, vaultKey } = newVault()
    const newCode = generateRecoveryCode()
    const rewrapped = rewrapVault({ manifest, encBytes, vaultKey, passphrase: NEXT_PASSPHRASE, recoveryCode: newCode, cost: SCRYPT_TEST, revision: 1 })
    expect(parseEnvelope(rewrapped.encBytes).kdf.salt).not.toBe(parseEnvelope(encBytes).kdf.salt)
    zeroize(vaultKey)
  })

  it('recover 只换口令槽：恢复码槽保持原样（契约 vault:recover 不返回新恢复码）', () => {
    const { manifest, encBytes, vaultKey, recoveryCode } = newVault()
    const rewrapped = rewrapVault({ manifest, encBytes, vaultKey, passphrase: NEXT_PASSPHRASE, cost: SCRYPT_TEST, revision: 1 })
    expect(rewrapped.manifest.recoveryKey).toEqual(manifest.recoveryKey)
    expect(
      openVault({ manifest: rewrapped.manifest, encBytes: rewrapped.encBytes, credential: { recoveryCode } }).payload
    ).toBe(PAYLOAD)
    zeroize(vaultKey)
  })
})

describe('envelope / 槽盐绑定与重封（AC-22 / AC-2 / AC-7）', () => {
  it('AC-22 盐与信封错配必须拒绝重封（另一只库的 salt → corrupt，绝不产出 AAD 失配的库）', () => {
    // 回退点：src/main/crypto/envelope.ts:644 `assertKdfSalt(input.expectedKdfSalt, input.envelope)` 删掉
    // → 本例必红（不抛，静默产出一只「槽是 A 机、盐是 B 机」的库，症状 = bad-passphrase）
    const local = newVault()
    const other = newVault()
    const localEnvelope = parseEnvelope(local.encBytes)
    const otherSalt = parseEnvelope(other.encBytes).kdf.salt
    expect(otherSalt).not.toBe(localEnvelope.kdf.salt)
    const before = Buffer.from(local.encBytes)

    // 旧 API 完全允许的误用：拿 B 机的 salt 配本机的口令槽
    expectCryptoError(
      () =>
        resealPayload({
          manifest: local.manifest,
          envelope: localEnvelope,
          expectedKdfSalt: otherSalt,
          vaultKey: local.vaultKey,
          payload: PAYLOAD,
          revision: local.manifest.revision + 1
        }),
      'corrupt'
    )
    // 同一条硬断言单独可判：不等即抛，相等放行（错误码固定 corrupt，不掺 bad-passphrase）
    expectCryptoError(() => assertKdfSalt(otherSalt, localEnvelope), 'corrupt')
    expect(() => assertKdfSalt(localEnvelope.kdf.salt, localEnvelope)).not.toThrow()
    // 抛错前不得改动任何入参（落盘方的 writeRepo 因此永远拿不到半成品）
    expect(local.encBytes.equals(before)).toBe(true)
    expect(parseEnvelope(local.encBytes).kdf.salt).toBe(localEnvelope.kdf.salt)
    zeroize(local.vaultKey)
    zeroize(other.vaultKey)
  })

  it('AC-2 slotFingerprint 口径：sha256(槽密文原始字节) 前 8 位小写 hex，只认这一种算法', () => {
    // 回退点：src/main/crypto/envelope.ts:398-402 把实现改成 `sha256Hex(manifest.passphraseKey.ciphertext)`
    // （对 base64 串而不是解码后的字节取摘要）或改成 64 位全长 → 第 1、2 条断言必红
    const { manifest } = newVault()
    const expected = sha256Hex(Buffer.from(manifest.passphraseKey.ciphertext, 'base64')).slice(0, 8)
    expect(slotFingerprint(manifest)).toBe(expected)
    expect(slotFingerprint(manifest)).toMatch(/^[0-9a-f]{8}$/)
    // 同一口令 + 不同 salt ⇒ 不同槽密文 ⇒ 不同指纹（否则「两台机器的库」无法区分）
    const other = newVault()
    expect(slotFingerprint(other.manifest)).not.toBe(slotFingerprint(manifest))
    // 指纹是内容摘要，不是「有槽/无槽」的布尔值
    const forged: VaultManifest = {
      ...manifest,
      passphraseKey: { ...manifest.passphraseKey, ciphertext: randomBytes(48).toString('base64') }
    }
    expect(slotFingerprint(forged)).not.toBe(slotFingerprint(manifest))
  })

  it('AC-7 resealPassphraseSlot 产出成对结果：新 salt + 新槽，新口令可开、旧口令失效、恢复码照旧可用', () => {
    // 回退点：src/main/crypto/envelope.ts:700 把 `randomBytes(SALT_BYTES)` 换成复用 `input.envelope.kdf.salt`
    // → `expect(resealed.envelope.kdf.salt).not.toBe(oldSalt)` 必红（AC-7 要的正是「换盐重封」）
    const { manifest, encBytes, vaultKey, recoveryCode } = newVault()
    const envelope = parseEnvelope(encBytes)
    const oldSalt = envelope.kdf.salt
    const oldFingerprint = slotFingerprint(manifest)

    const resealed = resealPassphraseSlot({
      manifest,
      envelope,
      vaultKey,
      passphrase: NEXT_PASSPHRASE,
      revision: manifest.revision + 1
    })

    // 成对 + 换盐
    expect(resealed.envelope).toEqual(parseEnvelope(resealed.encBytes))
    expect(resealed.envelope.kdf.salt).not.toBe(oldSalt)
    // 指纹跟着变，且等于单点实现的结果（manager 把它记进 LocalSlotRecord）
    expect(resealed.fingerprint).toBe(slotFingerprint(resealed.manifest))
    expect(resealed.fingerprint).not.toBe(oldFingerprint)

    const openedNew = openVault({
      manifest: resealed.manifest,
      encBytes: resealed.encBytes,
      credential: { passphrase: NEXT_PASSPHRASE }
    })
    expect(openedNew.payload).toBe(PAYLOAD)
    expect(openedNew.vaultKey.equals(vaultKey)).toBe(true)

    expectCryptoError(
      () =>
        openVault({
          manifest: resealed.manifest,
          encBytes: resealed.encBytes,
          credential: { passphrase: PASSPHRASE }
        }),
      'bad-passphrase'
    )

    // 恢复码槽原样保留：换口令盐不许把恢复码一起弄坏
    expect(resealed.manifest.recoveryKey).toEqual(manifest.recoveryKey)
    expect(openVault({ manifest: resealed.manifest, encBytes: resealed.encBytes, credential: { recoveryCode } }).payload).toBe(
      PAYLOAD
    )

    // 换 scrypt 参数会让恢复码槽解不开（这里拿不到恢复码、无法同步重封）→ 明确拒，不做半套
    expectCryptoError(
      () =>
        resealPassphraseSlot({
          manifest,
          envelope,
          vaultKey,
          passphrase: NEXT_PASSPHRASE,
          cost: { ...SCRYPT_TEST, N: SCRYPT_TEST.N * 2 },
          revision: 1
        }),
      'bad-params'
    )

    zeroize(vaultKey)
    zeroize(openedNew.vaultKey)
  })

  it('assertSlotBinding 挡结构性漂移（参数不一致 / 槽被改）但辨认不出身份错配 —— 后者交给指纹', () => {
    // 回退点：src/main/crypto/envelope.ts:473-479 删掉 `assertSlotBinding` 里任一条检查
    // → 对应的 expectCryptoError 必红
    const { manifest, encBytes } = newVault()
    const envelope = parseEnvelope(encBytes)
    expect(() => assertSlotBinding(manifest, envelope)).not.toThrow()

    // 1) kdf 参数漂移
    expectCryptoError(
      () => assertSlotBinding(manifest, { ...envelope, kdf: { ...envelope.kdf, r: envelope.kdf.r + 1 } }),
      'corrupt'
    )
    // 2) 槽被改却假装摘要没变
    const tampered: VaultManifest = {
      ...manifest,
      passphraseKey: { ...manifest.passphraseKey, ciphertext: randomBytes(48).toString('base64') }
    }
    expectCryptoError(() => assertSlotBinding(tampered, envelope), 'corrupt')

    // 3) 边界（这条断言本身就是文档）：把另一只库的槽 + 重算后的摘要放进来，结构检查**照样放行** ——
    //    所以「槽盐来自不同库」只能由 LocalSlotRecord 的指纹对账发现（AC-2），这正是指纹存在的理由。
    const other = newVault()
    const swapped: VaultManifest = { ...manifest, passphraseKey: other.manifest.passphraseKey }
    swapped.keywrap_sha256 = keywrapDigest(swapped)
    expect(() => assertSlotBinding(swapped, envelope)).not.toThrow()
    expect(slotFingerprint(swapped)).not.toBe(slotFingerprint(manifest))
  })

  it('AC-9 onKekDerived 只在口令派生时回调一次（recovery / keychain 分支不回调）', () => {
    // 回退点：src/main/crypto/envelope.ts:594 把 `onKekDerived?.()` 从口令分支挪到 `openPayloadBytes` 开头
    // （覆盖三个分支）→ 最后一条 `expect(derived).toBe(0)` 必红
    const { manifest, encBytes, vaultKey, recoveryCode } = newVault()

    let derived = 0
    const opened = openVault({
      manifest,
      encBytes,
      credential: { passphrase: PASSPHRASE },
      onKekDerived: () => {
        derived += 1
      }
    })
    expect(derived).toBe(1)
    zeroize(opened.vaultKey)

    // 口令错也如实计数：失败路径不能被「看起来 0 次」掩盖
    derived = 0
    expectCryptoError(
      () =>
        openVault({
          manifest,
          encBytes,
          credential: { passphrase: 'wrong passphrase' },
          onKekDerived: () => {
            derived += 1
          }
        }),
      'bad-passphrase'
    )
    expect(derived).toBe(1)

    // 恢复码 / keychain 不派生口令 KEK（把计数算进来会让 AC-9 的「≤4 次」判据失真）
    derived = 0
    const viaRecovery = openVault({
      manifest,
      encBytes,
      credential: { recoveryCode },
      onKekDerived: () => {
        derived += 1
      }
    })
    const viaKeychain = openVault({
      manifest,
      encBytes,
      credential: { vaultKey },
      onKekDerived: () => {
        derived += 1
      }
    })
    expect(derived).toBe(0)
    expect(viaRecovery.slot).toBe('recovery')
    expect(viaKeychain.slot).toBe('keychain')
    zeroize(viaRecovery.vaultKey)
    zeroize(viaKeychain.vaultKey)
    zeroize(vaultKey)
  })
})

describe('envelope / 工具函数', () => {
  it('sha256Hex 稳定且区分输入', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')))
    expect(sha256Hex('abc')).toHaveLength(64)
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'))
  })

  it('zeroize 把密钥材料清零（best-effort）', () => {
    const buffer = randomBytes(32)
    zeroize(buffer)
    expect(buffer.every((byte) => byte === 0)).toBe(true)
  })

  it('serializeEnvelope 以换行结尾，parseEnvelope 可逆', () => {
    const { encBytes } = newVault()
    expect(encBytes.subarray(-1).toString()).toBe('\n')
    expect(serializeEnvelope(parseEnvelope(encBytes)).equals(encBytes)).toBe(true)
  })
})
