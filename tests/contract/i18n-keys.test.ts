import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { I18N_NAMESPACES, LOCALES, localeResourcePath, type Locale, type LocaleResource } from '@shared'

/**
 * 代码里用到的 key 必须真的存在（契约测试）。
 *
 * `t('terminal:tab.foo')` 拼错一个字母，界面显示的是 humanize 后的英文词，构建、类型检查、
 * 现有单测全绿——只有用户会发现「这个按钮的字怪怪的」。所以直接扫源码里的字面量 key 与词表对齐。
 */
const repoRoot = resolve(__dirname, '../..')

function load(lang: Locale, namespace: string): LocaleResource {
  return JSON.parse(readFileSync(resolve(repoRoot, localeResourcePath(lang, namespace as never)), 'utf8')) as LocaleResource
}

const dictionaries: Record<string, LocaleResource> = {}
for (const lang of LOCALES) {
  for (const namespace of I18N_NAMESPACES) {
    dictionaries[`${lang}/${namespace}`] = load(lang, namespace)
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...sourceFiles(full))
    else if (['.ts', '.tsx'].includes(extname(full)) && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

interface KeyUsage {
  namespace: string
  key: string
  file: string
}

const usages: KeyUsage[] = []
const LITERAL_KEY = /\bt\(\s*'([a-zA-Z][a-zA-Z-]*):([^'${}]+)'/g

for (const file of sourceFiles(resolve(repoRoot, 'src/renderer'))) {
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(LITERAL_KEY)) {
    usages.push({ namespace: match[1]!, key: match[2]!, file: relative(repoRoot, file) })
  }
}

describe('i18n key 使用情况', () => {
  it('至少扫到一批字面量 key（扫描器本身没坏）', () => {
    expect(usages.length).toBeGreaterThan(50)
  })

  it('用到的 namespace 都在契约列表里（拼错 namespace 会静默退化成 common）', () => {
    const unknown = [...new Set(usages.map((usage) => usage.namespace))].filter(
      (namespace) => !(I18N_NAMESPACES as readonly string[]).includes(namespace)
    )
    expect(unknown, `未知 namespace: ${unknown.join(', ')}`).toEqual([])
  })

  it('en 与 zh-CN 都包含代码里用到的每一个 key', () => {
    const problems: string[] = []
    for (const usage of usages) {
      for (const lang of LOCALES) {
        const dictionary = dictionaries[`${lang}/${usage.namespace}`]
        if (!dictionary) {
          problems.push(`${lang}/${usage.namespace}.json 不存在（${usage.file} 用了 ${usage.namespace}:${usage.key}）`)
          continue
        }
        if (!(usage.key in dictionary)) {
          problems.push(`${lang} 缺 key: ${usage.namespace}:${usage.key}（${usage.file}）`)
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('每个 namespace 至少被用到一次（孤儿词表说明登记错了）', () => {
    const used = new Set(usages.map((usage) => usage.namespace))
    const orphan = I18N_NAMESPACES.filter((namespace) => !used.has(namespace))
    // auth / sync / hosts / ai 属于其它成员的功能，尚未接线时允许暂时没有字面量引用
    const allowedIdle: string[] = ['auth', 'sync', 'hosts', 'ai']
    expect(orphan.filter((namespace) => !allowedIdle.includes(namespace))).toEqual([])
  })

  it('zh-CN 文案不包含「半成品」标记', () => {
    const suspicious = /TODO|FIXME|待补|XXX|\?\?\?/i
    const offenders: string[] = []
    for (const namespace of I18N_NAMESPACES) {
      for (const [key, value] of Object.entries(dictionaries[`zh-CN/${namespace}`]!)) {
        if (suspicious.test(value)) offenders.push(`zh-CN/${namespace}:${key} = ${value}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
