import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { launchApp, type LaunchedApp } from './harness'
import { startMockAiServer, type MockAiServer } from './fixtures/ai-mock'
import { createVault, invokeInPage, openSettings, unlockVault } from './fixtures/ui'

/**
 * 设置 → AI 的「成熟 agent 工作台」形态（验收 AC-1 / AC-2 / AC-3 / AC-5 / AC-10 / AC-11）。
 *
 * 为什么这五条只能靠真点一遍：它们全部是**状态流**（未保存草稿 → 主进程用草稿发请求 → 列表渲染
 * → 点选回填；切换三档 → 落盘 → 重启后仍在；高级区默认收起）。构建通过、单测全绿都说明不了
 * 「点了会不会有反应」——本项目已经在这类「逻辑有、手感没有」上踩过。
 */

test.describe.configure({ mode: 'serial' })

const API_KEY = 'sk-draft-e2e-9f3a'
const MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'mock-large']

let app: LaunchedApp
let mock: MockAiServer

async function launch(userDataDir?: string): Promise<LaunchedApp> {
  return launchApp({
    ...(userDataDir === undefined ? {} : { userDataDir }),
    args: ['--disable-gpu'],
    waitFor: (page) => page.getByTestId('unlock-screen').waitFor()
  })
}

/** 进设置 → AI 页签，并保证 AI 开关已打开（不为『是否已启用』单独开一条用例） */
async function openAiSettings(page: Page): Promise<void> {
  await openSettings(page)
  await page.getByTestId('settings-tab-ai').click()
  const toggle = page.getByTestId('ai-enabled-toggle')
  if (!(await toggle.isChecked())) await toggle.check()
  await expect(toggle).toBeChecked()
}

/**
 * 让编辑器处于「新建」状态。空态本应直接展开（AC-11），这里同时兜住
 * 「已有供应商导致列表在、编辑器收着」的情况，避免用例被环境状态卡死。
 */
async function ensureDraftEditor(page: Page): Promise<void> {
  const editor = page.getByTestId('ai-provider-editor')
  if (!(await editor.isVisible())) {
    await page.getByTestId('ai-providers-add').click()
  }
  await expect(editor).toBeVisible()
  // 草稿态 = 没有正在编辑的已保存供应商（列表里一条都没有 / 或列表处于折叠）
  await expect(page.getByTestId('ai-provider-model')).toBeVisible()
}

function keyInput(page: Page) {
  return page.locator('[data-testid="ai-provider-editor"] input[type="password"]')
}

async function fillDraft(page: Page, baseUrl: string): Promise<void> {
  await page.getByTestId('ai-provider-name').fill('draft-provider')
  await page.getByTestId('ai-provider-base-url').fill(baseUrl)
  await keyInput(page).fill(API_KEY)
}

async function loadModels(page: Page): Promise<void> {
  await page.getByTestId('ai-provider-models-fetch').click()
}

/**
 * 走 IPC 读「真正入库的供应商」。
 * 为什么不能只看 DOM：DOM 计数只能证明「界面没渲染卡片」，证明不了「没写盘」——
 * 而 AC-1 要守的正是「草稿读取不得顺手保存」。
 */
async function persistedProviders(page: Page): Promise<{ id: string; name: string }[]> {
  const result = (await invokeInPage(page, 'ai:list-providers')) as { providers: { id: string; name: string }[] }
  return result.providers
}

test.beforeEach(async () => {
  mock = await startMockAiServer()
  mock.setModelsReply({ kind: 'list', models: MODELS })
  app = await launch()
  await createVault(app.window)
})

test.afterEach(async () => {
  await app?.cleanup()
  await mock?.stop()
})

test('AC-1/AC-2/AC-11：未保存的草稿也能读到模型，点选即回填，全程不落盘', async () => {
  const page = app.window
  await openAiSettings(page)
  await ensureDraftEditor(page)

  // AC-11：「读取模型」在没有已保存供应商时**必须可点**（改造前这里是禁用 + 先保存提示）
  await fillDraft(page, mock.baseUrl)
  const fetchButton = page.getByTestId('ai-provider-models-fetch')
  await expect(fetchButton).toBeEnabled()

  await loadModels(page)

  // AC-2：清单给出返回的全部模型（含数量）
  const combo = page.getByTestId('ai-provider-models-combo')
  await expect(combo).toBeVisible()
  for (const model of MODELS) {
    await expect(page.getByTestId(`ai-model-option-${model}`)).toBeVisible()
  }

  // AC-1：请求真的带着草稿里的 key 发出去了（只有尾 4 位可断言，明文不入日志/请求记录）
  const modelsRequest = mock.requests.find((request) => request.path.startsWith('/v1/models'))
  expect(modelsRequest, '主进程没有发起 GET /v1/models：按钮点了没反应').toBeTruthy()
  expect(modelsRequest?.authorization).toBe(`***${API_KEY.slice(-4)}`)

  // AC-1：没点保存 → 一个供应商都不该入库。
  // 断言必须**能对这个错误行为转红**（QA D-2）：用计数选择器 `ai-provider-card`
  // （只挂在摘要行、新建态不挂）+ IPC `ai:list-providers` 双重取证。
  // 注意：`ai-provider-item-<id>` 当时曾被改名消失，那才是「前缀恒不存在 = 恒绿」的坑；
  // 现在它被恢复在卡片根元素上，可以正常用作按 id 定位（见下面保存后的正向断言）。
  expect(await page.getByTestId('ai-provider-card').count(), '草稿读取后冒出了已保存卡片').toBe(0)
  expect(await persistedProviders(page), '草稿读取把供应商写库了').toEqual([])

  // AC-2：点选任一项即写入表单并可见
  await page.getByTestId(`ai-model-option-${MODELS[1]}`).click()
  await expect(page.getByTestId('ai-provider-model')).toHaveValue(MODELS[1])

  // 反向对照：上面两条「不落盘」断言必须**在真保存时会变**，否则它们就是恒绿。
  // 这一条把两个传感器都推到「有数据」的状态：卡片计数 0→1、IPC 条数 0→1。
  await page.getByTestId('ai-provider-save').click()
  await expect.poll(() => page.getByTestId('ai-provider-card').count(), { timeout: 15_000 }).toBe(1)
  await expect.poll(async () => (await persistedProviders(page)).length, { timeout: 15_000 }).toBe(1)

  // 同一张卡片必须同时挂两个 testid：摘要行 `ai-provider-card`（计数用）与
  // 根元素 `ai-provider-item-<id>`（按 id 定位、v1 起的既有契约）。少任何一个都算破契约。
  const savedId = (await persistedProviders(page))[0]!.id
  await expect(page.getByTestId(`ai-provider-item-${savedId}`)).toHaveCount(1)
})

test('AC-2：手输的模型名不会被下一次读取清空', async () => {
  const page = app.window
  await openAiSettings(page)
  await ensureDraftEditor(page)
  await fillDraft(page, mock.baseUrl)

  const modelInput = page.getByTestId('ai-provider-model')
  await modelInput.fill('my-private-endpoint-model')
  await loadModels(page)
  await expect(page.getByTestId('ai-provider-models-combo')).toBeVisible()
  await expect(modelInput).toHaveValue('my-private-endpoint-model')
})

test('AC-3：401 与空列表都给出具体原因，提示里不出现 key 明文', async () => {
  const page = app.window
  await openAiSettings(page)
  await ensureDraftEditor(page)
  await fillDraft(page, mock.baseUrl)

  mock.setModelsReply({ kind: 'status', status: 401, message: 'invalid api key' })
  await loadModels(page)

  const message = page.getByTestId('ai-provider-message')
  await expect(message).toBeVisible()
  await expect(message).toContainText('401')
  // 失败原因必须原样可见，不能只写「读取失败」
  await expect(message).toContainText('invalid api key')
  // AC-3 的硬约束：任何提示里都不许出现 key 明文
  await expect(message).not.toContainText(API_KEY)
  await expect(message).not.toContainText(API_KEY.slice(0, 8))

  // 空列表：同样要说话，而不是静默返回 []
  mock.setModelsReply({ kind: 'list', models: [] })
  await loadModels(page)
  await expect(message).toContainText(/空|empty/i)
})

test('AC-5：三档思考强度切换即落盘，重启后保留', async () => {
  const page = app.window
  await openAiSettings(page)

  const high = page.getByTestId('ai-reasoning-effort-high')
  await expect(high).toBeVisible()
  await high.check()
  await expect(high).toBeChecked()

  // 正面证明「写进 settings.json」，而不是只改了内存里的 store
  await expect
    .poll(
      () => {
        try {
          const raw = JSON.parse(readFileSync(app.settingsFile, 'utf8')) as {
            ai?: { reasoningEffort?: string }
          }
          return raw.ai?.reasoningEffort ?? null
        } catch {
          return null
        }
      },
      { timeout: 10_000 }
    )
    .toBe('high')

  // 重启同一个 userData：档位仍然在「高」
  const userDataDir = app.userDataDir
  await app.close()
  app = await launch(userDataDir)
  // 同一个库里已有口令，重启后要解锁（不是再建一次）
  await unlockVault(app.window)
  await expect(app.window.getByTestId('host-sidebar')).toBeVisible()
  await openAiSettings(app.window)
  await expect(app.window.getByTestId('ai-reasoning-effort-high')).toBeChecked()
})

test('AC-10：主区顺序为 key → 读取模型 → 思考强度，高级区默认收起', async () => {
  const page = app.window
  await openAiSettings(page)
  await ensureDraftEditor(page)

  const box = async (locator: ReturnType<Page['locator']>): Promise<number> => {
    const rect = await locator.boundingBox()
    return rect?.y ?? Number.NaN
  }
  const keyY = await box(page.locator('[data-testid="ai-provider-editor"] input[type="password"]'))
  const modelY = await box(page.getByTestId('ai-provider-model'))
  const fetchY = await box(page.getByTestId('ai-provider-models-fetch'))
  const effortY = await box(page.getByTestId('ai-reasoning-effort'))
  const advancedY = await box(page.getByTestId('ai-advanced-toggle'))

  expect(keyY).toBeLessThan(modelY)
  expect(Math.abs(modelY - fetchY)).toBeLessThan(48) // 同一行的按钮与输入框
  expect(modelY).toBeLessThan(effortY)
  expect(effortY).toBeLessThan(advancedY)

  // 高级区（温度 / maxTokens / 自定义请求头）默认收起：没展开前不该占版面
  const numbers = page.locator('[data-testid="ai-provider-editor"] input[type="number"]')
  await expect(numbers.first()).toBeHidden()
  await page.getByTestId('ai-advanced-toggle').click()
  await expect(numbers.first()).toBeVisible()
})
