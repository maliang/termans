import { Buffer } from 'node:buffer'
import { utils, type ParsedKey } from 'ssh2'
import { fingerprintSha256FromKey } from '../../known-hosts'

/**
 * 测试夹具用的 ed25519 密钥。
 *
 * ## 为什么不能每次 `utils.generateKeyPairSync('ed25519').private` 直接拿来用
 *
 * ssh2 1.17 的 `generateKeyPairSync('ed25519')` 有**上游缺陷**：约每 256 次（≈0.39%，
 * 实测 8/3000、15/3000 两轮）会生成一把**它自己的 `utils.parseKey` 都解析不了**的私钥。
 *
 * 机制：生成器把公钥串写成长度前缀 + 32 字节裸公钥，但中间经过了一次「按大整数往返」的
 * 编码，首字节为 `0x00` 时这个前导零被吞掉 —— 于是私钥容器里内嵌的公钥串变成 31 字节
 * （外层 50 字节 vs 正常 51 字节），`parseKey` 校验「外层 pub 与 private 段内嵌 pub 必须一致」
 * 时判定 `Malformed OpenSSH private key`。
 *
 * 后果不是"偶尔一把坏密钥"这么简单：`FakeSshServer` 每实例化一次就掷一次骰子，
 * 而一个测试套件会起几十个实例，于是**每次全量跑约有 1/3 概率踩到**，红在哪条用例完全随机
 * （实测分别红在 host-key.test.ts 的 accept-new、reconnect.test.ts 的重试耗尽、
 * sftp.test.ts 的 writeFile 往返）。单跑某个文件因为掷骰次数少，看起来是绿的 ——
 * 这正是「单跑绿、全量红」的来源。
 *
 * ## 所以：固定密钥 + 自校验重掷
 *
 * 1. 默认场景（PTY/exec/SFTP/known_hosts 主路径）用**钉死的常量密钥**：零掷骰、跨进程指纹稳定，
 *    指纹断言也因此更可读（不再是"每次跑都不一样的一串"）。
 * 2. 确实需要「另一把密钥」的场景（造 host key 变化的中间人）用 `generateValidKeyPair()`：
 *    生成后立刻 `parseKey` 自校验，坏了重掷 —— 不是改种子掩盖，而是把上游的 1/256 缺陷挡在夹具边界。
 *
 * 想"顺手简化"成 `utils.generateKeyPairSync(...).private` 之前，请先读完上面两段。
 */

/** 固定的宿主密钥（服务端）。私钥文本、公钥单行、指纹三者必须互相一致（有用例守着）。 */
export const FIXTURE_HOST_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACCFhthiHGlbec4CxCSbLgwlrx70kBWkYx/CzgcLOnK5lAAA
AIhVw2SrVcNkqwAAAAtzc2gtZWQyNTUxOQAAACCFhthiHGlbec4CxCSbLgwlrx70
kBWkYx/CzgcLOnK5lAAAAEBsCOcBj5smxB+fXjXkryZloX6R59IPk2tJYZWIBgla
MYWG2GIcaVt5zgLEJJsuDCWvHvSQFaRjH8LOBws6crmUAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`

export const FIXTURE_HOST_PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIWG2GIcaVt5zgLEJJsuDCWvHvSQFaRjH8LOBws6crmU'

/** 与 `ssh-keygen -lf` 一致的 SHA256 指纹（无 padding） */
export const FIXTURE_HOST_FINGERPRINT = 'SHA256:NC5CzUcuTMll6cKmFL+zl6xlo0IXzAeBy+DBhwVLVYw'

/** 固定的客户端密钥（publickey 认证用例）。客户端密钥从不参与 host key 校验，但仍避开掷骰。 */
export const FIXTURE_CLIENT_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACA8F/4k/JRkpZcsGU85UL7Fe44BjPAU06YRpUD7pLo7kgAA
AIh4vZGieL2RogAAAAtzc2gtZWQyNTUxOQAAACA8F/4k/JRkpZcsGU85UL7Fe44B
jPAU06YRpUD7pLo7kgAAAEDRs/mK166s97Ac3QGl5wR9PHmuJpGE4NPrzYF5615J
qjwX/iT8lGSllywZTzlQvsV7jgGM8BTTphGlQPukujuSAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----
`

export const FIXTURE_CLIENT_PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDwX/iT8lGSllywZTzlQvsV7jgGM8BTTphGlQPukujuS'

export const FIXTURE_CLIENT_FINGERPRINT = 'SHA256:NZxX81HU5mzuS96Wjn6Efr0p4aSxdjI7HRa9/jEb+gw'

export interface ValidatedKeyPair {
  /** OpenSSH 格式私钥文本 */
  privateKey: string
  /** authorized_keys 单行（`ssh-ed25519 AAAA...`） */
  publicLine: string
  /** SSH 线格式公钥 blob（指纹就是对它做 sha256） */
  publicBlob: Buffer
  /** `SHA256:` 前缀、无 padding，与 ssh-keygen -lf 一致 */
  fingerprintSha256: string
  /** ssh2 解析后的私钥，可用来签名（node crypto 读不了 OpenSSH 私钥） */
  parsed: ParsedKey
}

/**
 * 校验一把（已有）密钥：`parseKey` 解析失败就抛，避免把坏密钥一路带进夹具。
 * 这是「上游 1/256 缺陷」的守门人，不要在别处绕过它直接用 generateKeyPairSync。
 */
export function validateKeyPair(pair: { private: string; public: string }): ValidatedKeyPair {
  const parsed = utils.parseKey(pair.private)
  if (parsed instanceof Error) {
    throw new Error(`夹具密钥无效（ssh2 generateKeyPairSync 的已知缺陷）：${parsed.message}`)
  }
  return {
    privateKey: pair.private,
    publicLine: pair.public,
    publicBlob: parsed.getPublicSSH(),
    fingerprintSha256: fingerprintSha256FromKey(parsed.getPublicSSH()),
    parsed
  }
}

/**
 * 已知无效的密钥样本：现场复刻上游缺陷的形状。
 * 取钉死的合法私钥，把「内嵌 pub 串」的首字节删掉并同步把长度字段减 1
 * —— 外层 pub 与 private 段内嵌 pub 不再一致，`parseKey` 判 Malformed。
 * 用来守住 `validateKeyPair` 的守门逻辑（见 keys.test.ts）。
 */
export function makeMalformedEd25519PrivateKey(): string {
  const body = Buffer.from(FIXTURE_HOST_KEY.split('\n').slice(1, -2).join(''), 'base64')
  const marker = Buffer.from('ssh-ed25519', 'ascii')
  const at = body.indexOf(marker)
  if (at < 0) throw new Error('unexpected key layout')
  // 结构：uint32 len | "ssh-ed25519" | uint32 keyLen | key（两处：外层 publicKey、private 段内）
  const keyLenOffset = at + marker.length
  const keyLen = body.readUInt32BE(keyLenOffset)
  if (keyLen !== 32) throw new Error(`unexpected key length ${keyLen}`)
  const keyStart = keyLenOffset + 4
  const trimmed = Buffer.concat([
    body.subarray(0, keyLenOffset),
    Buffer.from([0, 0, 0, keyLen - 1]),
    body.subarray(keyStart + 1) // 丢掉首字节 → 内嵌 pub 只有 31 字节
  ])
  const lines = trimmed.toString('base64').match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/**
 * 生成一把**校验通过**的 ed25519 密钥；遇到上游的坏样本就重掷。
 * 只用于「需要另一把不同密钥」的场景（host key 变化等），默认路径请用固定常量。
 */
export function generateValidKeyPair(maxAttempts = 200): ValidatedKeyPair {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519')
    const parsed = utils.parseKey(pair.private)
    if (parsed instanceof Error) continue // 上游缺陷：坏样本重掷
    return {
      privateKey: pair.private,
      publicLine: pair.public,
      publicBlob: parsed.getPublicSSH(),
      fingerprintSha256: fingerprintSha256FromKey(parsed.getPublicSSH()),
      parsed
    }
  }
  throw new Error(`连续 ${maxAttempts} 次都生成不出可解析的 ed25519 密钥（上游缺陷概率异常）`)
}
