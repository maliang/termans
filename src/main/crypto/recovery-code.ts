import { randomBytes } from 'node:crypto'

/**
 * 一次性恢复码的编解码（Crockford base32）。
 *
 * 独立成文件是为了打断 `envelope.ts` ↔ `passphrase.ts` 的循环依赖：
 * 信封解锁时要归一化用户抄写的恢复码，而口令强度评估只需要「恢复码有多长」。
 */

/** 20 字节 = 160 bit，远超任务书要求的 128 bit */
export const RECOVERY_CODE_BYTES = 20

/** Crockford base32：去掉 I / L / O / U，避免手抄歧义 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_GROUP_SIZE = 4

export const RECOVERY_CODE_CHARS = Math.ceil((RECOVERY_CODE_BYTES * 8) / 5)

function encodeCrockford(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += CROCKFORD[(value << (5 - bits)) & 31]
  return output
}

/** 生成一次性恢复码，返回 `XXXX-XXXX-...` 形式（160bit 随机，可直接下载/抄写） */
export function generateRecoveryCode(byteLength: number = RECOVERY_CODE_BYTES): string {
  if (byteLength < 16) throw new RangeError('recovery code must be at least 128 bits')
  return formatRecoveryCode(encodeCrockford(randomBytes(byteLength)))
}

/**
 * 每 4 位加一个连字符，方便用户抄写与人工核对。
 * 幂等：先把已有的分隔符/空白剥掉再切分，所以「格式化已格式化的码」不会得到 `XXXX--XXXX`。
 */
export function formatRecoveryCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, '')
  const groups: string[] = []
  for (let index = 0; index < cleaned.length; index += RECOVERY_GROUP_SIZE) {
    groups.push(cleaned.slice(index, index + RECOVERY_GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * 归一化用户输入的恢复码：大小写、分隔符、手抄歧义（O→0、I/L→1）全部容错。
 * 无法识别时返回 null（由调用方回 E_INVALID_ARGUMENT，而不是拿脏字符串去做 scrypt）。
 */
export function normalizeRecoveryCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
  if (cleaned.length !== RECOVERY_CODE_CHARS) return null
  for (const char of cleaned) {
    if (!CROCKFORD.includes(char)) return null
  }
  return cleaned
}
