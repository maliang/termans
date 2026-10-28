import { describe, expect, it } from 'vitest'
import {
  buildHostBlock,
  diffTexts,
  filterSshConfigText,
  parseSshConfigText,
  removeHostBlock,
  updateHostFields
} from './ssh-config-text'

const SAMPLE = [
  '# 顶部注释：手工维护，不许被吃掉',
  'Host prod-web prod-web-alias',
  '  HostName 10.20.30.40',
  '  User deploy',
  '  Port 2222',
  '  # 行内注释',
  '  SendEnv LANG=en_US.UTF-8',
  '  ProxyJump bastion',
  '',
  'Host bastion',
  '    HostName 10.20.30.1',
  '    User admin',
  '',
  'Match host *.internal',
  '    User ops',
  ''
].join('\n')

describe('ssh_config 解析（只读）', () => {
  it('按 Host 切块，保留未知指令的原始大小写与行号', () => {
    const parsed = parseSshConfigText(SAMPLE, '/tmp/config')
    expect(parsed.path).toBe('/tmp/config')
    expect(parsed.exists).toBe(true)
    const web = parsed.entries.find((entry) => entry.alias === 'prod-web')
    expect(web).toMatchObject({ hostname: '10.20.30.40', port: 2222, user: 'deploy', proxyJump: 'bastion' })
    expect(web?.patterns).toEqual(['prod-web', 'prod-web-alias'])
    // 未知指令必须原样保留（SendEnv 大小写是用户写的）
    expect(web?.options.SendEnv ?? web?.options.Sendenv ?? web?.options.SENDENV).toBe('LANG=en_US.UTF-8')
    expect(web?.startLine).toBe(2)
  })

  it('Match 块不进 entries，但给一条 warning', () => {
    const parsed = parseSshConfigText(SAMPLE, '/tmp/config')
    expect(parsed.entries.map((entry) => entry.alias)).toEqual(['prod-web', 'bastion'])
    expect(parsed.warnings.some((warning) => warning.message.includes('Match'))).toBe(true)
  })
})

describe('ssh_config 写回（双向，只改指定字段）', () => {
  it('改 HostName/Port 只动那一行，注释与未知指令逐字保留', () => {
    const update = updateHostFields(SAMPLE, 'prod-web', { HostName: '10.20.30.99', Port: '2200' })
    expect(update.modified).toBe(true)
    expect(update.appended).toBe(false)
    expect(update.changedLineCount).toBe(2)
    expect(update.text).toContain('HostName 10.20.30.99')
    expect(update.text).toContain('  Port 2200')
    expect(update.text).toContain('# 顶部注释：手工维护，不许被吃掉')
    expect(update.text).toContain('  # 行内注释')
    expect(update.text).toContain('  SendEnv LANG=en_US.UTF-8')
    // 块外内容一行不改
    expect(update.text.slice(update.text.indexOf('Host bastion'))).toBe(SAMPLE.slice(SAMPLE.indexOf('Host bastion')))
  })

  it('沿用已有行的缩进（4 空格块不会被改成 2 空格）', () => {
    const update = updateHostFields(SAMPLE, 'bastion', { User: 'root' })
    const line = update.text.split('\n').find((item) => item.includes('User root'))
    expect(line).toBe('    User root')
  })

  it('null 删除该字段；缺字段插在 Host 行之后（4 空格缩进）', () => {
    const update = updateHostFields(SAMPLE, 'prod-web', { Port: null, IdentityFile: '~/.ssh/id_ed25519' })
    expect(update.text).not.toContain('Port 2222')
    const lines = update.text.split('\n')
    const hostIndex = lines.findIndex((line) => line.startsWith('Host prod-web'))
    expect(lines[hostIndex + 1]).toBe('    IdentityFile ~/.ssh/id_ed25519')
  })

  it('无改动时返回原文（幂等，避免无意义的提交）', () => {
    const update = updateHostFields(SAMPLE, 'prod-web', {})
    expect(update.text).toBe(SAMPLE)
    expect(update.changedLineCount).toBe(0)
  })

  it('alias 不存在时追加新块，且与上一个块之间留空行', () => {
    const update = updateHostFields(SAMPLE, 'new-host', { HostName: '10.9.9.9', User: 'deploy' })
    expect(update.appended).toBe(true)
    expect(update.patterns).toEqual(['new-host'])
    expect(update.text.trimEnd().endsWith('User deploy')).toBe(true)
    expect(update.text).toContain('\n\nHost new-host\n')
  })

  it('多 pattern 的块：用任一 pattern 都能定位到同一块', () => {
    const update = updateHostFields(SAMPLE, 'prod-web-alias', { User: 'ops' })
    expect(update.modified).toBe(true)
    expect(update.text).toContain('  User ops')
  })
})

describe('ssh_config 其他工具函数', () => {
  it('removeHostBlock 删掉整块且不留空行堆积', () => {
    const { text, removed } = removeHostBlock(SAMPLE, 'bastion')
    expect(removed).toBe(true)
    expect(text).not.toContain('Host bastion')
    expect(text).not.toContain('\n\n\n')
    expect(text).toContain('Host prod-web')
  })

  it('filterSshConfigText 按 alias 导出子集；null 原样返回', () => {
    expect(filterSshConfigText(SAMPLE, null)).toBe(SAMPLE)
    const subset = filterSshConfigText(SAMPLE, ['bastion'])
    expect(subset).toContain('Host bastion')
    expect(subset).not.toContain('prod-web')
  })

  it('buildHostBlock 用 4 空格缩进、跳过 null 字段', () => {
    const block = buildHostBlock('x', { HostName: '1.2.3.4', Port: null, User: 'u' })
    expect(block.split('\n').filter(Boolean)).toEqual(['Host x', '    HostName 1.2.3.4', '    User u'])
  })

  it('diffTexts 给出 +/- 行，供 UI 预览 dryRun', () => {
    const diff = diffTexts('a\nb\nc\n', 'a\nB\nc\n')
    expect(diff).toContain('-b')
    expect(diff).toContain('+B')
    expect(diff).toContain(' a')
  })
})
