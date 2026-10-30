<!-- meta: summary="把设置→AI 改成 DSH 式单列卡片（行内联展开编辑、可搜索模型清单、凭据状态与默认徽标），在一个页面里整合「填 key 即拉模型并可点选」与「全局三档默认思考强度」" -->

基线依赖：docs/teamflow/20261030-r1-ai-settings-model-picker/（产品口径沿用其 PRD 中的「未保存即读取模型 / 可点选模型清单 / 结构化失败 / 三档思考强度映射」四项；该轮已 cancelled、前端未落地，故本需求以 master 上的既有实现为**代码**基线）

取代：20261030-r1-ai-settings-model-picker#AC-10：把「列表 + 下方单栏表单」改为「单列卡片列表 + 卡片内联展开编辑」，编辑区内部字段顺序（预设→key→读取模型+模型→思考强度→高级折叠）保持不变

取代：20261030-r1-ai-settings-model-picker#AC-11：空态由「直接展开单栏表单」改为「直接展开新增卡片（`catalog` / `custom` 双模式）」，不再出现「先保存再读取」门槛与文案

# 设置 → AI：DSH 式供应商卡片（可搜索模型 + 三档思考强度）

## 一、背景与目标

### 1.1 主人的原话（需求来源）

- 设置中的 ai 配置不够直观，参考成熟的 agent 工作台进行修改，key 填写完就要能拉模型列表并选择，并且能选择默认思考强度
- 「我想要卡片式或者时左侧供应商右侧相关内容的设计，你现在是这样设计的吗？」
- 「或者参考DSH的设计」
- 「你从网上找一下源码」

### 1.2 现状核查（结论均有命令与输出支撑，不要凭印象推翻）

| # | 查到的事实 | 证据 |
|---|---|---|
| 1 | 当前形态既不是卡片式、也不是左右分栏：一行一条的 `<button>` 列表 + 同一容器下方的一整块单栏表单 | `src/renderer/theme/AiSettings.tsx:505`（`ts-ai-form__list`）、`:519`（`ts-ai-form` 单栏表单） |
| 2 | 「读取模型」在未保存时被硬禁用并提示 saveFirst —— 正是主人最不想要的那道门槛 | `src/renderer/theme/AiSettings.tsx:257-261`（`if (editingId === null) → fetchModels.saveFirst`）、`:598`（`disabled={... \|\| editingId === null}`） |
| 3 | 契约层已支持「草稿读模型」（`{providerId}` / `{draft}` 二选一 + 结构化 `failure`），但**尚未提交**；`src/shared/models/ai.ts` 里没有对应类型 | `src/shared/ipc.ts:238-247`；`grep -n "AiListModelsRequest" src/shared/models/ai.ts` → 0 命中 |
| 4 | 思考强度的映射代码已在工作树里写好（`adapters.ts` 按协议判定、Anthropic 抬 `max_tokens` 且不发 `temperature`），但**共享层缺口**：`src/shared/reasoning.ts` 不存在，`settings.ai.reasoningEffort` 未进 schema | `src/main/ai/adapters.ts:17`、`src/main/ai/index.ts:63`（从 `@shared` 导入）；`src/shared/models/settings.ts:55-59`（无该字段）；`src/main/ai/service.ts:381`（已在读它） |
| 5 | 结论：**当前工作树 typecheck 必定红**（三条引用指向不存在的符号），任何 UI 验证都不成立，必须先补齐共享层 | 由 #3、#4 直接推出；`git status --porcelain` 显示 `src/main/ai/{adapters,service,ipc,index}.ts`、`src/shared/ipc.ts`、`tests/ai-request.test.ts` 为 M，`tests/ai-draft-models.test.ts`、`tests/ai-reasoning.test.ts`、`e2e/ai-settings-models.spec.ts` 为未跟踪 |
| 6 | 供应商目录（catalog 数据）已经现成，11 个预设 + custom，不需要新造 | `src/renderer/features/ai/presets.ts:31-180`（openai / deepseek / moonshot / dashscope / openrouter / vllm / lmstudio / ollama / anthropic / gemini / gemini-native） |
| 7 | 设置内容列可用宽约 666px → 左右分栏每栏不足 330px，装不下一行「名称 · 模型 · key 尾 4 位 · 徽标 · 操作」；DSH 自己的模型设置也是单列卡片 | `src/renderer/theme/theme.css:183`（`.ts-settings__section`）；DSH `packages/client/ui-settings-models/src/client/ModelsSection.tsx` 为单列卡片列表 + 卡片内联展开 |

### 1.3 目标

1. **一眼看懂**：打开设置→AI 就能看到「我配了哪几个供应商、每个用什么模型、key 配没配、哪个是默认」，不需要逐条点开。
2. **填完就能用**：填 Base URL + key 后立刻「读取模型」，从真实清单里点选，不再有「先保存再读取」。
3. **协议差异不可见**：思考强度只呈现「低 / 中 / 高」，各家原生参数由一张映射表决定；不支持的供应商明说不支持，不做假生效。

## 二、用户故事与验收标准

> AC 编号在本需求内从 AC-1 起，与 r1 的编号无关。所有 AC 都必须可被真点一遍或一条命令判定。

### 故事 A：看清现状（卡片列表）

**作为**配过几个供应商的用户，**我想**在一屏里看清每个供应商的名称、当前模型、key 是否配好、哪个是默认，**以便**不用逐个点开就知道现在在用什么。

- **AC-1｜卡片行信息完整**：每个供应商占据一张独立卡片，卡内首行同时可见：① 名称 ② 当前模型 ③ API key 尾 4 位（未配置时显示「未配置 key」）④ 默认徽标（仅默认项显示）⑤ 凭据状态圆点（已配置 / 缺失，两态在深浅主题下均可区分）⑥ 行尾操作（编辑 / 删除 / 设为默认，默认项不显示「设为默认」）。
- **AC-2｜单列布局与宽度**：整页单列纵向排列卡片，内容列 `max-width: 720px`；在设置内容列可用宽 666px 的窗口下，卡片不出现横向滚动（`scrollWidth <= clientWidth`），行尾操作按钮不被裁切。
- **AC-3｜编辑＝卡片内联展开**：点击卡片行在该卡下方就地展开编辑区（不出现弹窗 / 抽屉 / 右侧栏），同一时刻最多一张卡展开；再次点击同一卡片收起；展开/收起时页面纵向滚动位置不跳（`window.scrollY` 抖动 ≤ 2px）。

### 故事 B：填完 key 就能拉模型

**作为**第一次配置的用户，**我想要**填完 Base URL 和 key 就能直接读模型并点选，**以便**不用先保存一个我还不确定的配置。

- **AC-4｜未保存即可读取模型**：处于「新增供应商」编辑态（未保存）时，「读取模型」按钮即可用，且用当前草稿（Base URL + 协议 + key + 自定义头）发请求；成功后模型清单出现在编辑器内，**磁盘上不产生供应商记录**（读取前后 `ai:list-providers` 条数不变）。
- **AC-5｜模型可搜索可点选、保留手输**：模型控件是「输入框 + 可搜索清单」：键入即按子串（忽略大小写）过滤、可上下键 + 回车选中、Esc 关闭；选中后输入框显示该模型名；用户手输任意未在清单中的模型名时不被覆盖、不被清空（自建网关场景）。
- **AC-6｜读取失败说人话**：失败时必须显示 HTTP 状态码与服务商返回的 message（截断至 300 字符），且至少可区分三类原因：401/403 鉴权失败、连接失败/超时、响应不是模型列表结构；**禁止**只显示「读取失败」。错误文案与 DOM 内不得出现明文 key（只允许出现尾 4 位）。
- **AC-7｜新增双模式**：新增编辑区顶部可在 `catalog`（从预设目录里挑，列表项显示品牌名 + 默认 Base URL + 说明）与 `custom`（手填 Base URL / 协议）之间切换；切换不清空已填的 key 与已选模型。

### 故事 C：默认思考强度

**作为**希望 agent 默认更「深」的用户，**我想要**在设置里选低/中/高，**以便**所有对话默认按这个强度请求，而不用记住各家参数名。

- **AC-8｜三档全局落盘**：设置页提供全局「默认思考强度」三档（低 / 中 / 高），写入 `settings.ai.reasoningEffort`，默认 `medium`；该控件位于供应商卡片区**之外**的独立区块（全局唯一，不放进单个供应商的编辑区）。旧 `settings.json` 缺该字段时经 `withDefaults` 补成 `medium`，其余字段一律保留（不得整份回退默认值）。
- **AC-9｜映射表唯一且逐协议正确**：`low / medium / high` 到原生参数的映射只存在一处实现，单测穷举 4 协议 × 3 档：OpenAI 系 `reasoning_effort = low|medium|high`；Anthropic `thinking.budget_tokens = 1024|4096|16384`；Gemini `generationConfig.thinkingConfig.thinkingBudget` 同上；Ollama 与未知/兼容端点**不发送**任何思考参数。
- **AC-10｜Anthropic 不静默 400**：开启思考时 `budget_tokens >= 1024` 且 `< max_tokens`；当保存的 `maxTokens` 小于「预算 + 1024」时，只在**本次请求**把 `max_tokens` 抬到 `max(cfg, budget + 1024)`（不写回配置），并在 UI 明确说明「本次请求已临时提高 max_tokens，不修改你的保存值」；同时该请求不发送 `temperature`（避免与 thinking 冲突），且这一点在 UI 文案里说清。
- **AC-11｜不支持就明说**：选中 Ollama 或未知兼容端点（含 `openai-compatible` 白名单外地址）时，思考强度区块下方显示「该供应商不支持思考强度，本次已忽略」；控件不隐藏、不假装生效。

### 故事 D：不把现有的东西搞坏

- **AC-12｜既有行为零回归**：`temperature`、`max_tokens`、`stream_options.include_usage`、上下文拼装、`commandConfirmation = true` 的二次确认均不回归；既有 testid 一律不改名（`settings-tab-ai`、`ai-provider-form`、`ai-provider-model`、`ai-provider-models-fetch`、`ai-provider-preset`、`ai-provider-kind`、`ai-provider-name`、`ai-provider-base-url`、`ai-provider-list`、`ai-provider-item-<id>`、`ai-provider-make-default-<id>`）；凡 label 内新增按钮/图标导致可访问名变化，必须给 input 补显式 `aria-label`（`getByLabel('模型', { exact: true })` 必须继续可用）。
- **AC-13｜文案双语 + 主题合规**：新增文案键同时进 `src/locales/en/*.json` 与 `src/locales/zh-CN/*.json`（`ai.json` / `settings.json`）；所有颜色、边框、阴影走既有 `--ts-*` token，禁止硬编码颜色与未定义的裸变量；中文界面不出现英文残留，英文界面不出现中文。
- **AC-14｜门禁与证据**：`pnpm typecheck` exit 0 且 `grep -c "error TS"` = 0；`npx vitest run` 全绿（不低于当前基线 55 files / 652 passed）；`env -u ELECTRON_RUN_AS_NODE pnpm build` exit 0；`env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/ --workers=1` 全绿（不低于当前基线 30 passed）；深色 / 浅色两套主题截图落到 `docs/assets/ui-audit/` 并在 `docs/UI-AUDIT.md` 记一行。

## 三、范围与非目标

### 3.1 范围（In）

- 设置→AI 页整体重排为单列卡片 + 行内联展开编辑（新增 `供应商卡片` 组件、`模型可搜索下拉`、`思考强度三档控件`）。
- 补齐 r1 遗留的共享层缺口（`src/shared/reasoning.ts`、`AiListModels*` 类型、`settings.ai.reasoningEffort`），让工作树 typecheck 回到 0。
- 草稿态读取模型（`{draft}` 通道）+ 结构化失败呈现。
- 全局三档默认思考强度 + 4 协议 × 3 档映射 + Anthropic 冲突处理 + 不支持提示。
- 双语文案、主题 token、e2e 调整与截图证据。

### 3.2 非目标（Out）

- 不做「每个模型单独配思考强度」——主人已在澄清中确认本期为全局单一默认，该能力留作后续跟进。
- 不新增供应商品牌、不改预设目录内容（沿用 11 个预设 + custom）。
- 不支持 Azure 类鉴权变体（`api-version` 变体），只在 UI 注明不支持。
- 不改主进程的加密包、Git 同步、AI 对话流式渲染。
- 不做模型能力探测（上下文长度 / 是否支持视觉），不展示价格。

## 四、反目标（反面目标）

> 这些是「测试全绿、主人仍然会打回」的形态。每一条都必须能被人在界面上看见。

1. **一屏看不出「我现在用谁」**：卡片只显示名称，模型 / key 尾 4 位 / 默认徽标要点开才看见 —— 于是「卡片式」只剩外观，没有任何信息收益，主人会问「这不还是要点开吗」。
2. **点了读取模型只得到「读取失败」**：没有 HTTP 状态、没有服务商原话，用户无法判断是 key 错、地址错还是模型服务挂了，只能来问人。
3. **展开编辑把布局挤坏**：在 666px 内容列里展开后出现横向滚动条、行尾操作按钮被裁到看不见，或者展开时整页跳到别处（滚动位置丢失）。
4. **配置看起来生效、请求里没有**：选了「高」但请求体没变；或者为了避开 Anthropic 冲突，把用户保存的 `temperature` 悄悄改成 1 —— 用户以为自己配的是 0.3。
5. **为了像 DSH 而改掉既有契约**：testid / label 重命名，30 条 e2e 里 AI 相关用例掉红，旧截图与文档全部对不上。
6. **新增供应商变成「背 URL」**：必须先知道 Base URL 才能看到模型，`catalog` 模式形同虚设，或者切换 catalog/custom 时把刚填的 key 清掉。

## 五、交互流程摘要

### 5.1 查看与切换默认

```
设置 → AI
├─ [AI 总开关 + 提示 + 披露文案]        （现有，位置最上）
├─ 默认思考强度  (低 · 中 · 高)           ← 全局唯一，卡片区之外（AC-8）
├─ 供应商（+ 新增按钮）
│   ├─ 卡片1  Anthropic · claude-… · …9f3a · [默认] · ●已配置   [编辑][删除]
│   ├─ 卡片2  Ollama · llama3.2 · 未配置 key · ○缺失            [编辑][删除][设为默认]
│   └─ （点卡片1 → 卡片1 下方就地展开编辑区，AC-3）
└─ 空态：直接展开「新增供应商」卡片（AC-7）
```

### 5.2 新增供应商（catalog 模式）

```
[新增] → 展开新增卡片
  ├─ 模式切换：从目录选择 | 手动填写            ← catalog / custom（AC-7）
  ├─ 协议 / 路由标签行（kind + 是否需要 key + 流格式，只读展示）
  ├─ 名称、Base URL                              （选目录时自动填好）
  ├─ API key                                     （填完即可下一步，无需保存）
  ├─ [读取模型]  +  模型（可搜索可点选，可手输）   ← AC-4 / AC-5
  │     失败：HTTP 401 · Incorrect API key provided（不含明文 key）  ← AC-6
  ├─ 思考强度：由全局默认决定（本卡只显示「跟随全局：高」，不改全局）
  └─ 高级（默认收起）：temperature / maxTokens / 自定义请求头
  底部动作：测试连接 · 保存 · 取消
```

### 5.3 编辑已保存供应商

点卡片行 → 展开同一套字段（预填当前值），保存后就地收起并刷新卡片行摘要；删除走行内两步确认（见假设与待澄清 Q4）。

## 六、优先级

- **P0**：AC-1、AC-2、AC-3、AC-4、AC-5、AC-6、AC-8、AC-9、AC-10、AC-11、AC-12、AC-14（卡片形态 + 草稿读模型 + 思考强度 + 不回归与门禁）。
- **P1**：AC-7（catalog / custom 双模式）、AC-13（双语文案与主题合规）。
- **P2**：卡片行的次要状态（最后读取模型时间、故障计数）、模型清单的最近使用排序、键盘可达性的进一步打磨（`aria-activedescendant`、焦点环）。

## 七、依赖与风险

| 依赖 / 风险 | 说明 | 处置 |
|---|---|---|
| **共享层缺口（最高优先）** | `src/shared/reasoning.ts` 不存在、`AiListModels*` 类型缺失、`settings.ai.reasoningEffort` 未进 schema，而 `src/main/ai/*` 已在引用 → 工作树 typecheck 必红 | 里程碑 M1 先补齐（见工程约束 1） |
| r1 半成品与他人工作树 | r1 的契约/适配器/服务/单测/e2e 规格已在工作树内但未提交，可能有成员在同一文件上作业 | 动手前 `git status --porcelain` 确认；不 revert 别人的改动 |
| Anthropic 抬 `max_tokens` 的语义 | 只在请求层抬高、不写回配置，用户可能误以为保存值被改 | UI 文案明说（AC-10），单测断言配置未被修改 |
| 兼容端点判定 | `openai-compatible` 的思考参数白名单为空＝不发；`gemini-native` 预设走原生 thinkingBudget | 单测按 kind + baseUrl 矩阵覆盖（AC-9 的 4 协议 × 3 档） |
| 布局改动会动到 e2e 锚点 | 卡片化后既有的行结构变化，`e2e/ai-settings-models.spec.ts` 与 `ai-assist.spec.ts` 的定位可能失效 | 只许改选择器的**范围**，不许改 testid 名（AC-12） |
| 设置内容列宽度硬约束 | 666px 下双栏不成立 | 单列 + 720px max-width（AC-2） |

## 八、里程碑建议

- **M1 共享层归零**：补 `src/shared/reasoning.ts`（三档映射 + Anthropic 最小 maxTokens + 端点判定）、`AiListModelsRequest/Result/Failure/ProviderDraft` 类型、`settings.ai.reasoningEffort`（进 schema 与 `DEFAULT_SETTINGS`，**不加 `.default()`**，避免 `withDefaults` 的 partial 吞值）；`pnpm typecheck` 回 0，`tests/ai-reasoning.test.ts`、`tests/ai-draft-models.test.ts` 绿。
- **M2 卡片骨架**：`ProviderCard`（行摘要 + 内联展开）+ 单列容器 + 空态；新增 `catalog/custom` 双模式；既有 testid 全保留。
- **M3 模型链路**：`ModelCombobox`（可搜索、保留手输、portal 渲染）+ 草稿态 `{draft}` 读取 + 结构化失败呈现。
- **M4 思考强度**：全局三档控件 + 跟随全局提示 + 不支持供应商提示 + 冲突说明文案。
- **M5 门禁与证据**：四连门禁 + 双主题截图 + `docs/UI-AUDIT.md` 一行 + 单笔显式路径提交。

## 九、工程约束（原样保留，不得改写）

1. **分支**：沿用 master（owner 已确认 `branchPolicy=keep`），不新建分支。
2. **既有未提交改动**：仓库当前有 8 处 M（`.gitignore`、`e2e/fixtures/ai-mock.ts`、`src/main/ai/{adapters,index,ipc,service}.ts`、`src/shared/ipc.ts`、`tests/ai-request.test.ts`）与 4 处未跟踪（`docs/teamflow/`、`e2e/ai-settings-models.spec.ts`、`tests/ai-draft-models.test.ts`、`tests/ai-reasoning.test.ts`）。动手前先 `git status --porcelain` 确认目标文件无人占用；这些改动属本需求的半成品，**补全而非丢弃**；不要 `git checkout --` / `git restore` 它们。
3. **门禁（必须真跑并贴输出）**：`pnpm typecheck` exit 0 且 `grep -c "error TS"` = 0；`npx vitest run` 全绿（当前基线 55 files / 652 passed）；`env -u ELECTRON_RUN_AS_NODE pnpm build` exit 0；`env -u ELECTRON_RUN_AS_NODE npx playwright test e2e/ --workers=1` 全绿（当前基线 30 passed）。本机 shell 导出 `ELECTRON_RUN_AS_NODE=1`，所有 GUI / e2e 命令必须 `env -u`。
4. **静默验证纪律**：跑 e2e 必须静默（默认 TERMANS_E2E 路径已全透明 + 屏外 + 不夺焦），禁止 `app.focus({steal:true})`、禁止 `open -a` 弹真实窗口、禁止替换正在运行的 `/Applications/Termans.app`。
5. **testid 与可访问名契约**：见 AC-12，testid 不改名；label 文本变化必须给 input 补显式 `aria-label`。
6. **CSS 纪律**：主题一律走 `--ts-*` token，禁止硬编码颜色；禁止使用裸的、未定义的 CSS 变量名（裸 `--border/--surface/--text-*` 会静默回落到浅色字面值，深色主题不报错但变浅）；组件 CSS 不得用单类选择器覆盖 kit 同族属性（`min-height` / `overflow` / `background` / `padding`）。
7. **`.gitignore` 审计（dev 阶段动作）**：现有覆盖 `node_modules/ out/ dist/ artifacts/ release/ coverage/ *.log .DS_Store .env .env.local !.env.example .data/ .vite/ playwright-report/ test-results/ *.tsbuildinfo .pnpm-store/ .agent-teams/`；本轮需补 **`logs/`**（TeamFlow 运行期 staging：`logs/teamflow/<runId>/` 结束即删，不得入库）；同时确认 `docs/teamflow/` 与 `e2e/`、`tests/`、`build/` 仍属入库内容（`.gitignore` 注释已明示，勿误加）；打包产物落 `dist/`（`electron-builder.yml` 的 `directories.output: dist`）已被覆盖，不必再加。
8. **提交纪律**：交付前 `git status --porcelain` 干净；用显式路径提交（`git commit -- <pathspec>`），不许 `git add -A`；报告里贴 `git rev-parse --short HEAD` 与逐条命令输出。
9. **证据留图**：改后附深色 / 浅色两套主题截图到 `docs/assets/ui-audit/`，并在 `docs/UI-AUDIT.md` 记一行。

## 十、假设与待澄清

> 每条都进了状态块的 `openQuestions`；`kind=fact` 是「研究能定」的，`kind=taste` 是「主人说了算」的。

- **Q1（fact，工作树归属）**：r1 遗留的未提交后端实现（契约 / 适配器 / 服务 / 单测 / e2e 规格）由本轮接管补齐，还是等原 owner？假设**本轮接管**——因为共享层缺失导致 `pnpm typecheck` 必红，不补齐则本条需求的任何 AC 都无法验证；若主人决定等原 owner，则 M1 顺延，本需求只能先做纯外观草案。
- **Q2（fact，e2e 基线）**：未跟踪的 `e2e/ai-settings-models.spec.ts` 是否作为本轮验收基线？假设**是**：保留其断言意图（草稿读模型 / 点选回填 / 三档落盘），按卡片布局调整选择器范围，testid 不改名；否则本轮需另写规格，覆盖率与既有断言可能重复遗漏。
- **Q3（taste，布局形态）**：单列卡片内联展开（DSH 同款）还是「左侧供应商列表 + 右侧详情」分栏？推荐**单列卡片**：设置内容列实测可用宽约 666px，双栏每栏不足 330px，装不下一行摘要 + 三个行尾操作；主人若坚持分栏，则 AC-1/AC-2 需要重写，且要接受摘要行折成两行或把「设为默认」收进溢出菜单。
- **Q4（taste，删除确认）**：删除供应商是否二次确认？推荐**行内两步确认**（点「删除」后按钮就地变「确认删除」，3 秒无操作自动回退），比 `window.confirm` 轻、比直接删安全；若主人希望「一键删」，则 AC-1 的操作列改为直接删除，并需接受误删后重建 key 的成本。
- **Q5（taste，卡片信息密度）**：卡片行除了「名称 / 模型 / key 尾 4 位 / 默认徽标 / 凭据圆点 / 操作」之外，要不要再显示别的状态（如被禁用徽标、上次读取模型时间、故障次数）？推荐**只显示上述六项**，其余进编辑区——行内元素一多，666px 下就会被压缩成两行或省略号；若主人想加，需要指定「加哪一项、牺牲哪一项」。
- **Q6（taste，高级区折叠记忆）**：`高级（温度 / maxTokens / 自定义头）` 的展开状态是否跨会话记忆？推荐**不记忆**（每次打开都默认收起）。记忆会让「我明明填过」与「默认收起」两种预期打架；若主人希望记忆，则它要作为一个新的 `settings.ui` 字段进入 schema（超出本期 settings.ai 的范围，需要单独确认）。

<!-- 本轮不修改 AGENTS.md；跨需求约定若有新增只写 docs/teamflow/memory.md。 -->
