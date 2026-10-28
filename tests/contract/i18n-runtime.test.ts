import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18next, { type i18n as I18nInstance, type InitOptions } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18N_NAMESPACES, LOCALES, localeResourcePath, type Locale, type LocaleResource } from '@shared'
import {
  buildFallbackLng,
  buildI18nOptions,
  getMissingKeys,
  humanizeKey,
  resetMissingKeys,
  type LocaleResources
} from '@renderer/i18n/options'

/**
 * i18next 运行时行为（真实实例，不是 mock）。
 *
 * 覆盖 SPEC L-02 / L-03 / L-04 的操作化版本：
 * 缺 key 时**不允许**出现 `ns:key` 原始串、不允许空白；zh-CN 缺译必须回退英文；
 * 调用方给了 defaultValue 就以 defaultValue 为准。
 */
const repoRoot = resolve(__dirname, '../..')

function loadResources(): LocaleResources {
  const resources: LocaleResources = {}
  for (const lang of LOCALES) {
    resources[lang] = {}
    for (const namespace of I18N_NAMESPACES) {
      const path = resolve(repoRoot, localeResourcePath(lang, namespace as never))
      resources[lang]![namespace] = JSON.parse(readFileSync(path, 'utf8')) as LocaleResource
    }
  }
  return resources
}

const resources = loadResources()

async function createInstance(locale: Locale = 'en', overrides: Partial<InitOptions> = {}): Promise<I18nInstance> {
  const instance = i18next.createInstance()
  await instance.init({ ...buildI18nOptions({ resources, locale, dev: true }), ...overrides })
  return instance
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetMissingKeys()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  resetMissingKeys()
})

describe('基本翻译', () => {
  it('英文/中文都能取到值，插值生效', async () => {
    const en = await createInstance('en')
    expect(en.t('common:app.name')).toBe('Termans')
    expect(en.t('common:state.tabs', { count: 3 })).toBe('tabs: 3')

    const zh = await createInstance('zh-CN')
    expect(zh.t('common:action.closeTab')).toBe('关闭页签')
    expect(zh.t('common:state.tabs', { count: 3 })).toBe('页签：3')
  })

  it('扁平点号 key 有效（keySeparator:false）且 namespace 前缀有效（nsSeparator:":"）', async () => {
    const zh = await createInstance('zh-CN')
    expect(zh.t('terminal:tab.confirmClose.title')).toBe('关闭该会话？')
    expect(zh.t('settings:theme.contrast.pair.button')).toBe('主按钮文字')
    // 不写 namespace → 落到 defaultNS(common)
    expect(zh.t('action.save')).toBe('保存')
  })

  it('changeLanguage 之后同一实例返回新语言（设置页切换即时生效）', async () => {
    const instance = await createInstance('en')
    expect(instance.t('common:action.save')).toBe('Save')
    await instance.changeLanguage('zh-CN')
    expect(instance.t('common:action.save')).toBe('保存')
    expect(instance.resolvedLanguage).toBe('zh-CN')
  })

  it('terminal 的插值键在两种语言里都能组装（{{title}}/{{lines}}/{{current}}/{{total}}）', async () => {
    const en = await createInstance('en')
    expect(en.t('terminal:paste.warning.title', { lines: 12 })).toContain('12')
    expect(en.t('terminal:search.matches', { current: 2, total: 9 })).toContain('2')
    const zh = await createInstance('zh-CN')
    expect(zh.t('terminal:paste.warning.title', { lines: 12 })).toContain('12')
    expect(zh.t('terminal:search.matches', { current: 2, total: 9 })).toContain('9')
  })
})

describe('缺 key 的兜底（永不显示裸 key / 永不空白）', () => {
  it('缺 key 返回 humanize 后的可读文案，且不含 ":" 或 namespace 前缀', async () => {
    const en = await createInstance('en')
    const value = en.t('terminal:tab.thisKeyDoesNotExist')
    expect(value.trim()).not.toBe('')
    expect(value).not.toContain(':')
    expect(value).not.toContain('terminal.')
    expect(value).not.toContain('thisKeyDoesNotExist')
    // humanize 取最后两段（保留少量语境），所以是 `Tab This Key Does Not Exist`
    expect(value).toBe('Tab This Key Does Not Exist')
  })

  it('缺 key 会收集进 getMissingKeys 并在 dev 下 console.warn（不静默）', async () => {
    const en = await createInstance('en')
    en.t('errors:someUnknownKey')
    const collected = getMissingKeys()
    expect(collected.some((item) => item.namespace === 'errors' && item.key === 'someUnknownKey')).toBe(true)
    expect(warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('[i18n] missing key:'))).toBe(true)
  })

  it('同一个缺 key 只告警一次（避免滚动列表把控制台刷满）', async () => {
    const en = await createInstance('en')
    en.t('errors:repeatedKey')
    en.t('errors:repeatedKey')
    en.t('errors:repeatedKey')
    expect(getMissingKeys().filter((item) => item.key === 'repeatedKey')).toHaveLength(1)
    const warned = warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('repeatedKey'))
    expect(warned).toHaveLength(1)
  })

  it('调用方 defaultValue 优先于 humanize（terminal-ui 的兜底写法）', async () => {
    const en = await createInstance('en')
    expect(en.t('terminal:tab.hosts.title', { defaultValue: 'Hosts' })).toBe('Hosts')
    expect(en.t('terminal:notThereYet', { defaultValue: 'Custom label' })).toBe('Custom label')
  })

  it('zh-CN 缺译时回退英文（L-04）', async () => {
    const partial: LocaleResources = {
      en: { common: { ...resources.en!.common! } },
      'zh-CN': { common: { ...resources['zh-CN']!.common! } }
    }
    delete (partial['zh-CN']!.common as LocaleResource)['action.retry']

    const instance = i18next.createInstance()
    await instance.init(buildI18nOptions({ resources: partial, locale: 'zh-CN', dev: true }))
    expect(instance.t('common:action.retry')).toBe('Retry')
    expect(instance.t('common:action.save')).toBe('保存')
  })

  it('生产模式（dev:false）不打印 warn，但仍然不显示裸 key', async () => {
    const instance = i18next.createInstance()
    await instance.init(buildI18nOptions({ resources, locale: 'en', dev: false }))
    const value = instance.t('terminal:silentMissingKey')
    expect(value).toBe('Silent Missing Key')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('humanizeKey', () => {
  it('驼峰与连字符拆词、取最后两段、首字母大写', () => {
    expect(humanizeKey('tab.confirmClose.body')).toBe('Confirm Close Body')
    expect(humanizeKey('terminal:tab.new')).toBe('Tab New')
    expect(humanizeKey('paste.warning.single-line')).toBe('Warning Single Line')
    expect(humanizeKey('single')).toBe('Single')
  })

  it('空 key 原样返回（不抛异常）', () => {
    expect(humanizeKey('')).toBe('')
  })
})

describe('fallback 链', () => {
  it('zh-CN → en，en 无回退，且总以 en 收尾', () => {
    expect(buildFallbackLng('zh-CN')).toEqual(['zh-CN', 'en'])
    expect(buildFallbackLng('en')).toEqual(['en'])
  })

  it('init 选项把契约值原样带上（改这些会静默坏掉界面）', () => {
    const options = buildI18nOptions({ resources, locale: 'zh-CN' })
    expect(options.keySeparator).toBe(false)
    expect(options.nsSeparator).toBe(':')
    expect(options.saveMissing).toBe(true)
    expect(options.returnNull).toBe(false)
    expect(options.returnEmptyString).toBe(false)
    expect(options.supportedLngs).toEqual([...LOCALES])
    expect(options.ns).toEqual([...I18N_NAMESPACES])
    expect(options.defaultNS).toBe('common')
    expect(options.fallbackLng).toEqual(['zh-CN', 'en'])
  })
})
