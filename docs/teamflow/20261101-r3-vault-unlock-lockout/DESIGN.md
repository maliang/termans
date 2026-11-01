<!-- meta: summary="解锁屏改造：库切换（≥2 库才给下拉 + 可折叠库列表）+ 失败四分类归因块（按 data-class 区分，红色只给 corrupt）+ 可折叠诊断区（六项台账 + 8 位槽指纹，永不显示路径）+ 常驻次级入口「新建一个本地库（保留现有库）」+ 二次确认三句话 + 一行变体进度 + 解锁后一次性顶部告知条；全产品零重置/清空/绕过入口，恢复码页无逃逸出口。" -->

基线依赖：`docs/teamflow/20261030-r2-ai-settings-model-picker/DESIGN.md`（视觉基调、三层表面律、状态反馈写法、anti-pattern 纪律、i18n/testid 命名纪律）
取代：无（本轮不与任何历史 DESIGN 冲突；既有 r1/r2 为 AI 设置，与本屏无交集）

# DESIGN · 解锁屏：失败归因 + 库切换 + 另开本地库（Termans）

**标记约定**：`（修订）`= 改既有实现；`（新增）`= 全新构件；未标注 = 沿用现状，不得顺手改。
**落点**：`src/renderer/features/unlock/UnlockScreen.tsx`（重排，`Mode` 扩容）、`src/renderer/features/vault/vault.css`（解锁卡新增块，现有 `.ts-unlock*` 段落从 `vault.css:623` 起）、`src/renderer/features/vault/i18n.ts`（namespace `vaultsync`，en 与 zh-CN 两份同步）、`src/renderer/features/vault/store.ts`（状态选择器）、新增 `src/renderer/features/vault/VaultNoticeBar.tsx`（解锁后的变体告知条），挂载在 `src/renderer/app/App.tsx`。
**不动**：`.ts-btn` / `.ts-link` / `.ts-field` / `.ts-toast`（`src/renderer/styles/base.css:393` 起）、全局 `:focus-visible`（`base.css:52`）、主题 token 清单（`src/renderer/styles/tokens.css`，本轮**不新增任何 token**）。

---

## 0. 视觉与手感意图（先读本节）

基调：**深色工作台里的一张"证物卡"**。用户此刻进不去自己的库，屏幕上的一切都必须回答「现在什么状态 / 证据是什么 / 我还能做什么」。因此本屏的层级不是靠颜色堆出来的，而是靠 **一张卡 + 一条琥珀主行动 + 一块可展开的证据区**。琥珀是稀缺资源，本屏只允许三处吃它：主按钮（解锁 / 创建 / 继续）、诊断区已展开时的箭头与「查看诊断」链接、顶部告知条的左侧 3px 竖条。红色只允许出现在 `corrupt` 一类。

### 0.1 表面处理（圆角 / 描边 / 背景 / 阴影 / 内距）

| 构件 | 圆角 | 描边 | 背景 | 阴影 | 内距 |
|---|---|---|---|---|---|
| 解锁卡（修订） | `--ts-radius-lg` 14 | 1px `--ts-border-strong` | `--ts-bg-surface` | 沿用 `0 20px 60px rgb(0 0 0 / 50%)`（`vault.css:645`，不改） | `20px 22px` |
| 库切换行（新增） | `--ts-radius-sm` 6 | 1px `--ts-border`；hover → `--ts-border-strong` | `--ts-bg-app` | 无 | `0 10px`，高 **34px** |
| 库列表（新增，折叠区） | `0 0 6 6` | 仅 1px 上边 `--ts-border` | `--ts-bg-app` | 无 | `4px 0`，单行高 **44px** |
| 库列表行（新增） | 0（由容器裁切） | 无；hover 1px `--ts-border` 内描边 | 透明；hover `--ts-bg-elevated`；当前行 `--ts-bg-elevated` + 左侧 **2px** `--ts-accent` | 无 | `8px 10px` |
| 口令 / 库名输入（沿用） | 6 | 1px `--ts-border-strong` | `--ts-bg-app` | 无 | 沿用 `.ts-field` |
| 归因块（新增，四类共用外壳） | 6 | 1px `color-mix(in srgb, <语义色> 45%, transparent)` + 左侧 **3px** 实心 `<语义色>` | `--ts-bg-app` | 无 | `10px 12px` |
| 归因块内自查清单（新增） | — | 无 | 透明 | 无 | 左缩进 16px，行高 18px |
| 诊断折叠区（新增） | 6 | 1px `--ts-border` | `--ts-bg-app` | 无 | `10px 12px` |
| 诊断行（新增） | — | 无；行间 1px 虚线 `--ts-border`（`border-bottom`） | 透明 | 无 | `4px 0` |
| 二次确认区（新增，内嵌卡片） | 6 | 1px `--ts-border-strong`；顶边 **3px** `--ts-accent` | `--ts-bg-elevated` | 无 | `12px` |
| 恢复码块（沿用） | 6 | 1px 虚线 `--ts-border-strong` | `--ts-bg-app` | 无 | `10px 12px` |
| 次级入口链接（新增，复用 `.ts-link`） | — | 无 | 透明 | 无 | 0 |
| 顶部告知条（新增） | 0 | 1px 下边 `--ts-border` + 左侧 **3px** `--ts-accent` | `--ts-bg-elevated` | 无 | `8px 12px`，高 32px |

层次只有三档，不许出现第四档：`--ts-bg-app`（页底 / 输入 / 归因块 / 诊断） ＜ `--ts-bg-surface`（卡片） ＜ `--ts-bg-elevated`（库列表悬停与当前行 / 确认区 / 告知条）。

**四类归因的语义色**（这是本屏唯一的"彩色编码"，必须同时有图标与标题，不许只靠颜色区分）：

| 类别 | `data-class` | 语义色（左侧 3px 条 + 描边） | 图标（lucide，已确认导出） | 主行动 |
|---|---|---|---|---|
| 口令不符 | `bad-passphrase` | `--ts-status-warn` | `CircleAlert` | 重新输入并重试（主按钮） |
| 限流 | `throttled` | `--ts-status-warn` | `Timer` | 主按钮 disabled + 倒计时 |
| 槽与本机记录不一致 | `slot-record-mismatch` | `--ts-accent` | `HardDrive` | 「查看诊断」+ 次级「新建一个本地库」 |
| 库文件损坏 | `corrupt` | `--ts-status-error` | `FileX` | 「查看处置说明」（外链文档） |

> `bad-passphrase` 与 `throttled` 同色不同图标，靠 **图标 + 标题 + 是否有倒计时 + 主按钮是否可用** 四个通道区分；`slot-record-mismatch` 用琥珀（可行动、不是故障）、`corrupt` 才用红。`HardDrive` 是刻意的中性选择——**不许**用盾牌 / 警示三角 / 指纹锁一类会暗示"被攻击"的图标（antic-goal 5：无副本时不得暗示被换过）。

### 0.2 状态反馈（每一态都必须看得见）

- **hover（库切换行 / 库列表行）**：描边或背景变一档，`transition: background var(--ts-motion-fast) ease, border-color var(--ts-motion-fast) ease`；`--ts-motion-fast` = 120ms（`tokens.css:211`，已存在）。**禁止**位移、放大、加阴影。
- **hover（次级链接 / 「查看诊断」）**：文字色 `--ts-text-secondary` → `--ts-accent`，120ms；下划线常驻（`text-decoration: underline; text-underline-offset: 3px`），避免靠颜色单独表达可点。
- **active（按下任何按钮 / 行）**：`filter: brightness(0.96)`，时长 0，松手回 hover。
- **focus-visible**：只走 `base.css:52` 全局规则（`--ts-focus-ring-width` / `--ts-focus-ring-color` / `--ts-focus-ring-offset`）；库列表行与告知条关闭按钮贴边，用 `outline-offset: -2px` 防被裁。
- **disabled（限流态主按钮）**：沿用 `.ts-btn:disabled`（`base.css:415`，`opacity` + `not-allowed`），**不得**额外加"锁定"文案以外的视觉。
- **busy（解锁中）**：主按钮文字 → `unlock.unlocking`，`aria-busy="true"`，其余控件保持可见可读（**不许**全屏遮罩、不许 skeleton——AC-9「不新增任何面板」）。
- **expanded（诊断 / 库列表）**：箭头 `ChevronDown` `rotate(180deg)` 120ms；内容**直接出现**，不做高度过渡（内容行数可变，做 `max-height` 动画在长文案上会抖）。
- **归因块出现**：`opacity 0→1` + `translateY(4px)→0`，120ms `ease-out`，只播一次。**禁止 shake / 抖动**（被告知"口令不对"时抖输入框属于骚扰）。
- **计数更新（倒计时 / 变体进度）**：数值用 `font-variant-numeric: tabular-nums`，只换数字不重排；不做脉冲、不做彩色闪烁。

### 0.3 动效与空态

- 动效只有 120ms 一档（`--ts-motion-fast`），不引入新时长 token。
- **空态（本屏的关键）**：
  - 只有 1 只库：库切换行退化为**只读行**「当前库 · <名称>」+ 当前徽标，不渲染下拉与列表（避免出现只有一个选项的空交互）；仍然可见 —— 这是"库确实存在"的可见证据（AC-11/AC-13 的升级兼容）。
  - 本机无解锁记录（老库首次升级）：诊断区「口令槽指纹」显示 `未知（本机无解锁记录）`，且**不得**据此判为 `slot-record-mismatch`（AC-2）。
  - 台账字段无记录：显示 `未知（旧版本库）`，不得用当前时间或 0 填充（AC-4）。
  - 库列表的时间缺失：显示 `未知`。
  - 变体进度：仅当本次解锁已至少失败一次且仍在飞行中出现；成功路径（第一次原样即命中）**不出现任何进度行**（AC-9 延迟零增加）。
- **错误态**：归因块替代现有的两行 `.ts-unlock__error` 红字（`vault.css:703`）；`.ts-unlock__error` 仅保留给非归类错误（如契约校验失败、`E_INVALID_ARGUMENT`）。

### 0.4 字号与排版角色

| 角色 | 字号 / 字重 | 色 | 用途 |
|---|---|---|---|
| 卡片标题 | 15 / 600 | `--ts-text-primary` | 「解锁加密包」/「新建一个本地库」 |
| 副标题 | 12 / 400，行高 1.45 | `--ts-text-muted` | 卡片说明、归因块正文 |
| 强调句（归因块标题） | 13 / 600 | `--ts-text-primary` | 四类归因的标题句 |
| 正文 | 13 / 400 | `--ts-text-primary` | 诊断值、确认区三句话 |
| 标签 / 元信息 | 12 / 400 | `--ts-text-secondary` | 字段标签、库名、日期标签 |
| 微元信息 | 11 / 400 | `--ts-text-muted` | 库列表第二行（创建 / 上次解锁） |
| 数字与摘要 | 12 / 400，`--ts-font-mono` + `tabular-nums` | `--ts-text-primary` | 槽指纹（8 位十六进制）、revision、KDF `N/r/p`、倒计时秒数、恢复码 |
| 链接 | 12 / 400，下划线常驻 | `--ts-text-secondary` → hover `--ts-accent` | 次级入口、「查看诊断」 |

数字一律等宽对齐：诊断值是"对账证据"，等宽才看得出 8 位是否一致、秒数是否在走。禁止对这三类数字用比例字体或加粗强调。

### 0.5 本产品明确禁止的形态（anti-patterns，逐条肉眼可判）

1. **任何"重置库 / 清空库 / 删除库 / 用新口令接管旧库"的按钮、链接、菜单项或 IPC 入口**——连 disabled 形态都不许出现（AC-17，用户原话「重置的话那密码的意义何在」）。
2. 新建库的**默认名 / 默认路径取自旧库**：会读成"这就是把旧库改名"，且掩盖了"新库是另一只库"（AC-11/AC-15）。
3. 用 `window.confirm` / 系统对话框做二次确认：原生对话框只能放一行话，AC-15 要三句话（旧库不动 / 看不到旧库凭据 / 可用原口令切回），一行都省不得。
4. 归因只靠颜色区分（红=错、绿=对）：四类必须各自有图标 + 标题 + 不同行动。
5. 除 `bad-passphrase` 之外任何位置的「口令错误 / 口令不符」字样，以及**任何**位置的「被篡改 / 被换过 / 被盗 / 来自另一台机器」。
6. 诊断区显示文件路径（`/Users/<用户名>/…` 本身就是用户名泄露，AC-3 的"用户名 0 命中"会因此判红）、主机名、IP、口令原文、库内部 id。
7. 成功解锁路径上出现进度面板、步骤条、引导浮层（AC-9）。变体命中只给**一行**文案 + 一条可关闭顶部条。
8. 恢复码页给出任何逃逸：关闭按钮、Esc、点遮罩、底部「预览模式」链接（AC-16「未确认不允许进入下一步」）。
9. 卡片不设 `max-height`：窗口压到最小高度（Electron `minHeight` 见 `electron.vite.config.ts` 之外的窗口配置）时主按钮被挤出可视区且无法滚动到 —— 等于"点了没反应"。
10. 在标题栏 `-webkit-app-region: drag` 子树里渲染本屏任何交互元素（合成点击会绕过 AppKit 拖拽区判定，Playwright 永远绿、真机点不动）。
11. 输入框留「显示口令」眼睛图标（本屏不做，等于给肩窥加一键）。

### 0.6 几何自洽校核（写死的数字必须真的放得下）

- 卡片：`width: min(420px, 92vw)`（不改）；新增 `max-height: min(760px, calc(100vh - 48px))` + `overflow-y: auto`（`.ts-unlock` 自身 `padding: 24px`，故减 48）。
- 内容宽 = 420 − 2×22（内距）− 2×1（描边）= **374px**；以下所有分栏按 374px 折算。
- 库列表行：`[名称 flex:1 min-width:0 省略] [徽标 40px] [日期 78px]`，间隙 2×8 → 名称可用 **240px**。名称按 16 个汉字（12px≈192px）设计，超出省略并 `title` 提示。
- 诊断行：`[标签 96px] [值 flex:1 = 374−96−12 = 266px]`。最长值 `2026-10-30 16:05`（16 字符 × 12px mono ≈ 116px）与 `scrypt N=131072 r=8 p=1`（23 字符 ≈ 166px）均在 266px 内；指纹 8 位十六进制 ≈ 58px。
- 归因块正文：按最长一条（`slot-record-mismatch` 正文 ≈ 46 个汉字）在 374−24 = 350px 宽、12px/1.45 下为 **2 行**；自查清单 3 条各 1 行 → 标题 18 + 正文 35 + 清单 54 + 行动行 30 + 内距 20 = **157px**，按 160px 预留。
- 卡内最坏情况（限流 + 归因块 + 诊断展开 + 库列表展开）：40（上下内距）+ 56（头部）+ 34 + 176（列表 4×44）+ 58（口令框）+ 20（记住）+ 160（归因）+ 160（诊断）+ 34（行动行）+ 44（页脚两行）+ 80（间隙）≈ **862px > 760** → 必须滚动；滚动后主按钮与页脚仍可达（`overflow-y: auto` 在卡片上，页脚不是 `position: fixed`）。
- 顶部告知条：高 32px、全宽；单行文案上限 `max-width: calc(100% - 96px)`（左图标 14+8、右关闭 24+12），中文约 46 字，超出省略 `text-overflow: ellipsis` 且 `title` 全文。
- 倒计时：「还需等待 **58** 秒」三位数以内单行，等宽数字宽度不跳。

---

## 1. 页面与模块清单（信息架构）

不新增独立页面（T3 已定：多库 = 解锁屏下拉 + 库列表 + 新建入口）。全部收敛在现有的解锁卡内，靠 `Mode` 切换：

| 模块 | 触发 | 载体 | 标记 |
|---|---|---|---|
| M1 解锁卡（含库切换、归因块、诊断区、兜底入口） | 应用启动 / 库已锁定 | `.ts-unlock__card` | 修订 |
| M2 新建库二次确认 | M1 次级入口点击 | 卡内确认区（替换表单区） | 新增 |
| M3 新建库表单 | M2「继续」 | 卡内表单（复用 `.ts-field`） | 新增 |
| M4 恢复码展示 | 创建成功 | 现有 `recovery-saved` 模式 | 修订（去逃逸） |
| M5 变体命中告知条 | 非「原样」变体解锁成功 | 主窗口顶部条 | 新增 |
| M6 库列表 | M1 切换行展开 | 卡内折叠区 | 新增 |

`Mode` 扩容（`UnlockScreen.tsx:10` 现为 `'unlock' | 'create' | 'recover' | 'recovery-saved'`）：
`'unlock' | 'create' | 'recover' | 'recovery-saved' | 'new-library-confirm' | 'new-library-create' | 'new-library-created'`。
后三态与 `'create'` 的区别只有一个：文案与"是否出现库切换/兜底入口"。**不复用 `'create'` 是刻意的**——`state==='uninitialized'` 时绝不能出现「新建一个本地库」（AC-10）。

**状态矩阵（`vault:status.state` × 库数）**：

| state | 库数 | 库切换行 | 兜底入口「新建一个本地库」 | 诊断区 | 预览模式 |
|---|---|---|---|---|---|
| `uninitialized` | 0 | 不渲染 | **不渲染** | 不渲染 | 渲染（现状） |
| `locked` | 1 | 只读行 + 当前徽标 | 渲染（次级链接，常驻） | 渲染（可折叠） | 渲染 |
| `locked` | ≥2 | 下拉 + 可折叠列表 | 渲染 | 渲染 | 渲染 |
| `recovery-saved`（任意） | 任意 | 不渲染 | 不渲染 | 不渲染 | **不渲染**（AC-16） |

---

## 2. 线框（含状态）

### 2.1 M1 解锁卡 · 失败归因 + 诊断收起（默认态，374px 内容宽）

```
┌────────────────────────────────────────────┐  420 × 自适应（max 760，内部滚动）
│ [🔒]  解锁加密包                            │  15/600
│       主机、设置与凭据都是加密的。…          │  12/muted
├────────────────────────────────────────────┤
│ ┌────────────────────────────────────────┐ │  库切换行 34px（≥2 库；此处 3 只库）
│ │ ▤  当前库 · 工作库        [当前] ⌄     │ │  ← 整行可点，展开库列表
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │  库列表（展开时）
│ │▌工作库                [当前] 10-30 16:05│ │  当前行：左 2px 琥珀 + elevated
│ │ 个人库                         10-28    │ │  hover: elevated
│ │ 测试库                         10-12    │ │
│ └────────────────────────────────────────┘ │
│ 主口令                                      │  12/secondary
│ ┌────────────────────────────────────────┐ │
│ │ ••••••••••••••                          │ │  type=password, autofocus
│ └────────────────────────────────────────┘ │
│ ☑ 在本机记住 7 天                            │  按当前库独立
│                                             │
│ ┌─▌口令不符 ────────────────────────────┐ │  归因块：左 3px warn
│ │ ⚠ 口令不符                             │ │  13/600 + CircleAlert
│ │ 输入的口令与这个库的主口令不一致。       │ │  12/muted（2 行内）
│ │ 先自查这三点：                          │ │
│ │  • 大小写与输入法（全角 / 半角）         │ │
│ │  • 粘贴是否带进了首尾空格                │ │
│ │  • 是否选对了库（当前：工作库）          │ │  ← 复用同一份"当前库"状态
│ └────────────────────────────────────────┘ │
│ ⌄ 诊断信息                                  │  12/secondary + ChevronDown
│ 忘记口令？用恢复码重置      [ 解锁 ]        │  .ts-link + 主按钮
├────────────────────────────────────────────┤
│ 新建一个本地库（保留现有库）                 │  次级链接（AC-10 兜底位）
│ 继续以预览模式使用                           │  现有 preview-mode
└────────────────────────────────────────────┘
```

### 2.2 M1-A 诊断区展开（证据区，六项台账 + 指纹）

```
│ ⌃ 诊断信息                                  │  箭头旋转 180°
│ ┌────────────────────────────────────────┐ │  1px border + bg-app
│ │ 创建时间          2026-10-28 09:14      │ │  标签 96px / 值 266px（mono）
│ │ 最近成功解锁      2026-10-30 16:01      │ │
│ │ 最近同步          2026-10-30 15:58      │ │
│ │ revision          10                     │ │
│ │ KDF 参数          scrypt N=131072 r=8 p=1│ │
│ │ 口令槽指纹        a1b2c3d4              │ │  8 位十六进制，mono
│ │ ⓘ 指纹是口令槽的单向摘要，只用于与本机  │ │  11/muted, 2 行
│ │   上次成功解锁的记录对账。               │ │
│ └────────────────────────────────────────┘ │
```
- 六项**只能**是这六项：不出现路径、主机名、IP、库 id、口令、KDF salt。
- 无记录/旧库：值位显示 `未知（旧版本库）` / `未知（本机无解锁记录）`，不填 0、不填当前时间（AC-4）。
- 展开按钮常驻于 `unlock` 模式；`create` / `recover` / `new-library-*` 模式不渲染。

### 2.3 M1-B 限流态（`throttled`）

```
│ ┌─▌试得太频繁 ──────────────────────────┐ │  同色不同图标
│ │ ⏱ 试得太频繁                           │ │  Timer
│ │ 为防离线暴力破解，连续失败后会短暂等待。  │ │
│ │ 还需等待 [ 42 ] 秒                      │ │  秒数 mono + tabular
│ └────────────────────────────────────────┘ │
│ 忘记口令？用恢复码重置      [ 解锁 ]        │  主按钮 disabled 至 0
```
- 倒计时每秒更新；到 0 时按钮自动恢复可用、块**不**自动消失（保留"刚才为什么等"的上下文），直到下一次提交。

### 2.4 M1-C 槽与本机记录不一致（`slot-record-mismatch`）

```
│ ┌─▌口令槽与本机记录不一致 ──────────────┐ │  琥珀（可行动，不是故障）
│ │ ▤ 口令槽与本机记录不一致                │ │  HardDrive
│ │ 本库的口令槽与本机上次成功解锁时记录的   │ │  逐字照 AC-2，禁止扩写
│ │ 不一致。本次解锁没有改动任何文件。       │ │
│ │ 上次成功解锁：2026-10-30 16:01          │ │  无记录 → 「未知」
│ │ [查看诊断]   [新建一个本地库（保留现有库）]│ │  次级行动，非主按钮
│ └────────────────────────────────────────┘ │
```

### 2.5 M1-D 损坏（`corrupt`）

```
│ ┌─▌库文件损坏 ──────────────────────────┐ │  唯一允许红色的一类
│ │ ⨯ 库文件损坏                           │ │  FileX
│ │ 摘要校验没有通过：文件内容已不是当初写下  │ │
│ │ 的那一份。解锁不会改动任何文件。          │ │
│ │ 查看处置说明 →                          │ │  指向 docs/VAULT-SYNC.md 的说明
│ └────────────────────────────────────────┘ │
```

### 2.6 M2 新建库二次确认（替换表单区，卡内）

```
│ ┌─ 新建一个本地库 ──────────────────────┐ │  顶边 3px 琥珀
│ │ 这是一个**新的库**，不是把现在这个库改名 │ │  13/600
│ │ 或重置。                                │ │
│ │ 1. 现有库不会被删除，也不会被改口令。    │ │  AC-15 ①
│ │ 2. 新库里看不到旧库的主机与凭据。        │ │  AC-15 ②
│ │ 3. 随时可以用原口令切回旧库。            │ │  AC-15 ③
│ │ 新库名称                                 │ │
│ │ ┌──────────────────────────────────┐   │ │  默认「本地库 2」，不取旧库路径
│ │ └──────────────────────────────────┘   │ │
│ │ 名称已存在时：⚠ 已有同名的库，换一个名称 │ │  行内错误，1 行
│ │ 取消                          [ 继续 ]  │ │  继续 disabled 当名称为空
│ └────────────────────────────────────────┘ │
```
- 三句话是**编号列表**，不可合并、不可折叠、不可缩短；`取消` 为次级、`继续` 为主按钮。
- 同时把卡头标题换成「新建一个本地库」，副标题「现有库不受影响」。

### 2.7 M3 新建库表单（`new-library-create`）

```
│ 新库名称  本地库 2                            │  只读回显（要改回 M2）
│ 新口令    ┌──────────────────────────────┐   │  ≥12 位
│ 重复口令  ┌──────────────────────────────┐   │
│ ☐ 在本机记住 7 天（仅对新库生效）             │  默认**不勾**（与旧库互不影响）
│ [警告条] 这个口令偏弱 — 再用同一口令提交一次   │  沿用既有弱口令二次确认协议
│ 取消                          [ 创建新库 ]  │
```
- 弱口令二次确认沿用现状：主进程第一次抛 `weak-passphrase`，同口令再提交一次才接受（`UnlockScreen.tsx:16-17` 注释里的既有协议）。
- **「记住本机」默认不勾**：多库场景下默认勾选会让"切回新库直接进去"变成默认行为，直接踩 anti-goal 4。旧库保持它自己已存的勾选状态。

### 2.8 M4 恢复码展示（修订：去逃逸）

```
│ 🛡 保存你的恢复码                            │
│ 这个码只显示一次。…                          │
│ ┌ XXXX-XXXX-XXXX-XXXX ──────────────────┐  │  mono，break-all
│ [下载恢复码]                 [ 我已保存 ]   │
└────────────────────────────────────────────┘
```
- **不渲染**底部的 `preview-mode` 链接（`UnlockScreen.tsx` 末尾 footer）；不响应 Esc；无关闭按钮（本屏本来也没有遮罩可点）。
- 「我已保存」是唯一出口；`data-testid` 不变（AC-18：既有 testid 不改名，只是在本态不出现）。

### 2.9 M5 变体命中告知条（解锁后，主窗口顶部）

```
┌───────────────────────────────────────────────────────────┐
│▌ ⓘ 已按「Unicode 归一化（NFKC）」修正输入编码差异。      [✕] │  高 32px，左 3px 琥珀
└───────────────────────────────────────────────────────────┘
```
- 位置：标题栏（38px）之下、主内容之上的一条普通流式元素（**不是** toast、**不是** fixed 浮层；`ErrorToast` 在右下且红色，语义与位置都不合）。
- 手动关闭，**不自动消失**（用户需要读到"按哪种变体修正"）；关闭即销毁，本会话不再出现。
- 文案里的变体名必须来自变体表枚举的中文/英文名，不允许运行时拼字符串（i18n `unlock.variant.name.*`）。

---

## 3. 交互与动效细节

### 3.1 解锁主路径（成功路径零新增元素）

1. 输入口令 → 提交（主按钮 → `unlocking`，`aria-busy`）。
2. 原样派生一次即命中 → 直接进主界面。**此路径不出现进度行、不出现归因块、不出现告知条**（AC-9：延迟零增加）。
3. 第一次失败 → 变体 ②③④ 自动尝试，期间在按钮行下方显示**一行** `正在核对输入编码差异…`（12/muted，`aria-live="polite"`）。
   - 该行由 unlock 请求的进行态驱动；tech 若不加新通道，则以「busy 且本次已失败 ≥1 次」为条件，视觉规格不变。
4. 变体命中 → 解锁成功 → 主进程静默重封槽 + 写审计 → 顶部出现 2.9 的告知条。
5. 全失败 → 按 0.1 的语义色表渲染对应归因块；同时 `passphrase-input` 清空并重新聚焦（不保留用户刚输入的错口令）。

### 3.2 提交后的焦点与输入策略

- 失败后：清空口令、`focus()` 回 `passphrase-input`、**不**自动重试、**不**预填。
- 切换库后：清空口令与恢复码、**不**沿用上一只库的输入（避免把 A 库口令递给 B 库，AC-12 的物理隔离在 UI 层也要成立）。
- 记住本机勾选态：跟随当前库的 `remember` 状态，切库即重读。

### 3.3 库切换（M6，无需重启）

- 点击当前库行 → 展开/收起列表（箭头 120ms 旋转）。≥2 库时该行右侧显示 `ChevronDown`；1 只库时无箭头、不可点。
- 点击非当前库行 → 该行进入 100ms 的 `opacity .6` 等待态，随后：
  - 有有效会话 → 直接 `unlocked`，卡片整体让位给主界面（不播任何转场动画）；
  - 无有效会话 → 卡片停留在 `unlock`，卡头副标题补一行「已切换到 <库名>」，口令框清空、聚焦。
- 切换失败（如目标库目录消失）→ 原地报错，**不**离开解锁屏，**不**改动任何库文件。
- `data-testid="library-switcher"`（≥2 库）/ `library-list` / `library-row`（`data-current="true"` 标当前）。

### 3.4 新建库路径（AC-10/14/15/16）

1. 页脚次级链接「新建一个本地库（保留现有库）」→ M2 确认区（替换表单，不弹窗）。
2. 名称校验只在本地做一次 `trim` + 空判断；重名/目录冲突由主进程 `E_INVALID_ARGUMENT(details.reason)` 回投，**必须**映射成行内 1 行错误（`unlock.newLibrary.exists`），不得冒到全局 toast。
3. 「继续」→ M3 表单 → 创建成功 → M4 恢复码 → 「我已保存」→ 进入新库（`unlocked`），旧库在列表里标记为非当前。
4. 任一步「取消」→ 回到 M1，**丢弃**已输入的名称与口令，库文件一个字节不动。

### 3.5 诊断区

- 折叠态：一行 `诊断信息` + `ChevronDown`，整行可点（44px 命中高度）。
- 展开态：六行台账 + 一行 11px 说明。数据来自 `vault:status`（见 §4.4 字段清单），**不在渲染层拼任何路径或外部命令输出**。
- 展开状态不持久化（每次进屏默认收起），避免每次启动都把台账摊在屏幕上。

### 3.6 会话还原返回值（AC-24）

- 会话还原失败 → 静默回到 `unlock` 并聚焦口令框，**不**弹归因块、**不**提示"会话过期"之类可能引发误解的文案（还原失败是正常的"需要重新输入"）。

---

## 4. 视觉规格（全部复用 token，本轮 0 新增 token）

### 4.1 复用表（不许写死数值）

| 用途 | 取值 |
|---|---|
| 卡 / 行 / 块圆角 | `--ts-radius-lg`（卡）、`--ts-radius-md`、`--ts-radius-sm` |
| 描边 | `--ts-border` / `--ts-border-strong` |
| 背景三档 | `--ts-bg-app` / `--ts-bg-surface` / `--ts-bg-elevated` |
| 文字三档 | `--ts-text-primary` / `--ts-text-secondary` / `--ts-text-muted` |
| 强调（琥珀） | `--ts-accent`（左侧竖条、链接 hover、诊断箭头） |
| 语义 | `--ts-status-warn`（bad / throttled）、`--ts-status-error`（corrupt）、`--ts-accent`（slot 不一致） |
| 字号 | `--ts-font-size-lg` 15 / `--ts-font-size-base` 13 / `--ts-font-size-sm` 12 / 11px 微元（既有字号阶梯里没有 11，允许直接写 11px，与 `.ts-vault__host-addr` 等既有微文案一致） |
| 等宽 | `--ts-font-mono` + `font-variant-numeric: tabular-nums` |
| 动效 | `--ts-motion-fast`（120ms，`tokens.css:211`） |
| 焦点 | `base.css:52` 全局 `:focus-visible` |

### 4.2 新增 class（沿用既有 BEM 与 `.ts-unlock__` 前缀，便于 QA 锚点）

```
.ts-unlock__library            库切换行（含只读变体 .ts-unlock__library--static）
.ts-unlock__library-badge      「当前」徽标（1px border-strong + 11px）
.ts-unlock__library-list       折叠列表容器（最大 176px，超出滚动）
.ts-unlock__library-row        列表行（44px；[data-current='true'] 左 2px 琥珀）
.ts-unlock__library-name       名称（flex:1，min-width:0，省略）
.ts-unlock__library-meta       日期列（78px，11px muted，tabular）
.ts-unlock__attribution        归因块外壳
.ts-unlock__attribution--warn | --notice | --error   三档语义色（见 0.1 表）
.ts-unlock__attribution-title  13/600 + 图标
.ts-unlock__attribution-body   12/muted
.ts-unlock__checks             自查清单（左缩进 16px，3 行）
.ts-unlock__countdown          倒计时数值（mono + tabular）
.ts-unlock__diag-toggle        诊断折叠行（44px 可点）
.ts-unlock__diag               折叠区（1px border + bg-app）
.ts-unlock__diag-row           标签 96px / 值 266px
.ts-unlock__diag-note          11px muted 说明
.ts-unlock__progress           一行进度文案（12px muted）
.ts-unlock__confirm            二次确认区（顶边 3px 琥珀）
.ts-unlock__confirm-list       编号列表（1/2/3）
.ts-unlock__inline-error       行内错误（1 行，status-error）
.ts-vault-notice               顶部告知条（32px，左 3px 琥珀）
.ts-vault-notice__text         单行省略
.ts-vault-notice__close        24×24 关闭按钮
```

### 4.3 i18n 键（namespace `vaultsync`，落 `src/renderer/features/vault/i18n.ts`，en 与 zh-CN **同批**补齐）

命名纪律：**新 key 里禁止出现 `reset` / `clear` / `delete` / `wipe` / `bypass` / `overwrite` 词根**（AC-17 的反向守卫按 key 与 testid 做 0 命中，写了就等于给了判红的入口）。

```
unlock.library.current            当前库 / Current library
unlock.library.switch             切换库 / Switch library
unlock.library.list               库列表（{{count}}） / Libraries ({{count}})
unlock.library.createdAt          创建 {{time}} / Created {{time}}
unlock.library.lastUnlocked       上次解锁 {{time}} / Last unlocked {{time}}
unlock.library.switchedTo         已切换到 {{name}} / Switched to {{name}}
unlock.attr.badTitle / badBody
unlock.attr.checksTitle / checks1 / checks2 / checks3
unlock.attr.throttleTitle / throttleBody / throttleWait   （throttleWait: 还需等待 {{seconds}} 秒）
unlock.attr.slotTitle / slotBody / slotLastUnlocked
unlock.attr.corruptTitle / corruptBody / corruptDoc
unlock.attr.retry                 重新输入并重试 / Re-enter and retry
unlock.diag.toggle                诊断信息 / Diagnostics
unlock.diag.createdAt / lastUnlocked / lastSynced / revision / kdf / fingerprint / note
unlock.diag.unknown               未知（旧版本库） / Unknown (older vault)
unlock.diag.fingerprintUnknown    未知（本机无解锁记录） / Unknown (no local record)
unlock.newLibrary.entry           新建一个本地库（保留现有库） / Create a new local vault (keep this one)
unlock.newLibrary.subtitle        现有库不受影响 / Your existing vault is not affected
unlock.newLibrary.lead            这是一个新的库，不是把现在这个库改名或重置。 / This is a new vault — not a rename or a reset of the current one.
unlock.newLibrary.point1 / point2 / point3      （AC-15 三句，编号 ≠ 文案）
unlock.newLibrary.nameLabel / namePlaceholder
unlock.newLibrary.cancel / continue / submit
unlock.newLibrary.exists          已有同名的库，换一个名称 / A vault with that name already exists
unlock.variant.progress           正在核对输入编码差异… / Checking input encoding differences…
unlock.variant.hit                已按「{{variant}}」修正输入编码差异。 / Input encoding was normalized with “{{variant}}”.
unlock.variant.name.nfkc / trim / stripZeroWidth
unlock.variant.dismiss            关闭 / Dismiss
```
> 既有 `unlock.recoverSubmit`（中文「重置口令」）属 S-08 恢复码既有能力的**文案值**，本轮不动；AC-17 守卫只对 key 与 testid 判 0 命中，不对既有文案值。

### 4.4 testid / 数据契约（给 QA 的锚点，逐条可断言）

新增（AC-18 只锁既有 8 个 testid 不改名，新增不受限、但必须唯一）：
`library-switcher`、`library-list`、`library-row`、`create-library-entry`、`create-library-confirm`、`create-library-confirm-points`、`new-library-name`、`new-library-continue`、`new-library-cancel`、`new-library-submit`、`unlock-attribution`（**带 `data-class`**，取值 `bad-passphrase|throttled|slot-record-mismatch|corrupt`）、`unlock-throttle-countdown`、`unlock-diag-toggle`、`unlock-diag`、`diag-created-at`、`diag-last-unlocked`、`diag-last-synced`、`diag-revision`、`diag-kdf`、`diag-fingerprint`、`unlock-progress`、`variant-notice`、`variant-notice-dismiss`。

`unlock-attribution` 用**属性**而不是"四类各一个 testid"：e2e 断言 `expect(el).toHaveAttribute('data-class', 'bad-passphrase')` 比四段文本匹配可靠（避免"整页文本被邻居满足"的假绿）。

渲染层需要但当前 `VaultStatus` 没有的字段（设计依赖，tech 按 AC 契约先行落 `src/shared/models/vault.ts`）：
`libraries: { id, name, createdAt, lastUnlockedAt, isCurrent }[]`、`revision`、`slotFingerprint: string | null`（8 位十六进制，无记录为 null）、`unlockFailure?: { class, retryAfterSeconds? }`。

### 4.5 组件复用与新增边界

- 全部复用 `.ts-btn`（primary / ghost）、`.ts-link`、`.ts-field`、`.ts-field__label`、`.ts-vault__spacer`、`.ts-vault__check`。
- 不引入任何 UI 库组件（项目现状无组件库）；库切换用原生 `<select>` 时**必须**套 `.ts-field` 的 select 样式（`HostEditor.tsx:289` 起有现成写法可照）。
- 变体告知条是唯一新增组件文件 `VaultNoticeBar.tsx`（37 行的 `ErrorToast.tsx` 同级体量），挂载点 `src/renderer/app/App.tsx`。

---

## 5. 无障碍要点（实现级）

1. 归因块 `role="alert"`；**倒计时数值用 `aria-live="off"` 独立元素**，另给一句 `aria-live="polite"` 的「还需等待，约 {{n}} 秒」按 10 秒粒度更新——否则每秒一条播报会把读屏用户轰死。
2. 诊断折叠行 `button` + `aria-expanded` + `aria-controls`；折叠区 `id` 与之对应，内容用 `<dl>`（标签 `dt` / 值 `dd`）而不是 `<p>` 拼字符串。
3. 库列表：容器 `role="listbox"` + 行 `role="option"` + 当前项 `aria-selected="true"`；键盘 ↑/↓ 移动、Enter 切换、Esc 收起并把焦点还给切换行。
4. 口令框：`type="password"`、`autoComplete="current-password"`、`spellCheck={false}`、`autoFocus`、可见 `<label>`（沿用 `.ts-field`），**不提供**"显示口令"。
5. 主按钮的忙碌态 `aria-busy="true"` 且保持 `disabled`；限流态的倒计时结束要**主动把焦点送回**输入框（否则用户以为卡住了）。
6. 颜色不是唯一通道：四类归因 = 图标 + 标题 + 行动差异；「当前库」徽标 = 文字「当前」+ 左竖条，不只靠底色。
7. 对比度：`--ts-text-muted` 在 `--ts-bg-app` 上为 11px 小字，仅用于微元信息，**不得**承载唯一关键结论（关键结论用 12/13px `--ts-text-secondary` 以上）。
8. 恢复码页：`role="alertdialog"` 语义不适用（同屏内），但必须 `aria-labelledby` 指向标题、且**没有**可关闭控件。
9. 键盘可达性：M2 确认区的三个编号要点是静态文本，不进入 tab 序；Tab 顺序 = 库切换行 → 口令 → 记住 → 诊断 → 忘记口令 → 主按钮 → 新建库 → 预览。
10. 标题栏拖拽区：`-webkit-app-region: drag` 的子树里不得出现本屏元素；回归守卫写成结构断言（从目标元素向上遍历祖先链，断言 computed `-webkit-app-region !== 'drag'`），不要只靠点一遍。

---

## 6. AC → 设计落点对照（dev / QA 检查表）

| AC | 设计落点 |
|---|---|
| AC-1 四分类 | 0.1 语义色表 + 2.3~2.5 线框 + `unlock-attribution[data-class]`；「口令错误」字样仅 `bad-passphrase`；`throttled` 必有 `unlock-throttle-countdown` |
| AC-2 指纹对账 | 2.2 第六行 + 「只陈述与本机记录不一致」的固定句 + 无记录显示"未知"且不分类；`HardDrive` 中性图标 |
| AC-3 不泄密 | 2.2 六项白名单（无路径/主机名/IP/用户名）+ 0.5 第 6 条 |
| AC-4 台账诚实 | 2.2 未知态（`未知（旧版本库）`/`未知（本机无解锁记录）`） |
| AC-10 兜底入口 | 2.1 页脚次级链接 + 状态矩阵（`uninitialized` 不渲染）；主按钮位仍属解锁 |
| AC-11 旧库零改动 | 0.5 第 2 条（默认名不取旧库）+ 3.4 步骤 4（取消即丢弃） |
| AC-12 隔离 | 3.2 切库清空输入 + 2.7 「记住本机」默认不勾 |
| AC-13 列表与切换 | 2.1 切换行 + 2.1 库列表 + 3.3（无需重启、切后 status 属新库） |
| AC-14 拒绝覆盖 | 3.4 步骤 2（行内 1 行错误，不冒全局 toast） |
| AC-15 三句话 | 2.6 编号列表，en/zh 同批；禁 `window.confirm`（0.5 第 3 条） |
| AC-16 恢复码强制 | 2.8 去逃逸（无 footer / 无 Esc / 唯一出口） |
| AC-17 零重置路径 | 0.5 第 1 条 + 4.3 key 命名纪律 + 全文不出现该类入口 |
| AC-5..9 变体（P1） | 3.1 步骤 3 的单行进度 + 2.9 一次性告知条；不新增面板、成功路径零增加 |
| AC-18 testid 不改名 | 4.4 既有 8 个 testid 原样保留，只新增 |
| AC-24 会话还原 | 3.6 静默回解锁，不弹块、不写文件 |

---

## 7. 交给 tech / dev 的三条实现注意

1. **`Mode` 扩容不要复用 `'create'`**：`uninitialized` 下的首建流程与「另开库」在文案、入口、状态上必须分开，复用会直接把 AC-10 的"出现两个创建按钮"引进来。
2. **归因块的类别来自主进程，不要在渲染层猜**：渲染层只按 `unlockFailure.class` 映射文案与图标；任何"口令里有空格就猜是输入问题"的推断都会破坏 AC-1 的互斥性。
3. **诊断区是证据区，不是调试区**：任何新增字段（路径、salt、库 id）都必须先过 0.5 第 6 条与 AC-3 的 0 命中守卫。
