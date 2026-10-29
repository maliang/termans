import { expect, test } from '@playwright/test'
import { startMockAiServer, type MockAiServer } from './fixtures/ai-mock'
import { startE2eSshServer, type E2eSshServer } from './fixtures/ssh-server'
import { launchApp, type LaunchedApp } from './harness'
import {
  addHost,
  configureAiProvider,
  connectHost,
  createVault,
  enableAi,
  enableAiContext,
  executeAiCommandCard,
  openAiPanel,
  sendAiPrompt,
  terminalText,
  waitForConnected
} from './fixtures/ui'

/**
 * AI 辅助（验收 ③）：**发送前看得见要发什么；命令进终端必须二次确认。**
 *
 * 供应商用本地 mock（`e2e/fixtures/ai-mock.ts`）：离线可跑，而且请求体全被记录下来，
 * 于是「点确认之前一个字节都没发出去」「发出去的内容里确实带了终端上下文」都能硬断言，
 * 这是真 API 做不到的。
 */

test.describe.configure({ mode: 'serial' })

/** 只出现在 mock 返回的命令里，用来判断「命令有没有被写进终端」 */
const EXEC_SENTINEL = 'AI-EXECUTED-42'
/** mock 模型回复的 Markdown（围栏代码块会被渲染成命令卡） */
const REPLY = `先确认文件是否存在：

\`\`\`bash
echo ${EXEC_SENTINEL}
\`\`\`
`
/** 只出现在用户 prompt 里，用来在预览里定位「我发的是什么」 */
const PROMPT = 'PROMPT-SENTINEL-77 请帮我确认一下当前环境'

let app: LaunchedApp
let ssh: E2eSshServer
let mock: MockAiServer

test.beforeEach(async () => {
  ssh = await startE2eSshServer()
  mock = await startMockAiServer({ text: REPLY })
  app = await launchApp({
    args: ['--disable-gpu'],
    waitFor: (page) => page.getByTestId('unlock-screen').waitFor()
  })
  const page = app.window
  await createVault(page)
  await addHost(page, {
    label: 'ai-host',
    hostname: '127.0.0.1',
    port: ssh.port,
    username: ssh.username,
    password: ssh.password
  })
  await connectHost(page, 'ai-host')
  await waitForConnected(page)
  await enableAi(page)
  await configureAiProvider(page, {
    name: 'mock-openai',
    baseUrl: mock.baseUrl,
    model: 'mock-model',
    apiKey: 'sk-e2e-test-0001'
  })
  await enableAiContext(page)
})

test.afterEach(async () => {
  await app?.cleanup()
  await ssh?.stop()
  await mock?.stop()
})

test('发送前必须看到将要发送的内容，命令卡必须二次确认才写进终端', async () => {
  const page = app.window
  const panel = page.getByTestId('ai-panel')
  await openAiPanel(page)

  await sendAiPrompt(page, PROMPT)

  // ① 预览：用户能看见 prompt 本体 + 即将随行发送的终端上下文
  const dialog = page.getByTestId('ai-preview-dialog')
  await expect(dialog).toBeVisible()
  const previewText = (await page.getByTestId('ai-preview-content').innerText()).replace(/\s+/g, ' ')
  expect(previewText).toContain('PROMPT-SENTINEL-77')
  // 终端上下文里应该有夹具的 banner —— 证明「带上终端内容」不是个开关摆设
  expect(previewText).toContain('termans-e2e ready')
  // ② 还没点发送，供应商一个请求都不该收到
  expect(mock.requests).toHaveLength(0)

  await page.getByTestId('ai-preview-send').click()
  await expect(dialog).toBeHidden()

  // ③ 请求真的发出去了，且发给模型的内容与预览一致（含终端上下文）
  await expect.poll(() => mock.requests.length, { timeout: 15_000 }).toBe(1)
  const sent = JSON.stringify(mock.requests[0]?.body ?? {})
  expect(sent).toContain('PROMPT-SENTINEL-77')
  expect(sent).toContain('termans-e2e ready')
  expect(mock.requests[0]?.authorization).toBe('***0001')

  // ④ 回复被流式拼起来，围栏代码块渲染成命令卡（默认按钮是「复制」，执行要另外点）
  await expect(panel.getByTestId('ai-message-assistant').last()).toContainText(EXEC_SENTINEL, { timeout: 20_000 })
  const card = page.getByTestId('ai-command-card').first()
  await expect(card).toBeVisible()
  await expect(card).toContainText(`echo ${EXEC_SENTINEL}`)

  // ⑤ 关键断言：卡片出现 ≠ 命令已执行
  expect(await terminalText(page)).not.toContain(EXEC_SENTINEL)

  // ⑥ 第一次点「执行」→ 二次确认；**取消**则什么都不发生
  await executeAiCommandCard(page)
  await expect(page.getByTestId('ai-execute-dialog')).toContainText(`echo ${EXEC_SENTINEL}`)
  await page.getByTestId('ai-execute-cancel').click()
  await expect(page.getByTestId('ai-execute-dialog')).toBeHidden()
  await expect.poll(async () => (await terminalText(page)).includes(EXEC_SENTINEL), { timeout: 3_000 }).toBe(false)

  // ⑦ 再点一次并确认 → 命令进终端、夹具回显
  await executeAiCommandCard(page)
  await page.getByTestId('ai-execute-confirm').click()
  await expect(page.getByTestId('ai-execute-dialog')).toBeHidden()
  await expect.poll(async () => (await terminalText(page)).includes(EXEC_SENTINEL), { timeout: 15_000 }).toBe(true)
})

test('供应商不可达：报错可见，且不会偷偷执行命令卡', async () => {
  const page = app.window
  mock.setReply({ status: 500, message: 'mock upstream boom' })

  await openAiPanel(page)
  await sendAiPrompt(page, '第二条：PROMPT-SENTINEL-88')
  await page.getByTestId('ai-preview-send').click()

  const error = page.getByTestId('ai-error')
  await expect(error).toBeVisible({ timeout: 20_000 })
  // 失败时不允许任何命令卡进入可执行状态
  await expect(page.getByTestId('ai-command-card')).toHaveCount(0)
  expect(await terminalText(page)).not.toContain(EXEC_SENTINEL)
})
