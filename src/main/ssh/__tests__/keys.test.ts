import { utils, type ParsedKey } from 'ssh2'
import { describe, expect, it } from 'vitest'
import {
  FIXTURE_CLIENT_FINGERPRINT,
  FIXTURE_CLIENT_KEY,
  FIXTURE_CLIENT_PUBLIC,
  FIXTURE_HOST_FINGERPRINT,
  FIXTURE_HOST_KEY,
  FIXTURE_HOST_PUBLIC,
  generateValidKeyPair,
  makeMalformedEd25519PrivateKey,
  validateKeyPair
} from './helpers/keys'
import { fingerprintSha256FromKey } from '../known-hosts'

/**
 * 夹具密钥的守门测试。
 *
 * 存在意义：`helpers/keys.ts` 里那段「为什么不能直接 generateKeyPairSync」的解释如果没有用例守着，
 * 下一个人会把固定密钥"顺手简化"回随机生成，然后全量跑又开始 1/3 概率红（这条缺陷在团队里红过三次）。
 *
 * 三条断言分别锁住：
 * 1. 钉死的私钥 / 公钥单行 / 指纹三者一致（替换任意一个常量都会红）；
 * 2. 上游缺陷的坏样本确实被 parseKey 判死，且 validateKeyPair 会拦住它（守门逻辑真的在跑）；
 * 3. 需要随机密钥时的 generateValidKeyPair() 只返回可解析密钥。
 */

/** parseKey 的返回类型是 `Error | ParsedKey`，用例里一律先收掉 Error 分支再取公钥 */
function asParsed(text: string): ParsedKey {
  const parsed = utils.parseKey(text)
  if (parsed instanceof Error) throw new Error(`夹具密钥解析失败: ${parsed.message}`)
  return parsed
}

describe('夹具密钥', () => {
  it('宿主密钥：私钥可解析，公钥单行与指纹三者一致', () => {
    const parsedKey = asParsed(FIXTURE_HOST_KEY)
    expect(utils.parseKey(FIXTURE_HOST_KEY)).not.toBeInstanceOf(Error)
    expect(parsedKey.getPublicSSH().toString('base64')).toBe(asParsed(FIXTURE_HOST_PUBLIC).getPublicSSH().toString('base64'))
    expect(fingerprintSha256FromKey(parsedKey.getPublicSSH())).toBe(FIXTURE_HOST_FINGERPRINT)
    expect(FIXTURE_HOST_FINGERPRINT).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })

  it('客户端密钥：私钥可解析，公钥单行与指纹三者一致', () => {
    const parsedKey = asParsed(FIXTURE_CLIENT_KEY)
    expect(utils.parseKey(FIXTURE_CLIENT_KEY)).not.toBeInstanceOf(Error)
    expect(parsedKey.getPublicSSH().toString('base64')).toBe(asParsed(FIXTURE_CLIENT_PUBLIC).getPublicSSH().toString('base64'))
    expect(fingerprintSha256FromKey(parsedKey.getPublicSSH())).toBe(FIXTURE_CLIENT_FINGERPRINT)
  })

  it('上游缺陷样本（内嵌 pub 少 1 字节）确实无法解析，validateKeyPair 会抛出而不是放行', () => {
    const malformed = makeMalformedEd25519PrivateKey()
    // 前置条件：样本真的是坏的（否则下面的断言测不到东西）
    expect(utils.parseKey(malformed)).toBeInstanceOf(Error)
    expect(() => validateKeyPair({ private: malformed, public: FIXTURE_HOST_PUBLIC })).toThrowError(
      /夹具密钥无效.*Malformed/
    )
    // 合法密钥必须静默通过（反证守门不是「一律拒绝」）
    expect(() => validateKeyPair({ private: FIXTURE_HOST_KEY, public: FIXTURE_HOST_PUBLIC })).not.toThrow()
  })

  it('generateValidKeyPair 只返回可解析的密钥（坏样本重掷）', () => {
    for (let i = 0; i < 5; i += 1) {
      const pair = generateValidKeyPair()
      expect(utils.parseKey(pair.privateKey)).not.toBeInstanceOf(Error)
      expect(pair.publicBlob.length).toBeGreaterThan(32)
      expect(pair.fingerprintSha256).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    }
  })
})
