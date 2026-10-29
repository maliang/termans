# UI / UX 审计与整改清单

> 出这份清单的方式：captain 用 Playwright 起真实应用（`--disable-gpu`、1320×860、3 台假主机 + 一台进程内 ssh2 夹具），把 7 个关键界面逐个截图后人工核对。截图见 `docs/assets/ui-audit/`。
> 结论先说：**功能是全的，界面是「能用」但不是「好用」** —— 主要问题不在缺东西，而在**同一件事有三种摆法**（入口分散、控件风格不一、状态无层次）。

## 收口状态（t34，2026-10-29）

**测的是哪份产物**：干净工作树里检出 `83cf76b`（`git worktree add /tmp/t34-head 83cf76b --detach`），
在**那份副本**里 `electron-vite build` 后跑截图脚本；侧栏高度修复（§六 #21）之后重建再出一轮图。
截图脚本按 `docs/TESTING.md` 的规矩放在仓库外（`/tmp/t34-head/scripts/shots/`），**没有进 `e2e/`**。

- 基线（同一脚本、同一夹具）：`git rev-parse --short HEAD` = `83cf76b`，17 张截图全部落到 `docs/assets/ui-audit/after-final-*.png`。
- **口径**：表格里「已修」只用于「代码已落地、截图上看得见效果」的项。凡是本轮只补了文案 key、
  组件还没接线的（例如 §五 #27 与 §六 里点名 t30 的项），一律写「key 已就位，接线在 t36」——
  不能把「key 有了」写成「已修」，那等于把缺陷写成成果。
- 20 条里 **19 条已修、1 条部分修**（#2 的「状态信息塞在工具栏」随 t30 改动移入状态栏，工具栏中间位留白已消除，
  但工具栏与页签条的间距仍由各自 padding 决定，没有共用 token —— 见 §六 #22）。
- t34 收口时**新发现 6 条**（§六），其中 #21（侧栏高度只到内容底部）我在本轮直接修掉，其余按「谁的目录谁改」发了请求。

---

## 一、布局与信息架构

| # | 现象（截图证据） | 影响 | 优先级 | 状态 | 证据 |
|---|---|---|---|---|---|
| 1 | 「新建页签」的 `+` 浮在窗口**最右上**，离最后一个页签 1000+ px，且比页签行高一格（`03-terminal.png` 右上） | 用户找不到新增入口，误以为是窗口按钮 | P0 | **已修** | `3bb0197`（t30）：`+` 贴最后一个页签之后；`after-final-03-hosts.png` |
| 2 | 工具栏左侧 4 个纯图标无文字、无 tooltip；右侧 `A- A A+` 与它们同一行；中间「web-prod-01 · 131×40 · DOM · 已连接」居中漂浮 | 图标含义不可猜；状态信息塞进工具栏，与页签争位置 | P0 | **部分修** | 图标补 `title`+`aria-label`（`3bb0197`）；连接状态移到状态栏左侧（`after-final-09-terminal-connected.png` 底部）。残留：工具栏/页签条垂直间距各写各的（§六 #22） |
| 3 | 状态栏一行到底：`Termans 45.1.0  darwin/arm64  加密包: unlocked  同步未开启  页签: 1`，无分隔、无层次 | 扫不出重点；「同步未开启」是应该有行动的告警却淹没在版本号里 | P0 | **已修** | `3bb0197` 三段（左＝当前会话/加密库/同步态，右＝页签数/版本/AI/设置）+ `5cdb33e` 高度 24→28px；`after-final-15-hosts-narrow.png` |
| 4 | 主机库底部 4 个按钮：3 图标 + 一个文字按钮「Git」；锁按钮被甩到最右 | 同一组操作被拆成两处、两种语汇 | P1 | **已修** | `7d7d431`（t31）：分两组（本机数据操作 / 同步与安全）+ 分隔线，全图标按钮带 `title`；`after-final-03-hosts.png` 左下 |
| 5 | 搜索行右侧同时有 `+`（新建）与「文件夹」图标（导入），两个新增入口并排且后者图标像信用卡 | 不知道点哪个；导入是卖点却用最弱的图标 | P1 | **已修** | `6b674ad`+`7d7d431`：搜索行只留 `+`，导入收进空态（`host-empty-import` / `term-empty-import`） |
| 6 | **侧栏 260px 时主机行溢出**：地址整列被裁、无省略号、底部出现横向滚动条 | 信息丢失 + 不该有的横向滚动条 | **P0（bug）** | **已修** | `7d7d431`（`overflow-x:hidden` + `.ts-vault__host-addr` 省略号）；`after-final-15-hosts-narrow.png`（260px，长主机名 `very-long-hostname.interna…`） |
| 7 | 空会话态只有一行灰字「当前没有会话 / 在左侧选择一台主机，或按 ⌘T 新建页签。」 | 冷启动第一屏没有可点的行动按钮 | P0 | **已修** | `3bb0197`：图标 + 标题 + 说明 + 主行动「新建页签 ⌘T」+ 次行动「快速连接」；`after-final-02-empty.png` |

## 二、主机编辑器（`after-final-04-host-editor.png`）

| # | 现象 | 影响 | 优先级 | 状态 | 证据 |
|---|---|---|---|---|---|
| 8 | 密码框把规则写在 **placeholder** 里 | 用户不知道是覆盖还是保留 | P1 | **已修** | `7d7d431`：规则改成字段下方 `.ts-field__hint`（`HostEditor.tsx:365` `editor.passwordHint`），placeholder 只留「输入密码」。**口径**：已保存状态是按 `credentialRef !== null` 推断（`src/shared` 无「读取已存密码」通道，安全设计如此），故提示写「已保存密码 · 留空则保留」而不渲染掩码 |
| 9 | 必填项无必填标记；弹窗无关闭 `X`，**Esc 关不掉** | 只有「取消」一条退路 | P1 | **已修** | `HostEditor.tsx:176` `requiredLabel()`（`*` + `aria-required`，:231）、`:95` Escape 关闭、右上 `X`（`host-editor-close`）；`after-final-04-host-editor.png` 标题行右侧 |
| 10 | 「转发 SSH Agent」孤零零在备注下面，离认证区块 200+ px | 与认证相关的开关跑到表单末尾 | P1 | **已修** | `7d7d431`：并入「认证」`<section>`（`HostEditor.tsx:387`，代码注释点名 t31/#10） |
| 11 | 颜色只有一个 12px 色块，无 label、无预设；跳板机说明是超长单行挤在字段之间 | 色块不知道点开会怎样；说明文字压扁布局 | P2 | **已修** | `7d7d431`：7 个预设色块 + 「无颜色」文字项（`role="group"` + `aria-label`，`HostEditor.tsx:424-440`）；跳板机改整行 + 一句短说明、全文进 `title`（`:413`） |
| 12 | 680px 两列网格里「端口」独占左列、右列空着 | 像漏了一格 | P2 | **已修** | 端口改为与「用户名」同行（网格自动流），并留 `ts-field--wide/--full` 修饰类（`vault.css:365-367`） |

## 三、主题与设置（`after-final-05-settings-appearance.png`）

| # | 现象 | 影响 | 优先级 | 状态 | 证据 |
|---|---|---|---|---|---|
| 13 | 设置只有「外观 / AI」两个页签，而「安全」「同步」是另外两个独立弹窗 | 同类设置三种入口 | P1 | **已修** | `f0e8398`（`security`/`sync` 页签内嵌 vault 的 `embedded` 面板，删掉占位组件）+ `44e6bce`（侧栏两个入口改为 `openSettingsDialog('security'|'sync')`）；`after-final-07-settings-security.png` / `after-final-08-settings-sync.png` |
| 14 | 主题卡缩略图画 `$`，与产品标识 `>_` 不一致；主题名在中文界面不本地化 | 品牌细节不一致；中英混排 | P1 | **已修** | `b10b057`：`ThemeMark`（inline SVG `>_`）+ `settings:theme.builtinName.*`（中文＝Termans 深色/午夜/浅色/高对比）；`after-final-05-settings-appearance.png` |
| 15 | 导入主题只有 textarea 贴 JSON，没有文件选择/拖放 | 卖点门槛过高 | P2 | **已修** | `b10b057`：拖放区 `theme-import-drop` + `input[type=file]` `theme-import-file` + 文件名回显；textarea 保留作粘贴兜底 |
| 16 | 弹窗内容区不随窗口高度自适应，底部大片空白 | 观感松散 | P2 | **已修** | `b10b057`：`--ts-dialog-max-h`/`--ts-dialog-min-h`(min(360px,56vh)) + body `flex:1;overflow:auto`；实测短页签底部留白 16/19/16px（t32 的 `.verify-kit2.mjs` 量的是 body 最后一个子元素底边） |

## 四、AI 面板（`after-final-10-ai-empty.png`）

| # | 现象 | 影响 | 优先级 | 状态 | 证据 |
|---|---|---|---|---|---|
| 17 | 头部下拉 + `+` + `⟳` 两个纯图标挤在一起，无标签无 tooltip | 同 §1 图标问题 | P1 | **已修** | `ca096c4`（头部重排）+ `b7929b4`（图标按钮 `title`+`aria-label`，`AiPanel.tsx:272-307`） |
| 18 | 空态三行长句在窄栏里断成「…回到这 里。」 | 文案碎、可读性差 | P2 | **已修** | `ca096c4`：空态改短句 + 分条（owner 报告「calm empty states」），文案在 `src/locales/*/ai.json` |

## 五、全局一致性

| # | 现象 | 影响 | 优先级 | 状态 | 证据 |
|---|---|---|---|---|---|
| 19 | 交互控件没有统一的 hover / focus-visible / active 语汇；图标按钮多数无 tooltip；焦点环不成体系 | 键盘与鼠标用户都缺反馈 | P1 | **已修** | 按钮三型 + `--danger` + 图标按钮规约写进 `docs/UI-KIT.md` §3（`b10b057`）；焦点环统一三元组、`--ts-focus-ring` 转 legacy（`83cf76b`，全仓 `outline:` 收干净）；各功能 owner 在 `7d7d431`/`5cdb33e`/`b7929b4` 里补齐 tooltip |
| 20 | 间距、圆角、控件高度各组件自定，没有 spacing / control-height token | 「风格不统一」的根因 | P1 | **已修** | `b10b057`：28 个底座 token（`tokens.css` 的 `html {}` 块）+ `tests/contract/theme-scope.test.ts` 钉住「底座的别搬进 `:root`」 |

---

## 六、t34 收口时新发现（本轮新增）

| # | 现象（实测） | 影响 | 状态 | 归属 / 请求 |
|---|---|---|---|---|
| 21 | **侧栏高度只画到内容底部**：`getBoundingClientRect().height` = 265px，而它所在网格行是 836px，下方露出 `--ts-bg-app`，看起来像「侧栏断了」 | 观感断裂；也让人误以为是配色问题 | **已修（本轮）** | 我改的 `src/renderer/styles/base.css`：`.ts-sidebar-host`（外壳 `HostLibraryPane.tsx:32` 那层 `<div>`，原来没有任何 CSS）改成 flex 容器 + `.ts-sidebar-host > .ts-sidebar { flex: 1 }`。修复后实测 836px（同一探针脚本），`after-final-15-hosts-narrow.png` 可见页脚贴底 |
| 22 | 工具栏与页签条、状态栏与工作区的垂直间距各写各的（`tab-strip` / `term-toolbar` / `statusbar` 三处 padding 字面量），没有共用 token | 窗口缩放时三处比例会飘 | **待 t30** | 建议 `--ts-tabstrip-h` / `--ts-toolbar-h` 两个底座 token（可放 `html {}` 块），由我加 token、t30 换用 |
| 23 | `.ts-vault__modal`（4 处：`HostEditor.tsx:189`、`SyncPanel.tsx:238`、`VaultSecurityPanel.tsx:156`、`HostSidebar.tsx:326`）与 `.ts-dialog` 数值等价但各写一遍（`padding:24px; background: var(--ts-bg-overlay); backdrop-filter: blur(2px)`） | 下一个人改一处忘一处就会分裂 | **待 t31** | 直接把根节点换成 `.ts-dialog` + `.ts-dialog__panel--md`（同一套 `--ts-dialog-*`），或至少 `@extend` 不了就删掉重复值 |
| 24 | `.ts-vault__search input` 只有 `outline: none`，**没有任何替代焦点样式** —— 键盘用户在这个搜索框上零反馈（`vault.css:71`） | 可达性缺陷 | **待 t31** | 参照我在 `base.css` 的做法：环画在外层 `.ts-vault__search:focus-within` 上（`base.css:134-139`） |
| 25 | 主机行「双击进编辑」**实际很难触发**：第一次 click 会 `onSelect` → 触发重渲染（`ts-vault__host--active` 换类）→ 第二次 click 落在新节点上，`dblclick` 没派发。截图脚本里 `dblclick()` 直接失败，只能改走「+ 新建」 | 用户会以为「双击没反应」 | **待 t31** | 用 `event.detail === 2` 在 `onPointerDown` 里判定，或把选中态从 class 换成不重建节点的 `data-active`；也可以给主机行加显式「编辑」入口 |
| 26 | 主机编辑器「标签」输入框下方有一个**孤立的小横线**（`after-final-04-host-editor.png` 标签列下方，距输入框约 34px） | 看起来像坏掉的控件 | **待 t31** | 疑似自定义色块那行的 `<input type="color">` 或空 `.ts-field__hint` 占位，需要 owner 定位 |
| 27 | 状态栏把 store 的原始英文状态直接插进中文句子：「加密包：unlocked」 | 中英混排 | **key 已就位（三个态齐全），接线在 t36** | `src/locales/*/common.json` 已有三态 `state.vaultUninitialized/vaultLocked/vaultUnlocked`（`加密包：未初始化/已锁定/已解锁`，en `vault: not set up/locked/unlocked`），`terminal:tab.confirmClose.bodySameHost` 也已加（`「{{title}}」仍有活动会话…`，页签名 == 主机名时用）；`StatusBar.tsx:38` 里的 `VAULT_UNINITIALIZED_KEY` 常量拼接等待 t36 换回字面量 |
| 28 | 主机行的行内铅笔按钮落在 hover pill **之外**（`after-vault-10-host-row-edit.png` 可见：pill 只裹住 label + 地址，铅笔在 pill 右侧） | 观感不齐，不影响可用性 | **已知观感项，主动不做（captain 裁定）** | 修它要把 pill 的范围与行内动作重新排布，属改版级改动；本轮冻结前不动的清单里已含它。登记在此**是为了防止以后被当成"漏修"重新开卡**——它不是漏的，是主动不做的 |

---

## 整改原则（写进每张任务卡）

1. **不许改 `data-testid`**：e2e 全部按 testid 定位，改一个名字就是一片红。要加就加新的。
2 `src/renderer/styles/tokens.css` 是风格唯一真源：新增视觉常量一律先加 token，再在组件里 `var(--ts-*)`。
3. 只改自己 scoped 目录；跨目录需要改的（例如统一弹窗外壳），由该目录 owner 提出、由对应 owner 改。
4. 每张卡都要**截图对比**（改前/改后存 `docs/assets/ui-audit/after-*`），不接受「应该好看了」的口头结论。
5. 冻结契约与安全语义不动：锁定态隐藏、AI 二次确认、密码不回显这些行为在改版中必须保持，并各留一条断言。

## 附：t34 截图清单与未取证项

`after-final-01-unlock` / `02-empty` / `03-hosts` / `04-host-editor` / `05-settings-appearance` /
`06-settings-ai` / `07-settings-security` / `08-settings-sync` / `09-terminal-connected` /
`10-ai-empty` / `12-newtab-picker` / `13-close-tab` / `15-hosts-narrow` / `16-terminal-narrow` /
`17-theme-light` / `18-theme-contrast` / `19-settings-light`（共 17 张，1320×860；15/16 是 260px 侧栏；
17/18 是浅色与高对比主题的可读性核对）。

**未取得截图的一处**：多行粘贴确认弹窗（`paste-dialog`）。渲染进程 `navigator.clipboard.writeText` 被权限拒绝
（`NotAllowedError: Write permission denied`），改从主进程 `app.evaluate(({clipboard}) => clipboard.writeText(...))`
写系统剪贴板后，在终端区域右键（`XtermSurface.tsx:71` 的 `contextmenu` → `requestPaste`）仍未弹出确认框，
三次尝试均无弹窗，因此**这一项没有截图**，只有代码证据：`PasteWarningDialog.tsx:47-80` 已改用
`.ts-dialog__panel--md` + `__header/__body/__footer`。请 qa 在 t8 里补一条能驱动它的用例（或在 `docs/TESTING.md` 记下这个限制）。
