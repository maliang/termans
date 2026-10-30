import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * e2e 选择器必须能命中真实存在的东西（QA D-2 的类级守卫）。
 *
 * 事故回顾：`e2e/ai-settings-models.spec.ts` 曾用
 * `[data-testid^="ai-provider-item-"]` 计数来证明「草稿读模型不落盘」，
 * 而当时卡片 testid 被改成了 `ai-provider-card` / `ai-provider-card-new`，
 * 旧前缀在整份 UI 里**不存在**，计数恒为 0，断言恒绿，等于没守
 * （那段历史还让 `ai-provider-item-` 这条既有契约整体消失）。
 * 现在的口径：卡片根元素保留 `ai-provider-item-<id>`，摘要行挂 `ai-provider-card` 供计数，
 * 两个 testid 同时存在，谁都不许单方面消失。
 *
 * 这类假绿的共同机制是「选择器指向不存在的 testid」，且失败的表现不是红，而是永远绿。
 * 所以这里对 e2e 里所有**前缀选择器**（`[data-testid^="..."]`）做静态对账：
 * 每个前缀都必须能在 `src/` 的某个 `data-testid` 字面量或模板里被找到，
 * 否则该选择器在 UI 里永远命中不到东西。
 *
 * 只覆盖前缀选择器，不覆盖 `getByTestId('字面量')`：后者大量由模板拼接产生
 * （如 `settings-tab-${tab.id}` 在测试里写成 `settings-tab-ai`），静态判定会误报。
 */

const repoRoot = resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (/\.(t|j)sx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** src/renderer 里所有 data-testid 的取值表达式（字面量与模板都算） */
function rendererTestIds(): string[] {
  const values: string[] = []
  for (const file of walk(resolve(repoRoot, 'src/renderer'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/data-testid=(?:"([^"]*)"|\{([^}]*)\})/g)) {
      values.push((match[1] ?? match[2] ?? '').trim())
    }
  }
  return values
}

/** e2e 里所有 `[data-testid^="..."]` 的前缀 */
function e2ePrefixSelectors(): Array<{ file: string; prefix: string }> {
  const found: Array<{ file: string; prefix: string }> = []
  for (const file of walk(resolve(repoRoot, 'e2e'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\[data-testid\^=\\?["']([^"'\\\]]+)/g)) {
      found.push({ file: file.slice(repoRoot.length + 1), prefix: match[1] })
    }
  }
  return found
}

describe('e2e 选择器与真实 testid 对账', () => {
  it('每个 [data-testid^="..."] 前缀都能在 src/renderer 里找到来源', () => {
    const testIds = rendererTestIds()
    const dangling = e2ePrefixSelectors().filter(({ prefix }) => !testIds.some((value) => value.includes(prefix)))
    expect(
      dangling,
      '这些前缀选择器在 UI 里永不存在（计数恒为 0，断言恒绿）：\n' +
        dangling.map((item) => `  ${item.file}: ${item.prefix}`).join('\n')
    ).toEqual([])
  })

  it('自检：扫到了前缀选择器，且能识别虚构前缀（证明本测试不是恒绿）', () => {
    const selectors = e2ePrefixSelectors()
    // 目前只有一个（`theme-option-`）；若归零说明正则或目录扫描坏了，同样是「恒绿」
    expect(selectors.length).toBeGreaterThan(0)
    const testIds = rendererTestIds()
    // 自检必须拿**虚构**前缀做反例。曾经这里写的是 `ai-provider-item-`，
    // 而它正是历史遗留的真实 testid——一旦卡片改名，这行会把「违约」固化成断言，
    // 让删掉旧 testid 的改动反而通过（AI 设置页 r2 实测踩过）。
    expect(testIds.some((value) => value.includes('ai-provider-nope-'))).toBe(false)
    // 真实存在的前缀必须判 true，否则「扫描到了但认不出」也会恒绿
    expect(testIds.some((value) => value.includes('theme-option-'))).toBe(true)
    // 旧 testid 体系（ai-provider-item-<id>）是有消费者的既有契约，必须仍在
    expect(testIds.some((value) => value.includes('ai-provider-item-'))).toBe(true)
  })
})
