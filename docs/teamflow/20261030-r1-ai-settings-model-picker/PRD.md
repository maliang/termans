<!-- meta: summary="把设置→AI 的供应商配置改成「选预设 → 填 key → 直接读取模型 → 从列表选模型 → 保存」的成熟工作台形态，并新增全局三档默认思考强度（低/中/高），按供应商协议映射到各自原生推理参数。" -->

基线依赖：无（本仓此前的 AI 配置迭代以 commit t47 / t53 与 `docs/UI-AUDIT.md` 记录，`docs/teamflow/` 下无历史 task folder 可引；t53 的「读取模型」行为在本需求中被重做，见「背景」）

# AI 配置：填 key 即拉模型列表 + 三档默认思考强度

## 1. 背景与目标

### 1.1 现状（均为读代码所得，附位置）

- 供应商配置页在 `src/renderer/theme/AiSettings.tsx`（854 行），字段顺序是：预设 → 类型 → 名称 → Base URL → **模型** → 温度 → maxTokens → **API key** → 自定义头 → 启用。用户要「选模型」时 key 还在下面没填，顺序与真实操作顺序相反。
- 「读取模型」按钮（`src/renderer/theme/AiSettings.tsx` 的 `ai-provider-models-fetch`）由 `handleFetchModels` 驱动；`editingId === null` 时它在函数开头直接报错 `ai:provider.fetchModels.saveFirst`（文案：「请先保存这个供应商，再读取它的模型列表。」），按钮本身也 `disabled={... || editingId === null}`。**这就是主人抱怨的痛点：key 填完不能立刻拉列表，必须先保存一次。**
- 根因在主进程契约：`ai:list-models` 只接受 `{ providerId }`（`src/shared/ipc.ts:231`），`AiService.listModels`（`src/main/ai/service.ts:205`）从供应商仓库取 baseUrl/kind 与 vault 里的 key —— 草稿态（未保存）的配置根本没有入口发请求。
- 模型选择控件是 `<datalist>`（`ts-ai-provider-models`），只是浏览器自动补全提示：用户点不到、看不到「有哪些可选」、也看不到「当前选中哪个是真实存在的」；拉取结果只塞进 datalist，与预设写死的清单混在一起。
- 完全没有「思考强度」：请求体只写 `temperature` / `max_tokens`（`src/main/ai/adapters.ts` 的 `buildBody`），`settings.ai` 只有 `enabled / autoContext / contextLines / defaultProviderId / commandConfirmation`（`src/shared/models/settings.ts` 的 `aiSettingsSchema`）。默认思考强度既没有存储位，也没有映射实现。

### 1.2 目标

1. **配置链路四步闭环**：选预设 → 填 API key（+ 必要时改 Base URL）→ 点「读取模型」→ 在列表里点选模型 → 保存。**读取不再以保存为前置条件**。
2. **模型是可点选的清单**，不是输入提示：读取结果以可搜索下拉/列表呈现，选中项在页面上明确可见；同时保留手输（自建网关 / vLLM / 新模型必须有逃生口）。
3. **默认思考强度三档（低 / 中 / 高）**：界面只呈现三档，存储为 `settings.ai.reasoningEffort`，请求构建时按供应商协议映射成各自原生参数；映射表只存在一处，可被单测穷举。
4. 整个配置页按「成熟 agent 工作台」的信息层级重排：常用项（供应商 / key / 模型 / 思考强度）在前，调参项（温度、maxTokens、自定义头）收进「高级」。

> 已由澄清轮确认，本 PRD 不再重议：① 思考强度固定三档，按供应商自动映射到原生参数，界面不暴露各家参数名；② 沿用 master 分支开发，不新建分支。

## 2. 用户故事与验收标准

### US-1（P0）作为首次配置 AI 的用户，我填完 key 就能看到这家供应商到底有哪些模型

- **AC-1｜未保存即可读取模型**：在新建（未保存）状态里，填好 Base URL 与 API key 后点「读取模型」，主进程使用**草稿配置**发起模型查询并返回列表；整个过程不写盘、不需要先保存供应商。
- **AC-2｜模型是可点选的清单**：读取成功后，模型字段展示可搜索的下拉/列表（列出返回的全部模型，含数量），点选任一项即写入表单并在界面上可见当前选中值；模型名仍可手输，且手输值不会被下一次读取清空。
- **AC-3｜失败原因原样可见且不泄漏 key**：401 / 403 / 404 / 超时 / 空列表 / 网关返回非 JSON，都展示**具体**文案（含 HTTP 状态与供应商返回的 message 片段），不得只出现「读取失败」；任何提示、日志、toast 中不得出现 API key 明文（只可出现尾 4 位）。
- **AC-4｜供应商条目一眼可读**：列表条目显示 `名称 · 模型 · key 尾4位 · 默认徽标`（现状已基本如此，改动后不得回退）；保存失败时必须指出具体字段（如「Base URL 不是合法 URL」），不能只说「保存失败」。

### US-2（P0）作为用户，我能设一个默认思考强度，之后每次对话自动生效

- **AC-5｜三档设置项落盘且可迁移**：设置→AI 有「默认思考强度」三个选项（低 / 中 / 高），切换即写 `settings.json` 的 `ai.reasoningEffort`，重启后保留；`DEFAULT_SETTINGS.ai.reasoningEffort` 有明确默认值（建议 `medium`），旧的 `settings.json`（无该字段）读取后自动补默认值，**不得**因为新增字段被判非法而导致整份设置回退默认（语言/主题被重置视为失败）。
- **AC-6｜映射表唯一且覆盖四种协议**：请求构建时按供应商类型映射（实现只允许一处映射函数，被单测穷举）：
  | 供应商类型（`AiProviderKind` / 判定） | 低 | 中 | 高 |
  |---|---|---|---|
  | `openai`、`openai-compatible`（OpenAI 帧） | `reasoning_effort: "low"` | `"medium"` | `"high"` |
  | `anthropic`（Messages 原生） | `thinking.budget_tokens: 1024` | `4096` | `16384` |
  | Gemini 原生（`sse-gemini`，base 不含 `/openai`） | `generationConfig.thinkingConfig.thinkingBudget: 1024` | `4096` | `16384` |
  | `ollama`（NDJSON 原生） | 不发送任何推理参数，UI 上有一句说明（本地模型无此语义） | 同左 | 同左 |
- **AC-7｜不发出必然 400 的请求**：Anthropic 开启 thinking 时，`budget_tokens` 必须 `>= 1024` 且 **小于** `max_tokens`，且 thinking 模式下温度不被同时发送为冲突值（按官方要求置 1 或省略）。当选「高」（16384）而 `maxTokens` 小于 16384+ 余量时，系统必须二选一且对用户可见：自动把本次请求的 `max_tokens` 抬到足够值，或在保存/对话前给出可操作提示（「把最大 tokens 调到 ≥16768 或改选低档」）；**不许**静默发出必定失败的请求。
- **AC-8｜映射有单测**：扩展 `tests/ai-request.test.ts`（或同级新测试），对 4 种协议 × 3 档断言请求体字段与数值；另断言 `ollama` 不出现推理字段、Anthropic 的 `budget_tokens < max_tokens` 恒成立。
- **AC-9｜既有行为不回归**：非 reasoning 场景下 `temperature` / `max_tokens` / `stream_options` / 系统提示与终端上下文的拼装方式不变；`ai.commandConfirmation` 仍恒为 true；`contextLines` 行为不变。`pnpm typecheck`、`pnpm test` 全绿。

### US-3（P1）作为用户，配置页的字段顺序与信息层级符合我的操作顺序

- **AC-10｜按操作顺序排布**：表单主区顺序为：供应商预设 / 类型 → **API key** → **读取模型 + 模型选择** → **默认思考强度**（该供应商适用的档位提示）→ 高级（温度、maxTokens、自定义请求头，默认收起）；「测试连接」「保存」在底部动作区。
- **AC-11｜空态直接可用**：一个供应商都没有时编辑器直接展开（保留现有行为），且只填了 key + Base URL 时「读取模型」按钮可用（AC-1 的 UI 侧呈现），不出现「先保存再读取」的提示文案。
- **AC-12｜文案双语言**：新增文案键同时进 `src/locales/en/*.json` 与 `src/locales/zh-CN/*.json`（`ai.json` / `settings.json`），中文界面不出现英文残留、英文界面不出现中文。

## 3. 范围与非目标

### 范围内
- 设置→AI 页供应商编辑器的布局与交互重排（`src/renderer/theme/AiSettings.tsx`）。
- `ai:list-models` 的**可选字段扩展**（草稿配置：kind / baseUrl / apiKey / headers），与既有 `ai:save-provider` 接受 `headers`/`apiKey` 的扩展模式一致；主进程 `AiService.listModels` 支持草稿来源。
- 模型选择控件（可搜索下拉）、读取结果的展示与错误文案。
- `settings.ai.reasoningEffort` 契约字段 + `DEFAULT_SETTINGS` 默认值 + 设置页三档控件。
- 请求构建侧的映射函数（`src/main/ai/adapters.ts`）+ 单测。
- en / zh-CN 文案。

### 非目标
- 不做「每个供应商各自一份思考强度」（本期只有全局默认）。
- 不在右侧 AI 面板里改配置（配置仍只在设置页，面板只留入口）。
- 不展示思维链内容（`delta.reasoning_content` / Anthropic thinking blocks 继续丢弃，用途只影响请求参数）。
- 不做按模型自动推断「是否支持思考」的能力探测（一期只按协议类型映射 + 保守发送策略）。
- 不引入新的三方依赖（不引 UI 组件库，沿用现有 `.ts-field` / `.ts-settings__*` 样式体系）。

## 4. 反面目标（anti-goals）

> 「测试全绿但主人会说这功能没用」的形态，逐条可用肉眼或一条命令验证。

1. **填完 key 点「读取模型」，界面回一句「请先保存这个供应商」** —— 这期等于没做，必须当场判红。
2. **读回来的模型仍是一串自动补全提示**：点不到、看不到「选中了哪个」、列表里还混着预设写死的型号、保存后打开又是原来那几个 —— 用户会认为「读取模型」按钮是个装饰。
3. **选了「高」之后第一次对话直接 400**（Anthropic `budget_tokens` ≥ `max_tokens`；或兼容端点不认 `reasoning_effort`），而界面事先没有一句提示、事后只显示一条英文原始错误 —— 「能选但不生效」比「不能选」更差。
4. **读取失败只说「读取失败」**，或把 API key 明文写进提示 / 日志 / 错误 toast —— 前者的用户无法自救，后者是安全事故。
5. **存量用户升级后打开设置页**：思考强度是空的、旧 `settings.json` 因新字段被判非法而整份回退默认（语言、主题、终端字号一起被重置）—— 「升级把我设置搞没了」是这一类改动最容易踩的坑。

## 5. 交互流程（摘要）

**首次配置（P0 路径）**
1. 设置 → AI → 供应商「+ 新建」→ 选预设（OpenAI / DeepSeek / Anthropic / Gemini / …），Base URL 与类型自动带出。
2. 粘贴 API key（只写字段，`type=password`，可切换明文，保存后清空本地 state）。
3. 点「读取模型」→ 主进程用草稿配置请求（不写盘）→ 按钮进入 loading（禁用 + 旋转图标）。
4. 成功：模型字段变为可搜索下拉，显示「共 N 个模型」；点选一项即为当前模型；列表含搜索框，空搜索显示最近使用的在前。
5. 「默认思考强度」显示当前全局值（低/中/高）与该供应商的适用提示（Ollama 显示「本地模型不发送推理参数」）。
6. 「测试连接」→ 走一次真实请求并回显状态与服务商原文（沿用现有 `ai:test-provider`，草稿态同样可测）。
7. 「保存」→ 落库（vault），第一个供应商自动成为默认供应商。

**失败分支**
- 401/403：提示「key 无效或无权限（HTTP 401）：<服务商 message>」。
- 404 / 路径不对：提示 Base URL 可能缺 `/v1`（沿用现有 `openAiUrl` 的拼接规则说明）。
- 空列表：提示「供应商返回空列表：请确认 Base URL 指向兼容端点」。
- 超时/网络：提示超时秒数并允许重试。
- vault 未解锁：显示「请先解锁加密包」，不显示「读取失败」。

**思考强度生效路径**
设置页切换 → `settings:update` 落盘（`settings.json`）→ 下一次 `ai:chat` 时主进程读取 `settings.ai.reasoningEffort` → 映射函数按供应商类型生成推理参数 → 合并进请求体。历史上已保存的对话不受影响。

## 6. 优先级

- **P0**：AC-1 ~ AC-9（草稿读模型 + 模型选择 + 三档思考强度 + 映射单测 + 不回归）。
- **P1**：AC-4、AC-10、AC-11（信息层级与字段顺序、空态可用、错误指向具体字段）。
- **P2**：AC-12 之外的文案打磨；下拉的键盘导航与最近使用排序；供应商条目展示思考强度适用性。

## 7. 依赖与风险

| 项 | 说明 | 处置 |
|---|---|---|
| vault 未解锁 | `ai:list-models` / 保存都会抛 `E_VAULT_LOCKED` | UI 明确提示解锁；草稿态读模型同样要先解锁（key 校验与写入都要 vault 就绪） |
| 明文 key 处理 | 草稿读模型意味着 key 从渲染层发往主进程一次 | 复用 `createRedactor(providerSecretValues(...))`；日志只记 id/状态/耗时；不缓存、不回传 |
| 兼容端点对未知字段的严格度 | 部分 OpenAI 兼容端（vLLM / LM Studio / 老网关）对 `reasoning_effort` 直接 400 | 保守发送策略（见 openQuestions Q1），并把失败原文透出 |
| Anthropic thinking 约束 | `budget_tokens >= 1024`、`budget_tokens < max_tokens`、thinking 下温度需为 1 | 映射函数内 clamp + AC-7 |
| Gemini thinkingBudget 模型差异 | 2.5 Pro 有最小预算、Flash 可为 0 | 档位预算取两家都合法的区间（1024/4096/16384） |
| 「高」+ 小 maxTokens | 默认 `maxTokens` 是 2048（预设 `presetToInput`） | AC-7：抬 max_tokens 或提前报错，二者择一且可见 |
| e2e 打不了外网 | Playwright 无法真实调供应商 | 单测覆盖请求体；UI 侧用可注入 fetch / 假供应商在集成层验证 |
| 契约扩展 | `ai:list-models` 新增可选字段，preload 若有通道白名单需同步 | 与 `headers`/`apiKey` 扩展同一模式，不改既有字段语义 |

## 8. 工程约束

- **分支**：沿用当前 `master` 分支开发，**不新建、不切换分支**（澄清轮已确认）。
- **提交时机**：先完成实现与验证再一次性提交；提交前 `git status --porcelain -- src tests e2e docs/teamflow` 确认没有把他人未提交改动卷进来（当前工作树仅有未跟踪的 `docs/teamflow/`，即本任务产物）。提交信息写明需求范围（AI 配置页重做 + 思考强度），便于单笔回滚。
- **`.gitignore` 审核（按本仓真实栈：Electron + Vite + React + TS + pnpm + vitest + Playwright）**：现有项已覆盖 `node_modules/`、`out/`、`dist/`、`release/`、`artifacts/`、`coverage/`、`playwright-report/`、`test-results/`、`*.log`、`.env*`、`.data/`、`.vite/`、`.agent-teams/`、`.DS_Store`。**待补**：`*.tsbuildinfo`（tsc 增量产物；当前脚本为 `--noEmit` 无 composite，补上零成本）、`.pnpm-store/`（子目录 store 情形）。**不可忽略**：`build/`（应用图标等源码资源，不是构建产物）、`docs/`、`tests/`、`e2e/`。收口前补完并确认 `git status` 里没有构建/缓存噪音。
- **契约纪律**：新增 `settings.ai.reasoningEffort` 必须同时进 `aiSettingsSchema` 与 `DEFAULT_SETTINGS`（旧配置靠 `withDefaults` 补齐），不得把字段做成可选后再在 UI 里到处兜底。
- **安全纪律（不可协商）**：明文 key 不进日志、不进提示词、不进错误文案、不回渲染层；`ai.commandConfirmation` 保持字面量 `true`；AI 产出命令仍需二次确认。
- **验证纪律**：`pnpm typecheck`（node + web 两端）+ `pnpm test` + 相关 e2e；前端改动必须真点一遍（构建通过不代表界面生效）。

## 9. 里程碑建议

- **M1**：契约与映射——`settings.ai.reasoningEffort` + 映射函数 + 单测（AC-5、AC-6、AC-7、AC-8）。
- **M2**：草稿读模型——`ai:list-models` 可选字段扩展 + service 草稿分支 + 错误文案（AC-1、AC-3）。
- **M3**：配置页重排——字段顺序、可搜索模型下拉、思考强度三档控件、Ollama 说明（AC-2、AC-9、AC-10、AC-11、AC-12）。
- **M4**：回归与收口——`typecheck` / `test` / e2e、`.gitignore` 补齐、一次提交。

## 10. 假设与待澄清

- **（taste）兼容端点是否发送 `reasoning_effort`**：已知官方 OpenAI / o 系列支持，未知兼容端（DeepSeek、Moonshot、DashScope、vLLM、LM Studio）未逐一实测；保守 = 未知端点不发（不会 400，但功能「看起来没生效」），激进 = 照发（支持者可用，不支持者 400）。**推荐：按 kind 白名单 + 已知模型族判断，未知端点默认不发并在 UI 注明「该供应商可能不支持」**，因为「静默 400」比「明确不支持」更伤。
- **（taste）三档到 Anthropic / Gemini 的预算数值**：`1024 / 4096 / 16384` 是我的推荐（两家都合法，成本与首字延迟折中）；也可选 `2048 / 8192 / 32768`（更强推理，更贵更慢）。改数值只影响映射表一处与单测断言。
- **（taste）模型选择的交互形态**：可搜索下拉（推荐，模型常达几十上百个）vs 原生 `<select>` 单选（实现最省、但长列表难用）vs 弹窗列表（信息最全、但多一个浮层）。无论选哪种，手输入口都保留。
- **（taste）思考强度放在哪一层**：全局默认（推荐，本期最小结构）vs 每个供应商各配一份（更灵活，但配置项翻倍且与「默认」语义重复）；若选后者，`settings.ai.reasoningEffort` 需要下沉为每个 provider 的字段。
- **（taste）「高级」区是否收起**：收起温度 / maxTokens / 自定义头（推荐，主路径只留 key、模型、思考强度）vs 全部平铺（少一次点击，但首屏信息过载）。
- **（fact）各端点对模型列表接口的真实行为**：OpenAI 兼容走 `GET /v1/models`、Anthropic 走 `GET /v1/models`、Ollama 走 `/api/tags`（现状已如此），但**草稿态**（未保存的 Base URL）能否覆盖所有托管商的鉴权方式（如 Azure 的 `api-key` 头 + `api-version`）需要实现时实测；若 Azure 类托管不被支持，需在 UI 说明而非假装支持。
