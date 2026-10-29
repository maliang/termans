# Termans UI-KIT —— 视觉语汇与复制即用的片段

> 这份文档是**改界面的唯一入口**：t30 / t31 / t33 并行改各自界面时都从这里取语汇，t34 收口也按这里判。
> 三条铁律，违反其中任何一条都会被契约测试或 e2e 打回：
> 1. **先加 token 再用**：`src/renderer/styles/tokens.css` 是风格唯一真源。组件里出现 `padding: 10px`、`#f8ab24`、`rgba(...)` 就是错的。
> 2. **不许改既有 `data-testid`**：`settings-dialog` / `settings-tab-*` / `settings-close` / `open-settings` / `theme-option-*` / `locale-select` / `theme-import*` / `status-toggle-ai` 等都被契约测试与 e2e 按名字用着。**要加就加新的**。
> 3. **只改自己 scoped 目录**：跨目录要改的（弹窗外壳统一在别人文件里）发消息给 owner，不要自己动手。

---

## 1. token 分两层，别混

| 层 | 位置 | 数量 | 谁可以覆盖 | 你能新增吗 |
|---|---|---|---|---|
| **契约层（主题 token）** | `tokens.css` 的 `:root, [data-theme='dark']` 与 `[data-theme='light']` 块；真源是 `src/shared/theme.ts` 的 `THEME_TOKENS` | 52 | 用户的自定义主题（子集继承内置） | **不能**。多一个会红 `tests/contract/theme-tokens.test.ts`，且会让用户已导出的主题 JSON 导入失败 |
| **底座层（非主题 token）** | `tokens.css` 末尾的 `html { … }` 块 | 28 | 谁也不覆盖（不随主题变） | 可以，但先确认真的缺 |

为什么底座层用 `html` 而不是 `:root`：两者命中同一元素、级联完全等价；分开写是为了让「52 个主题 token」与「不随主题变的尺寸」在文件里一眼分得清（`tests/contract/theme-scope.test.ts` 会拦住「合并两层」这种顺手改动）。

### 1.0 契约层 token 全表（52 个，**会被导出/导入**）

这 52 个是主题的全部内容：内置主题、用户自定义主题、`termans-theme` 导入导出的 JSON，都是这 52 个的子集或全集。改它们的值 = 改主题；**新增/改名 = 破坏兼容**。

| 组 | token | 用途 |
|---|---|---|
| **品牌 9** | `--ts-ink-900/800/700/600` | 中性阶（暗色由深到浅，浅色反过来），语义层靠引用它 |
| | `--ts-amber` / `--ts-amber-soft` / `--ts-amber-deep` | 琥珀三档：主色 / 浅底 / 深底 |
| | `--ts-mint` | 薄荷：状态正常 |
| | `--ts-danger` | 红：错误 |
| **语义 18** | `--ts-bg-app` / `--ts-bg-surface` / `--ts-bg-elevated` / `--ts-bg-overlay` | 四级背景（应用底 / 面板 / 抬高块 / 遮罩） |
| | `--ts-border` / `--ts-border-strong` | 两级描边（细分隔线 / 控件边框） |
| | `--ts-text-primary` / `--ts-text-secondary` / `--ts-text-muted` / `--ts-text-inverse` | 四级文字（正文 ≥4.5:1；muted 只用于元信息） |
| | `--ts-accent` / `--ts-accent-strong` / `--ts-accent-contrast` | 动作色三件套：主色 / hover 深色 / 压在主色上的文字色 |
| | `--ts-focus-ring` | **legacy**：仅为兼容用户已导出的主题 JSON 保留定义，组件零使用（详见 §3） |
| | `--ts-selection` | 文本选中底色 |
| | `--ts-status-ok` / `--ts-status-warn` / `--ts-status-error` | 三态语义色 |
| **ANSI 16** | `--ts-ansi-black` … `--ts-ansi-bright-white` | xterm 的 16 色，顺序 = xterm 索引（`--ts-ansi-black/red/green/yellow/blue/magenta/cyan/white` 后接 8 个 `bright-*`） |
| **排版 5** | `--ts-font-ui` / `--ts-font-mono` | 两套字族 |
| | `--ts-font-size-sm`(12) / `-base`(13) / `-lg`(15) | 三级字号（11px 用底座的 `--ts-font-size-xs`） |
| **尺寸 4** | `--ts-radius-sm`(6) / `-md`(10) / `-lg`(14) | 圆角三档 |
| | `--ts-titlebar-height`(38) | 顶部标题栏/页签条高度 |

### 1.1 底座层 token 全表（非主题，不随主题变、不进主题 JSON）

| token | 值 | 用在哪 |
|---|---|---|
| `--ts-space-1 … --ts-space-6` | 4 / 8 / 12 / 16 / 24 / 32 px | **所有** padding/gap/margin。只有这 6 档 |
| `--ts-control-h` | 32px | 输入框、下拉、单行选择器 |
| `--ts-control-h-sm` | 28px | `.ts-btn`、`.ts-icon-btn`、工具栏里的紧凑控件 |
| `--ts-control-px` | 10px | 控件左右内边距 |
| `--ts-icon-size` / `-lg` | 14 / 16 px | lucide 图标 `size={…}` |
| `--ts-font-size-xs` | 11px | badge、元信息（不要再用 10px/11px 野值） |
| `--ts-line-height` / `-tight` | 1.45 / 1.3 | 正文 / 标题与单行控件 |
| `--ts-font-weight-strong` | 600 | 标题、主按钮、强调数字 |
| `--ts-focus-ring-width` / `-offset` / `-color` | 2px / 2px / `var(--ts-accent)` | 焦点环（见 §3） |
| `--ts-dialog-width-sm\|md\|lg` | 420 / 680 / 880 px | 三个宽度档（见 §4 对照表） |
| `--ts-dialog-max-h` | `min(80vh, 760px)` | 弹窗最大高（短窗口自动收缩，不再顶出屏幕） |
| `--ts-dialog-min-h` | `min(520px, 70vh)` | 内容极短时的最小高（避免弹窗缩成一条） |
| `--ts-dialog-pad` | 16px | 弹窗内边距 |
| `--ts-dialog-header-h` / `--ts-dialog-footer-h` | 52 / 56 px | 头部/底部条高度 |
| `--ts-dialog-radius` | `var(--ts-radius-lg)` | 弹窗圆角 |
| `--ts-dialog-backdrop` | `var(--ts-bg-overlay)` | 遮罩色（引用主题 token，随主题变） |
| `--ts-dialog-shadow` | `0 24px 60px var(--ts-bg-overlay)` | 弹窗投影 |
| `--ts-motion-fast` | 120ms | hover / 展开过渡（超过 200ms 会显得迟钝） |

### 1.2 语义色怎么用（BRAND.md 的硬规则）

| token | 语义 | 允许 | 禁止 |
|---|---|---|---|
| `--ts-accent`（琥珀） | **可操作**：主按钮、焦点环、提示符、可点链接 | 主行动按钮、focus ring | 当「成功」色用，当装饰色大面积铺 |
| `--ts-status-ok`（薄荷） | **状态正常**：已连接、同步成功 | 状态点、成功提示 | 当按钮色 |
| `--ts-status-error`（红） | **错误**：失败、危险动作 | 错误文案、危险按钮描边 | 当普通强调色 |
| `--ts-status-warn` | **需要注意**：与其余状态不同的告警（如「同步未开启」） | 警示条左边框 | 与 error 混用 |
| `--ts-text-primary/secondary/muted` | 三级文字层次 | 正文/次要/元信息 | muted 用于正文（对比度低） |

正文对比度要求 ≥ 4.5:1（`tests/contract/theme-contrast.test.ts` 对四套内置主题逐对断言）。要自定义颜色时先跑那份测试。

---

## 2. 间距：6 档就够

| 场景 | 用哪个 |
|---|---|
| 图标与文字之间 | `--ts-space-1` |
| 同一行里的两个控件 | `--ts-space-2` |
| 表单标签与输入框、按钮之间 | `--ts-space-2` |
| 列表行内边距、卡片内小间距 | `--ts-space-2` ~ `--ts-space-3` |
| 卡片/区块内边距 | `--ts-space-4` |
| 弹窗内容区边距 | `--ts-dialog-pad`（= space-4） |
| 区块之间（form section 之间） | `--ts-space-5` |
| 页面级大间距（空态、栅格 gap） | `--ts-space-6` |

```css
.ts-card {
  display: flex;
  flex-direction: column;
  gap: var(--ts-space-3);
  padding: var(--ts-space-4);
  border: 1px solid var(--ts-border);
  border-radius: var(--ts-radius-md);
  background: var(--ts-bg-surface);
}
```

---

## 3. 控件：三型按钮 + 图标按钮 + 危险动作

**只有三型**。`primary` = 一个界面里最多一个（主行动），`secondary` = 默认，`ghost` = 次级/纯图标。

```css
/* 已内置在 src/renderer/styles/base.css，直接加 class 即可，不要复制这些声明到自己文件里 */
.ts-btn {            /* secondary：描边 + 表面色，默认型 */
  display: inline-flex; align-items: center; justify-content: center; gap: var(--ts-space-1);
  height: var(--ts-control-h-sm);
  padding: 0 var(--ts-space-3);
  border: 1px solid var(--ts-border-strong);
  border-radius: var(--ts-radius-sm);
  background: var(--ts-bg-elevated);
  color: var(--ts-text-primary);
  font-size: var(--ts-font-size-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--ts-motion-fast) ease, background var(--ts-motion-fast) ease,
    color var(--ts-motion-fast) ease;
}
.ts-btn:hover:not(:disabled) { border-color: var(--ts-accent); }
.ts-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.ts-btn--primary {   /* primary：琥珀实心，用于主行动 */
  border-color: var(--ts-accent);
  background: var(--ts-accent);
  color: var(--ts-accent-contrast);
  font-weight: var(--ts-font-weight-strong);
}
.ts-btn--primary:hover:not(:disabled) { border-color: var(--ts-accent-strong); background: var(--ts-accent-strong); }

.ts-btn--ghost {     /* ghost：无底无框，hover 才出现表面 */
  border-color: transparent;
  background: transparent;
  color: var(--ts-text-secondary);
}
.ts-btn--ghost:hover:not(:disabled) { background: var(--ts-bg-elevated); color: var(--ts-text-primary); }

.ts-btn--danger {    /* 危险动作：红描边 + 红字，hover 才铺红底 */
  border-color: var(--ts-status-error);
  background: transparent;
  color: var(--ts-status-error);
}
.ts-btn--danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ts-status-error) 14%, transparent);
}
```

用法：

```tsx
<button type="button" className="ts-btn ts-btn--primary">连接</button>
<button type="button" className="ts-btn">取消</button>
<button type="button" className="ts-btn ts-btn--ghost">重置默认</button>
<button type="button" className="ts-btn ts-btn--danger">删除主机</button>
```

**图标按钮**必须同时有 `title` 与 `aria-label`（鼠标用户看 tooltip、键盘/读屏用户看无障碍名），尺寸只用两档（28×28 或 32×32）：

```tsx
<button
  type="button"
  className="ts-icon-btn"
  title={t('terminal:toolbar.search')}
  aria-label={t('terminal:toolbar.search')}
  onClick={openSearch}
>
  <Search size={14} aria-hidden="true" />
</button>
```

**危险动作必须二次确认**，两种写法任选（都要有稳定 testid 供 e2e 点）：

```tsx
// A. 系统确认框（一步，最省事；主题无关所以丑一点）
if (window.confirm(t('hosts:action.confirmDelete', { label: host.label }))) void remove(host.id)

// B. 行内确认（推荐：不打断、可断言）
{confirming ? (
  <div className="ts-confirm" role="alertdialog" data-testid="delete-host-confirm">
    <p>{t('hosts:action.confirmDelete', { label: host.label })}</p>
    <div className="ts-settings__actions">
      <button type="button" className="ts-btn ts-btn--danger" data-testid="delete-host-confirm-yes" onClick={remove}>
        {t('common:action.delete')}
      </button>
      <button type="button" className="ts-btn ts-btn--ghost" data-testid="delete-host-confirm-no" onClick={cancel}>
        {t('common:action.cancel')}
      </button>
    </div>
  </div>
) : null}
```

**禁用态长什么样**：`.ts-btn:disabled` 统一 `opacity: 0.45; cursor: not-allowed`。主按钮禁用时会露出底色，
看起来像「琥珀描边的次级按钮」——这是预期效果（禁用不该比可用更抢眼），不是样式没生效。

### 焦点环：一处定义，全局生效

```css
/* src/renderer/styles/base.css —— 已内置，不要在组件里另写 outline */
:focus-visible {
  outline: var(--ts-focus-ring-width) solid var(--ts-focus-ring-color);
  outline-offset: var(--ts-focus-ring-offset);
}
```

注意：**不要**在输入框上写 `outline: none`（`base.css` 早先的 `.ts-field input` 就是这么干的，等于把键盘用户的唯一反馈抹掉）。要弱化就用同一组 token：

```css
.ts-field input:focus-visible {
  border-color: var(--ts-accent);
  outline: var(--ts-focus-ring-width) solid var(--ts-focus-ring-color);
  outline-offset: var(--ts-focus-ring-offset);
}
```

#### `--ts-focus-ring` 是 legacy：保留定义，组件零使用

契约层还有一个 `--ts-focus-ring`（`src/shared/theme.ts:39`，暗色 `rgba(248,171,36,.55)`、浅色 `rgba(200,106,8,.45)`）。
**不要删它**，也不要再用它：

- 它是 52 个主题 token 之一，会进用户导出的主题 JSON。删掉字段 = 用户既有主题文件导入时缺 token，
  `themeTokenSetSchema` 直接判失败（M-08 那类回归）。所以定义必须留着。
- 但它和底座的 `--ts-focus-ring-color`（实心 accent）**视觉不同**：旧的是半透明光晕，新的是实线。
  两者混用会出现「按 Tab 走一遍，有的控件是光晕、有的是实线」——这正是「不像一个产品」的典型残留。
- 裁定（captain，t34）：**保留定义、组件零使用**。新代码一律三元组；`--ts-focus-ring` 只在
  `tokens.css` 里继续声明，供旧主题 JSON 反序列化。

2026-10-29 `grep -rn "outline:" src/renderer --include=*.css` 的现状（已收干净）：

| 位置 | 形态 | 说明 |
|---|---|---|
| `src/renderer/styles/base.css:53` `/ :529` | 三元组 | 全局 `:focus-visible` + `.ts-field input:focus-visible` |
| `src/renderer/styles/base.css:137` | 三元组 | `.ts-sidebar__search:focus-within`（输入框无边框，环画在 wrapper 上） |
| `src/renderer/styles/base.css:372` | 三元组 | `.ts-ai-panel__composer textarea:focus-visible`（此前只有 `outline:none`，键盘用户零反馈） |
| `src/renderer/theme/theme.css:244` | 三元组 | `.ts-settings__input/select/textarea:focus-visible` |
| `src/renderer/app/layout/statusbar.css:82` | 三元组 | 状态栏按钮（原硬编码 `2px` + legacy 色） |
| `src/renderer/features/terminal/terminal.css:59` | 三元组 | 终端工具栏图标按钮（同上） |
| `src/renderer/features/terminal/terminal.css:227` | `box-shadow: 0 0 0 var(--ts-focus-ring-width) var(--ts-focus-ring-color)` | 终端搜索框（滚动容器内，环画在框内才不被裁） |
| `src/renderer/features/vault/vault.css:632` | 三元组 | 主机编辑器关闭按钮（同上） |
| `src/renderer/features/vault/vault.css:737` | `outline: var(--ts-focus-ring-width) solid var(--ts-accent)` | 取色块**选中态**（不是焦点环，故意用实心 accent） |
| `terminal.css:222` / `base.css:146` / `vault.css:71` | `outline: none` | 三个无边框输入框：前者配 `box-shadow` 环，后两者环画在 wrapper（`base.css` 已修，`vault.css` 待 vault-sync） |

自查句（写 PR / 评审时直接引用）：**组件 CSS 里出现硬编码的 outline 宽度或颜色（如 `outline: 2px solid var(--ts-focus-ring)`），视为不合格。**

---

## 4. 弹窗外壳：四个弹窗一套规格

现在有四个弹窗，此前各写一套内边距与标题样式，这是「同类界面不像一个产品」的主因：

| 弹窗 | 组件 | 宽度档 | 现状 |
|---|---|---|---|
| 设置 | `src/renderer/theme/SettingsDialogHost.tsx` | `lg` (880) | 已统一（四页签 + 内容驱动高度），见 §4.1 |
| 解锁屏 | `src/renderer/features/unlock/UnlockScreen.tsx` | `sm` (420) | 非弹窗（常驻全屏），不上遮罩 |
| 主机编辑器 | `src/renderer/features/vault/HostEditor.tsx` | `md` (680) | 待 t31/t34 按本规格收敛（仍在侧栏内联渲染） |
| Git 同步 | `src/renderer/features/vault/SyncPanel.tsx` | `md` (680) | **已并入设置页「同步」页签**（`embedded` 模式），独立弹窗入口已删除 |
| 安全 | `src/renderer/features/vault/VaultSecurityPanel.tsx` | `sm` (420) | **已并入设置页「安全」页签**（`embedded` 模式），独立弹窗入口已删除 |

> 结论：产品里现在只剩**一个**真正的模态（设置）。同步与安全是它的两个页签——
> 同类设置三种入口（侧栏弹窗 / 状态条 ⚙ / 菜单「设置…」）已经收敛成一处的三个门。

**规格**（`src/renderer/theme/theme.css` 里的 `.ts-dialog*` 就是这一套，其他弹窗照抄结构、复用同名类）：

```css
.ts-dialog {                     /* 遮罩层：铺满窗口、居中、点遮罩关闭 */
  position: fixed; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  padding: var(--ts-space-5);
  background: var(--ts-dialog-backdrop);
  backdrop-filter: blur(2px);
}
.ts-dialog__panel {              /* 面板：头 + 页签 + 内容（可滚动）+ 底 */
  display: flex; flex-direction: column;
  width: min(var(--ts-dialog-width-lg), 100%);
  min-height: var(--ts-dialog-min-h);
  max-height: var(--ts-dialog-max-h);
  overflow: hidden;
  border: 1px solid var(--ts-border-strong);
  border-radius: var(--ts-dialog-radius);
  background: var(--ts-bg-surface);
  box-shadow: var(--ts-dialog-shadow);
  color: var(--ts-text-primary);
}
.ts-dialog__header {             /* 高度固定，标题 + 关闭 × */
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--ts-space-3);
  min-height: var(--ts-dialog-header-h);
  padding: 0 var(--ts-space-4);
  border-bottom: 1px solid var(--ts-border);
}
.ts-dialog__title { margin: 0; font-size: var(--ts-font-size-lg); font-weight: var(--ts-font-weight-strong); }
.ts-dialog__body {               /* 内容区：唯一可滚动的地方 */
  flex: 1; min-height: 0; overflow: auto;
  padding: var(--ts-dialog-pad);
}
.ts-dialog__footer {             /* 底部动作条：右对齐，主行动在最右 */
  display: flex; align-items: center; justify-content: flex-end; gap: var(--ts-space-2);
  min-height: var(--ts-dialog-footer-h);
  padding: 0 var(--ts-space-4);
  border-top: 1px solid var(--ts-border);
}
```

**验收口径（t34 收口按这个判）**：
1. 四个弹窗的标题字号/头部高度/内边距/圆角/遮罩一致（明细见上表）；
2. 内容比窗口高时**只有 `.ts-dialog__body` 滚动**，头部与底部按钮永远可见；
3. 窗口变矮时弹窗跟着缩（`max-height: var(--ts-dialog-max-h)`），不会顶出屏幕；
4. 内容不满一屏时底部不出现固定高度的空白条（不要给 panel 写死 `height`）；
5. `Escape` 关闭、点遮罩关闭、右上 `×` 关闭三条都要在（`data-testid` 用 `*-close`）。

---

### 4.1 内嵌面板：`embedded` 契约

「一个页面 + 两个旧弹窗」是最容易长出两套视觉的做法。约定：**面板组件拥有内容，宿主拥有外壳**。

现状（t37 之后）：**安全 / 同步面板在界面上只以 `embedded` 形态出现在设置页签里**，
独立弹窗形态已没有 UI 入口——侧栏那两个按钮在 `44e6bce` 改成了
`openSettingsDialog('security' | 'sync')`；`HostSidebar.tsx:49-50` 里 `showSync` / `showSecurity`
两个状态与 `:371-372` 的独立弹窗渲染仍留在代码里（另一个清理卡处理），但恒为 `false`。

```tsx
// 面板侧（features/vault/SyncPanel.tsx、VaultSecurityPanel.tsx 已实现）
export interface SyncPanelProps {
  embedded?: boolean            // true = 只出内容：不渲染弹窗外壳、不渲染自己的 <h2>、不渲染「取消」
  onClose?: () => void          // embedded 时可省
}
return embedded
  ? <section className="ts-vault__card ts-vault__card--embedded" data-testid="sync-panel">{body}</section>
  : <div className="ts-dialog"><section className="ts-dialog__panel ts-dialog__panel--md" role="dialog">…</section></div>
//       ↑ 独立弹窗形态也走 kit 的 `.ts-dialog` 外壳（t37 把四处 `.ts-vault__modal` 全迁过来了）

// 宿主侧（theme/SettingsDialogHost.tsx）
if (tab === 'sync') {
  return (
    <div data-testid="settings-embed-sync">
      <SyncPanel embedded onClose={closeSettingsDialog} />
    </div>
  )
}
```

两条纪律：

1. **面板不要再自己加内边距/标题**——外壳的 header、padding、滚动条都归宿主，否则内嵌后会出现双层标题与双份留白。
2. **不要为「抹平旧外壳」写兜底 CSS**。t32 时这里曾有一层 `.ts-settings__embed .ts-vault__modal{…}`
   把旧遮罩抹平，注释写着「embedded 模式做好后这层只保留间距即可」——
   等 embedded 真加好、`.ts-vault__modal` 又从 `vault.css` 删掉之后，这条规则**匹配不到任何元素**，
   注释还描述着一个已经不存在的架构（t40 清掉）。去外壳的职责现在只有一个地方：
   `vault.css` 的 `.ts-vault__card--embedded`。**注释里出现的类名，必须当下就 `grep` 得到使用者**。

## 5. 表单

```tsx
<label className="ts-field" htmlFor="ts-host-port">
  <span className="ts-field__label">
    {t('hosts:editor.port')}
    <span className="ts-field__required" aria-hidden="true"> *</span>
  </span>
  <input id="ts-host-port" className="ts-input" inputMode="numeric" required aria-required="true" />
  <span className="ts-field__hint">{t('hosts:editor.portHint')}</span>
</label>
```

规则：
- **必填标记**用 `*` + `required` + `aria-required`（不要只在 placeholder 里说）；
- **规则不要写在 placeholder 里**（`placeholder="留空表示保留已保存的密码"` 是反例：用户分不清「空」与「有密码」）；
- 校验失败时 `aria-invalid="true"` + 一行 `.ts-field__error`，颜色用 `--ts-status-error`；
- 输入框高度统一 `var(--ts-control-h)`，左右内边距 `var(--ts-control-px)`。

---

## 6. 迁到新语汇：对照表

| 旧写法 | 新写法 | 说明 |
|---|---|---|
| `padding: 8px 10px` | `padding: var(--ts-space-2) var(--ts-space-3)` | 6 档阶梯 |
| `gap: 6px` | `gap: var(--ts-space-1)`（4）或 `--ts-space-2`（8） | 没有 6 这一档 |
| `height: 26px`（图标按钮） | `var(--ts-control-h-sm)`（28） | 两档：28 / 32 |
| `font-size: 11px` | `var(--ts-font-size-xs)` | |
| `outline: 2px solid var(--ts-focus-ring)` | `outline: var(--ts-focus-ring-width) solid var(--ts-focus-ring-color)` | 环色改实心 accent（`--ts-focus-ring` 转 legacy，见 §3） |
| `box-shadow: 0 0 0 3px var(--ts-focus-ring)` | `outline` + `outline-offset` | ring 只在 focus-visible 上 |
| `border-radius: 8px` | `var(--ts-radius-sm)`(6) 或 `--ts-radius-md`(10) | |
| 组件里写 `#` 色值 | 语义 token（见 §1.2） | |

---

## 7. 自查清单（提交前逐条勾）

- [ ] 新增的视觉常量先在 `tokens.css` 里加 token，组件里只写 `var(--ts-*)`
- [ ] 没有新增/修改既有 `data-testid`
- [ ] 每个图标按钮都有 `title` + `aria-label`
- [ ] 危险动作有二次确认，且有 `data-testid` 供 e2e 点
- [ ] 键盘 Tab 走一遍，焦点环清晰可见（暗色/浅色两套主题各看一次）
- [ ] `npx vitest run tests/contract` 全绿；`pnpm typecheck` exit 0
- [ ] 改前/改后截图存 `docs/assets/ui-audit/after-<你的模块>-*.png`

## 8. 本轮落地状态（t32，供 t34 收口复核）

| 审计项 | 状态 | 证据 |
|---|---|---|
| #13 设置入口收敛 | ✅ 四页签（外观/AI/安全/同步）；侧栏「同步」「安全」两个按钮改成 `openSettingsDialog('sync' \| 'security')`；安全/同步面板以 `embedded` 模式内嵌 | `src/renderer/theme/SettingsDialogHost.tsx`、`src/renderer/theme/settings-dialog.ts` 的 `VISIBLE_SETTINGS_TABS` |
| #14 主题卡 `\$` → `>_` | ✅ 内联 SVG（22×12，两条 path），颜色跟随各主题 accent；四套内置主题名走 `settings:theme.builtinName.*` 本地化 | `src/renderer/theme/AppearanceSettings.tsx` 的 `ThemeMark` / `cardLabel` |
| #15 导入加文件选择 + 拖放 | ✅ `input[type=file]`（视觉隐藏、可聚焦）+ `.ts-dropzone` 拖放 + 文件名回显；读文本只在渲染进程，不新增 IPC | `data-testid`：`theme-import-file` / `theme-import-drop` / `theme-import-file-name` |
| #16 内容区自适应 | ✅ 面板 `max-height:var(--ts-dialog-max-h)`、`min-height:var(--ts-dialog-min-h)`、只有 `__body` 滚动；实测 1320×860 → 688px 高、缩到 1000×560 → 480px 跟着缩 | `docs/assets/ui-audit/after-theme-settings*.png` |
| #19 交互语汇 | ✅ 按钮三型 + 图标按钮 + 危险动作 + 焦点环（§3） | `src/renderer/styles/base.css` |
| #20 间距/控件 token | ✅ 底座层 28 个 token（§1.1），`:root` 的 52 个契约 token 一个没动 | `src/renderer/styles/tokens.css`、`tests/contract/theme-scope.test.ts` |

仍未做（归属别人，t34 复核时按 §7 清单逐条看）：#6 侧栏主机行溢出（`features/vault`）、#1/#2/#3 页签条与状态栏层次（`features/tabs`、`app/layout`）、#17/#18 AI 面板（`features/ai`）。
