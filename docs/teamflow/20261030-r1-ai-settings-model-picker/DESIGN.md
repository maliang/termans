<!-- meta: summary="AI 配置页重做设计：编辑态供应商列表折叠为一行、编辑器三段式（连接/模型/高级折叠）；模型由 datalist 换成 portal 浮层 combobox（搜索+键盘+手输逃生口，保留 ai-provider-model / aria-label 契约）；思考强度唯一可编辑控件在全局区、编辑器内只读回显；high+maxTokens 单次请求自动抬升并可见说明。" -->

基线依赖：docs/teamflow/20261030-r1-ai-settings-model-picker/PRD.md（AC-1～AC-12）

# DESIGN · AI 配置：填 key 即拉模型 + 三档默认思考强度

**标记约定**：`（修订）`= 改动既有实现；`（新增）`= 全新构件；未标注 = 沿用现状，不得顺手改。
**适用范围**：`src/renderer/theme/AiSettings.tsx` + `src/renderer/theme/theme.css` + `src/renderer/features/ai/ai.css` + `src/renderer/styles/tokens.css`（仅新增 1 个 token）。设置弹窗外壳、`.ts-btn` 语汇、其它三页设置不动。

---

## 0. 视觉与手感意图（先读本节，它决定实现像不像「成熟 agent 工作台」）

整体基调：**深色工作台 + 一条琥珀主行动**。琥珀 `--ts-accent` 是稀缺资源——整页只允许两处吃它：主按钮「保存」与当前选中态（`--ts-accent` 或其 16% 混色）。其余一切靠「表面层次 + 1px 描边 + 12/13px 字号阶梯」表达，不靠加粗、不靠彩色块。

### 0.1 表面处理（圆角 / 描边 / 阴影 / 层次）

| 构件 | 圆角 | 描边 | 背景 | 阴影 |
|---|---|---|---|---|
| 供应商卡片行（列表项） | `--ts-radius-sm` 6 | 1px `--ts-border`；hover → `--ts-border-strong` | 静止透明；hover `--ts-bg-elevated` | 无 |
| 选中的供应商行 | 6 | 1px `--ts-border-strong` + 左侧 **2px 实心 `--ts-accent`**（`border-left`，用 `padding-left:8px` 抵掉视觉位移） | `--ts-bg-elevated` | 无 |
| 编辑器容器 | `--ts-radius-md` 10 | 1px `--ts-border` | `--ts-bg-app` | 无（用底色下沉表达「表单在卡片里」，不要加阴影） |
| 输入框 / 选择器 / combobox 触发器 | 6 | 1px `--ts-border-strong` | `--ts-bg-app` | 无 |
| 模型下拉浮层（新增） | 10 | 1px `--ts-border-strong` | `--ts-bg-elevated` | `--ts-shadow-popover`（**新增 token**，见 §4.2） |
| 错误/警告信息条 | 6 | 1px 语义色（error）/ 3px 左边框（warning） | `--ts-bg-elevated` | 无 |
| 思考强度分段控件容器 | 6 | 1px `--ts-border-strong` | `--ts-bg-app` | 无 |

层次只有三档，**不许出现第四档**：`--ts-bg-app`（页底/输入框） < `--ts-bg-surface`（弹窗底） < `--ts-bg-elevated`（浮层/悬停/选中）。任何新构件先从这三档里挑，挑不出来再讨论加 token。

### 0.2 状态反馈（每一态都必须看得见）

- **hover**：描边升到 `--ts-border-strong` + 背景升一档，过渡 `var(--ts-motion-fast)`（120ms）`ease`。**禁止**用位移/放大做 hover。
- **active（按下）**：背景再深一档（`--ts-bg-app`）或 `filter: brightness(0.96)`，时长 0（即时），松手回 hover 态。禁止缩放。
- **focus-visible**：唯一真源是 `base.css` 的全局 `:focus-visible`（`1.5px` + `--ts-focus-ring-color`，offset `2px`）。输入类另有「描边转琥珀 70% + 1px 外描边」的既有规则（`theme.css` 的 `.ts-settings__input:focus-visible`），combobox 触发器必须**逐字复用**这条规则，不许自创第二套焦点观感。滚动容器内的行（下拉选项）用 `outline-offset: -2px`，否则环被 overflow 裁掉半圈。
- **disabled**：`opacity: 0.45` + `cursor: not-allowed`（继承 `.ts-btn`）。**被判据禁止**：未保存状态下的「读取模型」按钮不允许因为 `editingId === null` 而 disabled（AC-1 / 反面目标 1）。
- **loading**：按钮内图标换成 `Loader2` + `.ts-spin`（既有动画），文字保持原文案不变宽度；控件本身 `aria-busy="true"`。不做全屏遮罩、不改按钮宽度。
- **hit-flash**：无。桌面端不需要点击闪光。

### 0.3 动效与空态

- 下拉浮层：进入 `120ms` 透明度 0→1 + `translateY(-4px)→0`；退出 `90ms` 仅透明度。`@media (prefers-reduced-motion: reduce)` 下取消 translate，只留透明度。
- 高级区展开/收起：高度用 CSS `grid-template-rows: 0fr → 1fr`（或 max-height）+ `160ms ease`，chevron `rotate(90deg)` 同 120ms。不做回弹。
- 供应商列表折叠/展开：与高级区同一套（160ms），不做位移动画。
- **骨架不引入**：全应用没有 skeleton 语汇，模型读取只在按钮内转圈 + 一行文字 `正在读取模型…`（12px muted）。空态/错误态一律是**一行可执行的话**，不是插图、不是大片留白。

### 0.4 字号与排版角色

| 角色 | token | 值 | 用途 |
|---|---|---|---|
| 分区标题 | `--ts-font-size-sm` + `letter-spacing:.06em` + `text-transform:uppercase` + `--ts-text-secondary` | 12 | 既有 `.ts-settings__label`，**复用**，不新造 |
| 字段标签 | `--ts-font-size-sm` `--ts-text-secondary` | 12 | `.ts-field__label` |
| 输入值 | `--ts-font-size-base` `--ts-text-primary` | 13 | `.ts-settings__input` |
| 模型名 / key 尾4位 | `--ts-font-mono` `--ts-font-size-sm` | 12 | 标识符必须等宽、可逐字比对（`gpt-4.1-mini` vs `gpt-41-mini`） |
| 说明/hint | `--ts-font-size-sm` `--ts-text-muted` | 12 | 行高 1.45 |
| 徽标（默认/自定义/共 N 个） | `--ts-font-size-xs` + `--ts-font-weight-strong` | 11 / 600 | 高 18px，padding `0 6px`，圆角 6 |
| 数字（模型数量） | 同上，**禁止**做等宽对齐全角 | 11 | 单处出现，不需要 tabular |

字号阶梯只有 11 / 12 / 13 / 15 四档（`--ts-font-size-xs|sm|base|lg`）。**禁止**出现 10px 或 14px。

### 0.5 本产品明确禁止的形态（anti-patterns，逐条可肉眼判）

1. 用 `<datalist>` 当模型选择器（点不到、看不到「选中了哪个」、与预设清单混在一起）——AC-2 反面目标 2，必须删除 `list="ts-ai-provider-models"` 与 `<datalist>`。
2. 未保存时把「读取模型」置灰，或弹「请先保存这个供应商」。
3. 失败只显示「读取失败」四个字；或把 HTTP 状态码吞成「网络错误」。
4. 有任何一处出现 key 明文（提示、日志、toast、`title`、`aria-label`）——只允许尾 4 位。
5. 三档控制器用琥珀**实底**整条：会和「保存」抢主行动层级；正确做法见 §2.4。
6. 页面上出现**第二个可编辑**的思考强度控件（会造成「每个供应商一份」的误解，PRD 已把 per-provider 列为非目标）。
7. 高级区折叠后，把「温度/maxTokens」这两个已生效的值一起藏掉（折叠必须留一行摘要）。
8. 弹出层被对话框的滚动容器裁掉一截（必须 portal + 翻转，见 §3.3）。
9. 长错误原文不换行、不滚动，把 666px 的内容列撑出横向滚动条。
10. 新增 14px/10px 字号、第四档层次色、第二套焦点环、`box-shadow` 做卡片分层。

### 0.6 几何自洽校核（写死在规格里的数字必须真的放得下）

- 设置弹窗：宽 `min(880px, 100%)`，高固定 `--ts-dialog-max-h` = `min(80vh, 760px)`（`.ts-settings__panel` 已钉死）。左侧导航 `--ts-dialog-nav-width` 180，body padding `--ts-dialog-pad` 16，弹窗左右 border 各 1 → **内容列可用宽 = 880 − 2 − 180 − 32 = 666px**。所有横向尺寸以 666 为上限，最小可用按 520 校核（窄窗时弹窗 `100%` 收缩）。
- 模型浮层：`width = 触发器宽度`（本题即 666），`max-height 300`；内部 = 搜索行 32 + 上下 padding 4×2 + 8 行 × 32 = **296 ≤ 300** ✓，即「整 8 行可见，第 9 行起滚动」。
- 触发器右侧留白：`padding-right: 30px` = chevron 右偏 8 + 图标 14 + 内间隙 8 ✓，最长模型名（如 `anthropic/claude-sonnet-4-20250514`，30 字符 × ~7.2px ≈ 216px）在 666−10−30 的可用宽内不撞图标 ✓；超长一律 `text-overflow: ellipsis` + `title` 全名。
- 三档控件：3 段等分，每段宽 `(666−2)/3 ≈ 221`；英文最长标签 `Medium`（6 字 ≈ 42px）+ padding 24 = 66 ≪ 221 ✓；容器高 32 = `--ts-control-h`，段内文字垂直居中不需要额外高度预算。
- 错误信息条：`max-height: 120px` + `overflow:auto`；按 12px/1.45 行高（17.4）算可容纳 6 行以上，服务商原文超长时**内部滚动**，绝不撑高整页。
- 供应商卡片行：高 40，内 `padding: 0 10px`，名称 + 模型 + 尾4位 + 徽标四件在 666 内单行放不下时——名称 `flex:0 1 auto` 可省略，模型 `flex:1 1 auto` 省略，尾4位与徽标 `flex:none` **永不省略**（否则 AC-4 的「一眼可读」失效）。
- 编辑态首屏约束（可验收）：供应商列表折叠后，从弹窗顶到「读取模型」按钮底边的累计高度 ≤ 676px（760 − header 52 − pad 16×2 = 676）。

---

## 1. 页面与模块清单（信息架构）

设置 › AI 一页，纵向单列（**不做左右双栏**：内容列只有 666px，双栏会把模型下拉与错误原文同时压窄）。四个区块按「从全局到具体、从常用到调参」排列：

```
A0 开关与披露        enabled + 说明 + 安全披露（既有，位置不变）
A1 供应商           区块标题 + [+ 新建] + 卡片列表（空/载入/锁定/错误四态）
A2 供应商编辑器     展开条件：editingId !== null 或 providers.length === 0
   A2.1 基本信息     预设 / 类型 / 名称                      （位置修订：类型与预设并排在前）
   A2.2 连接         API key（+显隐+清除） / Base URL / [测试连接]
   A2.3 模型         [读取模型] + combobox + 计数 + 状态行    （核心新增）
   A2.4 思考强度     只读回显 + 该供应商适用性 + [调整默认强度]（新增，见 §2.4）
   A2.5 高级（折叠） 温度 / 最大 tokens / 自定义请求头
   A2.6 动作         保存(primary) / 取消 / 删除(danger,二次确认)
A3 全局默认          默认供应商 / 默认思考强度（唯一可编辑处）/ 上下文行数
```

**与现状的差异（修订点，逐条可 diff）**
1. 字段顺序从「预设→类型→名称→Base URL→模型→温度→maxTokens→key→自定义头→启用」改为 AC-10 顺序：**key 在模型之前**，温度/maxTokens/自定义头进高级折叠。
2. 供应商列表在**编辑态折叠为一行摘要**（新增行为）：`供应商（3）· 正在编辑 OpenAI` + 右侧 `[展开列表]`。理由见 §0.6 首屏约束——否则模型区必然落到折线以下，用户要滚一屏才看到「读取模型」，等于把主路径藏起来。
3. 「测试连接」从底部动作区移到 A2.2 连接组内、紧跟 API key（它的语义是「验证这组连接参数」，不是「提交表单」）。
4. 「启用」复选框原来在表单末尾，属于单个供应商的字段——**保持在编辑器内**（既有行为，不挪动，避免与 A0 的全局开关混淆）。

---

## 2. 线框（含状态）

### 2.1 列表态（未进入编辑）

```
┌ 设置 › AI ─────────────────────────────────────────── 880×760 ┐
│ nav │ [x] 启用 AI                                               │
│ 180 │ 说明：只有在你主动提问时才会调用供应商（12px muted）      │
│     │ ⚠ 披露条：命令写入终端前必须二次确认（3px 琥珀左边框）    │
│     │                                                          │
│     │ 供应商                                        [+ 新建]   │
│     │ 卡片列表（列表整体 max-height 200px 后滚动）             │
│     │ ┌──────────────────────────────────────────────────────┐│
│     │ │▌OpenAI    gpt-4.1-mini          ···a1b2  [默认]      ││ 40px
│     │ │ DeepSeek  deepseek-chat          ···9f3c              ││
│     │ │ Ollama    llama3.1:8b            (未设 key)  [已停用] ││
│     │ └──────────────────────────────────────────────────────┘│
│     │                                                          │
│     │ 默认供应商   [OpenAI · gpt-4.1-mini              ▾]      │
│     │ 默认思考强度 [ 低 ][ 中 ][ 高 ]        ← 唯一可编辑处     │
│     │              中等：平衡质量与延迟（推荐）                 │
│     │ 上下文行数   [ 200 ]  hint                              │
└──────────────────────────────────────────────────────────────┘
```

- 空态（`providers.length === 0`）：列表区不渲染，编辑器**自动展开**并聚焦「API key」（既有行为保留，AC-11）；A1 的 hint 改为一句「还没有供应商，先填一个 key」。
- 锁定态：列表区显示「请先解锁加密包」+ `[去解锁]`（既有），编辑器不渲染。
- 加载态：一行 `正在读取供应商…`。
- 错误态：`--ts-status-error` 左边框信息条 + 具体 detail（既有）。

### 2.2 编辑态（**主路径，本期重点**）

```
│ 供应商（3）· 正在编辑 OpenAI                        [展开列表] │ 32px，ghost
│ ╭ 编辑器 ────────────────────────────────────────────────────╮
│ │ 预设 [OpenAI ▾]        类型 [OpenAI ▾]                     │
│ │ 名称 [OpenAI                                             ] │
│ │                                                            │
│ │ API key  [••••••••••••••••••••••••••] [👁]  [测试连接]     │
│ │   已保存 ···a1b2（12px mono muted）／未保存时：key 存本地加密包 │
│ │                                                            │
│ │ 模型   [gpt-4.1-mini                        ▾] [读取模型]  │
│ │   已读取 12 个模型 · 点选或直接输入                         │
│ │                                                            │
│ │ 思考强度  中（全局）· 该供应商将自动适配        [调整默认强度]│
│ │                                                            │
│ │ ▸ 高级  温度 0.7 · 输出上限 2048                            │
│ │                                                            │
│ │                              [保存]  [取消]  [删除]        │
│ ╰────────────────────────────────────────────────────────────╯
```

- 「读取模型」按钮在 label 行右端（既有位置），**始终可用**，仅 `busy || fetchingModels` 时禁用；`title` 改为「从供应商读取可用模型（不需要先保存）」。
- 模型行的顺序：**先触发器、后按钮**？否——保持既有「按钮在 label 行、输入在下」的结构（e2e 与 label 契约都依赖它），只在输入行右侧新增内嵌按钮「▾」不必要，chevron 由控件自己画。
- 未读取过模型时：触发器右侧显示 `[读取模型]` 诱导线？不引入新控件，只把下方状态行写成 `点「读取模型」获取这家的可用清单，或直接输入模型名`。

### 2.3 模型下拉展开（新增的核心构件）

```
│ 模型   [gpt-4.1-mini                        ▾]  [读取模型]  │
│        ┌─────────────────────────────────────────────────┐  │ ← portal，浮在页面上，宽=触发器
│        │ 🔍 搜索模型…                                    │  │ 32px
│        ├─────────────────────────────────────────────────┤  │
│        │ gpt-4.1-mini                              ✓     │  │ 32px，当前值琥珀左竖条 2px
│        │ gpt-4.1                                        │  │ hover 背景 elevated
│        │ gpt-4o                                         │  │
│        │ o4-mini                                        │  │
│        │ …（整 8 行可见，其后滚动，滚动条 8px 细条）      │  │
│        ├─────────────────────────────────────────────────┤  │
│        │ 共 12 个模型                      12px muted     │  │ 可选页脚，仅 >8 行时出现
│        └─────────────────────────────────────────────────┘  │
```

状态矩阵（模型区，逐条都要实现）：

| 状态 | 触发器 | 状态行（12px） | 下拉 |
|---|---|---|---|
| 初始（未读取） | 可输入 | `点「读取模型」获取这家的可用清单，或直接输入模型名` muted | 不打开 |
| 读取中 | disabled 外观 + 右侧 spinner | `正在读取 OpenAI 的模型…` | 不打开 |
| 成功 N>0 | 正常；chevron 有「可展开」观感 | `已读取 12 个模型 · 点选或直接输入` | 整 8 行 |
| 成功 N=0 | 正常 | `供应商返回空列表：请确认 Base URL 指向兼容端点`（**warning 色**） | 打开显示「没有可选项」 |
| 失败 | 正常（可重试） | 错误条：`HTTP 401 · invalid_api_key: Incorrect API key provided` + `[重试]` | 不打开 |
| key 未填 | 正常（不预判） | 灰色提示行不变；点击后主进程返回具体错误 | 不打开 |
| vault 锁定 | 正常 | `请先解锁加密包`（不是「读取失败」） | 不打开 |
| 手输值 ∉ 列表 | 正常，值右侧显示 `自定义` 徽标（11px，6px 圆角，`--ts-border-strong` 描边） | `自定义模型：不会被下一次读取清空` | 打开时列表照常，当前值不匹配任何行 |

### 2.4 思考强度（全局唯一可编辑处在 A3；编辑器内只读回显）

**A3 的可编辑件（新增）**

```
默认思考强度
[ 低 ] [ 中 ] [ 高 ]                    ← 32px 高，3 段等分，容器 1px 描边
中等：平衡质量与延迟（推荐）             ← 12px muted，跟随选中档切换文案
该供应商可能不支持思考参数，本次不会发送   ← 仅当 kind 属于「未知兼容端点」白名单时出现（琥珀 warning 色）
```

- 选中段：`background: color-mix(in srgb, var(--ts-accent) 16%, var(--ts-bg-app))`、文字 `--ts-text-primary` + 600、`box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ts-accent) 55%, transparent)`。未选中段：透明底 + `--ts-text-secondary`，hover 背景 `--ts-bg-elevated`。
- 段间分隔：1px `--ts-border`（用 `border-right` + 最后一段 `:last-child` 去掉）。**不做**滑动指示块（动效收益低于实现风险）。
- 三档文案（i18n）：低「更快、更省」／中「平衡质量与延迟（推荐）」／高「更深推理，更慢更贵」。
- **Ollama**：整组仍可点（这是全局设置），下方追加一行 `本地模型（Ollama）不发送推理参数，此档位对它不生效`。
- **未知兼容端点**：追加 `该供应商可能不支持思考参数，本次不会发送`（PRD Q1 推荐策略的 UI 落点）。

**编辑器 A2.4 的只读回显（新增）**

```
思考强度  中（全局）· 该供应商将自动适配          [调整默认强度] →
```

- 只有一行 32px：左侧 12px `--ts-text-secondary` 标签 + 中间当前档位文本（`--ts-text-primary`）+ 右侧 ghost 按钮。
- 点击 `[调整默认强度]` → 平滑滚动到 A3 并把焦点移到当前选中的那一段（`scrollIntoView({block:'center'})` + `focus({preventScroll:true})`）。
- **为什么不做第二个可编辑控件**（写清理由，避免下游"补回来"）：① 编辑器是「保存/取消」式表单，而思考强度是点即写盘的全局设置，混在里面会让用户以为「取消」能回滚它；② 两个可编辑实例必然被理解成 per-provider 配置，而 PRD 明确把它列为非目标。AC-10 要求的「该位置出现思考强度（含适用性提示）」由本行满足。
- Ollama 时本行文案：`中（全局）· 本地模型不发送推理参数`。

### 2.5 高级区（默认折叠，新增）

```
▸ 高级   温度 0.7 · 输出上限 2048            ← 折叠摘要：两个已生效值必须可见
───────── 展开后 ─────────
温度 [0.7]        输出上限 [2048]            ← 两列，间距 14（.ts-settings__grid2）
自定义请求头
[{"api-version": "2024-10-01"}          ]    ← textarea，mono，3 行
每行一个 JSON 对象；Azure 类托管在此填 api-version
⚠ 「高」档需要 ≥16768 的输出上限：单次请求会自动抬到 16768，不修改你保存的 2048
```

- 折叠头：整行可点 `<button type="button" aria-expanded>`，高 32，ghost 语汇（无边框），左 chevron 14 + 标签 12px + 摘要 12px muted（`·` 分隔）。
- 摘要取值：`温度 {temperature} · 输出上限 {maxTokens}`，数字直接来自表单草稿（未保存也显示）。
- 冲突提示条（AC-7 的 UI 落点）：条件 `(kind === 'anthropic' || gemini 原生) && effort === 'high' && Number(maxTokens) < 16768`。用既有 `.ts-settings__warning` 样式（3px 琥珀左边框），**信息级不是错误级**；文案必须写「不修改你保存的值」，否则用户会怀疑被偷偷改了。
- 高级区展开状态**不持久化**（每次进编辑器都折叠）。

---

## 3. 交互与动效细节

### 3.1 主路径（首次配置，7 步，步数与 PRD §5 对齐）

1. `[+ 新建]` → 编辑器展开，预设默认 OpenAI，类型/Base URL 自动带出，焦点落「API key」。
2. 填 key（`type=password`，可切明文；**保存成功后清空本地 state**，只留尾 4 位）。
3. 点「读取模型」→ 按钮转圈禁用，状态行 `正在读取 OpenAI 的模型…`（**不写盘**）。
4. 成功 → 状态行 `已读取 12 个模型 · 点选或直接输入`，自动**展开下拉一次**（用户刚点按钮就是要看清单，省一次点击；这是唯一允许自动打开的场景），焦点仍在触发器。
5. 点选 → 触发器写入值、下拉关闭、焦点回触发器、`aria-live` 播报 `已选择 gpt-4.1-mini`。
6. 思考强度（A3 或点 `[调整默认强度]`）→ 点即写盘，控件旁 1.5s 出 `已保存` 微提示（`role="status"`），失败则错误条。
7. `[保存]` → 落库；第一个供应商自动成为默认供应商（既有），列表从折叠恢复展开。

### 3.2 失败分支（文案直接写进 i18n，不许运行时拼英文）

| 情况 | 呈现 |
|---|---|
| 401 / 403 | 信息条：`HTTP 401 · <服务商 message 首 200 字>` + 第二行 `检查 key 是否正确或已过期` + `[重试]` |
| 404 | `HTTP 404 · <message>` + `Base URL 可能缺 /v1，检查是否指向兼容端点` |
| 空列表 | 警告行：`供应商返回空列表：请确认 Base URL 指向兼容端点`（不是 toast） |
| 超时 | `请求超时（15s）· 检查网络或代理` + `[重试]` |
| 非 JSON / 网关 HTML | `网关返回的不是 JSON（HTTP 200）· 可能是登录页或反代错误页` |
| vault 未解锁 | `请先解锁加密包`（不带「读取失败」） |
| 保存校验失败 | 定位到字段：`Base URL 不是合法 URL` 显示在该字段下方 `.ts-field__error` + `aria-invalid="true"`；`模型` 为空同理；顶部不再出现笼统「保存失败」 |

- 错误条统一用**已存在**的 `.ts-ai-form__message.is-error`，但补两条：`max-height:120px; overflow:auto;`（长原文内部滚动）与 `word-break: break-word`（长 token 不撑宽）。
- **key 脱敏硬约束**：错误条与日志中的 key 只允许 `···` + 后 4 位；服务商 message 里若回显 key，前端再兜一层正则替换（`sk-[A-Za-z0-9]{8,}` → `sk-···`）。这条要写进单测（AC-3）。

### 3.3 combobox 行为（ARIA 1.2 组合框，手写，不引库）

- **定位**：浮层 `createPortal` 到 `document.body`，`position: fixed`，坐标由触发器 `getBoundingClientRect()` 计算。原因必须写进注释：`.ts-dialog__body` 是 `overflow:auto` 的滚动容器，绝对定位的浮层会在容器边缘被裁掉一半。
- **翻转**：浮层下方空间 `< 320` 且上方空间更大 → 向上开（`bottom = viewportH − rect.top + 4`）。
- **跟随**：`window` 的 `scroll`（capture）+ `resize` 时重算一次；滚动容器滚动时若触发器移出视口则关闭。
- **触发器**：`<input role="combobox" aria-expanded aria-controls="ts-ai-model-list" aria-activedescendant aria-autocomplete="list" autocomplete="off" spellcheck="false" data-testid="ai-provider-model" aria-label={t('ai:provider.field.model')}>`。
  ⚠ 契约：`data-testid="ai-provider-model"` 与显式 `aria-label` **必须保留**（label 里塞了「读取模型」按钮，靠包裹 label 的可访问名就不再是纯「模型」，e2e 的 `getByLabel('模型', {exact:true})` 会超时；`data-testid="ai-provider-models-fetch"` 同理必须保留）。
- **键盘**：`↓`/`Alt+↓` 打开并高亮首项；`↑` 打开并高亮末项；列表内 `↑↓` 移动（`aria-activedescendant`）、`Home/End`、`Enter` 选中并关闭、`Esc` 关闭且值回滚到打开前的值、`Tab` 关闭并保留当前高亮项、连续字符即过滤（搜索框与输入框共用一个输入——**输入即过滤**，不额外给搜索框抢焦点；浮层顶部保留静态的「搜索模型…」占位行仅在值非空时作为过滤说明，避免两个输入框互相抢焦点）。
- **点击外部**关闭（`pointerdown` 捕获，判断 `!panel.contains(target) && !trigger.contains(target)`）。
- **空结果**：一行 `没有匹配的模型 · 回车使用「<输入值>」作为自定义模型`。
- **滚动条**：`scrollbar-width: thin`，浮层内不出现横向滚动。

### 3.4 供应商列表折叠（新增行为）

- 进入编辑（新建或点某行）时，列表收为一行 32px 摘要；点击摘要右侧 `[展开列表]` 恢复（点击某行则切换编辑对象并保持折叠）。
- 折叠/展开不改变 `data-testid`：行元素 `ai-provider-item-<id>`、默认徽标 `ai-provider-default-badge` 必须仍在 DOM 中（折叠是 `hidden` 属性或条件渲染二选一，**要求 e2e 可达**——若用条件渲染，展开后才可见，e2e 必须先点展开；此处选择**保留 DOM + `hidden`**，避免既有 e2e 大面积失效）。

---

## 4. 视觉规格（全部复用 token，只加 1 个）

### 4.1 复用表（不许写死数值）

| 用途 | token / 值 |
|---|---|
| 间距 | `--ts-space-1..6` = 4/8/12/16/24/32；字段内 label→控件 8；同组字段间 12；组间 20（沿用 `.ts-settings__section` 的 18 或 20，二选一，全页统一） |
| 控件高 | `--ts-control-h` 32（输入/选择/combobox/分段控件/折叠头）；`--ts-control-h-sm` 28（ghost 小按钮、图标按钮） |
| 圆角 | `--ts-radius-sm` 6（输入/按钮/卡片行）、`--ts-radius-md` 10（编辑器容器/浮层） |
| 颜色 | `--ts-bg-app` / `--ts-bg-surface` / `--ts-bg-elevated`；`--ts-border` / `--ts-border-strong`；`--ts-text-primary` / `secondary` / `muted`；`--ts-accent`（仅选中态与主按钮）；`--ts-status-error` / `warn` / `ok` |
| 字体 | `--ts-font-ui`（正文）/ `--ts-font-mono`（模型名、key 尾4位、请求头 JSON） |
| 动效 | `--ts-motion-fast` 120ms ease |

### 4.2 唯一新增 token：`--ts-shadow-popover`

在 `src/renderer/styles/tokens.css` 的**两个主题块**各写一次（暗/亮必须分开，不能靠一个值通吃）：

```css
/* 暗色块 */
--ts-shadow-popover: 0 12px 32px rgba(0, 0, 0, 0.55);
/* 亮色块 */
--ts-shadow-popover: 0 12px 28px rgba(16, 24, 40, 0.16);
```

- **不复用 `--ts-dialog-shadow`**：它的颜色是 `--ts-bg-overlay`，亮色主题下是 `rgba(247,248,251,.82)`，给浮层会变成一圈白色泛光。
- 组件侧只写 `box-shadow: var(--ts-shadow-popover)`；`theme.css` 的「no bare colors」契约测试覆盖组件文件，hex 只出现在 tokens.css。

### 4.3 新增 class 命名（与既有 BEM 一致，便于 QA 锚点）

```
.ts-ai-model-combo            触发器容器（position: relative）
.ts-ai-model-combo__panel     浮层（portal 内）
.ts-ai-model-combo__option    单行（[aria-selected=true] 样式）
.ts-ai-model-combo__status    状态行
.ts-ai-effort                 三档分段容器
.ts-ai-effort__seg            单段（[aria-checked=true] 样式）
.ts-ai-effort__caption        档位说明
.ts-ai-advanced               折叠容器 / __head / __summary
.ts-ai-provider-row--editing  选中行
.ts-ai-provider-summary       折叠后的一行摘要
```

不新增 `data-testid` 之外的既有 testid 改名；新增的 testid 建议：`ai-provider-models-combo`、`ai-model-option-<model>`、`ai-reasoning-effort`、`ai-reasoning-effort-low|medium|high`、`ai-advanced-toggle`、`ai-providers-collapse`。

### 4.4 i18n 键（en / zh-CN 同步，AC-12）

| namespace | key | zh-CN 参考 |
|---|---|---|
| `ai` | `provider.models.fetch` | 读取模型 |
| `ai` | `provider.models.count` | 已读取 {{count}} 个模型 · 点选或直接输入 |
| `ai` | `provider.models.loading` | 正在读取 {{name}} 的模型… |
| `ai` | `provider.models.empty` | 供应商返回空列表：请确认 Base URL 指向兼容端点 |
| `ai` | `provider.models.custom` | 自定义 |
| `ai` | `provider.models.searchPlaceholder` | 搜索模型… |
| `ai` | `provider.models.noMatch` | 没有匹配的模型 · 回车使用「{{value}}」 |
| `ai` | `provider.models.error.http` | HTTP {{status}} · {{message}} |
| `ai` | `provider.models.error.timeout` | 请求超时（{{seconds}}s）· 检查网络或代理 |
| `ai` | `provider.advanced.title` / `.summary` | 高级 / 温度 {{t}} · 输出上限 {{n}} |
| `settings` | `ai.reasoningEffort.label` | 默认思考强度 |
| `settings` | `ai.reasoningEffort.low` / `.medium` / `.high` | 低 / 中 / 高 |
| `settings` | `ai.reasoningEffort.caption.low` / `.medium` / `.high` | 更快、更省 / 平衡质量与延迟（推荐）/ 更深推理，更慢更贵 |
| `settings` | `ai.reasoningEffort.ollamaNote` | 本地模型不发送推理参数，此档位对它不生效 |
| `settings` | `ai.reasoningEffort.unknownKindNote` | 该供应商可能不支持思考参数，本次不会发送 |
| `settings` | `ai.reasoningEffort.budgetNote` | 「高」档需要 ≥{{min}} 的输出上限：单次请求会自动抬到 {{min}}，不修改你保存的 {{current}} |

---

## 5. 无障碍要点（实现级）

1. **键盘全可达**：key 字段 → 「测试连接」→「读取模型」→ 模型触发器 →（↓ 全列表）→ 「调整默认强度」→ 高级头 → 保存/取消/删除，全部可用 Tab + Enter/空格完成；打开浮层后焦点**不离开触发器**（`aria-activedescendant` 模式）。
2. **语义**：模型浮层 `role="listbox"` + `aria-multiselectable="false"`，每行 `role="option"` + `aria-selected`；三档控件用 `role="radiogroup"` + `role="radio"` + `aria-checked`（比 `<input type=radio>` 更省样式，但必须自己实现方向键切换：←→ 在档位间移动并即时写盘）。
3. **播报**：读取结果/选择结果/保存结果用 `role="status" aria-live="polite"`（不打断）；错误条 `role="alert"`（打断一次，且只在变为错误时更新，不要每次渲染都重播——用稳定 key）。
4. **焦点环**：一律继承全局 `:focus-visible`；浮层内选项 `outline-offset:-2px`；三档段内 `outline-offset:-2px`（段贴边）。
5. **可访问名**：模型 input 保留显式 `aria-label`（见 §3.3）；图标按钮（`👁`、`[读取模型]` 的 spinner 态）必须有 `title` + `aria-label` 或 `aria-hidden`；`Loader2` 一律 `aria-hidden="true"`。
6. **对比度**：正文 13px 用 `--ts-text-primary`（暗色 #e8edf7 on #05080e ≈ 15:1）；说明文字用 `--ts-text-muted`（≥4.5:1）；**禁止**用 `--ts-text-muted` 承载唯一的关键结论（如「共 N 个模型」可以，但「key 无效」必须 `--ts-status-error`）。
7. **拖拽区**：本页在 `.ts-dialog` 内，弹窗已声明 `-webkit-app-region: no-drag`，无需 portal 规避拖拽热区；但浮层仍必须 portal（滚动裁切问题）。若未来把 combobox 放进标题栏/页签条，必须同时 `no-drag` 或 portal。
8. **减少动效**：`prefers-reduced-motion: reduce` 下取消所有 translate/rotate，只保留透明度渐变。

---

## 6. AC → 设计落点对照（给 dev / QA 的检查表）

| AC | 设计落点 |
|---|---|
| AC-1 | §2.2「读取模型」始终可用；§0.2 disabled 禁用规则 |
| AC-2 | §2.3 combobox（可搜索、点选、计数、手输逃生口、`自定义` 徽标）；§0.5-1 删除 datalist |
| AC-3 | §3.2 错误文案表 + 内部滚动 + key 脱敏 |
| AC-4 | §0.6 供应商卡片行「尾4位与徽标永不省略」；§3.2 保存校验字段级定位 |
| AC-5 | §2.4 A3 三档控件（写盘即时、`role=status` 微提示） |
| AC-6 | §2.4 三档文案 + §3.3 无原始参数名暴露；Ollama / 未知端点说明行 |
| AC-7 | §2.5 冲突提示条（自动抬升 + 「不修改你保存的值」） |
| AC-10 | §1 四区块顺序 + §2.2 编辑器内字段顺序 + §2.5 高级折叠 |
| AC-11 | §2.1 空态自动展开、只填 key 即可点读取 |
| AC-12 | §4.4 i18n 键表 |

**设计侧未决（交 tech 决定，不影响本文件其余规格）**
- 模型列表是否缓存到渲染层 state：建议**只在当前编辑器会话内保留**（关闭编辑器即丢弃），避免「保存后打开又是原来那几个」的错觉；不落盘。
- 「最近使用」排序（PRD P2）：本期不做，浮层顺序**原样保持服务商返回顺序**（用户可搜索），不做字母排序——排序会让人以为列表变了。
