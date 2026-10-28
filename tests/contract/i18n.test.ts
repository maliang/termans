import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { I18N_NAMESPACES, LOCALES, localeResourcePath, type Locale, type LocaleResource } from '@shared'

/**
 * 多语言资源的结构测试。
 *
 * 缺一条 key 在 UI 上只是少一行字/显示原始 key，QA 极难系统性发现；
 * 所以「两种语言的 key 集合完全相等」必须是构建期红线。
 */
const repoRoot = resolve(__dirname, '../..')

function load(lang: Locale, namespace: string): LocaleResource {
  const path = resolve(repoRoot, localeResourcePath(lang, namespace as never))
  expect(existsSync(path), `missing locale file: ${path}`).toBe(true)
  return JSON.parse(readFileSync(path, 'utf8')) as LocaleResource
}

describe('locale 资源', () => {
  it('每个语言 × 每个 namespace 都有文件，且都是扁平 key', () => {
    for (const lang of LOCALES) {
      for (const namespace of I18N_NAMESPACES) {
        const resource = load(lang, namespace)
        expect(Object.keys(resource).length).toBeGreaterThan(0)
        for (const [key, value] of Object.entries(resource)) {
          expect(typeof value, `${lang}/${namespace}: ${key} must be a string`).toBe('string')
          expect(value.trim().length, `${lang}/${namespace}: ${key} is empty`).toBeGreaterThan(0)
          // 扁平 key：允许单段（namespace 内部已足够区分），也允许多段点号串；不允许嵌套对象
          expect(key, `${lang}/${namespace}: key should be flat`).toMatch(/^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*$/)
        }
      }
    }
  })

  it('en 与 zh-CN 的 key 集合完全相等', () => {
    for (const namespace of I18N_NAMESPACES) {
      const en = new Set(Object.keys(load('en', namespace)))
      const zh = new Set(Object.keys(load('zh-CN', namespace)))
      expect([...en].filter((key) => !zh.has(key)), `${namespace}: missing in zh-CN`).toEqual([])
      expect([...zh].filter((key) => !en.has(key)), `${namespace}: missing in en`).toEqual([])
    }
  })

  it('关键 UI 文案在两个语言里都存在（防止删 key 造成空界面）', () => {
    const required: Array<[Locale, string, string[]]> = [
      ['en', 'common', ['app.name', 'action.unlock', 'action.lock']],
      ['zh-CN', 'common', ['app.name', 'action.unlock', 'action.lock']],
      ['en', 'auth', ['lock.title', 'lock.passphrase', 'lock.recoveryHint']],
      ['zh-CN', 'auth', ['lock.title', 'lock.passphrase', 'lock.recoveryHint']],
      ['en', 'sync', ['conflict.keepLocal', 'conflict.keepRemote', 'conflict.keepBoth']],
      ['zh-CN', 'sync', ['conflict.keepLocal', 'conflict.keepRemote', 'conflict.keepBoth']]
    ]
    for (const [lang, namespace, keys] of required) {
      const resource = load(lang, namespace)
      for (const key of keys) expect(resource[key], `${lang}/${namespace}: ${key}`).toBeTruthy()
    }
  })
})
