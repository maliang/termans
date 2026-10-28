import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SCRYPT_TEST } from '../crypto/envelope'
import { VaultManager } from './manager'
import { listRepoFiles, listThemeFiles } from './repo'
import { createFileSecretBox } from './secret-box'
import { FIXTURE_PASSPHRASE, FIXTURE_PASSWORD, FIXTURE_HOSTNAMES, hostInput } from './test-fixtures'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('仓库布局（验收：ls -R 只有 manifest.json / vault.enc / themes）', () => {
  it('创建含主机与主题的仓库后，递归列目录只剩三类内容', () => {
    const root = mkdtempSync(join(tmpdir(), 'termans-repo-'))
    roots.push(root)
    const repoDir = join(root, 'vault')
    const localDir = join(root, 'vault-local')
    const manager = new VaultManager({
      repoDir,
      localDir,
      box: createFileSecretBox(localDir),
      cost: SCRYPT_TEST,
      autoLockMinutes: 0,
      requirePassphraseOnLaunch: true
    })
    manager.init()
    manager.create(FIXTURE_PASSPHRASE)

    for (const [index, hostname] of FIXTURE_HOSTNAMES.entries()) {
      const host = manager.createHost(hostInput({ label: `host-${index}`, hostname, credentialRef: `ref-${index}` }))
      manager.setSecret(`ref-${index}`, { password: FIXTURE_PASSWORD })
      expect(host.id).toHaveLength(36)
    }
    manager.setThemes([
      {
        id: 'ocean',
        name: 'Ocean',
        appearance: 'dark',
        builtin: false,
        extends: 'termans-dark',
        tokens: {},
        createdAt: null,
        updatedAt: null
      }
    ])

    // 真实 `ls -R` 输出（本机 macOS/Linux 均可），同时作为断言与证据
    const tree = execFileSync('ls', ['-R', repoDir], { encoding: 'utf8' })
    console.log(`ls -R ${repoDir}\n${tree}`)

    expect(listRepoFiles(repoDir)).toEqual(['manifest.json', 'vault.enc'])
    expect(listThemeFiles(repoDir)).toEqual(['ocean.json'])

    const files = tree
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith(':') === false && line.length > 0)
    // 目录标题行（形如 `<path>:`）与空行被过滤后，剩下的只能是这三个文件名 + themes 目录本身
    expect(files.sort()).toEqual(['manifest.json', 'ocean.json', 'themes', 'vault.enc'])
    expect(tree).not.toContain('credentials')
    expect(tree).not.toContain('local.json')
    expect(tree).not.toContain('session')
  })
})
