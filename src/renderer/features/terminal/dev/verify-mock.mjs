/**
 * 终端/多页签的浏览器级验证脚本（t3 交付时用它跑出 22 项断言，qa 可直接复用）。
 *
 * 为什么放在这里而不是 e2e/：它验证的是 features/terminal 自己的 dev mock 页
 * （`/features/terminal/dev/mock.html`），不需要启动 Electron 主进程，也不属于
 * architect/qa 维护的正式 e2e 套件；留在 feature 目录里跟着实现一起改。
 *
 * 用法（需要本机已装 chromium：`npx playwright install chromium`）：
 *   1) 起 dev server：`unset ELECTRON_RUN_AS_NODE && npx electron-vite dev`
 *      —— 注意它只监听 [::1]，所以下面必须用 http://localhost:5273，
 *         用 127.0.0.1 会 ERR_CONNECTION_REFUSED。
 *   2) 跑：`node src/renderer/features/terminal/dev/verify-mock.mjs`
 *   3) 截图落在 artifacts/（已 gitignore），断言不过时 exitCode=1。
 *
 * 覆盖：WebGL/DOM 两条渲染路径、握手与输入回显、addon-search 命中计数、
 * 字号缩放、双页签常驻（切页签不重建）、未读徽标、关闭二次确认、多行粘贴提示、
 * 主题切换后终端跟随（registerXterm 单一路径）。
 */

// t3 临时验证脚本（不入库）：Chromium 打开 dev server 上的 mock 终端页，
// WebGL 页验证渲染器，DOM 页验证文本级行为（输入回显/搜索/缩放/页签/粘贴确认）。
import { chromium } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const BASE = process.env.MOCK_BASE ?? 'http://localhost:5273/features/terminal/dev/mock.html'
const OUT = 'artifacts'
mkdirSync(OUT, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()

async function openPage(url, { clipboard } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
  const errors = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  if (clipboard) {
    await page.addInitScript((text) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: async () => text, writeText: async () => {} }
      })
    }, clipboard)
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__termansMockReady === true, null, { timeout: 20000 })
  await page.locator('[data-testid="terminal-workspace"] .xterm-screen').first().waitFor({ state: 'visible', timeout: 20000 })
  return { page, errors }
}

// ---------- A. WebGL 渲染页 ----------
{
  const { page, errors } = await openPage(BASE)
  await page.waitForFunction(
    () => document.querySelector('[data-testid="terminal-workspace"]')?.getAttribute('data-renderer') === 'webgl',
    null,
    { timeout: 15000 }
  )
  const renderer = await page.locator('[data-testid="terminal-workspace"]').getAttribute('data-renderer')
  const canvases = await page.locator('[data-testid="terminal-workspace"] canvas').count()
  const statusText = await page.locator('[data-testid="term-status"]').innerText()
  check('WebGL 渲染器启用（data-renderer=webgl）', renderer === 'webgl', String(renderer))
  check('WebGL 画布已挂载到终端', canvases >= 1, `canvas=${canvases}`)
  check('状态条显示尺寸与渲染器', /×/.test(statusText) && /WEBGL/i.test(statusText), statusText.replace(/\n/g, ' '))
  check('WebGL 页无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.screenshot({ path: `${OUT}/t3-terminal-webgl.png` })

  // 主题切换：走主题模块（registerXterm 跟随），终端背景必须跟着变
  const bgBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ts-bg-app').trim()
  )
  await page.screenshot({ path: `${OUT}/t3-theme-before.png`, clip: { x: 820, y: 560, width: 60, height: 40 } })
  const applied = await page.evaluate(() => window.__termansMockApplyTheme?.('termans-light'))
  await page.waitForTimeout(500)
  const bgAfter = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ts-bg-app').trim()
  )
  await page.screenshot({ path: `${OUT}/t3-theme-after.png`, clip: { x: 820, y: 560, width: 60, height: 40 } })
  check('主题切换落到 DOM（--ts-bg-app 变化）', bgBefore !== bgAfter, `${applied}: ${bgBefore} → ${bgAfter}`)
  const activeAfter = await page.locator('[data-testid="terminal-workspace"]').isVisible()
  check('切主题后终端仍在（没有重建实例）', activeAfter)
  await page.screenshot({ path: `${OUT}/t3-terminal-light.png` })
  await page.close()
}

// ---------- B. DOM 渲染页（文本级断言） ----------
{
  const { page, errors } = await openPage(`${BASE}?renderer=dom&heartbeat=400`, {
    clipboard: 'first-line\nsecond-line\n'
  })
  const renderer = await page.locator('[data-testid="terminal-workspace"]').getAttribute('data-renderer')
  check('?renderer=dom 走 DOM 回退渲染器', renderer === 'dom', String(renderer))

  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('Welcome to Termans mock shell') === true,
    null,
    { timeout: 20000 }
  )
  const rows = () => page.locator('[data-testid^="terminal-surface-"]:not([hidden]) .xterm-rows').first()
  const welcome = await rows().innerText()
  check('mock 会话握手并输出欢迎语', welcome.includes('Welcome to Termans mock shell'), welcome.split('\n')[0])
  check('页签条渲染', (await page.locator('[data-testid="tab-strip"]').count()) === 1)
  check('自动开了一个页签', (await page.locator('[data-testid="tab-strip"] .ts-tab').count()) === 1)

  // 键盘输入 → ssh:input → mock 回显
  await page.locator('.xterm-screen').first().click()
  await page.keyboard.type('echo hello-from-e2e')
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    () => document.querySelector('.xterm-rows')?.textContent?.includes('hello-from-e2e') === true,
    null,
    { timeout: 10000 }
  )
  check('输入经 transport 回显到终端', (await rows().innerText()).includes('hello-from-e2e'))

  // 搜索（addon-search）
  await page.locator('[data-testid="term-search-toggle"]').click()
  await page.locator('[data-testid="term-search-input"]').fill('mock')
  await page.waitForTimeout(400)
  const countText = await page.locator('[data-testid="term-search-count"]').innerText()
  check('addon-search 命中计数', /\d+\s*\/\s*\d+/.test(countText) && !/^0\s*\/\s*0$/.test(countText.trim()), countText.trim())
  await page.screenshot({ path: `${OUT}/t3-terminal-search.png` })
  await page.keyboard.press('Escape')

  // 字体缩放
  const fontSize = () =>
    page.evaluate(() => {
      const el = document.querySelector('.xterm-rows')
      return el ? getComputedStyle(el).fontSize : ''
    })
  const before = await fontSize()
  await page.locator('[data-testid="term-zoom-in"]').click()
  await page.locator('[data-testid="term-zoom-in"]').click()
  await page.waitForTimeout(400)
  const after = await fontSize()
  check('字体缩放生效', parseFloat(after) > parseFloat(before), `${before} → ${after}`)
  await page.locator('[data-testid="term-zoom-reset"]').click()
  await page.waitForTimeout(300)

  // 新建页签（picker → 选主机）
  await page.locator('[data-testid="tab-new"]').click()
  await page.locator('[data-testid="new-tab-picker"]').waitFor({ state: 'visible', timeout: 5000 })
  await page.locator('[data-testid^="picker-host-"]:not([data-testid="picker-host-filter"])').first().click()
  await page.waitForTimeout(800)
  const tabCount = await page.locator('[data-testid="tab-strip"] .ts-tab').count()
  const surfaces = await page.locator('[data-testid^="terminal-surface-"]').count()
  check('新建页签后共 2 个页签', tabCount === 2, `tabs=${tabCount}`)
  check('每个页签各有一个常驻终端（切页签不重建）', surfaces === 2, `surfaces=${surfaces}`)

  // 切回第一个页签 → scrollback 还在
  await page.locator('[data-testid="tab-strip"] .ts-tab').first().click()
  await page.waitForTimeout(400)
  check('切页签后保留 scrollback', (await rows().innerText()).includes('hello-from-e2e'))

  // 非激活页签收到输出 → 未读标记
  // 用 mock transport 的 heartbeat 制造「页签 2 在后台持续输出」：在激活页签上打字不可能产生未读，
  // 因为 markOutput 只对被激活的那个页签跳过——输出必须发生在它不活跃的时候。
  await page.locator('[data-testid="tab-strip"] .ts-tab').first().click()
  await page.waitForFunction(() => document.querySelector('[data-testid^="tab-unread-"]') !== null, null, {
    timeout: 10000
  })
  const unread = await page.locator('[data-testid^="tab-unread-"]').count()
  const unreadText = await page.locator('[data-testid^="tab-unread-"]').first().innerText()
  check('后台页签输出累计未读徽标', unread >= 1, `badges=${unread} text=${unreadText.trim()}`)

  // 关闭活跃会话页签 → 二次确认
  await page.locator('[data-testid^="tab-close-"]').first().click()
  await page.locator('[data-testid="close-tab-dialog"]').waitFor({ state: 'visible', timeout: 5000 })
  check('关闭活跃会话页签弹二次确认', await page.locator('[data-testid="close-tab-dialog"]').isVisible())
  await page.screenshot({ path: `${OUT}/t3-terminal-tabs.png` })
  await page.locator('[data-testid="close-tab-cancel"]').click()
  check('取消后页签仍在', (await page.locator('[data-testid="tab-strip"] .ts-tab').count()) === 2)

  // 多行粘贴要弹安全提示
  await page.locator('[data-testid="term-paste"]').click()
  await page.locator('[data-testid="paste-dialog"]').waitFor({ state: 'visible', timeout: 5000 })
  const pasteLines = await page.locator('[data-testid="paste-lines"]').innerText()
  check('多行粘贴弹安全提示', await page.locator('[data-testid="paste-dialog"]').isVisible(), pasteLines.trim())
  await page.screenshot({ path: `${OUT}/t3-terminal-paste.png` })
  await page.locator('[data-testid="paste-cancel"]').click()

  // captain 裁定：主题联动只能走主题模块的 registerXterm（我已删掉自己那份 MutationObserver）。
  // 证据用「文本前景色」：它来自 xterm 的 options.theme，不是我们的 CSS 类，
  // 所以它变了就说明 registerXterm 真的把新主题写进了这个（并未聚焦的）终端实例。
  const textColor = () =>
    page.evaluate(() => {
      const span = document.querySelector('.xterm-rows span')
      return span ? getComputedStyle(span).color : 'missing'
    })
  const colorDark = await textColor()
  await page.evaluate(() => window.__termansMockApplyTheme?.('termans-light'))
  await page.waitForTimeout(500)
  const colorLight = await textColor()
  const luminance = (rgb) => {
    const m = /rgba?\((\d+), (\d+), (\d+)/.exec(rgb || '')
    return m ? 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) : -1
  }
  check(
    '切主题后终端文字色跟着变（registerXterm 唯一路径，无自有 observer）',
    luminance(colorDark) > 128 && luminance(colorLight) < 128,
    `${colorDark} → ${colorLight}`
  )
  await page.evaluate(() => window.__termansMockApplyTheme?.('termans-dark'))

  check('DOM 页无 console 错误', errors.length === 0, errors.slice(0, 3).join(' | '))
  await page.screenshot({ path: `${OUT}/t3-terminal-workspace.png` })
  await page.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
