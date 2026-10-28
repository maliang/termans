import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { I18N_NAMESPACES, LOCALES, localeResourcePath, type LocaleResource } from '@shared'
import { SSH_GLOSSARY, glossaryById, glossaryByEn, glossaryMarkdownRows } from '@renderer/i18n/glossary'

/**
 * 术语一致性（SPEC 的「SSH 术语中英一致」）。
 *
 * 术语各译一套是最容易被用户察觉的粗糙感来源（同一个东西在设置页叫「跳板机」、
 * 在主机页叫「中转机」）。这里做两件事：
 * ① 文档 `docs/i18n.md` 的术语表必须与 `glossary.ts` 逐条对得上；
 * ② zh-CN 全部文案里不允许出现 `avoid` 里登记的「不要这么译」。
 */
const repoRoot = resolve(__dirname, '../..')
const doc = readFileSync(resolve(repoRoot, 'docs/i18n.md'), 'utf8')

function dictionary(lang: LocaleResource extends never ? never : string, namespace: string): LocaleResource {
  return JSON.parse(readFileSync(resolve(repoRoot, localeResourcePath(lang as never, namespace as never)), 'utf8')) as LocaleResource
}

describe('术语表', () => {
  it('至少覆盖任务要求的 host key / jump host / PTY / snippet', () => {
    for (const id of ['host-key', 'jump-host', 'pty', 'snippet']) {
      expect(glossaryById(id), `术语表缺 ${id}`).toBeDefined()
    }
    expect(SSH_GLOSSARY.length).toBeGreaterThanOrEqual(20)
  })

  it('每条术语都有非空的英文/中文/说明，且 id 唯一', () => {
    const ids = SSH_GLOSSARY.map((term) => term.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const term of SSH_GLOSSARY) {
      expect(term.en.trim()).not.toBe('')
      expect(term.zh.trim()).not.toBe('')
      expect(term.note.trim()).not.toBe('')
    }
  })

  it('按英文名与 id 都能查到', () => {
    expect(glossaryByEn('host key')?.zh).toBe('主机密钥')
    expect(glossaryById('host-key')?.en).toBe('host key')
    expect(glossaryByEn('nonexistent')).toBeUndefined()
  })

  it('docs/i18n.md 的术语表与 glossary.ts 逐条一致', () => {
    const rows = glossaryMarkdownRows()
    expect(rows.length).toBe(SSH_GLOSSARY.length)
    const missing: string[] = []
    for (const term of SSH_GLOSSARY) {
      if (!doc.includes(`| ${term.en} | ${term.zh} |`)) missing.push(`${term.en} → ${term.zh}`)
    }
    expect(missing, `docs/i18n.md 术语表缺少/写错：\n${missing.join('\n')}`).toEqual([])
    // 反向：只数「第 9 节术语表」这张表本身的行数——全文扫 `| x |` 会把其它表格也数进来，
    // 那样文档一加别的表测试就红，属于错误告警。
    const section = doc.slice(doc.indexOf('## 9.'), doc.indexOf('## 10.'))
    const docRows = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| en |'))
    expect(docRows.length, '第 9 节术语表行数与 glossary.ts 不一致').toBe(SSH_GLOSSARY.length)
  })

  it('zh-CN 文案里没有出现被禁用的译法', () => {
    const banned = new Map<string, string>()
    for (const term of SSH_GLOSSARY) {
      for (const wrong of term.avoid ?? []) banned.set(wrong, `${term.en} 应译作「${term.zh}」，不要用「${wrong}」`)
    }
    const offenders: string[] = []
    for (const namespace of I18N_NAMESPACES) {
      const entries = Object.entries(dictionary('zh-CN', namespace))
      for (const [key, value] of entries) {
        for (const [wrong, reason] of banned) {
          if (value.includes(wrong)) offenders.push(`zh-CN/${namespace}:${key} = "${value}" —— ${reason}`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('en 文案里 host key / jump host / snippet 等术语用词统一', () => {
    const en = { ...dictionary('en', 'common') }
    for (const namespace of I18N_NAMESPACES) Object.assign(en, dictionary('en', namespace))
    const values = Object.values(en).join('\n').toLowerCase()
    // 英文侧不做强制（术语未必都出现在已有文案里），只保证没有「别名」写法
    for (const [alias, canonical] of [
      ['jump server', 'jump host'],
      ['jump box', 'jump host'],
      ['snippets of', 'snippet']
    ] as const) {
      if (values.includes(alias)) expect.soft(values, `英文文案用了「${alias}」，应为「${canonical}」`).not.toContain(alias)
    }
  })
})

describe('docs/i18n.md 结构', () => {
  it('包含新增语言的步骤与 namespace 说明', () => {
    expect(doc).toContain('## 10. 新增一门语言')
    expect(doc).toContain('I18N_NAMESPACES')
    expect(doc).toContain('keySeparator')
    expect(doc).toContain('nsSeparator')
  })

  it('记录的 namespace 列表与契约一致', () => {
    for (const namespace of I18N_NAMESPACES) expect(doc).toContain(`\`${namespace}\``)
  })

  it('引用的 LOCALES 与契约一致', () => {
    for (const locale of LOCALES) expect(doc).toContain(locale)
  })
})
