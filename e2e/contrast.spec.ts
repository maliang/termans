import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './harness'
import { invokeInPage } from './fixtures/ui'

/**
 * 对比度回归：4 套内置主题 × 5 个界面状态，逐元素算 WCAG 对比度，低于阈值即红。
 *
 * 为什么要有这条用例：主人反馈「设置主口令界面有黄底白字提示，看不清」—— 这种问题
 * 单测、类型检查、甚至人工点界面都发现不了（要算比值），只能用 DOM 全量扫描。
 * 本次扫描在修复前找到 63 处低于阈值，修完为 0；把它固化成回归，下次改配色漏一处就会红。
 *
 * 判据（不许为了迁就现状而下调）：
 * - 正文（font-size < 24px，或 < 18.66px+bold）：4.5:1 —— WCAG 2.1 AA，也是 SPEC M-06 的口径
 * - 大字号（≥24px，或 ≥18.66px 且 bold）：3:1
 * - muted 文字同样按 4.5 算：它是「次要正文」不是装饰，弱化不等于可以不达标
 *
 * 每个「主题 × 状态」都要断言「违规元素数 = 0」，同时断言「扫描到的元素数 ≥ 下限」——
 * 否则界面结构一变（整屏没渲染出来）时会以「0 个元素、0 个违规」的形式假绿。
 */

const THEMES = ['termans-dark', 'termans-midnight', 'termans-light', 'termans-contrast'] as const
type ThemeId = (typeof THEMES)[number]

/**
 * 5 个状态都对应真实用户会停留、且文字与底色关系各不相同的屏：
 * 1. setup              未初始化 → 「设置主口令」引导屏（主人报的那一眼）
 * 2. weak-warn          口令被判弱后的黄色提示条（就是这次出事的地方）
 * 3. shell              解锁后的主外壳（侧栏/页签条/终端空态/状态条）
 * 4. settings-appearance 设置 → 外观（主题卡片、色板、对比度提示）
 * 5. settings-security  设置 → 安全（主口令表单、危险区按钮）
 */
const STATES = ['setup', 'weak-warn', 'shell', 'settings-appearance', 'settings-security'] as const

/** 弱到必然触发「弱口令二次确认」的主口令（产品要求 ≥12 位、含多类字符才算强） */
const WEAK_PASSPHRASE = 'termans-e2e-passphrase'

/**
 * 白名单：不参与对比度断言的元素，逐条给理由。
 * 只允许「本来就不是给人读的」或「颜色不由 token 决定」两类进来，
 * 不许因为「扫出来是红的」就把它加进来。
 */
const EXCLUDE = {
  /** 装饰性图标容器：lucide 图标、SVG 均带 aria-hidden，读屏与语义上都不可见 */
  decorative: '[aria-hidden="true"]',
  /**
   * 终端网格：xterm 的前景/背景由 xterm 的 theme 对象与 ANSI 调色板决定，
   * 不是 CSS token；它的可读性由「主题 tokens → xterm theme」的映射单测负责。
   * 而且 xterm 会内联 style，混合算出来的比值不代表用户看到的配色。
   */
  terminal: '.xterm, .xterm *'
} as const

/**
 * 在页面里执行的扫描脚本。只收「有直接文本子节点」的元素（纯图标按钮、空 div 天然进不来），
 * 背景从自身向上找到第一个不透明背景并按 alpha 合成，前景若半透明也先与背景合成再比。
 */
const COLLECT = (() => {
  const exclude = JSON.stringify([EXCLUDE.decorative, EXCLUDE.terminal])
  return `(() => {
  const EXCLUDE = ${exclude}
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null
    const p = m[1].split(',').map((v) => parseFloat(v.trim()))
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
  }
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b)
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
    return (hi + 0.05) / (lo + 0.05)
  }
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1
  })
  const bgOf = (el) => {
    let cur = el, acc = null
    while (cur) {
      const s = getComputedStyle(cur)
      const c = parse(s.backgroundColor)
      const img = s.backgroundImage && s.backgroundImage !== 'none'
      if (c && c.a > 0) acc = acc ? blend(acc, c) : c
      if (acc && acc.a >= 1) return { color: acc, image: img }
      if (img) return { color: acc || { r: 0, g: 0, b: 0, a: 1 }, image: true }
      cur = cur.parentElement
    }
    return { color: acc || { r: 255, g: 255, b: 255, a: 1 }, image: false }
  }
  const violations = []
  const seen = new Set()
  let scanned = 0
  let skippedImage = 0
  let skippedExcluded = 0
  for (const el of document.querySelectorAll('*')) {
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent || '').trim())
      .join('')
    if (!own) continue
    if (EXCLUDE.some((sel) => el.closest(sel) !== null)) { skippedExcluded += 1; continue }
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) < 0.15) continue
    const bg = bgOf(el)
    if (bg.image) { skippedImage += 1; continue }
    const fg = parse(s.color)
    if (!fg) continue
    scanned += 1
    const fgc = fg.a < 1 ? blend(fg, bg.color) : fg
    const r = ratio(fgc, bg.color)
    const size = parseFloat(s.fontSize)
    const bold = parseInt(s.fontWeight, 10) >= 700
    const large = size >= 24 || (size >= 18.66 && bold)
    const need = large ? 3 : 4.5
    if (r >= need) continue
    const key = own.slice(0, 24) + '|' + s.color + '|' + s.backgroundColor
    if (seen.has(key)) continue
    seen.add(key)
    const cls = el.className && typeof el.className === 'string'
      ? el.className.split(/\\s+/).filter(Boolean).slice(0, 2).join('.')
      : ''
    violations.push({
      text: own.slice(0, 40),
      tag: el.tagName.toLowerCase(),
      cls,
      fg: s.color,
      bg: 'rgb(' + Math.round(bg.color.r) + ', ' + Math.round(bg.color.g) + ', ' + Math.round(bg.color.b) + ')',
      ratio: Math.round(r * 100) / 100,
      need,
      size: Math.round(size * 10) / 10
    })
  }
  return { scanned, skippedImage, skippedExcluded, violations }
})()`
})()

interface Violation {
  text: string
  tag: string
  cls: string
  fg: string
  bg: string
  ratio: number
  need: number
  size: number
}

interface Sample {
  scanned: number
  skippedImage: number
  skippedExcluded: number
  violations: Violation[]
}

/**
 * 每个状态的「扫描到的元素数」下限。取值来自实测值的一半左右，作用只有一个：
 * 界面没渲染出来（或 testid 改名导致停在别的屏）时立刻红，而不是「0 个元素 0 违规」假绿。
 */
const MIN_SCANNED: Record<(typeof STATES)[number], number> = {
  setup: 6,
  'weak-warn': 6,
  shell: 10,
  'settings-appearance': 15,
  'settings-security': 10
}

async function sample(page: Page): Promise<Sample> {
  return (await page.evaluate(COLLECT)) as Sample
}

function describe(theme: ThemeId, state: string, s: Sample): string {
  const head = `主题 ${theme} / 状态 ${state}：${s.violations.length} 处文字与底色对比度低于阈值（扫描 ${s.scanned} 个元素）`
  const rows = s.violations.map((v) => {
    const cls = v.cls ? `.${v.cls}` : ''
    return `  - <${v.tag}${cls}> 「${v.text}」 fg=${v.fg} bg=${v.bg} 实测 ${v.ratio}:1 < 需 ${v.need}:1（${v.size}px）`
  })
  return [head, ...rows].join('\n')
}

async function applyTheme(page: Page, theme: ThemeId): Promise<void> {
  await invokeInPage(page, 'settings:update', { themeId: theme })
  // settings:update 会广播 settings:changed → 主题 store 调 applyThemeToDocument()，
  // 后者给 documentElement 写 data-theme-id。等它真的生效再采样，否则采到的是上一个主题。
  await expect
    .poll(async () => page.evaluate(() => document.documentElement.dataset['themeId']), { timeout: 10_000 })
    .toBe(theme)
}

/**
 * 把应用推到「弱口令警告」那一屏。
 * 该提示条是协议级的二次确认：第一次提交弱口令时主进程回 weak-passphrase，界面才渲染
 * `weak-passphrase-warning`；同口令再提交一次才真的建库 —— 所以这里刻意停在提示出现的那一刻。
 */
async function reachWeakWarning(page: Page): Promise<void> {
  await page.getByTestId('passphrase-input').fill(WEAK_PASSPHRASE)
  await page.getByTestId('passphrase-repeat').fill(WEAK_PASSPHRASE)
  await page.getByTestId('create-vault').click()
  await expect(page.getByTestId('weak-passphrase-warning')).toBeVisible({ timeout: 20_000 })
}

/** 接受弱口令（同口令再点一次创建）→ 回到外壳 */
async function finishVaultCreation(page: Page): Promise<void> {
  await page.getByTestId('create-vault').click()
  const recovery = page.getByTestId('unlock-recovery-code')
  const screen = page.getByTestId('unlock-screen')
  // 建库成功即解锁：`App.tsx:161` 是 `{locked ? <UnlockScreen /> : null}`，所以解锁屏会被**卸载**，
  // 恢复码屏（同一组件里的 recovery-saved 分支）在正常路径上根本没机会出现 —— 直接等解锁屏消失。
  // 仍然保留「万一产品改成先展示恢复码」的分支，两条路都不靠固定 sleep。
  await expect
    .poll(
      async () => {
        if (await recovery.isVisible().catch(() => false)) return 'recovery'
        if ((await screen.count()) === 0) return 'unlocked'
        return 'pending'
      },
      { timeout: 20_000 }
    )
    .not.toBe('pending')
  if (await recovery.isVisible().catch(() => false)) {
    // 「我已经保存好了」按钮没有 testid（同一容器里另有「下载」按钮，靠文案又会随语言变）
    await recovery.getByRole('button').last().click()
  }
  await expect(screen).toHaveCount(0, { timeout: 20_000 })
  await expect(page.getByTestId('host-sidebar')).toBeVisible()
}

for (const theme of THEMES) {
  test(`对比度：主题 ${theme} 的 5 个状态全部达标`, async () => {
    // mainEntry 必须是仓库根：harness 默认指 out/main/index.js，那里没有 package.json，
    // app.getVersion() 会回落成 Electron 版本（不影响对比度，但截图/日志里会写出错版本号）。
    const { app, window: page, cleanup } = await launchApp({
      mainEntry: process.cwd(),
      args: ['--disable-gpu']
    })
    const samples: Partial<Record<(typeof STATES)[number], Sample>> = {}
    try {
      await expect(page.locator('.ts-app')).toBeVisible({ timeout: 60_000 })
      await applyTheme(page, theme)

      // ① 未初始化：设置主口令
      samples.setup = await sample(page)

      // ② 弱口令警告
      await reachWeakWarning(page)
      samples['weak-warn'] = await sample(page)

      // ③ 主界面外壳
      await finishVaultCreation(page)
      samples.shell = await sample(page)

      // ④ 设置 → 外观
      await page.getByTestId('open-settings').click()
      await expect(page.getByTestId('settings-dialog')).toBeVisible()
      await page.getByTestId('settings-tab-appearance').click()
      await expect(page.getByTestId('appearance-settings')).toBeVisible()
      samples['settings-appearance'] = await sample(page)

      // ⑤ 设置 → 安全
      await page.getByTestId('settings-tab-security').click()
      await page.waitForTimeout(200)
      samples['settings-security'] = await sample(page)

      // 先断言「每个状态都采到了足够多的元素」，再断言违规数为 0：
      // 顺序反了的话，「某状态整屏没渲染」会被当成达标。
      for (const state of STATES) {
        const s = samples[state]
        expect(s, `主题 ${theme} / 状态 ${state} 没有采样结果`).toBeDefined()
        expect(
          (s as Sample).scanned,
          `主题 ${theme} / 状态 ${state} 只扫到 ${(s as Sample).scanned} 个带文字的元素（下限 ${MIN_SCANNED[state]}），` +
            '说明这一屏没渲染出来或已有元素被误排除，此时「0 处违规」不代表达标'
        ).toBeGreaterThanOrEqual(MIN_SCANNED[state])
      }

      // 违规**跨状态汇总后一次性断言**：分成 5 条断言时，第一条红就中断，人只看到一个状态的毛病，
      // 得跑 5 次才知道全貌。汇总成一条后，一次失败就能看到「哪个主题的哪几屏、哪些元素、差多少」。
      const problems = STATES.filter((state) => (samples[state] as Sample).violations.length > 0).map((state) =>
        describe(theme, state, samples[state] as Sample)
      )
      expect(problems, `主题 ${theme} 有 ${problems.length} 个状态存在对比度不达标元素`).toEqual([])

      // 白名单不是「随便跳过」：把被跳过的量级打出来，涨得离谱时人能在日志里看见
      const skipped = STATES.map((state) => `${state}=${(samples[state] as Sample).skippedImage}`).join(' ')
      test.info().annotations.push({
        type: 'skipped-background-image',
        description: `背景含渐变/图片而无法算比值的元素数：${skipped}`
      })
      // 采样规模是这条用例的「证据强度」：每个状态扫到多少个带文字的元素，直接打进日志
      const scanned = STATES.map((state) => `${state}=${(samples[state] as Sample).scanned}`).join(' ')
      console.log(`[contrast] ${theme}: ${scanned}`)
    } finally {
      await cleanup()
      void app
    }
  })
}
