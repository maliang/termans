# QA-REPORT · 设置 → AI 改成 DSH 式供应商卡片工作台（r2）· 复验轮 2

- 需求夹：`docs/teamflow/20261030-r2-ai-settings-model-picker/`（PRD / DESIGN / TECHNICAL 同夹）
- 被测工作树：`/Users/maliang/Documents/develop/maliang/termans`，分支 `master`，`git status --porcelain --untracked-files=all` 实测 46 项（均属本需求在途改动，未提交）
- 测试时间：2026-10-31 00:49 ~ 01:25（Asia/Shanghai）
- **本轮性质：对上一轮两条 P2（D-1 / D-2）修复的复验**，不是全新一轮测试：先原样复跑上一轮留下的全部 checker 与两条缺陷的 Check command，再补上一轮**没有覆盖**的两个面（见 §3.3）。
- **结论：可验收。P0/P1/P2 未发现开放缺陷；D-1、D-2 两条 P2 已确认修复且新增了永久门禁。** 剩余 5 条 P3 观察项（不阻塞，见 §6.2）。

## 一、范围与环境

| 项 | 内容 |
|---|---|
| 功能范围 | AC-1..14 全部；复验重点为 D-1（Gemini 端点判定单点）与 D-2（e2e 选择器恒绿）及其类级扩面 |
| 运行时 | macOS + Electron（Playwright `_electron.launch`，窗口 1320×860）。**不依赖独立 Chromium**（宿主沙箱禁 Chromium crashpad，见 §7） |
| 工程约定来源 | 项目根**无 AGENTS.md**（`find . -maxdepth 2 -name AGENTS.md` 零命中），验证命令取自 `package.json` scripts |
| 本轮新增 checker | `logs/teamflow/tf-mvuq80dp-d4kkc5/scripts/qa/qa-round2-probe.spec.ts`（双语言运行时渲染 + 可访问名全扫）、`.../probe-testid-sweep.mjs`（D-2 类扩面到字面量选择器） |
| 复用的既有 checker | `qa-ac-probe.spec.ts`（7 条 AC 兜底）、`probe-reasoning-map.mts`（映射矩阵）、`ai-settings-layout.spec.ts`（AC-2 布局）、`scripts/dev/defect-gates.mjs`（dev 侧的判别力自检） |

## 二、门禁与回归复跑（上一轮 checker 全部原样复跑，逐项贴实测通过数）

| # | 命令 | 退出码 | 实测结果 |
|---|---|---|---|
| G1 | `pnpm typecheck`（node + web 双工程） | 0 | 零报错 |
| G2 | `pnpm test` | 0 | **59 files / 694 tests passed**（12.0s；上一轮 58/690，新增 `tests/contract/e2e-selectors.test.ts` 与 D-1 的 2 条守卫） |
| G3 | `pnpm run build` | 0 | `out/renderer/assets/index-CJH1WXtO.js` 1650.14 kB，built in 1.60s |
| G4 | `pnpm exec playwright test e2e/ai-settings-models.spec.ts` | 0 | **5 passed**（17.1s）— D-2 的通过判据之一 |
| G5 | `pnpm exec playwright test`（全量） | 0 | **35 passed / 0 failed**（2.5m，含 theme-locale 的语言往返、contrast、ssh-terminal、vault-security） |
| C1 | `playwright test --config .../qa/playwright.qa.config.ts qa-ac-probe` | 0 | **7 passed**（20.3s）— AC-1/3/4/5/6/7/11 兜底探针 |
| C2 | `node --experimental-strip-types .../qa/probe-reasoning-map.mts` | 0 | 10 行矩阵输出与上一轮报告 §2.3 **逐行一致**（含 P3-1 现象仍在） |
| C3 | `playwright test --config .../shots/playwright.shots.config.ts ai-settings-layout` | 0 | **2 passed**；列宽 666 → 摘要 585≤585、657.6 → 577≤577、529.4 → 449≤449；浮层 `panel=0 dialog=1`（Esc 只关浮层） |
| C4 | `node .../scripts/dev/defect-gates.mjs` | 0 | **7/7 PASS**（含把常量加回 adapters / 旧前缀选择器喂入 → 必须判红的反向对照） |
| C5 | `node .../scripts/qa/probe-testid-sweep.mjs`（本轮新增） | 0 | 应检 190 / 实检 190 / **悬空 0**；自检「虚构前缀 `ai-provider-item-` 判悬空」= 对 |
| C6 | `playwright test --config .../qa/playwright.qa.config.ts qa-round2-probe`（本轮新增） | 0 | **2 passed**（5.4s）— 见 §3.3 |

## 三、逐条缺陷复验（Check command / Pass criterion 原样执行）

### 3.1 D-1（P2 · 架构 · Gemini 端点判定双份）

| 项 | 内容 |
|---|---|
| 原 Check command | `grep -rn "generativelanguage.googleapis.com" src/main/ai/adapters.ts src/shared/reasoning.ts \| wc -l` |
| 原 Pass criterion | 输出 `1`（常量下沉到 `src/shared` 单处），或新增一致性单测且 `vitest run tests/reasoning-map.test.ts` 绿 |
| 本轮实测 | 输出 **`1`**（唯一命中 `src/shared/reasoning.ts:62`）→ 满足 |
| 补充证据 | `grep -n "isGeminiEndpoint" src/main/ai/adapters.ts` → `:20`（从 `@shared` 导入）、`:138`（`if (isGeminiEndpoint(provider.baseUrl)) return 'sse-gemini'`）；adapters 内已无本地 `GEMINI_HOST`；`resolveStreamFormat` 的 4 处调用点（`:216/:312/:325` 等）行为不变 |
| 判定 | **已修复** |

### 3.2 D-2（P2 · 测试资产 · AC-4 断言恒绿）

| 项 | 内容 |
|---|---|
| 原 Check command | `grep -c "ai-provider-item-" e2e/ai-settings-models.spec.ts` |
| 原 Pass criterion | 输出 `0`，随后 `pnpm exec playwright test e2e/ai-settings-models.spec.ts` 仍 5 passed |
| 本轮实测 | 输出 **`0`**；该 spec **5 passed** → 满足 |
| 断言现在长什么样 | `e2e/ai-settings-models.spec.ts:119` 用真实卡片 `ai-provider-card` 计数 0 + IPC `ai:list-providers` 为 `[]` 双重取证，并**自带反向对照**（`:130-134` 真保存后卡片数 0→1、IPC 0→1）——断言能在「草稿读取写了库」时转红 |
| 新增长期守卫 | `tests/contract/e2e-selectors.test.ts` 对账「每个 `[data-testid^=…]` 前缀都能在 `src/renderer` 找到来源」，并含自检（扫描非空 + 虚构前缀必悬空） |
| 判定 | **已修复** |

### 3.3 缺陷类命中数复算 + 扩面（上一轮未覆盖的面，附「为什么漏了」）

| 缺陷类 | 上一轮命中 | 本轮命中（同一判据） | 扩面后的面 | 扩面命中 | 说明 |
|---|---|---|---|---|---|
| 同一端点判定在多处实现（D-1 类） | 2 | **1** | Ollama 端口常量是否也双份 | **0**（`OLLAMA_DEFAULT_PORT` 仅 `src/shared/reasoning.ts:66`，adapters 0 处） | 类级已收口，不是只修了 Gemini 一处 |
| e2e 选择器指向不存在的 testid（D-2 类） | 1（前缀面） | **0** | 扩到**字面量选择器**（`getByTestId('x')` / `[data-testid="x"]`），共 190 条 | **0 悬空** | 上一轮漏的原因：守卫只覆盖「前缀」这一种写法，而 D-2 的根因是「指向不存在的名字」，字面量与前缀同属一类。本轮用 `probe-testid-sweep.mjs` + 自检对照补齐 |

### 3.4 上一轮未覆盖的两个面（本轮新增探针 `qa-round2-probe.spec.ts`，2 passed）

| 面 | 为什么上一轮漏了 | 断言（实跑） | 结果 |
|---|---|---|---|
| **AC-13 的 en 语言运行时渲染** | 上一轮只做了磁盘键集比对（en/zh 各 141、158 齐平），全程在系统默认中文下跑 UI。若组件写成 `t('ai:ai.models.read')` 或 en 资源键名拼错，静态比对 + typecheck + 单测全绿，界面却显示裸 key | 切 `locale-select='en'` → AI 页「Load models」/「No default provider yet」/「High」；切回 `zh-CN` → 同一批元素变「读取模型」/「默认供应商」/「高」（**双向对照 = 断言能分辨**）；两种语言下对 `settings-dialog` 全文本扫 `\b(ai|settings)\.x.y\b` 裸 key，均为 `[]` | PASS |
| **AC-12 的 aria-label 结构性全扫** | 上一轮只用 `getByLabel('模型', {exact:true})` 单点佐证（且在 zh 下），单点过只说明那一个被补了 | 遍历 `ai-provider-editor` 内**每一个** input/select，可访问名必须非空：实测 6 个全部有名字（预设 / 接口风格 / 名称 / Base URL / API key / 模型），且 `ai-provider-model` 的名字恰为「模型」、`getByLabel('模型',{exact:true})` 命中 1 | PASS |

## 四、逐条 AC 结果（本轮复验口径）

| AC | 本轮证据 | 结果 |
|---|---|---|
| AC-1 六项摘要 | C1 第 2 条（清 key 后凭据圆点 `is-ok → is-missing`，证明非写死装饰） | PASS |
| AC-2 单列 720px 无横滚 | C3：三档宽度 `scrollWidth ≤ clientWidth`（585/577/449），行尾操作不越界 | PASS |
| AC-3 内联展开 | C1 第 3 条（编辑器在卡片 DOM 内、`role=dialog` 恰 1 个、仅 1 个展开、滚动抖动 ≤2px） | PASS |
| AC-4 草稿读模型不落盘 | G4 第 1 条（`ai-provider-card`=0 + IPC `[]` + 反向对照 0→1）；C1 第 1 条另证 mock 收到 `GET /v1/models` 且 authorization 只留尾 4 位 | PASS |
| AC-5 搜索/点选/Enter/Esc/手输不覆盖 | C1 第 5 条 + G4 第 2 条（手输值不被下次读取清空） | PASS |
| AC-6 失败显示 HTTP 状态 + 原文、不泄 key | C1 第 6 条（500 文案含状态码与 `boom`、长度 ≤340、不含 key 前 8 位与整串）；主进程 `clipFailureMessage` 在 `redactText` **之后**截断（`service.ts:149/281/285`） | PASS |
| AC-7 catalog/custom 不清 key 与模型 | C1 第 4 条 | PASS |
| AC-8 三档落盘 + withDefaults 不整份回退 | G4 第 4 条（切「高」落盘、重启后保留） | PASS |
| AC-9 4 协议 × 3 档单点映射 | C2 十行矩阵 + G2（`reasoning-map` / `ai-reasoning`） | PASS |
| AC-10 Anthropic 预算与 max_tokens | G2（`max_tokens = max(cfg, budget+1024)` 只抬本次请求、`temperature` 不发、入参 provider 不被改写）+ G4 第 5 条（主区顺序、高级区默认收起、UI 明说） | PASS |
| AC-11 不支持显示「已忽略」不隐藏 | C1 第 7 条（Ollama 默认时 `-unsupported` 可见且控件仍 enabled；换 OpenAI 后消失；无默认时 `-no-default`） | PASS |
| AC-12 既有行为/testid 不复归 | G5 全量 35 passed（含 `ai-assist` 命令确认、`theme-locale`、`ssh-terminal`、`vault-security`）；C5 190 条选择器 0 悬空；§3.4 可访问名全扫 6/6 | PASS |
| AC-13 双 locale + 只走 `--ts-*` | §3.4 新增面（en/zh 双向 + 裸 key 为 0）+ G2（`i18n-keys` / `theme-tokens` 契约） | PASS |
| AC-14 门禁四连 + 双主题截图 | G1~G5；截图 `docs/assets/ui-audit/after-ai-settings-r2-{dark,light}-{01-cards,02-editor}.png` 仍在，`docs/UI-AUDIT.md` 已记 | PASS |

## 五、架构与接口一致性（静态，逐条实际 grep/Read）

| 检查 | 命令/依据 | 结果 |
|---|---|---|
| 端点判定单点性 | `grep -rn "generativelanguage\|11434" src/main/ai/adapters.ts src/shared/reasoning.ts` | 主机名 1 处、端口 1 处，均在 `src/shared/reasoning.ts`；adapters 只调用 `isGeminiEndpoint` |
| 预算数字单点性 | `grep -rn "1024\|4096\|16384" src/main/ai/adapters.ts` | 仅 2 行**注释**，无第二份数字表 |
| 新 IPC 链路签名一致性 | renderer `api.ts:82` `call('ai:list-models', request)` → `src/shared/ipc.ts:144/247` 通道名与 `{request,response}` 类型 → `src/main/ai/ipc.ts:109` `handle('ai:list-models', …)`（带 `aiListModelsRequestSchema`）→ `service.ts:261 listModels(request): Promise<AiListModelsResult>` | 名称/形状逐层对齐；AC-4 探针已真实走通该链路（非存在性检查） |
| 重复实现/抽象缺失 | 本轮新增的 `e2e-selectors` 契约与 QA 的 `probe-testid-sweep.mjs` 判据重叠但不冲突（前者覆盖前缀、后者覆盖字面量），未产生第二套「安全/存储」类复制 | 未发现新的漂移实现 |
| 门禁自身判别力 | C4（7/7）与 C5 自检：把修复前形态喂进去必须判红 | 两个门禁都不是恒绿 |

## 六、缺陷表（只列**本轮仍未关闭**的缺陷）

未发现缺陷（P0 / P1 / P2 均为 0）。

### 6.1 轮次对照（同一缺陷类的复验结论；此表**不是**新的缺陷登记）

| 编号 | round-1 级 | round-2 级 | 复验结论 | 证据 |
|---|---|---|---|---|
| D-1 Gemini 端点判定双份 | P2 | 已关闭 | 常量下沉 `src/shared/reasoning.ts:62`，adapters 改调 `isGeminiEndpoint`，并有单测 + `defect-gates.mjs` 守卫 | §3.1 |
| D-2 AC-4 断言恒绿 | P2 | 已关闭 | 改用真实 testid + IPC 双重取证 + 反向对照；新增前缀对账契约测试 | §3.2 |

### 6.2 P3 观察项（不阻塞验收，供后续打磨；非缺陷登记）

| 编号 | 模块 | 观察 | 本轮状态 / 证据 |
|---|---|---|---|
| P3-1 | 思考强度映射 | `kind:'openai'` 且 Base URL 指本机 Ollama（11434）时仍判 `openai-effort`，会发 `reasoning_effort` 且 UI 不提示「已忽略」；走 `kind:'ollama'` 或「OpenAI 兼容 + 11434」则正确不发 | 仍在（C2 输出第 2 行 `{"mode":"openai-effort","reason":"openai"}`）；改点在 `src/shared/reasoning.ts` 的 `case 'openai'` 不看 baseUrl |
| P3-2 | 文案 | `settings.ai.reasoning.hint` 等 2 处仍把 `reasoning_effort` / `thinkingConfig` 写给终端用户 | 仍在（`grep -c` en=2 zh=2） |
| P3-3 | 既有 testid | 删除按钮 testid 由字面 `ai-provider-delete` 变为 `ai-provider-delete-{id}`（多卡必须唯一）；全仓无旧名消费者 | 仍在（`ProviderCard.tsx:526`）；C5 已证 190 条 e2e 选择器无悬空 |
| P3-4 | 文档一致性 | `TECHNICAL.md:107` 称「渲染层不再截断」，实际 `ProviderCard.tsx:155` 仍有 300 字兜底截断（纵深防御、无害）；`TECHNICAL.md:161` 把 `inputTestId` 默认值写成 `'ai-provider-models-combo'`，实际 `ModelCombobox.tsx:44` 是 `'ai-provider-model'` | 仍在（文档笔误，实现符合 AC-12） |
| P3-5 | 缺键检测的运行时出口 | `src/renderer/i18n/index.ts:77 missingKeyReport()` 无任何消费者；缺键机制本身有单测（`tests/contract/i18n-runtime.test.ts:105`），但真实界面缺裸 key 只能靠本轮 QA 的文本扫描兜底 | 本轮新观察（§3.4 的探针就是因为没有这个出口才改成扫 DOM 文本） |

## 七、提交面卫生（0c）

- `git status --porcelain --untracked-files=all | wc -l` → **46**；其中命中 `node_modules|out/|dist/|test-results/|logs/|.env|.idea|.DS_Store` 的行数 → **0**。
- `git ls-files | grep -cE "^(node_modules|out|dist|test-results|logs)/"` → **0**（这些目录从未入库）。
- `.gitignore` 关键行：`node_modules/`(1) `out/`(2) `dist/`(3) `test-results/`(17) `logs/`(25)。
- 结论：提交面干净，无依赖目录/产物/缓存/密钥噪声。

## 八、人工补测清单（环境限制，非交付缺陷）

| 项 | 验收标准 | 方法 / 工具 |
|---|---|---|
| 真外网供应商连通 | OpenAI / Anthropic / Gemini / Ollama 真实端点下三档强度均正常返回 | 人工填真 key 跑一轮；沙箱无外网与真 key，本机只验到 mock 报文层 |
| 屏幕阅读器 | combobox/listbox/option 与三档 radio 播报顺序正确、`ai-reasoning-effort-unsupported` 可被读出 | VoiceOver（macOS）+ Chromium AX 树（本轮已做 DOM 层可访问名全扫，但未做真实播报） |
| 浮层视觉遮挡与动画手感 | 深/浅两主题下浮层不被裁切、阴影不过重、滚动跟随不抖（脚本侧已证 portal + z=60 + 不越窗） | 人眼过 `docs/assets/ui-audit/after-ai-settings-r2-*.png` + 真机拖动 |
| 高 DPI / 200% 缩放 | 333px 内容列下省略号仍可用、操作组不被压缩 | 系统缩放 200% 或设备模拟（本轮已测 125% / 160% zoom） |
| 独立浏览器渲染 | — | **宿主沙箱禁 Chromium**（crashpad 需要 PROCESS_SET_INFORMATION 被拒），故全部 e2e 走 Electron 真机驱动；这是环境限制，不是交付缺陷 |

## 九、结论

- **可验收**：D-1 / D-2 两条 P2 均按原 Check command 复验通过并具备永久门禁（`tests/reasoning-map.test.ts` 单点守卫、`tests/contract/e2e-selectors.test.ts` 选择器对账、`scripts/dev/defect-gates.mjs` 判别力自检）。
- 门禁四连 + 全量 e2e 全绿：`typecheck 0` / `vitest 59 files 694 passed` / `build 0` / `playwright 35 passed`；两个 QA 自有探针组 7 + 2 passed，均带「反向对照 / 自检」以确保不是恒绿。
- 本轮把两个缺陷类**扩面**复核（字面量选择器 190 条、Ollama 端口判定），命中数均为 0 —— 说明修复是类级的，不是单点。
- 剩余 5 条 P3 观察项不阻塞；其中 P3-1（openai 类型指向 11434）与 P3-4（TECHNICAL 两处笔误）建议排进后续迭代。
- 复验回归入口（本 run 的 checker，宿主已归档）：
  - `pnpm exec playwright test --config=logs/teamflow/tf-mvuq80dp-d4kkc5/scripts/qa/playwright.qa.config.ts qa-ac-probe qa-round2-probe`
  - `node logs/teamflow/tf-mvuq80dp-d4kkc5/scripts/qa/probe-testid-sweep.mjs`
  - `node logs/teamflow/tf-mvuq80dp-d4kkc5/scripts/dev/defect-gates.mjs`
  - `node --experimental-strip-types logs/teamflow/tf-mvuq80dp-d4kkc5/scripts/qa/probe-reasoning-map.mts`
