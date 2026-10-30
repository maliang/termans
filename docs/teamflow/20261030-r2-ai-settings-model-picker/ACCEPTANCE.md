# ACCEPTANCE · 设置 → AI 改成 DSH 式供应商卡片工作台（r2）

- 需求夹：`docs/teamflow/20261030-r2-ai-settings-model-picker/`（PRD / DESIGN / TECHNICAL / QA-REPORT 同夹）
- 被测工作树：`/Users/maliang/Documents/develop/maliang/termans`，分支 `master`，`git status --porcelain --untracked-files=all` = **46 项**（与 QA 复验轮一致，未提交；无 `node_modules|out|dist|logs` 噪声）
- 验收时间：2026-10-31 01:30 ~ 01:55（Asia/Shanghai）；验收方式：独立复跑门禁 + 逐条读实现取证 + 人眼过双主题截图，不等同于转述 QA 结论

## 一、结论

**功能面全绿、门禁四连与全量 e2e 全绿；但 AC-12（P0）有一条既有 testid 被改名，另有一处「UI 不暴露各家参数名」的既定约定被破坏。两项都是小改（合计 <10 行），整改后可直接复验通过。**

- 阻塞项 2 条：见 §五（① `ai-provider-item-<id>` 消失；② 全局思考强度说明文案里出现 `reasoning_effort` / `thinkingConfig`）。
- 其余 12 条 AC 通过；5 条 P3 观察不阻塞（§六）。

## 二、逐条 AC 判定（14 条）

| AC | 判定 | 验收证据（实跑 / file:line） |
|---|---|---|
| AC-1 卡片行六项 | PASS | `src/renderer/theme/ProviderCard.tsx:449-476`（圆点 is-ok/is-missing、名称、模型、key 尾 4、默认徽标、编辑/设为默认/删除）；暗色截图六项齐全；QA C1 证明清 key 后圆点 `is-ok → is-missing`（非装饰） |
| AC-2 单列 + 不横滚 | PASS（等效） | 内容列由固定宽弹窗决定（`.ts-dialog__panel` 走 `--ts-dialog-width-lg`），实测可用宽 666 → 585/577/449 三档 `scrollWidth <= clientWidth`（QA C3）。**未单写 `max-width:720px`**，因容器恒 <720 故自然满足，记为观察 §六 |
| AC-3 内联展开 | PASS | 编辑器在卡片 DOM 内（`ProviderCard.tsx:538` `ai-provider-editor`），同时最多一张（`AiSettings.tsx` expandedId 单值），滚动抖动 ≤2px（QA C1 #3）；浅色截图可见卡内展开 |
| AC-4 草稿读模型不落盘 | PASS | 请求二选一 `src/shared/models/ai.ts:59-65`；链路 `ipc.ts:144/247` → `src/main/ai/ipc.ts:109` → `service.ts listModels`；e2e 第 1 条：读取前后 `ai-provider-card`=0 且 IPC `[]`，并有 0→1 反向对照 |
| AC-5 搜索/点选/手输保留 | PASS | `ModelCombobox.tsx:235-289`（`role=combobox/listbox/option`）；e2e 第 2 条手输值不被下次读取清空；QA C1 #5 覆盖上下键/回车/Esc |
| AC-6 失败说人话 | PASS | `src/main/ai/service.ts:149` `clipFailureMessage(redactor.redactText(text))`（先脱敏后截断，300 字上限 `:130`），`:281/:285` 两条出口同序；e2e 第 3 条：401 文案含状态码与 message、DOM 无 key 明文 |
| AC-7 catalog/custom 双模式 | PASS | `ProviderCard.tsx:546/556` 两个 mode 页签 + `:565` `ai-catalog`；QA C1 #4 证明切换不清空已填 key 与模型 |
| AC-8 三档落盘 + withDefaults | PASS | `src/shared/models/settings.ts:61`（**无 `.default()`**）、`:154` 默认 medium；`:181-195` `withDefaults` 逐字段 `pickSection`，坏字段只回退自己；e2e 第 4 条切「高」落盘且重启保留 |
| AC-9 映射单点 + 4×3 | PASS | `src/shared/reasoning.ts:40-48` 唯一数字表；本轮 grep `1024\|16384` 在 `src/main`+`src/shared` 仅命中 `reasoning.ts:42/44` 与 `adapters.ts:248-249` 注释，无第二份；`tests/reasoning-map.test.ts` 12 例穷举 |
| AC-10 Anthropic 不静默 400 | PASS | `adapters.ts:250-256`：`body.max_tokens = Math.max(provider.maxTokens, ANTHROPIC_MIN_MAX_TOKENS[level])`、`delete body.temperature`、不写回 provider；e2e 第 5 条主区顺序 + 高级区默认收起 + UI 明说 |
| AC-11 不支持就明说 | PASS | `ReasoningEffortControl.tsx:67/71`：`-no-default` 与 `-unsupported` 文案可见、控件不禁用；QA C1 #7 三态互斥（默认 Ollama → 已忽略；换 OpenAI → 消失；无默认 → 另一条） |
| AC-12 既有行为零回归 | **FAIL（有条件）** | 10/11 个既有 testid 命中（`settings-tab-ai` 由 `SettingsDialogHost.tsx:118` 模板生成、`ai-provider-model` 由 `ModelCombobox.tsx:44` 默认值生成、`aria-label="模型"` 在 `ProviderCard.tsx:714` 保留）；**`ai-provider-item-<id>` 已消失**，详见 §五-① |
| AC-13 双 locale + token | PASS（1 观察） | en/zh `ai.json` 158/158、`settings.json` 141/141，双向差集 0；QA 新探针做 en/zh 双向往返 + 裸 key 扫描为 0；token 契约测试绿。文案暴露参数名见 §五-② |
| AC-14 门禁与证据 | PASS | 本轮独立复跑：typecheck exit 0；vitest **59 files / 694 passed**；build exit 0（`out/renderer/assets/index-CJH1WXtO.js` 1650.14 kB，1.71s）；`e2e/ai-settings-models.spec.ts` **5 passed**；全量 playwright **35 passed / 0 failed**（2.5m）；4 张截图在 `docs/assets/ui-audit/after-ai-settings-r2-{dark,light}-{01-cards,02-editor}.png`，`docs/UI-AUDIT.md:170-178` 已记（含「绿点是按 `apiKeyRef !== null` 推断、非连通性探测」的口径） |

## 三、架构与结构一致性（M3 质量门）

- **蓝图落地**：按 TECHNICAL 拆成 `AiSettings` / `ProviderCard` / `ModelCombobox` / `ReasoningEffortControl`，r1 的 `src/renderer/features/ai/ProviderForm.tsx` 已删除（`git status` 记为 `D`），无留在原地的旧表单分支。
- **单点性（无重复实现）**：映射数字只在 `src/shared/reasoning.ts:42-48`；端点判定常量只在 `src/shared/reasoning.ts:62`（Gemini 主机）/`:66`（Ollama 端口），`src/main/ai/adapters.ts` 只调 `isGeminiEndpoint`，本轮 grep 在 adapters 内 0 命中本地副本 —— 上一轮 D-1 的双份判定已类级收口。
- **接口一致性**：`ai:list-models` 通道名/形状逐层对齐（`src/shared/ipc.ts:144/247` → `src/main/ai/ipc.ts:109` → `service.ts:261`），并有 strict 二选一 schema 挡脏请求。
- **测试资产判别力**：`tests/contract/e2e-selectors.test.ts` 前缀对账 + 自检、`tests/reasoning-map.test.ts` 映射矩阵、`scripts/dev/defect-gates.mjs` 7/7（喂回旧形态必判红）—— 门禁不是恒绿。
- **轻微耦合（不整改，仅记录）**：`ProviderCard.tsx:421` 用 `document.querySelector('[data-testid="ai-reasoning-effort-global"]')` 做「去顶部修改」跳转，跨组件 DOM 查询；当前可用，若今后控件改名会静默失效，建议后续改成回调 prop。

## 四、独立复跑记录（本轮，非引用 QA）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | exit 0（node + web 两工程） |
| `pnpm test` | exit 0，59 files / 694 tests，12.98s |
| `env -u ELECTRON_RUN_AS_NODE pnpm build` | exit 0，renderer 1650.14 kB，1.71s |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test e2e/ai-settings-models.spec.ts` | exit 0，5 passed（16.5s） |
| `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test` | exit 0，35 passed / 0 failed（2.5m） |

## 五、整改项（必须，整改后复验即可通过）

1. **[AC-12·P0] 补回既有 testid `ai-provider-item-<id>`**。证据：HEAD `src/renderer/theme/AiSettings.tsx:493` 原为 `data-testid={`ai-provider-item-${provider.id}`}`；现在 `src/renderer/theme/ProviderCard.tsx:435` 改成 `data-testid={isNew ? 'ai-provider-card-new' : 'ai-provider-card'}`，全仓 `src/` 下 `ai-provider-item` 零命中；更严重的是 `tests/contract/e2e-selectors.test.ts:77` 用 `expect(...includes('ai-provider-item-')).toBe(false)` 把「该 testid 不存在」写成了永久断言，等于把违约固化。整改：已保存卡片根元素同时挂 `data-testid={`ai-provider-item-${provider.id}`}`（与 `ai-provider-card` 并存，保留 `data-provider-id`），并把上述自检换成虚构前缀（如 `ai-provider-nope-`）。判据：`grep -rn 'ai-provider-item-\${provider' src/renderer` 命中 1；`e2e/ai-settings-models.spec.ts` 5 passed；`pnpm test` 绿。
2. **[约定·P2] 去掉 UI 文案里的各家参数名**。证据：`src/locales/zh-CN/settings.json:121` 与 `:138`（en 同两处）写着「OpenAI 走 reasoning_effort，Anthropic 走思考预算，Gemini 走 thinkingConfig」，与 `docs/teamflow/memory.md`「UI 只呈现三档，不暴露 `reasoning_effort` / `budget_tokens` 等原始参数名」直接冲突，且暗色截图首屏即可见。整改：改成「按供应商协议自动映射为各自的推理强度参数」之类表述，en/zh 同步。判据：`grep -c 'reasoning_effort\|thinkingConfig' src/locales/*/settings.json` = 0；键集不变（en/zh 各 141）；`e2e/theme-locale.spec.ts` 绿。

## 六、遗留观察（不阻塞，建议排后续）

- P3-1：`kind:'openai'` 且 Base URL 指本机 11434 时仍判 `openai-effort`，会发 `reasoning_effort` 且 UI 不提示「已忽略」；改点在 `src/shared/reasoning.ts` 的 `case 'openai'` 不看 baseUrl。
- AC-2 未单写 `max-width:720px`（当前由固定宽弹窗天然满足）；若日后设置弹窗放开宽度，需补上这条上限。
- P3-4：`TECHNICAL.md:107`（渲染层仍保留 300 字兜底截断，文档称「不再截断」）、`TECHNICAL.md:161`（`inputTestId` 默认值写成 `ai-provider-models-combo`，实际 `ModelCombobox.tsx:44` 是 `ai-provider-model`）两处笔误。
- P3-5：`src/renderer/i18n/index.ts:77 missingKeyReport()` 无消费者，缺键只能靠 QA 的 DOM 文本扫描兜底。

## 七、人工补测（环境限制，非交付缺陷）

真外网供应商（OpenAI/Anthropic/Gemini/Ollama 真实端点 × 三档）、VoiceOver 播报顺序、高 DPI/200% 缩放下 333px 内容列的省略号与操作组、浮层真实拖动手感，按 QA-REPORT §8 清单人工过一遍；本机沙箱禁 Chromium（crashpad 需 PROCESS_SET_INFORMATION），e2e 全部走 Electron 真机驱动。

验收结论：⚠️ 有条件通过
