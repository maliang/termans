# TECHNICAL.md · AI 供应商配置（草稿读模型 + 可搜索模型选择 + 三档思考强度）

基线依赖：`docs/teamflow/20261030-r1-ai-settings-model-picker/PRD.md` + 同夹 `DESIGN.md`
需求夹：`docs/teamflow/20261030-r1-ai-settings-model-picker/`（建后不可变，不归档不升版）
分支：`master`（沿用，不新建不切换）；提交：实现与验证全绿后**一次性提交**
栈：Electron + Vite + React 18 + TS(strict) + zustand + zod 4 + vitest + Playwright

---

## 0. 基线与不变量

| 项 | 结论 |
|---|---|
| 新增依赖 | **无**（zod / react / vitest 已在） |
| 新增 IPC 通道 | **无**（只扩 `ai:list-models` 的请求/响应形状） |
| preload 白名单 | **不改**（`IPC_CHANNELS` 未新增成员，`IPC_INVOKE_CHANNELS` 长度不变） |
| 落盘新增文件 | **无**（思考强度进既有 `settings.json`；草稿与模型清单都不落盘） |
| 明文 key | 只在内存里过一趟 IPC，不进日志 / 提示 / 错误文案 / 响应 |
| `commandConfirmation` | 保持 `z.literal(true)`，不动 |

PRD §10 待决五问的本设计裁决（下游不要再翻案）：

| # | 问题 | 裁决 | 理由 |
|---|---|---|---|
| 1 | 兼容端点是否发 `reasoning_effort` | **不发**，UI 明确写「本次不会发送」 | 静默 400 比明确不支持更伤；未逐一实测的端点不许猜 |
| 2 | 三档预算 | `1024 / 4096 / 16384` | Anthropic `budget_tokens` 最小 1024；三档跨度在 4×/4× 量级，与「低/中/高」的直觉一致 |
| 3 | 模型选择形态 | **portal + fixed 定位的可搜索 combobox**，保留手输 | `datalist` 不可点选（AC-2 的根因）；`.ts-dialog__body` 是滚动容器，绝对定位会被裁掉 |
| 4 | 思考强度层级 | **全局一份** | 每供应商一份必然被读成 per-provider 配置，PRD 已列非目标；单存储位才能做「映射单点」 |
| 5 | 温度 / maxTokens / 自定义头 | **收进默认收起的「高级」区** | 首屏留给 key → 读取模型 → 模型（AC-10/AC-11） |

分层与数据流：

```
渲染层 AiSettings.tsx ──(draft: kind/baseUrl/model/apiKey/headers)──▶ ai:list-models
        │                                                              │
        │  settings:update {ai:{reasoningEffort}}                       ▼
        └──────────────────────────────▶ SettingsStore        AiService.listModels
                                                │                      │
                                      settings.json           buildModelsRequest
                                                                       │
                                          AiService.chat ── ▶ buildChatRequest
                                                │                      │
                                    settings.ai.reasoningEffort ─▶ resolveReasoningMode
                                                │                      │
                                         （唯一映射表）        src/shared/reasoning.ts
```

---

## 1. 数据模型与存储

### 1.1 设置字段（唯一落盘位）

`src/shared/models/settings.ts`

```ts
// 仅在 DEFAULT_SETTINGS.ai 里给默认值；schema 字段本身【不加 .default()】
aiSettingsSchema = z.object({
  enabled: z.boolean(),
  autoContext: z.boolean(),
  contextLines: z.number().int().min(0).max(500),
  defaultProviderId: z.string().nullable(),
  commandConfirmation: z.literal(true),
  reasoningEffort: reasoningEffortSchema          // ← 新增
})

DEFAULT_SETTINGS.ai = { …, reasoningEffort: 'medium' }   // ← 新增
```

**为什么不写 `.default('medium')`（AC-5 的保命条款）**：`withDefaults` 走的是 `aiSettingsSchema.partial().safeParse()`；在 zod 里字段被 `.partial()` 包成 optional 后，键缺席时**不会**执行内层 default，解析结果会是 `{ reasoningEffort: undefined, … }`，随后 `{...DEFAULT_SETTINGS.ai, ...pick}` 把默认值覆盖成 `undefined` —— 旧 `settings.json` 的用户会拿到一份缺字段的设置，`settingsSchema.parse` 直接判非法、**整份回退默认**（语言/主题一起被重置）。所以：字段声明只写 `reasoningEffort: reasoningEffortSchema`，默认值只放 `DEFAULT_SETTINGS`。

存储路径与写入链不变：`<userData>/settings.json` → `JsonStore` → `SettingsStore.normalize = withDefaults` → `settings:update`（`settingsPatchSchema` 每个 section `.partial().strict()` 自动容纳新字段，无需改 IPC）。

### 1.2 草稿配置（不落盘）

草稿只在一次 IPC 往返里存在，结构定义在 `src/shared/models/ai.ts`：

```ts
export const aiProviderDraftSchema = z.object({
  kind: aiProviderKindSchema,
  baseUrl: z.string().min(1).max(2048),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(8192).optional(),          // 明文只在内存里过一趟，绝不回传
  headers: z.record(z.string(), z.string()).optional()  // 走与保存同一条 sanitizeHeaders
}).strict()
export type AiProviderDraft = z.infer<typeof aiProviderDraftSchema>
```

- 缺 `id / name / temperature / maxTokens / enabled` —— 草稿读模型用不到，传了也只增加泄漏面。
- `headers` 与 `apiKey` 的扩展方式**照抄 `ai:save-provider` 的既有模式**（`saveProviderRequestSchema` + `SaveProviderExtras`），不发明第二套。

### 1.3 模型清单（不落盘）

`fetchedModels: string[]` 留在 `AiSettings.tsx` 的编辑器会话内：关闭编辑器 / 切换 `editingId` 时清空。不排序、不去重跨来源（服务商返回顺序即真相），与预设 `models` 合并时才 `new Set`。

### 1.4 契约类型（`src/shared/models/ai.ts` 新增）

```ts
export interface AiListModelsFailure {
  kind: 'no-key' | 'http' | 'timeout' | 'network' | 'empty' | 'unknown'
  status: number | null      // 仅 kind==='http' 有值
  message: string            // 供应商原文 / 网络原文，已脱敏，不含本进程中文前缀
}

export interface AiListModelsResult {
  models: string[]
  error: string | null       // 兼容：人话一句（已脱敏），旧调用方继续用它判空
  failure: AiListModelsFailure | null   // 结构化：渲染层按 kind 走 i18n（AC-3/AC-12）
}

export const aiListModelsRequestSchema = z.union([
  z.object({ providerId: z.string().min(1) }).strict(),
  z.object({ draft: aiProviderDraftSchema }).strict()
])
export type AiListModelsRequest = z.infer<typeof aiListModelsRequestSchema>
```

### 1.5 敏感数据生命周期

| 阶段 | 明文 key 在哪 | 约束 |
|---|---|---|
| 用户在输入框键入 | 渲染层 `form` state | 与今天一致（`type=password` + 可见性开关） |
| 点「读取模型」 | IPC 载荷 `draft.apiKey` | 不进 `console`，不写 `logs/`，不写磁盘 |
| 主进程收到 | 局部变量 | `sanitizeHeaders` 后的 headers + key 只进 `providerSecretValues` 生成的 redactor |
| 返回 | **不回传** | 响应里只有 `models / error / failure`，`failure.message` 已过 redactor |
| 保存后 | vault（safeStorage） | 与今天一致，`apiKeyRef` 只留尾 4 位 |

---

## 2. 思考强度映射（唯一实现）

### 2.1 文件与签名

新增 `src/shared/reasoning.ts`（**唯一**映射表；主进程与渲染层都从这里取）：

```ts
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high'])
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high']

export const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> = { low: 1024, medium: 4096, high: 16384 }
export const ANTHROPIC_MIN_MAX_TOKENS: Record<ReasoningEffort, number> = { low: 2048, medium: 5120, high: 17408 }
export function anthropicMinMaxTokens(level: ReasoningEffort): number

/** 兼容端点的「已知支持 reasoning_effort」白名单。当前为空：未逐一实测，宁可明确不发。 */
export const REASONING_EFFORT_COMPAT_HOSTS: readonly string[] = []

export type ReasoningMode = 'openai-effort' | 'anthropic-thinking' | 'gemini-budget' | 'none'
export interface ReasoningPlan {
  mode: ReasoningMode
  /** mode==='none' 时的说明来源，UI 据此选文案 */
  reason: 'ollama' | 'unknown-endpoint' | null
}
export function resolveReasoningMode(input: { kind: AiProviderKind; baseUrl: string }): ReasoningPlan
```

**为什么单开一个 shared 文件**：这张表被两处消费——主进程 `buildBody` 决定发什么，渲染层要算「高档需要多大输出上限」并在 UI 上说明「该供应商不会发送」。分处两写必然漂移（本项目记忆里「同一份数据两条链路给不同结论」已经出过事故）。`shared/` 是主进程/渲染层/pic 三端共用区，放这里不引入任何运行期依赖。

### 2.2 三档 → 四协议

| 协议 | 判定 | low | medium | high |
|---|---|---|---|---|
| OpenAI 官方 | `kind==='openai'` | `reasoning_effort:'low'` | `'medium'` | `'high'` |
| Anthropic | `kind==='anthropic'` | `thinking:{type:'enabled',budget_tokens:1024}` + `max_tokens=max(cfg,2048)` | `budget_tokens:4096` + `max_tokens=max(cfg,5120)` | `budget_tokens:16384` + `max_tokens=max(cfg,17408)` |
| Gemini 原生 | `kind==='openai-compatible'` 且 host 含 `generativelanguage.googleapis.com` | `generationConfig.thinkingConfig.thinkingBudget:1024` | `4096` | `16384` |
| Ollama | `kind==='ollama'` | 不发任何推理字段 | 同 | 同 |
| 其余兼容端点 | 其余 `openai-compatible` | 不发（`reason:'unknown-endpoint'`） | 同 | 同 |

补充常数：`REASONING_EFFORTS` 顺序即 UI 左→右顺序（低/中/高）。

### 2.3 Anthropic 的两条硬约束（AC-7）

1. **`budget_tokens` 必须 `< max_tokens`**：`max_tokens' = Math.max(provider.maxTokens, ANTHROPIC_MIN_MAX_TOKENS[level])`。默认预设 `maxTokens` 只有 2048，「高」档要 16384 → 不抬就是必然 400。抬升只作用于**这一次请求**，不写回 `settings/providers.json`（文案必须说清「不修改你保存的 2048」，否则用户会怀疑配置被偷改）。
2. **温度必须为 1**：Anthropic 开启 thinking 时 `temperature` 只接受 1。故 anthropic + thinking 时**不发送 `temperature` 键**（省略即默认 1），UI 在只读回显行给一句 `anthropicTempNote`。不做「悄悄把 0.3 改成 1 发出去」——那是另一种静默篡改。

### 2.4 为什么不是每供应商一份

`resolveReasoningMode` 的输入是 `{kind, baseUrl}`，没有 providerId —— 从类型上就堵死「按供应商存一份」的走法。全局一份的好处是可解释：用户在设置里选「中」，四家供应商各自收到自己原生语汇下的「中」。

---

## 3. 主进程改造

### 3.1 契约变更（`src/shared/ipc.ts`）

```diff
- 'ai:list-models': { request: { providerId: string }; response: { models: string[]; error: string | null } }
+ 'ai:list-models': { request: AiListModelsRequest; response: AiListModelsResult }
```

其余通道、事件（`ai:stream-delta|done|error`）一律不动。`IPC_INVOKE_CHANNELS` 由 `IPC_CHANNELS` 扁平推导，长度不变 → `tests/contract/ipc.test.ts` 不需要改期望值。

### 3.2 `AiService.listModels` 改成双路径

`src/main/ai/service.ts:205` 签名从 `listModels(providerId: string)` 改为：

```ts
async listModels(request: AiListModelsRequest): Promise<AiListModelsResult>
```

流程（两条路径**共用后半段**，只有「配置从哪来」不同）：

```
路径 A（已保存供应商，旧行为不变）
  providers.get(providerId) → providers.getApiKey(providerId) → provider.headers
路径 B（草稿，AC-1）
  request.draft → 临时 AiProvider{ id:'draft', name:'draft', enabled:true, temperature:0.3,
                    maxTokens:2048, model:draft.model ?? '', apiKeyRef:null, createdAt/updatedAt:now }
                → apiKey = draft.apiKey ?? null
                → extraHeaders = sanitizeHeaders(draft.headers)
  ★ 全程不调用 providers.save / vault 写入，不碰磁盘

共用
  requiresApiKey(kind) && !apiKey  → { models:[], error:<旧中文句>, failure:{kind:'no-key',status:null,message:''} }
  redactor = createRedactor(providerSecretValues(apiKey, extraHeaders))
  buildModelsRequest({ provider, apiKey, extraHeaders })
  requestJson(..., connectTimeoutMs)
  !res.ok     → failure{kind:'http', status, message: extractProviderErrorMessage(status, text)}  + error=`HTTP ${status}：${msg}`
  models 为空 → failure{kind:'empty', status:null, message:''}
  throw       → describeError(error) → 按 AiRequestError.kind 映射 timeout/network/unknown
```

要点：`sanitizeHeaders` 必须在**主进程**对草稿 headers 再跑一遍（渲染层传什么都不能信），与 `provider-store.ts:44` 同一条实现，不新写。

### 3.3 `ai:list-models` handler

`src/main/ai/ipc.ts:106`：

```ts
handle('ai:list-models', (request) => service.listModels(request), aiListModelsRequestSchema)
```

删除 `providerIdRequestSchema` 在该通道上的使用（该 schema 仍被 `ai:test-provider` 等使用，勿删定义）。schema 变更后 `{providerId}` 与 `{draft}` 二选一，两者同时传会被 `.strict()` 拒（`.strict()` 只在各自分支内生效，额外键直接判失败 → 渲染层拼错字段会立刻报错而不是静默走错路径）。

### 3.4 `AiService.chat` 注入

`src/main/ai/service.ts` 约 :288-293 的 `adapterInput` 增加一个字段：

```ts
const adapterInput: AdapterInput = {
  provider, apiKey, extraHeaders: provider.headers, messages,
  reasoningEffort: settings.reasoningEffort ?? DEFAULT_SETTINGS.ai.reasoningEffort   // ← 新增
}
```

`settings` 已经在该方法内取到（`getSettings()`），不新增依赖。`adapters.ts` 侧：

```ts
export interface AdapterInput {
  provider: AiProvider
  apiKey: string | null
  extraHeaders?: Record<string, string>
  messages: AiMessage[]
  reasoningEffort?: ReasoningEffort | null      // ← 新增，可选；缺省 = 不发
}
```

`buildChatRequest` / `buildModelsRequest` 的签名**不变**（`buildModelsRequest` 收 `Omit<AdapterInput,'messages'>`，多出的可选字段自然后传，不参与模型列表请求体）。

`buildBody` 内按 `resolveReasoningMode({ kind: provider.kind, baseUrl: provider.baseUrl })` 分支：

- `openai-effort` → `body.reasoning_effort = level`（只加这一个键，`temperature/max_tokens/stream_options` 一律保持原逻辑）
- `anthropic-thinking` → 见 2.3：`body.thinking = { type:'enabled', budget_tokens }`、`body.max_tokens = Math.max(provider.maxTokens, ANTHROPIC_MIN_MAX_TOKENS[level])`、**删掉 `temperature`**
- `gemini-budget` → `body.generationConfig.thinkingConfig = { thinkingBudget }`（其余 `generationConfig` 字段保持 temperature/maxOutputTokens）
- `none` → 一个键都不加

### 3.5 错误结构化（AC-3）

`describeError(error, redactor)` 现有实现返回 `{message, retryable}`；新增一个纯函数 `toListModelsFailure(error)`（同文件内，不导出到 `index.ts` 也可以，但为单测导出更省事）：

```
AiRequestError.kind === 'timeout' → { kind:'timeout', status:null, message:<redacted> }
AiRequestError.kind === 'network' → { kind:'network', status:null, message:<redacted> }
AiRequestError.kind === 'http'    → { kind:'http', status:<status>, message:<redacted> }
其他                              → { kind:'unknown', status:null, message:<redacted> }
```

`redactor.redactText` 是唯一出口：`failure.message` 与 `error` 都必须过它。日志侧 `AiService.log()` 只打 requestId / providerId（草稿路径打 `'draft'`）/ model / 字符数 / 用量，**不打 headers、不打 body**（现状已如此，此处只是要求保持）。

---

## 4. 渲染层改造

### 4.1 文件职责

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/renderer/theme/ai/ModelCombobox.tsx` | 新增 | 可搜索可点选的模型选择器（纯受控，portal 浮层） |
| `src/renderer/theme/ai/ReasoningEffortControl.tsx` | 新增 | 三档 radiogroup + 说明；外加编辑器内的只读回显 `ReasoningEffortSummary` |
| `src/renderer/features/ai/ai.css` | 追加 | `.ts-ai-model-combo*` / `.ts-ai-effort*` / `.ts-ai-advanced*` / `.ts-ai-provider-summary` + 1 个 token `--ts-shadow-popover` |
| `src/renderer/theme/AiSettings.tsx` | 修改 | 字段重排、高级区收起、列表折叠摘要、草稿读模型、错误渲染、保存失败定位字段 |
| `src/locales/{en,zh-CN}/ai.json`、`settings.json` | 修改 | 新增键（4.7），删除 `provider.fetchModels.saveFirst` |

样式追加到既有 `src/renderer/features/ai/ai.css`（`ts-ai-form__*` 就住在这里），**不新建 css 文件、不引组件库**。

### 4.2 组件签名（下游必须逐字调用）

```tsx
// src/renderer/theme/ai/ModelCombobox.tsx
export interface ModelComboboxProps {
  value: string
  options: string[]
  onChange: (next: string) => void
  ariaLabel: string
  disabled?: boolean
  loading?: boolean
  placeholder?: string
  testId?: string           // 默认 'ai-provider-model'
}
export function ModelCombobox(props: ModelComboboxProps): JSX.Element

// src/renderer/theme/ai/ReasoningEffortControl.tsx
export interface ReasoningEffortControlProps {
  value: ReasoningEffort
  onChange: (next: ReasoningEffort) => void
  kind?: AiProviderKind      // 缺省时不显示适用性说明
  baseUrl?: string
  disabled?: boolean
}
export function ReasoningEffortControl(props: ReasoningEffortControlProps): JSX.Element

export interface ReasoningEffortSummaryProps {
  value: ReasoningEffort
  kind: AiProviderKind
  baseUrl: string
  maxTokens: number
  onJump: () => void
}
export function ReasoningEffortSummary(props: ReasoningEffortSummaryProps): JSX.Element
```

行为要点（组件内，不放父组件）：

- `ModelCombobox`：输入即筛选（大小写不敏感的子串匹配，保持服务商顺序）；浮层 `createPortal(document.body)` + `position:fixed`，触发器 `getBoundingClientRect()` 定位，下方空间 < 300 时向上翻转；`role="listbox"` / `option` / `aria-selected`，焦点留在 input（`aria-activedescendant`）；↑↓ 移动、Enter 选中、Esc 关闭；值不在 `options` 内且非空时显示「自定义」徽标；`options` 为空且 `!loading` 时不弹浮层（避免空框闪烁）。**input 必须有显式 `ariaLabel`**：label 里塞了「读取模型」按钮后，可访问名不再是纯「模型」，`getByLabel('模型',{exact:true})` 会超时。
- `ReasoningEffortControl`：`role="radiogroup"` + 三个 `role="radio"`，←→ 切档并触发 `onChange`；caption 文案走 i18n（不出现 `budget_tokens` 等原始参数名）；`resolveReasoningMode` 为 `none` 时按 `reason` 追加 `ollamaNote` / `unknownKindNote`。
- `ReasoningEffortSummary`：一行只读回显 `中（全局）· 该供应商将自动适配`，附 `[调整默认强度] →` 调 `onJump()`；当 `kind==='anthropic'` 且 `maxTokens < anthropicMinMaxTokens(value)` 时追加 `budgetNote`（`min`=被抬到的值，`current`=用户保存值）；anthropic 追加 `anthropicTempNote`。

### 4.3 状态归属

| 状态 | 位置 | 说明 |
|---|---|---|
| `providers` / `providersState` / `editorOpen` / `editingId` | `AiSettings.tsx` 本地（现状） | 不进 zustand，避免全局污染 |
| `form`（含 `kind/baseUrl/model/name/temperature/maxTokens/apiKeyRef/enabled`） | 本地 | 现状，草稿即此对象 |
| `apiKey`（本次输入） | 本地 | 保存后清空；草稿读模型时用 |
| `fetchedModels` / `fetchingModels` | 本地 | 编辑器会话内；关闭或换 `editingId` 即清空 |
| `providerModelsError`（`AiListModelsFailure | null`） | 本地新增 | 渲染层按 `kind` 走 i18n |
| `listCollapsed`（编辑态列表折叠） | 本地新增 | 默认 `editingId !== null` 时为 `true`；用户点开可保持 `false` 直到关闭编辑器 |
| `advancedOpen` | 本地新增 | 默认 `false`（AC-10） |
| `reasoningEffort` | **zustand**（`useShellStore.settings.ai.reasoningEffort`） | 唯一真实源；控件是受控组件，`onChange` → `settings:update` |

写盘路径复用既有 `patch()`：必须带 `ui: { aiPanelVisible: visible }`（否则落盘的 `ui.aiPanelVisible` 会把正在打开的 AI 面板关掉，t47 实测过）。

### 4.4 表单顺序与高级区（AC-10 / AC-11）

渲染顺序（自上而下，同一屏不折行）：

```
A0 供应商列表（编辑态 → 折叠为一行摘要 `供应商（3）· 正在编辑 OpenAI [展开列表]`）
A1 预设 / API style（既有 :532-568 保持不变）
A2.1 名称
A2.2 Base URL
A2.3 【读取模型】按钮 + 模型 ModelCombobox      ← 顺序与现状相反（现状是模型在前、按钮在后）
A2.4 思考强度只读回显（ReasoningEffortSummary）
A2.5 高级（默认收起）：温度 + maxTokens / 自定义请求头
A2.6 API key（含可见性开关）
A2.7 enabled 复选框
A2.8 message / 字段级错误
A3 全局区（列表下方）：默认思考强度（ReasoningEffortControl，可编辑）+ 默认供应商
```

- 折叠用「保留 DOM + `hidden` 属性」而不是条件渲染：既有 `ai-provider-item-*` e2e 依赖这些节点存在。
- 「读取模型」按钮 `disabled` 条件改为：`busy !== null || fetchingModels || !canFetchModels`，其中 `canFetchModels = baseUrl.trim() !== '' && (needsKey ? apiKey.trim() !== '' || editingId !== null : true)`。**不含 `editingId === null`**，并删除 `provider.fetchModels.saveFirst` 分支与文案。
- 空态（无供应商）：`editorOpen` 初始为 `true`、`editingId=null`、`form=draftFromPreset('openai')`（AC-11）。

### 4.5 草稿读模型的请求构造（AC-1）

```ts
function buildListModelsRequest(): AiListModelsRequest | null {
  const baseUrl = form.baseUrl.trim()
  if (!baseUrl) return null
  const apiKey = apiKeyInput.trim()
  if (apiKey) return { draft: { kind: form.kind, baseUrl, model: form.model || undefined, apiKey, headers: parseHeaders(headersText) } }
  if (editingId) return { providerId: editingId }   // 用户没改 key → 用 vault 里已存的，别逼他重输
  return null                                        // 需要 key 但既没输入也没保存 → no-key
}
```

- `parseHeaders` 已有（`AiSettings.tsx:67`），复用；失败即给字段级错误，不发请求。
- 读到模型后**不清空、不覆盖**已填的模型值（AC-2），只更新 `fetchedModels` 与成功提示 `provider.models.count`。
- 请求期间按钮文案 `provider.models.loading`，`Loader2` 带 `aria-hidden="true"`。

### 4.6 错误渲染（AC-3）

`providerModelsError` 非空时在 A2.3 下方渲染 `role="alert"` 的红条，按 `failure.kind` 取文案：

| kind | 文案键 | 变量 |
|---|---|---|
| `http` | `ai:provider.models.error.http` | `status`、`message` |
| `timeout` | `ai:provider.models.error.timeout` | `seconds`（`connectTimeoutMs/1000`，从常量取，不写死数字） |
| `no-key` | `ai:provider.models.error.noKey` | 无 |
| `empty` | `ai:provider.models.error.empty` | 无 |
| `network` / `unknown` | `ai:provider.models.error.other` | `message` |

硬规则：**任何分支都不得只显示「读取失败」**；`message` 直接来自 `failure.message`（已脱敏），渲染层不得再做「把所有供应商原文吞掉」的处理；不得把 `form.apiKey` 拼进任何文案。

### 4.7 i18n 键（en + zh-CN 双份，`tests/contract/i18n-keys.test.ts` 自动守门）

`src/locales/<lang>/ai.json`（`provider.` 前缀）：

`provider.models.fetch`、`provider.models.loading`、`provider.models.count`、`provider.models.empty`、`provider.models.custom`、`provider.models.searchPlaceholder`、`provider.models.noMatch`、`provider.models.useCustom`、`provider.models.error.http`、`provider.models.error.timeout`、`provider.models.error.noKey`、`provider.models.error.empty`、`provider.models.error.other`、`provider.advanced.title`、`provider.advanced.summary`、`provider.summary.collapse`、`provider.summary.expand`、`provider.save.fieldRequired`、`provider.save.fieldInvalidUrl`

`src/locales/<lang>/settings.json`（`ai.` 前缀）：

`ai.reasoningEffort.label`、`ai.reasoningEffort.low`、`ai.reasoningEffort.medium`、`ai.reasoningEffort.high`、`ai.reasoningEffort.caption.low`、`ai.reasoningEffort.caption.medium`、`ai.reasoningEffort.caption.high`、`ai.reasoningEffort.ollamaNote`、`ai.reasoningEffort.unknownKindNote`、`ai.reasoningEffort.anthropicTempNote`、`ai.reasoningEffort.budgetNote`

**删除**：`zh-CN`/`en` 中的 `provider.fetchModels.saveFirst`（连同代码引用一起删，同一笔提交）。

文案措辞以 `DESIGN.md §4.4` 为准；`budgetNote` 必须含「不修改你保存的 {{current}}」；`unknownKindNote` 必须明确「本次不会发送」，不能写「可能不支持」这种含糊话。

---

## 5. 关键实现点与边界

| 场景 | 期望行为 | 落点 |
|---|---|---|
| 新建供应商，只填 Base URL + key | 「读取模型」可点，点完出清单（不落盘） | 4.4 `canFetchModels` + 4.5 |
| 填了 Base URL 没填 key、也没保存 | 按钮禁用 + 悬停提示「先填 key」；不发请求 | 4.4 |
| Ollama（`needsKey=false`） | 不填 key 也能读 `/api/tags` | `requiresApiKey` 既有逻辑 |
| 编辑已保存供应商、没改 key | 走 `{providerId}`，用 vault 里的 key | 4.5 |
| 读取失败：401 / 429 / 5xx | 红条显示 `HTTP 401 · <供应商 message>` | 3.5 + 4.6 |
| 供应商返回 `{data: []}` | 显示 `provider.models.empty`（「确认 Base URL 指向兼容端点」） | 3.2 |
| 读取中关闭编辑器 | 丢弃迟到响应（`fetchingModels` + 在 unmount/换 id 时用序号或 AbortController 守卫） | 4.3 |
| 手输模型值不在清单里 | 显示「自定义」徽标，值原样保留，下一次读取不清空 | 4.2 + 4.5 |
| 切到 Ollama 后选「高」 | 仍可保存 `high`，但回显里写明「对该供应商不生效」 | 2.2 + 4.2 `ollamaNote` |
| Anthropic + 高 + maxTokens=2048 | 请求自动用 `max_tokens=17408`，琥珀条说明「不修改你保存的 2048」 | 2.3 + 4.2 `budgetNote` |
| Anthropic + 任意档 + 用户设了温度 0.3 | 请求不带 `temperature`（默认 1），回显写明 | 2.3 |
| 旧 `settings.json`（无 reasoningEffort） | `withDefaults` 补 `medium`，语言/主题不受影响 | 1.1 |
| 保存时名称 / Base URL / 模型为空 | 错误指向具体字段并 focus 该输入 | 4.4 `provider.save.fieldRequired` |
| 供应商 message 里回显了 key | redactor 打码后才进 UI | 3.2 / 3.5 |
| 兼容端点（DeepSeek / Moonshot / DashScope / vLLM / LM Studio） | body 里没有任何推理参数 | 2.2 `REASONING_EFFORT_COMPAT_HOSTS=[]` |
| Azure 类托管（`api-key` + `api-version`） | 草稿读模型走兼容分支 GET `/v1/models`；若实测不通，在 `docs/ai-providers.md` 记一句「不支持草稿读模型」，UI 退回用错误红条说明 | 3.2（实现时实测，不预写结论） |

---

## 6. 测试策略

### 6.1 单测：映射矩阵（AC-8）

新增 `tests/reasoning-map.test.ts`（纯函数，无网络）：

- `ANTHROPIC_THINKING_BUDGET` / `ANTHROPIC_MIN_MAX_TOKENS` 三档数值逐条断言（1024/4096/16384、2048/5120/17408）。
- `resolveReasoningMode` 穷举：`openai × 3 baseUrl` → `openai-effort`；`anthropic` → `anthropic-thinking`；`openai-compatible + generativelanguage.googleapis.com` → `gemini-budget`；`ollama` → `none/reason='ollama'`；`openai-compatible + api.deepseek.com` → `none/reason='unknown-endpoint'`。

新增 `tests/ai-reasoning.test.ts`（**4 协议 × 3 档 = 12 条**，断言 `JSON.parse(buildChatRequest(input).body)`）：

| 协议 | 断言 |
|---|---|
| OpenAI | `body.reasoning_effort === level`，且 `body.temperature` / `body.max_tokens` / `body.stream_options` 仍在（回归） |
| Anthropic | `body.thinking === {type:'enabled', budget_tokens: 期望值}`，`body.max_tokens === 期望值`，`'temperature' in body === false`，`body.stream === true` |
| Gemini | `body.generationConfig.thinkingConfig.thinkingBudget === 期望值`，`body.generationConfig.maxOutputTokens` 保持 |
| Ollama | `JSON.stringify(body)` 里不出现 `reasoning_effort` / `thinking` / `thinkingBudget` 任一子串 |

### 6.2 单测：草稿读模型（AC-1 / AC-3）

新增 `tests/ai-draft-models.test.ts`（`fetchImpl` 注入，参考 `tests/ai-request.test.ts` 的写法）：

- 草稿读模型：断言**发出的 URL 来自草稿 baseUrl**、`Authorization` 头来自草稿 key；断言 `providerStore.save` 与 vault 写入 **零调用**（AC-1 的「不写盘」要正面证明，不能只看返回值）。
- 失败分级：401 → `failure{kind:'http',status:401}` 且 `error` 含 `HTTP 401`；超时 → `kind:'timeout'`；空列表 → `kind:'empty'`。
- 脱敏：供应商 message 里回显 key 时，`error` 与 `failure.message` 都不含明文 key。
- `requiresApiKey` 为真的 kind 且无 key → `kind:'no-key'`。

### 6.3 契约测

- `tests/contract/models.test.ts` 增：`withDefaults({...DEFAULT_SETTINGS, ai:{enabled:true}}).ai.reasoningEffort === 'medium'` 且 `ai.contextLines` 仍为默认 200（证明「只补缺的那一个字段」，不是整份回退）。
- 同文件增：`settingsPatchSchema` 接受 `{ai:{reasoningEffort:'high'}}`、拒绝 `'ultra'`。
- `tests/contract/i18n-keys.test.ts` 自动覆盖 AC-12（代码里的 `t('ai:…')` 必须在两份词表里存在）。
- `tests/contract/ipc.test.ts` 期望值不变（通道数不变）。

### 6.4 e2e

新增 `e2e/ai-settings-models.spec.ts`，扩既有 `e2e/fixtures/ai-mock.ts`（已有 `GET /v1/models` 分支）：

1. 打开设置 → AI → 新建供应商，填 Base URL + key，**不保存**点「读取模型」→ 断言出现 mock 的模型项、且 mock 收到了请求（AC-1/AC-11）。
2. 点选模型 → 断言 input 的值等于所选项（AC-2）。
3. mock 返回 401 → 断言红条含 `HTTP 401` 与供应商 message，且不含明文 key（AC-3）。
4. 切三档 → 断言 `settings:update` 落盘值与 UI 选中态一致；重开设置仍为所选项（AC-5）。
5. 「高级」默认收起：温度输入在收起时不可见，展开后可见（AC-10）。

> e2e 需要真实 Electron 窗口；若本机跑不起来（无显示/沙箱限制），如实记录未跑，不得写成「已验证」。

### 6.5 手工真点一遍

PRD §8 要求前端必须真点：新建 → 读模型 → 选模型 → 保存 → 重开设置 → 切三档 → 关掉重开确认持久化。

---

## 7. 任务拆分

文件边界互不重叠 → 可并行的真并行；接口以 §4.2 签名为准逐字实现。

### T1 · 契约地基（先行，其他任务读它）

- 文件：`src/shared/reasoning.ts`(新)、`src/shared/models/ai.ts`、`src/shared/models/settings.ts`、`src/shared/index.ts`、`src/locales/{en,zh-CN}/ai.json`、`src/locales/{en,zh-CN}/settings.json`、`tests/reasoning-map.test.ts`(新)、`tests/contract/models.test.ts`
- 交付：§1.1 / §1.4 / §2.1 的全部类型与常量；4.7 的全部键（en+zh-CN 双向一致，占位符同名）；删除 `provider.fetchModels.saveFirst`
- 验收：`pnpm exec vitest run tests/reasoning-map.test.ts tests/contract/models.test.ts tests/contract/i18n-keys.test.ts` 全绿

### T2 · 主进程请求链（依赖 T1 的类型，文件与 T1/T3 不重叠）

- 文件：`src/shared/ipc.ts`、`src/main/ai/ipc.ts`、`src/main/ai/service.ts`、`src/main/ai/adapters.ts`、`src/main/ai/index.ts`、`tests/ai-reasoning.test.ts`(新)、`tests/ai-draft-models.test.ts`(新)、`tests/ai-request.test.ts`
- 交付：§3.1~§3.5；`chat` 注入 `reasoningEffort`；草稿路径不落盘
- 验收：`pnpm exec vitest run tests/ai-reasoning.test.ts tests/ai-draft-models.test.ts tests/ai-request.test.ts` 全绿；`tests/ai-stream.test.ts`、`tests/ai-conversations.test.ts` 不回归（AC-9）

### T3 · 两个新组件 + 样式（依赖 T1 的类型/文案键，可与 T2 并行）

- 文件：`src/renderer/theme/ai/ModelCombobox.tsx`(新)、`src/renderer/theme/ai/ReasoningEffortControl.tsx`(新)、`src/renderer/features/ai/ai.css`
- 交付：§4.2 三个导出逐字实现；portal 浮层翻转逻辑；键盘与 ARIA；`--ts-shadow-popover` 只加这一个 token
- 验收：`pnpm typecheck`；CSS 里所有 `var(--ts-*)` 都在 `src/renderer/theme/*.css` 有定义（写错的变量是无效声明，构建不报错）

### T4 · AiSettings 整合（依赖 T2 + T3）

- 文件：`src/renderer/theme/AiSettings.tsx`
- 交付：§4.4 字段重排与高级区、编辑态列表折叠摘要、§4.5 请求构造、§4.6 错误渲染、保存失败定位字段、`ModelCombobox` 与 `ReasoningEffortControl` 接线
- 验收：`pnpm typecheck`；`pnpm test`（含 i18n 契约）；真点一遍（6.5）

### T5 · e2e + 收口（依赖 T4）

- 文件：`e2e/fixtures/ai-mock.ts`、`e2e/ai-settings-models.spec.ts`(新)、`.gitignore`
- git 约束（PRD §8，逐条执行）：
  1. 分支保持 `master`，**不新建、不切换**；
  2. 全绿后一次性提交：`git add -A src tests e2e .gitignore docs/teamflow` （`docs/teamflow` 里只提本次需求夹，别把 `logs/` 加进去）；
  3. 提交前 `git status --porcelain -- src tests e2e docs/teamflow` 逐行确认没有卷进他人改动（当前工作树只有未跟踪的 `docs/teamflow/`、`logs/`）；
  4. commit message 写明范围便于单笔回滚，例：`feat(ai-settings): 草稿态读取模型 + 可搜索模型选择 + 全局三档思考强度 (AC-1..12)`
  5. `.gitignore` 补 `*.tsbuildinfo`、`.pnpm-store/`；**不可**忽略 `build/`、`docs/`、`tests/`、`e2e/`（那四个里有需要入库的产物）
- 全量验证：`pnpm typecheck && pnpm test && pnpm run build && pnpm exec playwright test e2e/ai-settings-models.spec.ts e2e/ai-assist.spec.ts`

### 依赖图

```
T1 ──┬─▶ T2 ──┐
     └─▶ T3 ──┴─▶ T4 ──▶ T5
```

---

## 8. 风险与取舍

| 风险 | 处理 |
|---|---|
| zod `.partial()` 吞默认值导致旧配置整份回退 | 1.1 明令不加 `.default()`；`tests/contract/models.test.ts` 正面证明只补缺字段 |
| 映射表在主进程与渲染层漂移 | 表只存在于 `src/shared/reasoning.ts`；两处 import，无第二份常量 |
| label 内新增按钮改了可访问名，e2e `getByLabel('模型',{exact:true})` 超时 | `ModelCombobox` 的 input 使用显式 `ariaLabel`；`data-testid="ai-provider-model"` 保持不变 |
| 编辑态把列表整块留着，导致「读取模型」落到折线以下 | 折叠为一行摘要（保留 DOM + `hidden`），既有 `ai-provider-item-*` 断言不失效 |
| 浮层被 `.ts-dialog__body` 的 `overflow:auto` 裁切 | `createPortal` 到 `document.body` + `position:fixed` + 空间不足向上翻转 |
| 自动抬 `max_tokens` 被读成「偷改我的配置」 | 抬升只在单次请求内生效，UI 明写「不修改你保存的 {{current}}」 |
| Anthropic 温度被静默改写 | 不发 `temperature`（等价默认 1），并在回显行明说 |
| 兼容端点发了不支持的字段 → 静默 400 | 白名单为空 = 不发；UI 明写「本次不会发送」 |
| 迟到响应覆盖新一轮结果 | 请求序号 guard（或 `AbortController`），编辑器关闭/切换即失效 |
| Azure 类托管的草稿读模型能力未实测 | 实现时实测；不支持就如实写进 `docs/ai-providers.md`，不预写「已支持」 |

非目标（与 PRD §3 一致，别顺手做）：模型清单持久化、最近使用排序、每供应商一份思考强度、把 `reasoning_content` 渲染到面板、`ai:test-provider` 的语义改动。
