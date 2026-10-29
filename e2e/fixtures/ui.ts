import { expect, type Page } from '@playwright/test'

/**
 * e2e 的 UI 操作库 —— 把「解锁/建主机/连主机/读终端」这些步骤收敛成一处。
 *
 * 三条纪律：
 * 1. **只按 data-testid 与 label 定位**，不按文案定位：本机系统语言是中文，文案随语言变，按文案写用例等于埋一个会随 i18n 红的坑。
 * 2. 每一步都等到「真的发生了」（元素消失/文本出现），不用 `waitForTimeout` 当同步手段。
 * 3. 终端内容从 `.xterm-rows` 读 —— 只在 **DOM 渲染器** 下成立，所以调用方必须用 `launchApp({ args: ['--disable-gpu'] })`
 *    （WebGL 下终端文字在 canvas 里，DOM 里一个字都没有；实测 `.xterm-rows` 数量为 0）。
 */

/** 强到不会被「弱口令二次确认」挡住的测试主口令（产品要求 ≥12 位） */
export const VAULT_PASSPHRASE = 'Termans-E2E-Passw0rd!2026'

export interface HostSpec {
  label: string
  hostname: string
  port: number
  username: string
  password?: string
  /** publickey 认证时填：'' = 只管选认证方式（私钥另行导入 vault），有值则填 IdentityFile */
  privateKeyPath?: string
  /** 跳板机：填另一台主机的 label（这台主机必须先存在）。S-12 用它验证 jumpHostId 真的生效 */
  jumpHostLabel?: string
}

/** 第一次运行：创建加密包（含弱口令二次提交的重试逻辑），等到解锁屏消失 */
export async function createVault(page: Page, passphrase = VAULT_PASSPHRASE): Promise<void> {
  await expect(page.getByTestId('unlock-screen')).toBeVisible()
  await page.getByTestId('passphrase-input').fill(passphrase)
  await page.getByTestId('passphrase-repeat').fill(passphrase)
  await page.getByTestId('create-vault').click()

  // 口令被判弱：协议要求「同口令再提交一次」才接受（冻结契约里没有 confirm 字段）。
  // 两个分支二选一，等到任意一个发生再判断，避免用固定 sleep 猜时序。
  const weak = page.getByTestId('weak-passphrase-warning')
  await Promise.race([
    weak.waitFor({ timeout: 15_000 }).catch(() => null),
    page.getByTestId('unlock-screen').waitFor({ state: 'detached', timeout: 15_000 }).catch(() => null)
  ])
  if (await weak.isVisible().catch(() => false)) {
    await page.getByTestId('create-vault').click()
  }
  await expect(page.getByTestId('unlock-screen')).toHaveCount(0, { timeout: 20_000 })
  // 解锁屏消失 = 外壳可用；再等一次主机库真的渲染出来
  await expect(page.getByTestId('host-sidebar')).toBeVisible()
}

/** 已有加密包时解锁（错误口令用例也用它，结果由调用方断言） */
export async function unlockVault(page: Page, passphrase = VAULT_PASSPHRASE): Promise<void> {
  await expect(page.getByTestId('unlock-screen')).toBeVisible()
  await page.getByTestId('passphrase-input').fill(passphrase)
  await page.getByTestId('unlock-vault').click()
}

/** 新建一台主机并保存；返回后主机库里已经能看到它 */
export async function addHost(page: Page, host: HostSpec): Promise<void> {
  await page.getByTestId('host-new').click()
  await expect(page.getByTestId('host-label')).toBeVisible()
  await page.getByTestId('host-label').fill(host.label)
  await page.getByTestId('host-hostname').fill(host.hostname)
  await page.getByLabel(/端口|Port/).fill(String(host.port))
  await page.getByLabel(/用户名|Username/).fill(host.username)

  if (host.privateKeyPath !== undefined) {
    await page.getByLabel(/认证方式|Auth/).selectOption('publickey')
    // 空串 = 认证方式选 publickey 但私钥走 vault 导入（不填 IdentityFile）
    if (host.privateKeyPath !== '') await page.getByLabel(/IdentityFile/).fill(host.privateKeyPath)
  } else if (host.password !== undefined) {
    await page.getByTestId('host-password').fill(host.password)
  }

  if (host.jumpHostLabel !== undefined) {
    // 跳板机下拉的 option 文本就是主机 label（HostEditor.tsx 里按 candidate.label 渲染），
    // 没有 testid，靠 id 定位（select 的 id 是 ts-host-jump）。
    await page.locator('#ts-host-jump').selectOption({ label: host.jumpHostLabel })
  }

  await page.getByTestId('host-save').click()
  await expect(page.getByTestId('vault-host-item').filter({ hasText: host.label })).toBeVisible({ timeout: 15_000 })
}

/** 双击主机连上去，并在出现时接受主机密钥（记住指纹） */
export async function connectHost(page: Page, label: string): Promise<void> {
  const item = page.getByTestId('vault-host-item').filter({ hasText: label }).first()
  await expect(item).toBeVisible()
  await item.dblclick()

  const prompt = page.getByTestId('host-key-dialog')
  const appeared = await prompt.waitFor({ timeout: 20_000 }).then(
    () => true,
    () => false
  )
  if (appeared) {
    await page.getByTestId('host-key-accept').click()
    await expect(prompt).toBeHidden({ timeout: 10_000 })
  }
}

/**
 * 等连接真的可用：**等 SSH 服务端自己的 banner 出现在终端里**，而不是看状态点/标题文案。
 * 状态点类名属于渲染层实现细节，换个 class 名用例就红；banner 是端到端证据（服务端 → ssh:data → xterm）。
 */
export async function waitForConnected(page: Page, banner = 'termans-e2e ready', timeout = 30_000): Promise<void> {
  await expectTerminalContains(page, banner, timeout)
}

/**
 * 终端文本：**拼接全部 `.xterm-rows`**，不要只取第一个。
 * 不活跃页签的 xterm 面板仍挂在 DOM 里（切页签保留 scrollback 的实现就是「隐藏不销毁」），
 * 所以「切回页签还能看到之前的输出」这条断言的证据恰好来自非当前页签的那份 rows。
 */
export async function terminalText(page: Page): Promise<string> {
  const rows = page.locator('.xterm-rows')
  const count = await rows.count()
  if (count === 0) throw new Error('[e2e] 没有 .xterm-rows：是不是忘了 --disable-gpu（WebGL 下文字在 canvas 里）')
  const parts: string[] = []
  for (let index = 0; index < count; index += 1) parts.push(await rows.nth(index).innerText())
  return parts.join('\n')
}

/** 往当前终端敲一行命令（走真实键盘事件，覆盖 onData → ssh:input 全链路） */
export async function typeCommand(page: Page, command: string): Promise<void> {
  const textarea = page.locator('.xterm-helper-textarea').first()
  await textarea.click()
  await page.keyboard.type(command, { delay: 20 })
  await page.keyboard.press('Enter')
}

/** 等终端里出现某段文本（回显断言用） */
export async function expectTerminalContains(page: Page, text: string, timeout = 20_000): Promise<void> {
  await expect
    .poll(async () => terminalText(page), { timeout, message: `终端里应出现：${text}` })
    .toContain(text)
}

/* ---------------------------------------------------------------- 桥接辅助 */

/** 本机私钥在 vault 里的引用约定（与 src/renderer/features/vault/api.ts 的 PRIVATE_KEY_REF_PREFIX 一致） */
export const PRIVATE_KEY_REF_PREFIX = 'privatekey:'

interface HostListItem {
  id: string
  label: string
}

/**
 * 在渲染层进程里调一次 IPC 并**拆信封**。
 *
 * 所有 IPC 的返回值都是 `{ ok: true, data } | { ok: false, error }`（src/main/ipc/registry.ts），
 * 直接当业务对象用会得到「Cannot read properties of undefined」——踩过一次，这里统一拆。
 */
export async function invokeInPage(page: Page, channel: string, payload?: unknown): Promise<unknown> {
  const envelope = (await page.evaluate(
    async (args: { channel: string; payload?: unknown }) => {
      const bridge = window.termans
      if (bridge === undefined) throw new Error('[e2e] window.termans 不存在：preload 没加载成功')
      return bridge.invoke(args.channel, args.payload)
    },
    { channel, payload }
  )) as { ok: boolean; data?: unknown; error?: { code: string; message: string } }
  if (!envelope.ok) throw new Error(`[e2e] IPC ${channel} 失败：${envelope.error?.code} ${envelope.error?.message}`)
  return envelope.data
}

/**
 * 同 `invokeInPage`，但**不拆信封、失败也不抛**：需要断言「这个调用必须失败」（如 E_VAULT_LOCKED、
 * E_HOST_KEY_UNVERIFIED）时用它。踩过一次：期望失败的断言被 helper 抛成「测试红」，
 * 看起来像产品坏了，实际是断言通过了但没有出口。
 */
export async function invokeInPageRaw(
  page: Page,
  channel: string,
  payload?: unknown
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> {
  return (await page.evaluate(
    async (args: { channel: string; payload?: unknown }) => {
      const bridge = window.termans
      if (bridge === undefined) throw new Error('[e2e] window.termans 不存在：preload 没加载成功')
      return bridge.invoke(args.channel, args.payload)
    },
    { channel, payload }
  )) as { ok: boolean; data?: unknown; error?: { code: string; message: string } }
}

/**
 * 按 label 取主机 id（只读，走 hosts:list）。
 * 为什么不用 DOM：主机行上没有 id 属性，而后面要用 hostId 组 `privatekey:<hostId>` 引用。
 */
export async function hostIdByLabel(page: Page, label: string): Promise<string> {
  const library = (await invokeInPage(page, 'hosts:list')) as { hosts: HostListItem[] }
  const host = library.hosts.find((candidate) => candidate.label === label) ?? null
  if (host === null) throw new Error(`[e2e] 主机库里没有 label=${label}`)
  return host.id
}

/**
 * 把私钥导入 vault（等价于 UI 的「导入私钥」按钮，走同一条 credentials:set 通道）。
 *
 * 为什么用桥接而不是点 UI：当前 shell 里 PrivateKeyGuide 只在 `host !== null` 时渲染，
 * 而主机编辑器的编辑态无法打开（双击被 HostLibraryPane 改写成「连接」），
 * 于是「导入私钥」按钮点了没反应 —— 这是产品缺口，已作为 finding 上报；
 * 本函数让「公钥认证链路」本身仍能被端到端验证。
 */
export async function importPrivateKey(page: Page, label: string, privateKeyText: string): Promise<void> {
  const hostId = await hostIdByLabel(page, label)
  await invokeInPage(page, 'credentials:set', { reference: `${PRIVATE_KEY_REF_PREFIX}${hostId}`, secret: privateKeyText })
}

/** 清掉某台主机的本机私钥（模拟「换机后私钥不在本机」） */
export async function clearPrivateKey(page: Page, label: string): Promise<void> {
  const hostId = await hostIdByLabel(page, label)
  await invokeInPage(page, 'credentials:clear', { reference: `${PRIVATE_KEY_REF_PREFIX}${hostId}` })
}

/** 打开 AI 面板（状态条上的 AI 按钮） */
export async function openAiPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('ai-panel')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByTestId('status-toggle-ai').click()
  }
  await expect(panel).toBeVisible()
}

/** 打开设置对话框（状态条 ⚙） */
export async function openSettings(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
}

/**
 * 读「终端背景」的实际取值。
 *
 * 为什么不读 `.xterm` 的 computed background：xterm 把主题画在自己的渲染层里
 * （DOM 渲染器下 `.xterm-viewport` 始终是 `rgb(0, 0, 0)`，与主题无关），
 * 只有 canvas/theme 对象知道真实底色，DOM 上没有可依赖的计算值。
 * 所以取主题 token 的计算值 —— 它正是 `src/renderer/theme/xterm.ts` 传给
 * `options.theme.background` 的那一个（`background: tokens['--ts-bg-app']`），
 * 换个主题这个值必变，没变就说明主题没真正应用。
 */
export async function terminalBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    if (document.querySelector('.xterm') === null) throw new Error('[e2e] 没有打开的终端')
    return getComputedStyle(document.documentElement).getPropertyValue('--ts-bg-app').trim()
  })
}
// ---------------------------------------------------------------- AI 面板

/**
 * 打开 AI 总开关（默认关，见 `src/shared/models/settings.ts` 的 `DEFAULT_SETTINGS.ai.enabled = false`）。
 * 走真实设置界面而不是直接改 settings.json：开关本身也是一条要验证的路径。
 */
export async function enableAi(page: Page): Promise<void> {
  await openSettings(page)
  await page.getByTestId('settings-tab-ai').click()
  const toggle = page.getByTestId('ai-enabled-toggle')
  if (!(await toggle.isChecked())) {
    await toggle.check()
  }
  await expect(toggle).toBeChecked()
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('settings-dialog')).toBeHidden()
}

export interface AiProviderConfig {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
}

/** 在 AI 面板里新建/覆盖一个供应商配置（离线 mock 的 baseUrl 就填这里） */
export async function configureAiProvider(page: Page, config: AiProviderConfig): Promise<void> {
  await openAiPanel(page)
  const panel = page.getByTestId('ai-panel')
  const form = page.getByTestId('ai-provider-form')
  if (!(await form.isVisible().catch(() => false))) {
    // 面板头部有个「AI 供应商」图标（只有它带这个 aria-label）；空态时则是一个「添加供应商」按钮
    const opener = panel.getByRole('button', { name: /^(AI 供应商|AI provider)$/i })
    if ((await opener.count()) > 0) await opener.first().click()
    else await panel.getByRole('button', { name: /添加供应商|add provider/i }).click()
  }
  await expect(form).toBeVisible()
  // 必须 exact：`额外请求头` 的提示文案里也含「名称: 值」，用子串匹配会撞成 strict 冲突
  await form.getByLabel('名称', { exact: true }).fill(config.name)
  await form.getByLabel('Base URL', { exact: true }).fill(config.baseUrl)
  await form.getByLabel('模型', { exact: true }).fill(config.model)
  if (config.apiKey !== undefined) {
    await form.locator('input[type="password"]').fill(config.apiKey)
  }
  await form.getByRole('button', { name: /^保存$|^save$/i }).click()
  // 保存成功后 message 会被随后的 reloadProviders 冲掉，所以不盯 message，
  // 改盯「已配置的供应商」列表里真的出现了这条 —— 这是持久化生效的直接证据。
  await expect(form.getByRole('button', { name: new RegExp(`^${config.name} `) })).toBeVisible({ timeout: 15_000 })
  await panel.getByRole('button', { name: /返回|back/i }).click()
  await expect(page.getByTestId('ai-provider-form')).toBeHidden()
}

/** 勾上「带上终端上下文发送」（发送时会先弹预览） */
export async function enableAiContext(page: Page): Promise<void> {
  const toggle = page.getByTestId('ai-panel').locator('.ts-ai-context__toggle input[type="checkbox"]')
  if (!(await toggle.isChecked())) await toggle.check()
  await expect(toggle).toBeChecked()
}

/** 在 AI 输入框里写一条 prompt 并发送（⌘/Ctrl+Enter） */
export async function sendAiPrompt(page: Page, prompt: string): Promise<void> {
  const box = page.getByTestId('ai-panel').getByRole('textbox').first()
  await box.fill(prompt)
  await box.press('Meta+Enter')
}

/** 点命令卡上的「执行」（卡片主按钮是复制，执行需要额外点） */
export async function executeAiCommandCard(page: Page, index = 0): Promise<void> {
  const card = page.getByTestId('ai-command-card').nth(index)
  await card.getByRole('button', { name: /执行|execute/i }).click()
  await expect(page.getByTestId('ai-execute-dialog')).toBeVisible()
}

// ---------------------------------------------------------------- Git 同步

/** 打开同步面板 */
export async function openSyncPanel(page: Page): Promise<void> {
  await page.getByTestId('open-sync-panel').click()
  await expect(page.getByTestId('sync-panel')).toBeVisible()
}

export interface SyncTarget {
  /** HTTP smart-git 地址（`e2e/fixtures/git-http.ts` 的 `serveBareRepo().url`） */
  url: string
  branch?: string
  /** 本地 bare 仓库走 http 网关，没有凭据 → 'none'；默认就是它 */
  auth?: 'none' | 'token'
}

/** 首次连接远端（此时面板显示的是「远端地址 + 分支 + 认证」表单） */
export async function connectSyncRemote(page: Page, target: SyncTarget): Promise<void> {
  const panel = page.getByTestId('sync-panel')
  await page.getByTestId('sync-remote-url').fill(target.url)
  if (target.branch !== undefined) {
    await panel.getByLabel(/分支|branch/i).fill(target.branch)
  }
  await panel.getByLabel(/认证|authorization|auth/i).selectOption(target.auth ?? 'none')
  await page.getByTestId('sync-connect').click()
  // 连上之后表单消失、换成 push/pull 那组按钮
  await expect(page.getByTestId('sync-push')).toBeVisible({ timeout: 20_000 })
}

/** 推送到远端（等状态条从「同步中」回到稳定态由调用方断言仓库内容） */
export async function pushSync(page: Page): Promise<void> {
  await page.getByTestId('sync-push').click()
  await expect(page.getByTestId('sync-push')).toBeEnabled({ timeout: 30_000 })
}

/** 从远端拉取 */
export async function pullSync(page: Page): Promise<void> {
  await page.getByTestId('sync-pull').click()
  await expect(page.getByTestId('sync-pull')).toBeEnabled({ timeout: 30_000 })
}

/** 关掉同步面板（✕ 可能是面板内的取消按钮） */
export async function closeSyncPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('sync-panel')
  if (await panel.isVisible().catch(() => false)) {
    await panel.getByRole('button', { name: /取消|cancel/i }).click()
  }
  await expect(panel).toBeHidden()
}
