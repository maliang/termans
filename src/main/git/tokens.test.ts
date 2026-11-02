import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcCallError } from '@shared'
import { detectSystemGitTokens, maskGitToken, readGitTokenFile } from './tokens'

/**
 * t57：令牌来源探测。
 *
 * 这些用例守的是「用户能不能看懂失败原因」——令牌读不出来时，说「读取失败」
 * 等于让用户干瞪眼，必须说清是路径不存在 / 是目录 / 太大 / 空文件。
 */

function reasonOf(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(IpcCallError)
    const details = (error as IpcCallError).details as { reason?: string } | undefined
    return details?.reason ?? '<no-reason>'
  }
  throw new Error('期望抛错，但没有抛')
}

describe('maskGitToken', () => {
  it('短令牌整体遮住（尾 4 位等于大半个明文，不能露）', () => {
    expect(maskGitToken('short')).toBe('••••')
    expect(maskGitToken('12345678901')).toBe('••••')
  })

  it('长令牌只露尾 4 位', () => {
    expect(maskGitToken('ghp_1234567890abcdefWXYZ')).toBe('••••WXYZ')
  })

  it('去掉首尾空白后再判断长度（粘贴常带换行）', () => {
    expect(maskGitToken('  ghp_1234567890abcdefWXYZ \n')).toBe('••••WXYZ')
  })
})

describe('readGitTokenFile', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'termans-token-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('取第一条非空行（文件里有空行/尾随换行也照常）', () => {
    const path = join(dir, 'token')
    writeFileSync(path, '\n\n  ghp_real_token_value  \n第二行应被忽略\n')
    expect(readGitTokenFile(path)).toBe('ghp_real_token_value')
  })

  it('空路径 / 不存在 / 是目录 / 是空文件，四种失败各自可分辨', () => {
    expect(reasonOf(() => readGitTokenFile('   '))).toBe('token-file-empty-path')
    expect(reasonOf(() => readGitTokenFile(join(dir, 'nope')))).toBe('token-file-missing')

    const subdir = join(dir, 'sub')
    mkdirSync(subdir)
    expect(reasonOf(() => readGitTokenFile(subdir))).toBe('token-file-not-a-file')

    const empty = join(dir, 'empty')
    writeFileSync(empty, '\n   \n')
    expect(reasonOf(() => readGitTokenFile(empty))).toBe('token-file-empty')
  })

  it('超过 8KB 的文件拒绝（那不是令牌）', () => {
    const huge = join(dir, 'huge')
    writeFileSync(huge, 'x'.repeat(9_000))
    expect(reasonOf(() => readGitTokenFile(huge))).toBe('token-file-too-large')
  })
})

describe('detectSystemGitTokens', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('环境变量里的令牌会被发现，且掩码不泄漏明文', () => {
    delete process.env['GH_TOKEN']
    delete process.env['GITLAB_TOKEN']
    delete process.env['TERMANS_GIT_TOKEN']
    process.env['GITHUB_TOKEN'] = 'ghp_envOnlyTokenValue123'
    const found = detectSystemGitTokens()
    const env = found.find((item) => item.source === 'env')
    expect(env).toBeDefined()
    expect(env?.masked).toBe('••••e123')
    expect(env?.masked).not.toContain('ghp_envOnly')
  })

  it('同一个令牌值只报一次（GITHUB_TOKEN 与 GH_TOKEN 填一样时只有一条）', () => {
    process.env['GITHUB_TOKEN'] = 'ghp_sameTokenValue1234'
    process.env['GH_TOKEN'] = 'ghp_sameTokenValue1234'
    delete process.env['GITLAB_TOKEN']
    delete process.env['TERMANS_GIT_TOKEN']
    const envItems = detectSystemGitTokens().filter((item) => item.source === 'env')
    expect(envItems).toHaveLength(1)
  })
})
