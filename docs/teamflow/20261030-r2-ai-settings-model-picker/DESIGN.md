<!-- meta: summary="设置→AI 改为单列供应商卡片：卡片行六项摘要（名称/模型/key 尾4位/默认徽标/凭据圆点/行尾操作）+ 卡片内联展开编辑；新增卡片走 catalog/custom 双模式；模型为 portal 可搜索组合框并保留手输；全局三档思考强度置于卡片区上方（唯一可编辑处），卡片内只读回显「跟随全局」；Anthropic max_tokens 抬升与不发 temperature 在编辑器内明说。" -->

基线依赖：docs/teamflow/20261030-r1-ai-settings-model-picker/DESIGN.md（视觉基调、combobox ARIA 行为、三档控件语义、i18n 命名沿用）
取代：docs/teamflow/20261030-r1-ai-settings-model-picker/DESIGN.md#1 的「A1 折叠列表 + A2 单栏编辑器」形态 —— 改为**单列卡片 + 卡片行内联展开**；与本需求 PRD 对 r1 AC-10 / AC-11 的取代条款配套（历史文件夹不改动）。

# DESIGN · 设置 → AI：单列供应商卡片（草稿读模型 + 全局三档思考强度）

**标记约定**：`（修订）`= 改既有实现；`（新增）`= 全新构件；未标注 = 沿用现状，不得顺手改。
**落点**：`src/renderer/theme/AiSettings.tsx`（重排）、`src/renderer/features/ai/ai.css`（卡片 / 编辑区 / 目录 tile）、`src/renderer/theme/theme.css`（思考强度分段控件、行尾图标按钮）、`src/renderer/styles/tokens.css`（仅新增 1 个 token）、`src/locales/{en,zh-CN}/{ai,settings}.json`。设置弹窗外壳、`.ts-btn` 语汇、其余三页设置**不动**。

---

## 0. 视觉与手感意图（先读本节；它决定「像不像成熟 agent 工作台」）

基调：**深色工作台 + 一条琥珀主行动 + 卡片承载「对象」**。琥珀是稀缺资源——本页只允许三处吃它：主按钮「保存」、当前选中/展开卡的左侧 2px 竖条、模型浮层的选中行底色。其余一切靠「表面层次 + 1px 描边 + 11/12/13 字号阶梯」表达，不靠加粗、不靠彩色块。

### 0.1 表面处理（圆角 / 描边 / 背景 / 阴影）

| 构件 | 圆角 | 描边 | 背景 | 阴影 |
|---|---|---|---|---|
| 供应商卡片（收拢） | `--ts-radius-md` 10 | 1px `--ts-border`；hover → `--ts-border-strong` | `color-mix(in srgb, var(--ts-bg-elevated) 55%, transparent)`；hover 100% | 无 |
| 供应商卡片（展开中） | 10 | 1px `--ts-border-strong` + 左侧 **2px 实心 `--ts-accent`**（`border-left`，`padding-left` 减 2 抵掉视觉位移） | `--ts-bg-elevated` | 无 |
| 卡片行（摘要行） | 由卡片裁切 | 无 | 透明 | 无 |
| 卡片内编辑区（新增） | `0 0 10 10` | 仅 1px 上边 `--ts-border` | `--ts-bg-app`（下沉一档，表达「表单在卡里」） | 无 |
| 输入框 / select / combobox 触发器 / textarea | `--ts-radius-sm` 6 | 1px `--ts-border-strong` | `--ts-bg-app` | 无 |
| 行尾图标按钮（26×26） | 6 | 透明；hover 1px `--ts-border-strong` | 透明；hover `--ts-bg-app` | 无 |
| 模型浮层（新增） | 10 | 1px `--ts-border-strong` | `--ts-bg-elevated` | `--ts-shadow-popover`（**新增 token**，见 §4.2） |
| 浮层选中/悬停行 | 6 | 无 | 选中 `color-mix(in srgb, var(--ts-accent) 16%, transparent)`；悬停 `--ts-bg-app` | 无 |
| 目录选择 tile（新增） | 6 | 1px `--ts-border`；hover `--ts-border-strong`；选中 1px `--ts-accent` | 透明；hover `--ts-bg-app`；选中 `--ts-bg-app` | 无 |
| 三档分段控件（新增） | 6 | 1px `--ts-border-strong` | `--ts-bg-app`；选中段 `--ts-bg-elevated` + 1px `--ts-accent` | 无 |
| 「默认」徽标 | 6 | 1px `--ts-border-strong` | 透明 | 无 |
| 错误信息条 | 6 | 1px `--ts-status-error` | `--ts-bg-elevated` | 无 |
| 警告 / 说明条 | 6 | **3px 左边** `--ts-status-warn` | `--ts-bg-elevated` | 无 |

层次只有三档，**不许出现第四档**：`--ts-bg-app`（页底 / 输入框 / 编辑区） < `--ts-bg-surface`（弹窗底） < `--ts-bg-elevated`（卡片 / 浮层 / 悬停 / 选中）。卡片静止态用「elevated 55% 混透明」而不是新颜色——深色下是微亮卡片、浅色下是微灰卡片，一套值跨两套主题成立。

### 0.2 状态反馈（每一态都必须看得见）

- **hover（卡片）**：描边 `--ts-border` → `--ts-border-strong`，背景 55% → 100%，`transition: background var(--ts-motion-fast) ease, border-color var(--ts-motion-fast) ease`（120ms）。**禁止**位移 / 放大 / 阴影加深。
- **hover（行尾图标按钮）**：背景 `transparent` → `--ts-bg-app`、图标色 `--ts-text-secondary` → `--ts-text-primary`，120ms。鼠标移入按钮**不得**同时触发卡片 hover（按钮自带背景，视觉上已分区）。
- **active（按下）**：`filter: brightness(0.96)`，时长 0，松手回 hover。禁止缩放。
- **focus-visible**：唯一真源是 `base.css` 全局规则（1.5px `--ts-focus-ring-color`，offset 2px）；输入类逐字复用 `theme.css` 的 `.ts-settings__input:focus-visible`（描边转琥珀 70% + 1px 外描边）。卡片摘要按钮与浮层选项在容器内贴边，用 `outline-offset: -2px` 防止被裁。
- **expanded（展开中）**：左侧 2px 琥珀条 + 背景满档 + 摘要行右侧箭头图标 `ChevronDown` `rotate(180deg)`（120ms）。
- **disabled**：`opacity: 0.45` + `cursor: not-allowed`（继承 `.ts-btn`）。**被判据禁止**：未保存（新增）状态下的「读取模型」不得 disabled（AC-4）。
- **loading**：「读取模型」按钮内图标换 `Loader2` + `.ts-spin`，文字与宽度不变，按钮 `aria-busy="true"`；下方状态行 `正在读取模型…`（12px muted）。不做全屏遮罩、不引 skeleton（全应用没有 skeleton 语汇）。
- **hit-flash**：无。桌面端不需要点击闪光。

### 0.3 动效与空态

- 卡片展开 / 收起：容器 `display: grid; grid-template-rows: 0fr → 1fr`，内层 `min-height: 0; overflow: hidden`，`160ms ease`；chevron `rotate` 120ms。**不做回弹、不做位移动画**。
- 高级区展开 / 收起：同上（160ms）。
- 模型浮层：进入 `120ms` 透明度 0→1 + `translateY(-4px) → 0`；退出 `90ms` 仅透明度。`@media (prefers-reduced-motion: reduce)`：取消所有 translate/rotate，只留透明度。
- 每次只允许一张卡展开（AC-3）：切换展开时**不做交叉淡入**，前一张直接收起、后一张展开（同时进行，总时长 160ms）。
- **空态**：不出现插图 / 大片留白 / 「暂无数据」。供应商为空时，卡片区直接渲染一张**已展开的新增卡片**（`catalog` 模式），并在标题旁保留「+ 新增」。错误态与空态一律是**一行可执行的话**（例：「还没配置供应商 · 从下面选一个，填上 API key 就能读取模型」）。
- 模型读取失败：错误条从 0 高度展开到内容高度（120ms），`role="alert"`。

### 0.4 字号与排版角色

| 角色 | token | 值 | 用途 |
|---|---|---|---|
| 分区标题（供应商 / 全局） | `--ts-font-size-sm` + `letter-spacing .06em` + `text-transform uppercase` + `--ts-text-secondary` | 12 | 复用既有 `.ts-settings__label`，**不新造** |
| 卡片供应商名 | `--ts-font-size-base` + `--ts-font-weight-strong` | 13 / 600 | 唯一允许 600 的正文——它是卡片标题 |
| 模型名 / key 尾 4 位 / Base URL / 请求头 | `--ts-font-mono` + `--ts-font-size-sm` | 12 | 标识符必须等宽可逐字比对（`gpt-4.1-mini` vs `gpt-41-mini`） |
| 字段标签 | `--ts-font-size-sm` + `--ts-text-secondary` | 12 | 复用 `.ts-field__label` |
| 输入值 | `--ts-font-size-base` + `--ts-text-primary` | 13 | `.ts-settings__input` |
| 说明 / hint / 状态行 | `--ts-font-size-sm` + `--ts-text-muted` + 行高 1.45 | 12 | |
| 徽标（默认 / 协议 / 共 N 个） | `--ts-font-size-xs` + `--ts-font-weight-strong`，高 18，padding `0 6px` | 11 / 600 | 圆角 6 |
| 三档标签 | `--ts-font-size-base` | 13 | 低 / 中 / 高 |

字号阶梯只有 **11 / 12 / 13 / 15** 四档（`--ts-font-size-xs|sm|base|lg`）。**禁止** 10px / 14px。数字不做 tabular 对齐（本页无列对齐的数字列）。

### 0.5 本产品明确禁止的形态（anti-patterns，逐条可肉眼判）

1. 左右分栏（左供应商 / 右详情）：内容列只有 666px，双栏每栏 < 330px，六项摘要必然折行 → 与 AC-1 冲突。
2. 编辑用弹窗 / 抽屉 / 右侧栏 / `window.confirm`：必须是卡片内联展开。
3. 卡片行只显示名称：模型、key 尾 4 位、默认徽标必须**不点开就看得见**（反面目标 1）。
4. 未保存时把「读取模型」置灰，或提示「请先保存这个供应商」。
5. 失败只显示「读取失败」；或把 HTTP 状态码吞成「网络错误」；或把服务商原文做成 `title` 属性（点不到、摸不着）。
6. 任何一处出现 key 明文（提示、错误条、`title`、`aria-label`、DOM 文本）——只允许尾 4 位。服务商 message 里可能回显 `sk-…` 前缀，**必须脱敏后再渲染**。
7. 三档控件用琥珀**实底**整条（会和「保存」抢主行动）；正确形态见 §2.5。
8. 出现**第二个可编辑**的思考强度控件（per-provider 是本轮非目标）；卡片内只允许只读回显 + 「去顶部修改」链接。
9. 错误的 markdown：用卡片行内的 `overflow: visible` 让长错误原文把 666px 撑出横向滚动条。
10. 为「像 DSH」而改 testid / label 可访问名；或新增 14px/10px 字号、第四档层次色、第二套焦点环、用 `box-shadow` 做卡片分层。

### 0.6 几何自洽校核（写死在规格里的数字必须真的放得下）

- 内容列可用宽 **666px** = `--ts-dialog-width-lg` 880 − 弹窗左右 border 2 − 导航 `--ts-dialog-nav-width` 180 − body padding `--ts-dialog-pad` 16×2。`max-width: 720px`（AC-2）是上限声明，**实际瓶颈是 666**，一切预算按 666 算；窄窗按 **520px** 复核（弹窗宽 `min(880, 100%)`）。
- 卡片内宽 **648** = 666 − border 2 − `padding: 0 10px` 左右各 8（右 6）。
- 卡片行高 **44** = 图标按钮 26 + 上下 padding 8×2 + 2（视觉余量）；摘要行 `min-height: 44`，展开后不变高。
- 六项横向预算（最坏值）：圆点槽 15 + 间隙 10 + **名称 ≤160**（省略） + 间隙 10 + **模型弹性** + 间隙 10 + key 尾 ≤96 + 间隙 8 + 徽标 36 + 间隙 10 + 行尾操作 92（3×26 + 2×7 间隙）＝**固定项 277**；648 − 277 = **371 留给「名称 + 模型」**。名称取上限 160 时模型仍得 211px（≈27 个等宽字符，`anthropic/claude-sonnet-4-20250514` 显示到 `…20250514` 之前就被省略并带 `title` 全名）✓。
- 窄窗 520：内宽 498 − 277 = 221，名称压到 60（省略）、模型 161（≈20 字符）；因为六个文本节点全部 `min-width: 0 + overflow: hidden + text-overflow: ellipsis + white-space: nowrap`，**任何宽度下都不产生横向滚动**（AC-2 的结构性保证，不靠调数值）。
- 模型浮层：宽 = 触发器实测宽（666 卡片内编辑区 636，`min-width: 320`），高 = 搜索行 32 + 8 行 × 32 + padding 4×2 = **296 ≤ `max-height: 300`** ✓（第 9 行起滚动）。
- 三档分段控件：3 段 × **84** = 252 宽、高 32（`--ts-control-h`）；段内最宽标签「中」13px，居中不需额外预算。
- 目录 tile：2 列，每列 (648 − 8)/2 = **320**，tile 高 **56**（品牌名 18 + URL 16 + padding 20 + 2）；11 个预设 = 6 行 → 容器 `max-height: 264` 恰好容纳 4 行（4×56 + 3×8 = 248）+ 16 余量，其余内部滚动 ✓。
- 错误条：`max-width` 由容器约束，`max-height: 120` + `overflow: auto`；中文 12px/1.45（17.4/行）在 636 内约 53 字/行 → 300 字截断上限 ≈ 6 行 = 104.4px **≤ 120** ✓，永不撑高整页、永不换行溢出。
- 首屏约束（可验收）：弹窗高 `min(80vh, 760)`，body 可视 ≈ 760 − header 52 − padding 32 = **676**。A0（开关 + 说明 + 披露）≈100 + A1（思考强度行 + 说明）≈104 + A2 标题与「+ 新增」行 40 + 第一张卡收拢 44 ＝ 288；展开后编辑区 padding 12 + key 字段 56 + 模型区 80 → 「读取模型」按钮底边 ≈ **436 ≤ 676** ✓ 主路径不必滚动。
- 徽标高度 18 < 行高 44，不与 13px 名称争垂直空间；圆点 7px 与 12px 文本基线对齐（`align-items: center`）。

---

## 1. 页面与模块清单（信息架构）

设置 › AI 一页，**纵向单列**，四个区块按「全局 → 对象 → 对象细节 → 全局兜底」排列：

```
A0 开关与披露        启用 AI + 说明 + 安全披露            （沿用，位置不变）
A1 默认思考强度      三档分段控件（全局唯一可编辑处）        ← 新增，位于卡片区之外（AC-8）
   A1.1 档位说明     低/中/高 的当前档一句话
   A1.2 适用性提示   默认供应商不支持时的「已忽略」警告行（AC-11）
A2 供应商            标题「供应商」+ 计数 + [+ 新增]
   A2.1 卡片列表     每供应商一张卡：六项摘要 + 行尾操作（AC-1）
   A2.2 卡片编辑区   点卡片行就地展开（AC-3），同一时刻最多一张
A3 全局默认          默认供应商（select）/ 上下文行数          （沿用，位置不变）
```

**与现状的差异（修订点，逐条可 diff）**
1. `.ts-ai-form__list` + `.ts-ai-form`（一行一条 `<button>` + 下方整块单栏表单）→ **卡片列表 + 卡片内联编辑区**。列表不再与表单并列，编辑区属于卡片本身。
2. 「读取模型」从「已保存才可用」改为**草稿即可用**（AC-4）；`fetchModels.saveFirst` 文案与 `editingId === null` 禁用条件一并删除。
3. 模型控件从 `<input list="ts-ai-provider-models">` + `<datalist>` 换成 **portal 组合框**（AC-5）。
4. 默认思考强度插到 A1（现状无此区块）；卡片编辑区内只放**只读回显**（AC-8 单点可编辑）。
5. A3 的两个既有项**保留原位**：卡片上的「设为默认」是快捷方式，`<select>` 是完整入口（卡片多时不必滚动去找），两者写的是同一字段，**必须双向同步**——只改一处 = 改了卡片徽标但下拉不变，是允许被肉眼抓到的缺陷。

---

## 2. 线框（含状态）

### 2.1 列表态（无人编辑，666px 实宽）

```
┌ 设置 › AI ───────────────────────────────────────────── 880×760 ┐
│ nav │ [x] 启用 AI                                                │
│ 180 │ 说明：只有在你主动提问时才会调用供应商（12px muted）        │
│     │ ⚠ 披露条：命令写入终端前必须二次确认（3px 琥珀左边框）      │
│     │                                                            │
│     │ 默认思考强度                        ┌低│中│高┐  (252×32)   │
│     │ 平衡质量与延迟（推荐）· 对 Anthropic 系会自动抬升输出上限     │
│     │                                                            │
│     │ 供应商 (3)                                        [+ 新增]  │
│     │ ┌────────────────────────────────────────────────────┐     │
│     │ │● Anthropic  claude-sonnet-4  …9f3a  [默认]  [✎][✕] │ 44  │
│     │ ├────────────────────────────────────────────────────┤     │
│     │ │● OpenAI     gpt-4.1-mini   未配置 key       [✎][★][✕]│ 44  │
│     │ ├────────────────────────────────────────────────────┤     │
│     │ │○ Ollama     llama3.2      未配置 key       [✎][★][✕]│ 44  │
│     │ └────────────────────────────────────────────────────┘     │
│     │                                                            │
│     │ 默认供应商            [ Anthropic        ▾ ]   （沿用）       │
│     │ 上下文行数            [ 20               ]     （沿用）       │
└────────────────────────────────────────────────────────────────┘
```

- `●`=已配置（7px 实心 `--ts-status-ok`）、`○`=缺失（7px 环，1.5px `--ts-text-muted`，透明心）。两态**同时**用形状与颜色区分，深浅主题与色觉异常下都成立；`aria-label`/`title` 给「已配置凭据 / 未配置凭据」。
- 行尾操作：`✎`=编辑（`Pencil`）、`★`=设为默认（`Star`，默认项**不渲染**）、`✕`=删除（`Trash`）；均 26×26、`--ts-icon-size` 14、`title` + `aria-label`，`data-testid="ai-provider-edit-<id>" / "ai-provider-make-default-<id>" / "ai-provider-delete-<id>"`。
- key 尾 4 位永远 `…` + 4 位等宽（`…9f3a`）；未配置显示 `未配置 key`（muted）。**永不省略**（`flex: none`），名称与模型才允许省略。
- 状态来源说明（给 QA）：圆点是按 `provider.credentialRef !== null` **推断**「已保存 key」，不等于真实连通性——不得写成「已读取真实状态」。

### 2.2 编辑态（点卡片 → 卡片内联展开）

```
┌────────────────────────────────────────────────────────────┐
│● Anthropic  claude-sonnet-4  …9f3a  [默认]        [✎][✕] ▲ │ 摘要行不变
├────────────────────────────────────────────────────────────┤ ← 1px
│ （bg-app 下沉区，padding 12 14 14）                          │
│ 协议 · 路由  openai · 流式 SSE · 需要 API key         12px  │
│ 名称         [ Anthropic                          ]         │
│ Base URL     [ https://api.anthropic.com          ]         │
│ API key      [ ••••••••••••••••••9f3a   ] [👁][清除]        │
│ 模型         [ claude-sonnet-4            ▾ ] [读取模型]    │
│              已读取 12 个模型 · 点选或直接输入（12px）        │
│ 思考强度     跟随全局 · 高  [去顶部修改]                     │
│ ▸ 高级（温度 0.7 · 输出上限 4096）                           │
│                    [测试连接]  [取消]  [保存]               │
└────────────────────────────────────────────────────────────┘
```

- 字段顺序（PRD §5.2）：**mode/协议行 → 名称 + Base URL → API key → 读取模型 + 模型 → 思考强度（只读）→ 高级折叠 → 底部动作**。key 在模型之前——先有凭据才有模型可读。
- 布局：`名称 / Base URL / API key / 模型` 各占整行（label 上、控件下，gap 6；同组 gap 12）；`温度 + 输出上限` 在高级区内两列（`grid-template-columns: 1fr 1fr`，gap 12）。
- 「测试连接」在动作区最左（与「取消 / 保存」用 `margin-right: auto` 分开），保持既有位置与 testid。
- 「保存」`ts-btn--primary`（唯一琥珀实底），「取消」「测试连接」`ts-btn`（描边），「删除」`ts-btn--ghost` 走 §3.4 两步确认。
- 展开/收起**不移动焦点**、不主动滚动（AC-3）；仅当编辑区顶边已越出对话框 body 可视区下沿时，才 `editor.scrollIntoView({ block: 'nearest' })`（该分支不在 AC-3 断言路径内，QA 需知）。

### 2.3 新增态（catalog 模式，空列表时自动展开）

```
┌────────────────────────────────────────────────────────────┐
│ 新增供应商                                    [✎][★][✕] 无  │
├────────────────────────────────────────────────────────────┤
│ ┌ 从目录选择 │ 手动填写 ┐   ← 分段（默认「从目录选择」）      │
│ ┌──────────────────┐ ┌──────────────────┐                 │
│ │ OpenAI       ✓   │ │ DeepSeek         │  tile 320×56   │
│ │ api.openai.com/v1│ │ api.deepseek.com │                 │
│ ├──────────────────┤ ├──────────────────┤                 │
│ │ … 4 行可见，其余内部滚动（max-height 264）                 │
│ 说明：OpenAI 协议 · 需要 API key                              │
│ API key      [                                     ]        │
│ 模型         [                          ▾ ]  [读取模型]      │
│ 思考强度     跟随全局 · 中  [去顶部修改]                       │
│ ▸ 高级                                                      │
│                              [测试连接] [取消] [保存]        │
└────────────────────────────────────────────────────────────┘
```

- tile 内容：品牌名（13/600）+ 协议徽标（11px，`openai` / `openai-compatible` / `anthropic` / `gemini` / `ollama`，中文见 §4.4）+ Base URL（mono 12、省略、`title` 全值）。**不渲染 `preset.note`**（英文原文，会违反 AC-13「中文界面不出现英文残留」）；tile 的「说明」由 `kind + needsKey` 派生中文短句（例：「OpenAI 协议 · 需要 API key」/「本地模型 · 无需 key」），2 个模板键 + 4 个协议名，不为 11 个预设各写一条。
- `catalog` 模式：名称 / 协议 / Base URL 由选中预设派生并**只读展示**（不出现可编辑输入框——避免「选了目录又改 URL」的半吊子态）。
- `custom` 模式：名称 / Base URL 可编辑，协议用 `<select>`（沿用 `ai-provider-kind`）；`ai-provider-preset` 与 `ai-provider-kind` 在两种模式下都必须在 DOM 中（catalog 模式下 `ai-provider-preset` 为选中预设、`ai-provider-kind` 为派生值，均 `disabled` 但存在）。
- **切换模式不清空 key 与模型**（AC-7）：API key 与模型两个输入在两种模式间**不卸载、不换位置以上下错位**——同一 React 节点，只切换其上方字段的形态。

### 2.4 模型组合框（新增核心构件）

```
未展开： [ claude-sonnet-4                        ▾ ] [读取模型]
         已读取 12 个模型 · 点选或直接输入

展开：   ┌────────────────────────────────────────────┐
         │ 🔍 搜索模型…                                │ 32
         ├────────────────────────────────────────────┤
         │ claude-sonnet-4-20250514          [当前]    │ 32 × 8
         │ claude-opus-4-20250514                      │  （第 9 行起滚动）
         │ claude-haiku-3-5                            │
         │ …                                           │
         ├────────────────────────────────────────────┤
         │ 没有匹配的模型 · 回车使用「claude-x」         │ 32（无命中时）
         └────────────────────────────────────────────┘
```

- 行为见 §3.3；浮层 **portal 到 `document.body`**（对话框 body 是 `overflow: auto`，就地渲染会被裁）。
- 手输任意值**不被覆盖**：清单不包含手输值时，收起后输入框保留原值；「读取模型」成功后**只有用户上次点选过的值**被保留，不自动覆盖成清单第一项。
- 空清单：状态行显示「供应商返回空列表：请确认 Base URL 指向兼容端点」，控件仍可手输。

### 2.5 A1 默认思考强度（全局唯一可编辑处）

```
默认思考强度                                   ┌ 低 │ 中 │ 高 ┐
平衡质量与延迟（推荐）· 「高」只对支持思考的协议生效
```

- 行式布局：label 左（12px 大写 secondary），分段控件右（252×32），同一行垂直居中；说明行在下方（12px muted，整行左对齐）。
- 选中段：背景 `--ts-bg-elevated` + 1px `--ts-accent` + 文字 `--ts-text-primary`；未选中：透明 + `--ts-text-secondary`。**不整条实底琥珀**（anti-pattern 7）。
- 说明行文案随档位变化（低：更快更省；中：平衡质量与延迟（推荐）；高：更深推理，更慢更贵）。
- 不支持时（AC-11）：分段控件仍在、仍可切（改的是全局默认），下方追加一条 3px 琥珀左边框的警告行：「当前默认供应商 Ollama 不支持思考强度，本次已忽略（请求里不会带任何推理参数）」。
- Anthropic 静态提示（AC-10 的入口级说明）：「「高」档需要 ≥16384 的输出上限：单次请求会自动抬到 17500 左右，不修改你保存的值」→ 具体数字与「不发送 temperature」的完整说明放在编辑器高级区（§3.5），此处只给结论。
- 写盘即时（切换即 `patch`），不设「保存」按钮；成功后用 `role="status" aria-live="polite"` 播报一次「默认思考强度已设为 高」。
- vault 锁定时**不进入 locked 态**（该字段不在 vault 内，与 `enabled` 开关一致）。

---

## 3. 交互与动效细节

### 3.1 主路径（首次配置，8 步）

1. 打开 设置 → AI：A1 显示当前默认强度（默认「中」）。
2. 空列表直接展开新增卡片（catalog 模式）；否则点「+ 新增」。
3. 选一个 tile → 名称 / 协议 / Base URL 自动填好。
4. 填 API key（填完即可，**不需要保存**）。
5. 点「读取模型」→ 按钮内转圈 + 状态行 `正在读取模型…`；成功后状态行 `已读取 12 个模型 · 点选或直接输入`，控件可展开。
6. 点选模型（或手输），输入框回填。
7. （可选）展开高级区调温度 / 输出上限 / 自定义头。
8. 保存 → 卡片就地收起，摘要行立刻反映新模型与 key 尾 4 位。

### 3.2 失败分支（文案直接进 i18n，禁止运行时拼英文）

| `data-error-kind` | 触发 | 首行 | 次行（可省） |
|---|---|---|---|
| `auth` | HTTP 401 / 403 | `HTTP 401 · 鉴权失败` | `检查 API key 是否正确、是否有该接口权限` |
| `network` | 超时 / DNS / 连接被拒 | `无法连接（{{seconds}}s 超时）` | `检查 Base URL 与网络 / 代理设置` |
| `shape` | 响应不是模型列表 | `HTTP {{status}} · 响应不是模型列表` | `确认 Base URL 指向兼容端点（通常以 /v1 结尾）` |
| `unknown` | 其余 | `HTTP {{status}}`（无状态码时 `读取失败`） | 服务商 message |

- 渲染顺序：`HTTP 状态 · 分类` 一行（`--ts-status-error`，600）→ 服务商 message 一行（`--ts-text-secondary`，12px，`word-break: break-word`），**message 截断到 300 字符**后加 `…`。
- **脱敏（硬要求）**：渲染前对 message 做两件事——① 把用户本次输入的 key 完整字符串替换为 `…{{last4}}`；② 正则 `\b(sk|pk|api)[-_][A-Za-z0-9_\-]{8,}\b` 命中的 token 一律替换为 `…{{last4}}`（取末尾 4 位）。DOM 文本、`title`、`aria-label` 三处都不得出现明文。
- 错误条 `role="alert"`，`data-testid="ai-provider-models-error"` + `data-error-kind`；`max-height: 120` + 内部滚动（§0.6）。
- 既有 `ai-provider-message`（测试连接结果）继续复用 `.ts-ai-form__message is-ok/is-error`，不合并到新的读取失败条里。

### 3.3 模型组合框行为（ARIA 1.2 组合框，手写不引库）

- 触发器即输入框（保留 `data-testid="ai-provider-model"` 与显式 `aria-label="模型"`）；右侧 `ChevronDown` 26×26 按钮（`aria-label="展开模型清单"`）。
- 打开：点击 / `↓` / `Alt+↓`；关闭：`Esc`（保留当前值不回车）、点外部、`Tab` 离开。
- 过滤：键入即按子串**忽略大小写**过滤（不排序，保持服务商返回顺序）；高亮项随 `↑/↓` 移动、`Enter` 选中、`Home/End` 跳首尾。
- 焦点不离开输入框（`aria-activedescendant` 指向高亮项 id）；浮层 `role="listbox"`，行 `role="option"` + `aria-selected`；命中项很多时只渲染前 200 条（列表本身 ≤ 数千，服务商峰值 ~1k）。
- 选中后：输入框显示该模型名、浮层关闭、焦点留在输入框，播报「已选择 {{model}}」。
- 手输：不点选直接收起 = 采用手输值，状态行不报错；下次打开浮层时高亮「与输入完全相等」的行（若有）。

### 3.4 删除的两步确认（行内，不用 `window.confirm`）

- 点 `✕` → 行尾操作簇就地替换为 `[确认删除]`（danger 实底，28 高，68 宽）+ `[取消]`（ghost `X`，28×28）；摘要行其余部分宽度收缩（文本已省略化，不产生溢出）。
- 3 秒无操作自动回退为 `[✎][★][✕]`；`Esc` 或「取消」立即回退；确认后卡片淡出（120ms）并从列表移除。
- 确认按钮 `title`/`aria-label`：「删除后需重新填写 API key」，`aria-live` 播报「已进入删除确认」。
- 删除是唯一破坏性动作：**不得**在未确认状态下删除。

### 3.5 Anthropic 冲突说明（AC-10 的落点）

编辑器高级区内，`kind === 'anthropic'` 时：

- `输出上限` 字段下方一行说明（12px muted）：「当前全局强度「高」需要输出上限 ≥16384；若保存值更小，**本次请求**会自动抬到 17500（budget 16384 + 1024），不修改你保存的值」。
- `温度` 字段下方一行说明：「开启思考的请求不发送 `temperature`（避免与 thinking 冲突），你的保存值保持 {{t}} 不变」。
- 两行都用 `.ts-settings__hint`（**不是** warning 条）——它是常驻解释，不是异常。数字由共享层 `src/shared/reasoning.ts` 的映射导出，**不得在 UI 里另写一份映射**（AC-9 单点）。

### 3.6 卡片展开的滚动稳定性（AC-3）

- 展开 / 收起只改变「被点那张卡」的高度，`scroll` 容器（`.ts-dialog__body`）的 `scrollTop` 不动；不给编辑区第一个输入框 `autoFocus`（focus 会触发浏览器滚动）。
- 同一时刻最多一张卡展开：点另一张 → 先收起当前（160ms）再展开目标（不叠加过渡，视觉上是一次「换卡」）。

---

## 4. 视觉规格（全部复用 token，只新增 1 个）

### 4.1 复用表（不许写死数值）

| 用途 | token / 值 |
|---|---|
| 间距 | `--ts-space-1..6` = 4/8/12/16/24/32；卡片间距 8；卡片内 padding `0 10`；编辑区 padding `12 14 14`；字段 label→控件 6；同组字段间 12；区块间 18（沿用 `.ts-settings__section`） |
| 控件高 | `--ts-control-h` 32（输入 / select / 组合框 / 分段控件 / 折叠头）；`--ts-control-h-sm` 28（小按钮）；行尾图标按钮 26 |
| 圆角 | `--ts-radius-sm` 6（输入 / 按钮 / 徽标 / tile / 分段）/ `--ts-radius-md` 10（卡片 / 浮层） |
| 颜色 | `--ts-bg-app` / `--ts-bg-surface` / `--ts-bg-elevated`；`--ts-border` / `--ts-border-strong`；`--ts-text-primary` / `secondary` / `muted`；`--ts-accent`（仅主按钮 / 展开卡左条 / 浮层选中）；`--ts-status-ok`（已配置）/ `--ts-status-warn`（说明条）/ `--ts-status-error`（失败） |
| 字体 | `--ts-font-ui`（正文）/ `--ts-font-mono`（模型名、key 尾 4 位、Base URL、请求头） |
| 动效 | `--ts-motion-fast` 120ms ease；展开类 160ms |
| 焦点 | `--ts-focus-ring-width` / `--ts-focus-ring-color` / `--ts-focus-ring-offset` |

> **CSS 纪律（PRD 工程约束 6）**：不得使用未定义变量；不得用单类选择器覆盖 kit 同族属性。`ai.css` 里现有的 `.ts-ai-form input, .ts-ai-form select, .ts-ai-form textarea { padding: 5px 7px; border: 1px solid var(--ts-border) }` **（修订）必须在本次收窄**到只剩自定义头 textarea，否则卡片内输入框会与设置页其它输入框（`.ts-settings__input`：高 32、padding 0 10、border-strong）长得不一样。

### 4.2 唯一新增 token：`--ts-shadow-popover`

写在 `src/renderer/styles/tokens.css` 的 **`html{}` 非契约块**（与 `--ts-dialog-shadow` 同处），单值同时服务两套主题：

```css
--ts-shadow-popover: 0 12px 32px rgba(0, 0, 0, 0.42), 0 0 0 1px var(--ts-border-strong);
```

- **不能写进 `:root` / `[data-theme='light']` 契约块**：`tests/contract/theme-tokens.test.ts` 会逐 token 比对 `src/shared/theme.ts` 的 `THEME_TOKENS`，「多一个就红」。
- **不能复用 `--ts-dialog-shadow`**：它的颜色是 `--ts-bg-overlay`，浅色主题下是 `rgba(247,248,251,.82)`，给浮层会变成一圈白色泛光。
- 单值通吃的依据：0 0 0 1px 的描边环保证浅色主题下浮层边界清晰，深色主题下靠 42% 黑投影分层。
- 组件侧只写 `box-shadow: var(--ts-shadow-popover)`；颜色字面量只允许出现在 `tokens.css`。

### 4.3 新增 class 命名（沿用既有 BEM 与 `ts-ai-` 前缀，便于 QA 锚点）

```
.ts-ai-provider-cards            卡片列表容器（grid 单列，row-gap 8）
.ts-ai-provider-card             卡片（is-expanded 修饰）
.ts-ai-provider-card__summary    摘要行按钮（flex:1，六项 + 省略规则）
.ts-ai-provider-card__dot        凭据圆点（is-ok / is-missing）
.ts-ai-provider-card__name       名称（13/600，max-width 160）
.ts-ai-provider-card__model      模型（mono，flex:1，省略）
.ts-ai-provider-card__key        key 尾 4 位 / 未配置（mono，flex:none）
.ts-ai-provider-card__badge      默认徽标（沿用 .ts-ai-form__badge 视觉）
.ts-ai-provider-card__actions    行尾操作簇（flex:none）
.ts-ai-provider-card__editor     卡片内编辑区（bg-app 下沉，0 0 10 10）
.ts-ai-effort / __seg / __caption    三档分段控件（全局区）
.ts-ai-effort__warning           不支持提示行
.ts-ai-catalog                   目录 tile 网格（2 列，max-height 264）
.ts-ai-catalog__item             单 tile（is-selected）
.ts-ai-model-combo               组合框触发器容器（position: relative，length)
.ts-ai-model-combo__panel        浮层（portal 内，z-index 与 .ts-dialog 同级之下、页面之上）
.ts-ai-model-combo__option       单行（[aria-selected=true]）
.ts-ai-model-combo__status       状态行（role=status）
.ts-ai-model-combo__error        结构化错误条（role=alert）
.ts-ai-advanced / __head / __summary  高级折叠
```

testid 纪律（AC-12）：**既有 testid 一律不改名**；新增仅追加：`ai-provider-cards`、`ai-provider-toggle-<id>`、`ai-provider-edit-<id>`、`ai-provider-delete-<id>`、`ai-provider-delete-confirm-<id>`、`ai-provider-status-<id>`、`ai-provider-models-combo`、`ai-model-option-<model>`、`ai-provider-models-error`（+`data-error-kind`）、`ai-reasoning-effort`、`ai-reasoning-effort-low|medium|high`、`ai-catalog`、`ai-catalog-item-<presetId>`、`ai-advanced-toggle`。

### 4.4 i18n 键（en / zh-CN 同步；AC-13）

| namespace | key | zh-CN 参考 |
|---|---|---|
| `settings` | `ai.reasoningEffort.label` | 默认思考强度 |
| `settings` | `ai.reasoningEffort.low` / `.medium` / `.high` | 低 / 中 / 高 |
| `settings` | `ai.reasoningEffort.caption.low` / `.medium` / `.high` | 更快、更省 / 平衡质量与延迟（推荐）/ 更深推理，更慢更贵 |
| `settings` | `ai.reasoningEffort.saved` | 默认思考强度已设为 {{level}}（播报用） |
| `settings` | `ai.reasoningEffort.anthropicNote` | 「高」档需要 ≥{{min}} 的输出上限，单次请求会自动抬升，不修改你保存的值 |
| `settings` | `ai.reasoningEffort.unsupported` | {{name}} 不支持思考强度，本次已忽略 |
| `settings` | `ai.provider.none` | 还没配置供应商 |
| `ai` | `provider.models.fetch` | 读取模型 |
| `ai` | `provider.models.loading` | 正在读取模型… |
| `ai` | `provider.models.count` | 已读取 {{count}} 个模型 · 点选或直接输入 |
| `ai` | `provider.models.empty` | 供应商返回空列表：请确认 Base URL 指向兼容端点 |
| `ai` | `provider.models.searchPlaceholder` | 搜索模型… |
| `ai` | `provider.models.noMatch` | 没有匹配的模型 · 回车使用「{{value}}」 |
| `ai` | `provider.models.select` | 已选择 {{model}}（播报用） |
| `ai` | `provider.models.error.auth` / `.network` / `.shape` / `.unknown` | 见 §3.2 |
| `ai` | `provider.models.error.hint.auth` / `.network` / `.shape` | 见 §3.2 次行 |
| `ai` | `provider.keyConfigured` / `provider.keyMissing` | 已配置凭据 / 未配置凭据 |
| `ai` | `provider.keyTailMissing` | 未配置 key |
| `ai` | `provider.effortFollowing` | 跟随全局 · {{level}} |
| `ai` | `provider.effortGoGlobal` | 去顶部修改 |
| `ai` | `provider.effortAnthropicBudget` | 当前强度需要输出上限 ≥{{min}}：本次请求会临时抬到 {{effective}}，不修改你的保存值 {{current}} |
| `ai` | `provider.effortAnthropicTemperature` | 开启思考的请求不发送 temperature，你的保存值 {{value}} 不变 |
| `ai` | `provider.advanced.title` / `.summary` | 高级 / 温度 {{t}} · 输出上限 {{n}} |
| `ai` | `provider.delete.confirm` / `.hint` / `.done` | 确认删除 / 删除后需重新填写 API key / 已删除 {{name}} |
| `ai` | `provider.catalog.mode` / `provider.custom.mode` | 从目录选择 / 手动填写 |
| `ai` | `provider.catalog.needsKey` / `.noKey` | {{kind}} 协议 · 需要 API key / {{kind}} 协议 · 无需 key |
| `ai` | `provider.kind.openai` / `.openaiCompatible` / `.anthropic` / `.gemini` / `.geminiNative` / `.ollama` | OpenAI / OpenAI 兼容 / Anthropic / Gemini / Gemini 原生 / Ollama |

---

## 5. 无障碍要点（实现级）

1. **键盘全可达**：A1 三档（`→/←` 切换，`role="radiogroup"` + `role="radio"` + `aria-checked`，一次 Tab 进入整组）→ 卡片摘要按钮（`Enter/Space` 展开）→ 编辑区字段 → 「读取模型」→ 组合框（`↓` 展开）→ 高级头 → 保存 / 取消 / 删除。
2. **语义**：卡片摘要按钮是原生 `<button>` 且带 `aria-expanded` + `aria-controls`；编辑区用 `<div role="group" aria-label="编辑 {{name}}">`（不用 `<fieldset>`，避免默认样式覆盖）；行尾图标按钮必须有 `aria-label`（图标 `aria-hidden="true"`）。
3. **播报**：读取结果 / 选择结果 / 保存结果用 `role="status" aria-live="polite"`；错误条 `role="alert"` 且用稳定 key（只在内容变化时重播，避免每次渲染重播）。
4. **焦点环**：卡片摘要按钮 `outline-offset: -2px`（卡片有 border，2px 会被裁）；浮层选项与分段段内同样 `-2px`。
5. **可访问名契约**：`ai-provider-model` 的输入框必须有显式 `aria-label="模型"`——它在 label 内新增了「读取模型」按钮与 `▾`，不补 `aria-label` 时 `getByLabel('模型', { exact: true })` 立刻超时，且构建 / 单测全绿只有 e2e 红。
6. **对比度**：正文 13px 用 `--ts-text-primary`（暗色 #e8edf7 on #0d1424 ≥ 13:1；浅色 #0d1424 on #fff ≈ 16:1）；`--ts-text-muted` 只承载说明，不承载唯一结论（关键结论用 `--ts-status-error` / `.ts-settings__warning`）。
7. **不只靠颜色**：「已配置 / 缺失」用实心 vs 空心圆 + 文本，不靠颜色单独区分；「默认」用徽标文字，不靠琥珀条单独区分。
8. **拖拽区**：本页在 `.ts-dialog` 内，弹窗已声明 `-webkit-app-region: no-drag`；但浮层仍必须 portal（`overflow: auto` 裁切问题），若将来把组合框放进标题栏/页签条，必须同时 `no-drag`。
9. **减少动效**：`prefers-reduced-motion: reduce` 下取消所有 translate/rotate/高度过渡，只保留透明度。

---

## 6. AC → 设计落点对照（给 dev / QA 的检查表）

| AC | 设计落点 |
|---|---|
| AC-1 | §2.1 六项摘要（圆点/名称/模型/key 尾/徽标/操作）+ §0.6 「尾 4 位与徽标 flex:none 永不省略」；`.ts-ai-form__item` 的两行 grid **修订**为单行 flex |
| AC-2 | §0.6 内容列 666 与全部 `min-width: 0 + ellipsis` 规则；卡片 `max-width: 720` 只是上限 |
| AC-3 | §2.2 编辑区在卡片内 + §3.6 滚动稳定性 + §0.3 展开动效（同一时刻一张） |
| AC-4 | §1 差异 2（移除 saveFirst 禁用）+ §0.2「未保存时读取模型不得 disabled」 |
| AC-5 | §2.4 + §3.3（可搜索 / 键盘 / 手输不被覆盖 / portal） |
| AC-6 | §3.2 四类 `data-error-kind` + 300 字截断 + **脱敏两条规则** + §0.6 max-height 120 |
| AC-7 | §2.3 catalog/custom（tile 320×56、容器 264、模式切换不卸载 key/模型） |
| AC-8 | §2.5 A1 全局唯一可编辑处（卡片区之外）+ §2.2 卡片内只读「跟随全局」+ 写盘即时播报 |
| AC-9 | §2.5/§3.5：界面只出现「低/中/高」，数字由 `src/shared/reasoning.ts` 导出，UI 不另写映射 |
| AC-10 | §2.5 静态结论 + §3.5 编辑器内完整说明（抬升不写回、不发 temperature） |
| AC-11 | §2.5 不支持警告行 + §4.4 `unsupported` 文案；控件不隐藏 |
| AC-12 | §4.3 testid 纪律 + §5.5 `aria-label="模型"`；`.ts-ai-form input` 通配规则收窄（否则视觉回归） |
| AC-13 | §4.1 复用表（只用 `--ts-*`）+ §4.2 唯一新增 token + §4.4 双 locale 键表 |
| AC-14 | 本文件不涉及命令；深/浅两套主题的观感差异集中在 §0.1 混色卡片、§0.2 hover、§2.1 圆点两态——截图必须覆盖这三处 |

**设计侧未决（交 tech 决定，不影响本文件其余规格）**
- 目录 tile 是否记忆上次选中的预设：建议**不记忆**（每次新增都从空选起，避免「默认帮你选了某家」的错觉）。
- 模型清单是否缓存：建议只在当前编辑器会话内保留，关闭编辑器即丢弃；不落盘（与 r1 一致）。
- 卡片排序：保持服务商 / 供应商返回顺序，不排序（用户按位置记忆）。
