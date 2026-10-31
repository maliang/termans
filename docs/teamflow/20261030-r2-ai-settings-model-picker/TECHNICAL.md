# TECHNICAL · 设置 → AI 单列卡片工作台 + 三档思考强度（r2）

- 需求：docs/teamflow/20261030-r2-ai-settings-model-picker/PRD.md（AC-1..AC-14）
- 形态：docs/teamflow/20261030-r2-ai-settings-model-picker/DESIGN.md（A0/A1/A2/A3 四段、卡片内联展开）
- 基线：r1 的 main 进程半成品（工作树未提交），本轮**接管**并补齐共享层
- 分支：master（工作树已有 13 处未提交改动，属 r1 半成品，任何人都不得 `git checkout/restore` 它们）

## 1. 范围与不变量

1. **接管而非重写**：`src/main/ai/{adapters,service,ipc,index}.ts` 与 `src/shared/ipc.ts` 已在工作树里按新契约改过（`ai:list-models` 请求变 strict 二选一、响应加 `failure`），本轮只补它们 import 却不存在的东西，不回退这些改动。
2. **契约先行**：所有跨进程类型只从 `@shared` 出（`src/shared/index.ts` 的 `export *` 链），渲染层不许自己再定义一份 `AiListModels*`。
3. **单点映射**：三档思考强度的协议映射只允许存在 `src/shared/reasoning.ts` 一处；`src/renderer/theme/ReasoningEffortControl.tsx` 的「支持/已忽略」判断也必须调同一个 `resolveReasoningMode`，禁止在前端另写一份 `kind === 'ollama'` 判断。
4. **不扩 UI 契约**：本轮不新增 `settings.ui.*` 字段（高级区展开状态不跨会话记忆），不新增 IPC 通道。
5. **既有行为零回归**（AC-12）：`temperature / maxTokens / stream_options / 上下文行数 / commandConfirmation` 原样；既有 `data-testid` 一律不改名；`label` 内容变化处一律补显式 `aria-label`。

## 2. 数据模型与存储

### 2.1 思考强度（新，纯 shared 常量 + 纯函数）

`src/shared/reasoning.ts`（**新建**，无副作用、不 import electron/fs，可被主进程与渲染层共用）：

```ts
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
export const REASONING_EFFORT_DEFAULT: ReasoningEffort = 'medium'
export const reasoningEffortSchema = z.enum(REASONING_EFFORTS)

export type ReasoningMode = 'openai-effort' | 'anthropic-thinking' | 'gemini-budget' | 'none'
export type ReasoningModeReason = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'unknown-endpoint'

/** 三档 → Anthropic thinking.budget_tokens */
export const ANTHROPIC_THINKING_BUDGET: Record<ReasoningEffort, number> =
  { low: 1024, medium: 4096, high: 16384 }

/** budget + 1024：三档对应的本次请求 max_tokens 下限 */
export const ANTHROPIC_MIN_MAX_TOKENS: Record<ReasoningEffort, number> =
  { low: 2048, medium: 5120, high: 17408 }

export function resolveReasoningMode(input: { kind: AiProviderKind; baseUrl: string }): {
  mode: ReasoningMode
  reason: ReasoningModeReason
}

export function anthropicEffectiveMaxTokens(level: ReasoningEffort, maxTokens: number): number
// = Math.max(maxTokens, ANTHROPIC_MIN_MAX_TOKENS[level])
```

`resolveReasoningMode` 判定顺序（唯一实现，主进程与 UI 共用）：

| kind / baseUrl | mode | reason |
| --- | --- | --- |
| `anthropic` | `anthropic-thinking` | `anthropic` |
| `gemini` | `gemini-budget` | `gemini` |
| `openai` | `openai-effort` | `openai` |
| `openai-compatible` 且 host 命中 `ollama` / `11434` | `none` | `ollama` |
| `openai-compatible` 其它（deepseek / vllm / moonshot / 任意白名单外） | `none` | `unknown-endpoint` |

兼容端点白名单**为空**（PRD AC-9 决定），所以任何 `openai-compatible` 都不会发思考参数；将来要放行只改这张表，不改判定分支。

### 2.2 供应商草稿（新，仅内存、不落盘）

`src/shared/models/ai.ts` 追加：

```ts
export const aiProviderDraftSchema = z.object({
  kind: aiProviderKindSchema,
  baseUrl: z.string().min(1),
  model: z.string().optional(),
  apiKey: z.string().optional(),        // 明文，只在本次 IPC 调用里存在
  headers: z.record(z.string(), z.string()).optional()
}).strict()
export type AiProviderDraft = z.infer<typeof aiProviderDraftSchema>

export const aiListModelsRequestSchema = z.union([
  z.object({ providerId: z.string().min(1) }).strict(),   // 已保存供应商
  z.object({ draft: aiProviderDraftSchema }).strict()    // 未保存草稿
])
export type AiListModelsRequest = z.infer<typeof aiListModelsRequestSchema>

export const aiListModelsFailureSchema = z.object({
  kind: z.enum(['no-key', 'empty', 'http', 'timeout', 'network']),
  status: z.number().int().nullable(),   // 仅 http 有值
  message: z.string()                    // 已脱敏 + 主进程截断 ≤300 字
})
export type AiListModelsFailure = z.infer<typeof aiListModelsFailureSchema>

export const aiListModelsResultSchema = z.object({
  models: z.array(z.string()),
  error: z.string().nullable(),          // r1 兼容字段，恒等于 failure?.message ?? null
  failure: aiListModelsFailureSchema.nullable()
})
export type AiListModelsResult = z.infer<typeof aiListModelsResultSchema>
```

**存储结论**：草稿与模型清单都**不落盘**。供应商仍走 `ai/providers.json` + `ai/api-key.<id>`（`src/main/ai/provider-store.ts`），`apiKeyRef = vault:ai-key:<id>:<last4>`；模型清单只活在当前编辑器组件的 React state 里，收起/切换卡片即丢弃（PRD 未要求缓存，缓存会引入「清单过期」这一新失败模式）。

### 2.3 设置字段

`src/shared/models/settings.ts`：

- `aiSettingsSchema` 增加 `reasoningEffort: reasoningEffortSchema`（**不加** `.default()`，原因见 §6.7）。
- `DEFAULT_SETTINGS.ai.reasoningEffort = 'medium'`。
- 存量配置文件缺该字段 → `withDefaults` 的 `pickSection`（schema.partial()）解析成功、缺字段不覆盖默认值 → 得到 `medium`，且**其它 ai 字段不被整份回退**。

### 2.4 失败明文的截断位置

`src/main/ai/service.ts` 的 `listModels` 出口处对 `failure.message` 做 `slice(0, 300)`（脱敏与截断都不在渲染层重复做；渲染层只保留一处 300 字**兜底**并补省略号，见 `src/renderer/theme/ProviderCard.tsx:151-155`，不改内容、不二次脱敏）。脱敏仍是 service 既有逻辑（替换本次输入的 key + 正则兜底 `sk-…`/`pk-…`，只留尾 4 位），截断必须**放在脱敏之后**，否则可能把 key 前缀切成半截而绕开正则。

## 3. API 设计（IPC）

通道不变，只有 `ai:list-models` 的请求/响应形状在本轮定型（`src/shared/ipc.ts` 已指向新类型，`src/main/ai/ipc.ts` 已用 `aiListModelsRequestSchema` 校验）。

| 通道 | 请求 | 返回 | 备注 |
| --- | --- | --- | --- |
| `ai:list-providers` | `void` | `{ providers: AiProvider[] }` | 不返回明文 key |
| `ai:save-provider` | `AiProviderInput & { apiKey?: string \| null; headers?: Record<string,string> }` | `AiProvider` | 保存后渲染层要重新拉列表 |
| `ai:delete-provider` | `{ providerId: string }` | `{ deleted: boolean }` | 删默认供应商后前端自行清 `ai.defaultProviderId` |
| `ai:test-provider` | `{ providerId } \| { draft }` | 见既有契约 | 本轮不改 |
| **`ai:list-models`** | `{ providerId } \| { draft }` | `AiListModelsResult` | `{draft}` 分支**不创建、不修改**任何供应商记录 |
| `settings:update` | `SettingsPatch` | `Settings` | 广播 `settings:changed` |

`{draft}` 分支的取值语义（`src/main/ai/service.ts` 的 `resolveModelsTarget`）：

- `providerId` 存在但 key 缺失 → `failure.kind = 'no-key'`，`status = null`，`message = ''`（UI 用 i18n 文案，不回显主进程英文）。
- 草稿有 key 则用草稿 key；草稿无 key 且给了 `providerId` 才回退到已存 key（草稿分支没有 providerId，所以纯草稿无 key 就是 `no-key`）。
- HTTP 非 2xx → `kind:'http'` + 真实 `status` + 服务商 `error.message/error/message`（截断 300）。
- 超时 → `timeout`；网络异常 → `network`；200 但解析出空数组 → `empty`（`models: []`）。
- Ollama 走 `GET /api/tags`（`{models:[{name}]}`），其它走 `GET {baseUrl}/models`（`{data:[{id}]}`），Gemini 走 `POST :generateContent` 探活后回固定候选。

**渲染层调用约定**：统一走 `src/renderer/features/ai/api.ts`，`call()` 返回 `{ ok, data, error }` 信封——**必须解构 `data`**（本项目踩过直接赋整个信封导致判断恒 `undefined`）。

## 4. 前端组件与页面拆分

单列四段（DESIGN §3）：A0 开关披露 → A1 默认思考强度 → A2 供应商卡片列表 → A3 默认供应商 + 上下文行数。内容列 `max-width:720px`，实测可用宽约 666px（`src/renderer/theme/theme.css:183` `.ts-settings__section`）。

### 4.1 文件

| 文件 | 类型 | 职责 |
| --- | --- | --- |
| `src/renderer/theme/AiSettings.tsx` | 改 | 编排：A0/A1/A2 外壳/A3、`expandedId` 单开状态、设置 patch |
| `src/renderer/theme/ProviderCard.tsx` | **新** | 一张卡片：行摘要六项 + 行尾操作 + 内联编辑器（含读取模型、删除两步确认、高级区） |
| `src/renderer/theme/ModelCombobox.tsx` | **新** | 模型输入 + 可搜索浮层（portal 到 `document.body`），受控 |
| `src/renderer/theme/ReasoningEffortControl.tsx` | **新** | A1 三档分段控件 + 「已忽略」提示 |
| `src/renderer/features/ai/api.ts` | 改 | 加 `listModels(request): Promise<AiListModelsResult>` 门面 |
| `src/renderer/features/ai/ai.css` | 改 | 卡片/浮层样式 + 收窄旧表单通配（见 §6.9） |
| `src/renderer/styles/tokens.css` | 改 | 只加一个 token（见 §6.10） |
| `src/locales/{en,zh-CN}/settings.json` | 改 | 新文案（§5.3） |
| `src/locales/{en,zh-CN}/ai.json` | 改 | 删 `saveFirst` 等草稿阻塞文案 |

组件放在 `theme/` 而不是 `features/ai/`：它们只被 `AiSettings` 使用，`features/ai/` 目前是 AI 面板（AiPanel）的领域，混放会让面板的依赖面变宽；同时避免 `SettingsDialogHost` 改 import 路径。

### 4.2 组件契约（下游照抄，不要改名）

```ts
// ModelCombobox.tsx
export interface ModelComboboxProps {
  value: string
  options: string[]
  onChange: (value: string) => void
  ariaLabel: string
  inputTestId?: string          // 默认 'ai-provider-model'
  optionTestIdPrefix?: string   // 默认 'ai-model-option-'
  disabled?: boolean
}
export function ModelCombobox(props: ModelComboboxProps): JSX.Element

// ReasoningEffortControl.tsx
export interface ReasoningEffortControlProps {
  value: ReasoningEffort
  disabled?: boolean
  onChange: (level: ReasoningEffort) => void
  /** 默认供应商的协议能力；null = 未设置默认供应商 */
  support: { providerName: string; supported: boolean } | null
}
export function ReasoningEffortControl(props: ReasoningEffortControlProps): JSX.Element

// ProviderCard.tsx
export interface ProviderCardProps {
  provider: AiProvider | null        // null = 新建草稿卡
  expanded: boolean
  isDefault: boolean
  effort: ReasoningEffort
  onToggle: () => void
  onSaved: (provider: AiProvider) => void
  onDeleted: (providerId: string) => void
  onMakeDefault: (providerId: string) => void
}
export function ProviderCard(props: ProviderCardProps): JSX.Element
```

`ProviderCard` 自己持有表单/模型清单/删除确认/busy 等全部编辑态（`useState`），**只在 `expanded` 时挂载编辑器子树** → 收起即卸载，模型清单与草稿自然清空，无需手工 reset。`AiSettings` 只持 `expandedId: string | 'new' | null`，保证「同时最多展开一张」（AC-3）。

### 4.3 testid 合同（新增）

| 位置 | testid |
| --- | --- |
| 卡片（已保存） | `ai-provider-card` + `data-provider-id={id}` |
| 卡片（新建草稿） | `ai-provider-card-new`（**禁止**用 `ai-provider-item-*`：e2e 用 `[data-testid^="ai-provider-item-"]` 计数已保存供应商） |
| 卡片列表容器 | `ai-provider-list`（保留原有） |
| 编辑器根 | `ai-provider-editor`（e2e 在其内取 `input[type=password]`、并断言 模型 < 读取 < 思考强度 < 高级 的 y 序） |
| 读取模型按钮 | `ai-provider-models-fetch` |
| 模型输入 | `ai-provider-models-combo` |
| 单条模型 | `ai-model-option-{model}` |
| 编辑器消息 | `ai-provider-message`（既有） |
| A1 控件 | `ai-reasoning-effort`；三档 radio `ai-reasoning-effort-low|medium|high` |
| 高级区开关 | `ai-advanced-toggle`（既有） |

既有 testid（`ai-provider-kind/name/baseurl/model/temp/maxtokens/headers/apiKey/save/delete/enabled` 等）**原样保留**；改名前先 `grep -rn "data-testid" src/renderer/theme/AiSettings.tsx e2e/`。

### 4.4 A1 位置与「已忽略」

- 三档控件在**卡片区之上**（A1），是全局唯一可编辑处；卡片内不再放任何思考强度可编辑控件（PRD AC-8 单点）。
- 「支持性」按 `ai.defaultProviderId` 找供应商 → `resolveReasoningMode({kind, baseUrl})`；`mode === 'none'` 时控件**保持可见可点**，下方显示「{{provider}} 不支持，已忽略」。切档仍写 `settings.ai.reasoningEffort`（AC-11：不隐藏、不假装生效）。
- 未设默认供应商 → `support === null`，只显示一行提示，不显示「已忽略」。

## 5. 状态管理与数据流

### 5.1 归属

| 状态 | 位置 | 生命周期 |
| --- | --- | --- |
| `providers` / `providersState` | `AiSettings`（`useState`，`listProviders()` 拉取） | 页面挂载 + 每次保存/删除后重拉 |
| `expandedId: 'new' \| string \| null` | `AiSettings` | 点行切换，同时最多一个 |
| 表单（kind/name/baseUrl/model/temp/maxTokens/headers/presetId） | `ProviderCard` | 编辑器挂载期间；收起丢弃 |
| `apiKey` 明文、`keyVisible` | `ProviderCard` | 同上，绝不进任何日志/URL |
| 模型清单 `models[]`、`modelsBusy`、`modelsFailure` | `ProviderCard` | 同上 |
| `confirmDelete`（两步删除） | `ProviderCard` | 3s 自动回退 |
| `settings.ai.reasoningEffort` | 全局（`useShellStore` + 主进程 settings 文件） | 立即 `settings:update` 落盘 |

### 5.2 写路径

- 保存供应商：`ai.saveProvider(input, { apiKey?, headers? })` → 成功后 `onSaved(provider)` → `AiSettings` 重拉 `listProviders()` 并调用 AI 面板 store 的 `reloadProviders()`（保持面板与设置页一致）。
- 读模型：`ai.listModels({ draft })`（新建/未保存）或 `{ providerId }`（已保存且未改关键字段）。**已保存卡在编辑态改了 kind/baseUrl/model/key 时也走 draft**，因为要验的是「将要保存的配置」，不是库里那份。
- 改档位：`patch({ ai: { reasoningEffort } })` —— `patch` 沿用 `AiSettings` 现有实现（会带上 `ui.aiPanelVisible`），**不要**改这段逻辑。
- 设默认 / 删默认：`patch({ ai: { defaultProviderId: id } })`；删除默认供应商后 `patch({ ai: { defaultProviderId: null } })`，避免 select 指向不存在的 id。

### 5.3 文案（同时进 en 与 zh-CN，AC-13）

`settings` namespace 新增（`src/locales/*/settings.json`，键名照抄）：

```
ai.reasoning.title / .hint / .low / .medium / .high
ai.reasoning.lowHint / .mediumHint / .highHint
ai.reasoning.ignored        "{{provider}} 不支持，已忽略" / "{{provider}} does not support this — ignored"
ai.reasoning.noDefault
ai.reasoning.anthropicNote  "保存的 maxTokens 过小时，本次请求会临时抬到 {{tokens}}（不写回配置，且不发 temperature）"
ai.provider.add / .empty / .count / .defaultBadge / .makeDefault
ai.provider.delete / .deleteConfirm / .deleteCancel
ai.provider.mode.catalog / .mode.custom
ai.models.read / .reading / .hint / .search / .noMatch / .needKey
ai.models.failed            "{{status}} · {{message}}" / 同形
```

`ai` namespace：删除 `provider.test.saveFirst`（两个 locale 都删）——AC-4 要求草稿态直接可读，`saveFirst` 文案与行为必须一起消失（`grep -rn "saveFirst" src/locales src/renderer` 应为 0）。

约束：卡片目录模式**不渲染 `preset.note`**（英文原文，违反 AC-13），改用 `kind + needsKey` 派生的两条中文模板。

## 6. 关键实现点与边界

1. **666px 不横向滚动（AC-2）**：行摘要固定段 ≈277px（圆点 15 + key 尾 ≤96 + 徽标 36 + 操作 92 + 间隙），名称 ≤160，模型吃剩余（上限时仍 211px）。六个文本节点全部 `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`；`display:flex` + `gap:var(--ts-space-2)`，禁止 `flex-wrap`。
2. **草稿读模型（AC-4）**：读取按钮只按 `apiKey.trim() !== ''` 或 `providerId !== null` 决定 `disabled`，**绝不能**再出现 `editingId === null` 条件。读取前后 `listProviders()` 理应返回同一条数（e2e 已断言记录数不变）。
3. **模型点选不覆盖手输（AC-5）**：`ModelCombobox` 受控，选中才 `onChange(model)`；浮层打开时过滤基于输入值，输入框键入不清空 options；`Enter` 选第一个可见项、`Esc` 只关浮层不改值；失焦（点外部）关闭但保留文本。
4. **浮层必须 portal**：设置对话框的 `div` 是 `overflow:auto` 的滚动容器，浮层就地渲染会被裁掉；`createPortal(panel, document.body)` + `position:fixed` 按触发元素 `getBoundingClientRect()` 定位，并在 `resize`/`scroll`（捕获阶段）时重新计算或直接关闭。
5. **失败信息（AC-6）**：优先渲染 `failure`（`{{status}} · {{message}}`，`no-key`/`empty`/`timeout`/`network` 用 i18n 文案），`failure === null` 时才退回旧 `error` 字符串。任何路径都不得把明文 key 写进 DOM/`title`/`aria-label`——渲染层再过一次 `redact` 兜底。
6. **Anthropic 冲突说明（AC-10）**：只出现在编辑器的**高级区**（值属于单个供应商），文案用 `ANTHROPIC_MIN_MAX_TOKENS[effort]` 插值；全局 A1 只说结论 + 「不发送 temperature」。主进程 `anthropicEffectiveMaxTokens` 只影响本次请求体，不回写配置。
7. **旧配置不整份回退（AC-8）**：`reasoningEffort` 不写 `.default()`。此前 `.default('medium')` 会让 `pickSection` 的 `partial()` 解析在「旧配置整份 parse 失败」时连带把别的字段也丢掉——宁可让缺字段靠 `DEFAULT_SETTINGS` 兜底。
8. **删除两步确认**：点删除 → 行尾就地变「确认删除 / 取消」，3s 无操作自动回退；确认后 `ai.deleteProvider` 并收起卡片；`key` 不可回读，所以不做「撤销删除」。
9. **样式收窄（必做，否则视觉不一致）**：`src/renderer/features/ai/ai.css:306` 的 `.ts-ai-form input/select/textarea { padding:5px 7px }` 是给面板写的，卡片内一律改用 `.ts-settings__input` 语汇（高 32、`border:1px solid var(--ts-border-strong)`），把通配规则限定到 `.ts-ai-panel .ts-ai-form ...` 作用域内。
10. **新 token 只能放 `html{}`**：`--ts-shadow-popover: 0 12px 32px rgba(0,0,0,.42), 0 0 0 1px var(--ts-border-strong)` 写进 `src/renderer/styles/tokens.css` 的 `html{}` 非契约块（`tests/contract/theme-tokens.test.ts` 对 `:root`/`[data-theme='light']` 逐 token 比对，多一个就红）。
11. **aria-label 陷阱**：`ai-provider-model` 的输入框在 label 内新增了「读取模型」按钮与 `▾` 后，可访问名会变；必须补显式 `aria-label={t('ai.provider.field.model')}`，否则 `getByLabel('模型', { exact: true })` 超时——构建与单测全绿、只有 e2e 红。
12. **空列表自动展开新建卡**：`listProviders()` 返回 0 条时 `expandedId = 'new'`（e2e 依赖「设置页一打开就有可读模型的编辑器」）。
13. **不做的取舍**：草稿未保存关闭时不做「确认丢弃」弹窗（PRD 未要求，且与 AC-3「同一时刻只展开一张」的手感冲突）；模型清单不做缓存；高级区展开状态不跨会话记忆。

## 7. 测试策略

| 层 | 文件 | 断言要点 |
| --- | --- | --- |
| 单测（映射） | `tests/reasoning-map.test.ts`（已有） | 4 协议 × 3 档：OpenAI 发 `reasoning_effort`；Anthropic 发 `thinking.budget_tokens` 1024/4096/16384 且 `max_tokens >= 2048/5120/17408` 且无 `temperature`；Gemini 发 `thinkingConfig.thinkingBudget`；Ollama 与白名单外兼容端点**不带**任何思考字段 |
| 单测（解析） | `tests/ai-reasoning.test.ts`（已有） | `resolveReasoningMode` 的 mode/reason 表；`ANTHROPIC_MIN_MAX_TOKENS > budget + 1024 - 1`；`anthropicEffectiveMaxTokens` 取大值 |
| 单测（草稿） | `tests/ai-draft-models.test.ts`（已有） | `{draft}` 分支零落盘（`providers.save/get` 未被调用、vault 写入数不变）；`no-key`/`empty`/`http`/`timeout` 四级 failure；`providerId` 分支仍用库里 key |
| 单测（请求） | `tests/ai-request.test.ts`（已改） | r1 的既有请求体断言不回归 |
| 契约 | `tests/contract/models.test.ts` | `aiSettingsSchema` 缺 `reasoningEffort` 时通过、`'ultra'` 被拒；`aiListModelsRequestSchema` 拒 `{providerId, draft}` 同时出现与未知键；`AiListModelsResult` 允许 `failure:null` |
| 契约（自动） | `tests/contract/i18n-keys.test.ts` | 新 `t('settings:…')` 在 en 与 zh-CN 都存在（扫描 `src/renderer` 字面量，漏写必红） |
| 契约（token） | `tests/contract/theme-tokens.test.ts` | 新 token 在 `:root`/light 块中**不出现** |
| e2e | `e2e/ai-settings-models.spec.ts`（未跟踪基线） | AC-1/2/3/4/5/6/8/11 的界面断言（行摘要、666px 无横向滚动、单开、草稿读取、点选、401+message、切档落盘、已忽略提示） |
| e2e 回归 | `e2e/ai-assist.spec.ts` | 面板既有交互不回归 |
| 视觉证据 | `docs/assets/ui-audit/` + `docs/UI-AUDIT.md` | 深/浅两主题截图，各含「卡片列表」与「展开编辑器」两态 |

门禁四连（收口必跑）：

```
pnpm typecheck
pnpm test
pnpm run build
pnpm exec playwright test e2e/ai-settings-models.spec.ts e2e/ai-assist.spec.ts
```

定向快跑（改前端时）：

```
pnpm exec vitest run tests/reasoning-map.test.ts tests/ai-reasoning.test.ts \
  tests/ai-draft-models.test.ts tests/contract/models.test.ts tests/contract/i18n-keys.test.ts
```

## 8. 任务拆分（文件边界不交叠 → 可并行）

依赖链：T1 →（T2 ∥ T3）→ T4 → T5。T2/T3 文件集完全不交叠，可并行；T4 依赖 T2 的组件与 T3 的 key；T5 只读源码。

### T1 补共享层与契约（阻塞解除，必须先做）

- 文件：`src/shared/reasoning.ts`（新）、`src/shared/models/ai.ts`、`src/shared/models/settings.ts`、`src/shared/index.ts`、`src/main/ai/service.ts`（仅加 300 字截断）、`tests/contract/models.test.ts`
- 只读：`src/main/ai/{adapters,index,ipc}.ts`、`tests/ai-{reasoning,draft-models}.test.ts`
- 验收：`pnpm typecheck` 全绿（当前必红）；`pnpm exec vitest run tests/reasoning-map.test.ts tests/ai-reasoning.test.ts tests/ai-draft-models.test.ts tests/contract/models.test.ts` 全绿。
- 注意：`reasoning.ts` 从 `./models/ai` 取 `AiProviderKind`，`models/settings.ts` 从 `../reasoning` 取 schema——方向单向，不得反向 import 形成环。

### T2 卡片与浮层组件 + 样式（与 T3 并行）

- 文件：`src/renderer/theme/ProviderCard.tsx`（新）、`src/renderer/theme/ModelCombobox.tsx`（新）、`src/renderer/theme/ReasoningEffortControl.tsx`（新）、`src/renderer/features/ai/api.ts`、`src/renderer/features/ai/ai.css`、`src/renderer/styles/tokens.css`
- 只读：`src/shared/reasoning.ts`（T1）、`src/shared/models/ai.ts`、`src/renderer/theme/AiSettings.tsx`（取既有表单字段与 testid 命名）、`src/renderer/features/ai/presets.ts`
- 验收：按 §4.2 签名实现；`pnpm typecheck` 绿；组件不 import `AiSettings`（避免环）。
- 硬点：§6.9 的 `.ts-ai-form` 收窄、§6.10 的 token 落位、§6.11 的 aria-label。

### T3 双 locale 文案（与 T2 并行）

- 文件：`src/locales/en/settings.json`、`src/locales/zh-CN/settings.json`、`src/locales/en/ai.json`、`src/locales/zh-CN/ai.json`
- 验收：按 §5.3 的键表**全部**补齐两语言；删除 `saveFirst`；`grep -rn "saveFirst" src/locales src/renderer` 为 0；`pnpm exec vitest run tests/contract/i18n-keys.test.ts` 绿（在 T2/T4 用到新 key 后才真正生效，允许先写后验）。

### T4 AiSettings 整合（T2、T3 完成后）

- 文件：`src/renderer/theme/AiSettings.tsx`
- 只读：T2 三个组件、`src/renderer/app/store.ts`（`setSettings`）、`src/shared/models/settings.ts`
- 验收：§4 的 A0–A3 结构与 §4.3 的 testid 全部到位；`expandedId` 单开；删除/默认切换/重拉列表按 §5.2；`pnpm typecheck` 绿；`pnpm run build` 通过。
- 禁止：改 `aiPanelVisible` patch 逻辑、改既有 testid、把卡片内思考强度做成可编辑。

### T5 交付自检与门禁（最后）

- 文件：`.gitignore`（补 `logs/`）、`docs/UI-AUDIT.md`、`docs/assets/ui-audit/*.png`（新）
- 验收：门禁四连全绿；双主题截图两态各一组；UI-AUDIT 追加一行（注明「已配置圆点是按 `apiKeyRef !== null` 推断，非连通性探测」）；`git status --porcelain` 收口。
- 边界：本任务只做交付自检，发现即修；**不写 QA-REPORT.md / ACCEPTANCE.md**，不跑跨浏览器/真机矩阵。

### git 纪律（PRD 工程约束，逐条带进任务）

1. 全程在 **master** 上顺序落地，**中间不单独 commit**（避免 HEAD 长期红、避免多次重写契约）；所有改动一次到底。
2. 提交只由 T5 在门禁四连通过后执行，且必须**限定路径**：`git add src/shared src/main/ai src/renderer src/locales tests e2e .gitignore docs/teamflow docs/UI-AUDIT.md docs/assets/ui-audit`；**禁止 `git add -A`**（工作树里有他人未跟踪文件）。
3. commit message：`feat(ai): 设置→AI 单列卡片工作台 + 三档思考强度（r2）`，正文列 4 条（草稿读模型 / 模型点选 / 三档映射单点 / Anthropic 抬 max_tokens）。
4. 不得 `git checkout --` / `restore` 任何 r1 半成品文件；`.gitignore` 只允许**追加** `logs/`。
5. 提交后不再改任何文件（后续轮次会因新提交作废旧判决）。

## 9. 风险与显式取舍

| 风险 | 处置 |
| --- | --- |
| 卡片与「左右分栏」的期待不一致 | 666px 实测不足，DESIGN §1 已给出判据；卡片形态落地即满足 AC-1..3，不再讨论分栏 |
| `openai-compatible` 白名单为空 → 用户以为无效 | AC-11 的「已忽略」提示 + A1 文案说明「仅 OpenAI / Anthropic / Gemini 生效」 |
| 已保存卡编辑态用了库里 key 读模型，但用户改了 baseUrl | 走 `{draft}`（带上新 baseUrl + 已存 key 的语义由 `resolveModelsTarget` 兜底：草稿无 key 时 `no-key`），提示用户重填 key |
| 删除默认供应商后 select 指向不存在 id | 前端在 `onDeleted` 里补 `defaultProviderId: null` |
| 新 token 加错块导致契约测试红 | 只写 `html{}`，并跑 `tests/contract/theme-tokens.test.ts` |
