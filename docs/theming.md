# 主题系统（Theming）

> 归属：`src/renderer/theme/**` + `src/renderer/styles/tokens.css`（变量契约由 architect 冻结，本模块只消费）。
> 相关契约：`src/shared/theme.ts`、`docs/SPEC.md` M-01…M-08、`design/BRAND.md`。

## 1. 三层结构与「单一事实来源」

```
src/shared/theme.ts      52 个 --ts-* token 名 + zod schema（冻结，改名 = 破坏契约）
src/renderer/styles/tokens.css   :root(深色) / [data-theme='light'](浅色)  —— 仅用于「首屏第一帧」
src/renderer/theme/builtin.ts   4 套内置主题的 token 覆盖集  —— 运行期唯一事实来源
```

React 挂载后由 `applyThemeToDocument()` 把 52 个变量以**内联样式**写到 `<html>`，内联样式优先级高于
`tokens.css` 的 `:root`/`[data-theme]` 块，因此：

- 首屏（JS 未执行）拿到的是 `tokens.css` 的深色/浅色值 → 无白屏、无闪烁；
- 之后一切以 `builtin.ts` 为准 → 主题可以是任意值，不受 CSS 文件限制。

**为什么 `tokens.css` 不能删**：React 首帧之前、以及任何 CSS-only 场景（例如后续新增的静态页面）
都需要一套合法值，否则 `var(--ts-bg-app)` 全部落空、界面发白。

**漂移防线**：`tests/contract/theme-builtin.test.ts` 会解析 `tokens.css` 的两个块，逐 token 与
`BUILTIN_THEMES` 里 `termans-dark` / `termans-light` 的原始值比对（含 `var(--ts-ink-*)` 这类别名形态）。
改了 CSS 不改 TS（或反过来）测试立刻红——避免「首屏一套色、运行期另一套色」这种只在启动瞬间可见的 bug。

## 2. token 清单（52 个）

分五组（`src/renderer/theme/tokens.ts` 的 `TOKEN_GROUPS`，主题编辑器按这个分组渲染）：

| 组 | 数量 | token |
| --- | --- | --- |
| brand | 9 | `--ts-ink-900` `--ts-ink-800` `--ts-ink-700` `--ts-ink-600` `--ts-amber` `--ts-amber-soft` `--ts-amber-deep` `--ts-mint` `--ts-danger` |
| semantic | 18 | `--ts-bg-app` `--ts-bg-surface` `--ts-bg-elevated` `--ts-bg-overlay` `--ts-border` `--ts-border-strong` `--ts-text-primary` `--ts-text-secondary` `--ts-text-muted` `--ts-text-inverse` `--ts-accent` `--ts-accent-strong` `--ts-accent-contrast` `--ts-focus-ring` `--ts-selection` `--ts-status-ok` `--ts-status-warn` `--ts-status-error` |
| ansi | 16 | `--ts-ansi-black` … `--ts-ansi-bright-white`（顺序 = xterm 的 ANSI 0…15） |
| typography | 5 | `--ts-font-ui` `--ts-font-mono` `--ts-font-size-sm` `--ts-font-size-base` `--ts-font-size-lg` |
| metric | 4 | `--ts-radius-sm` `--ts-radius-md` `--ts-radius-lg` `--ts-titlebar-height` |

另有两个**非契约**布局变量，只存在于 `tokens.css`（主题不覆盖、编辑器不展示）：
`--ts-sidebar-width: 264px`、`--ts-ai-panel-width: 360px`。

### 2.1 底座 token 不在这 52 个里（别搬进来）

间距、控件高度、焦点环、弹窗尺寸、动效时长这类**不随主题变**的常量，放在 `tokens.css` 末尾的
`html { … }` 块（28 个，清单与用途见 [docs/UI-KIT.md](./UI-KIT.md) §1.1）。为什么不放进 `:root`：

- 这 52 个是**主题可覆盖集合**，会随主题 JSON 导出/导入（SPEC M-08）。把 `--ts-space-*` 混进去，
  用户早先导出的主题文件就会因为「缺一批新 token」而导入失败；
- `tests/contract/theme-scope.test.ts` 把这条决定钉住了：`:root` 的 `--ts-*` 集合必须**恰好**等于
  `THEME_TOKENS ∪ {--ts-sidebar-width, --ts-ai-panel-width}`，`html` 块里的 token 名字只允许命中
  底座前缀白名单（`--ts-space-` / `--ts-control-` / `--ts-dialog-` / `--ts-focus-ring-` …）。

加常量时的顺序：**先判断它会不会随主题变**。会 → 改 `src/shared/theme.ts` 的 52 个清单（跨成员，
需要 architect 同意 + 四套内置主题补齐 + 契约测试同步改）；不会 → 加到底座块。

### 使用规则（组件侧）

1. **组件里禁止写死颜色**。`tests/contract/theme-tokens.test.ts` 会扫描 `tokens.css` 里的裸色值；
   组件侧靠 review + 对比度审计兜底。
2. **品牌色语义固定**（`design/BRAND.md`）：
   - 琥珀（`--ts-amber` / `--ts-accent`）**只用于动作**：主按钮、焦点环、提示符、光标；
   - 薄荷（`--ts-mint` / `--ts-status-ok`）**只用于状态**：已连接、同步成功；
   - 红（`--ts-danger` / `--ts-status-error`）**只用于错误**。
3. 语义层不要互相替代：正文永远用 `--ts-text-primary`，不要因为「想要更亮」改成 `--ts-text-inverse`。
   自定义主题要改观感就改 token 值，不要改用法。

### 变量别名是允许的

内置主题里语义层大量使用别名（`--ts-bg-app: var(--ts-ink-900)`）。
`resolveTokenSet()` / `resolveThemeTokens()` 会把别名链**展平成字面值**（最长 16 层，`MAX_VAR_DEPTH`），
所以对比度计算、xterm palette、导出 JSON 拿到的都是 `#rrggbb` / `rgba(…)`，不会是 `var(...)`。
自定义主题允许直接写 `var(--ts-amber)`——改一处品牌色，语义层跟着走。

## 3. 内置主题（4 套）

`src/renderer/theme/builtin.ts` 的 `BUILTIN_THEMES`：

| id | 名称 | 外观 | 基座 | 设计意图 |
| --- | --- | --- | --- | --- |
| `termans-dark` | Termans Dark | dark | — | 默认主题，与 `tokens.css` 的 `:root` 完全一致 |
| `termans-midnight` | Termans Midnight | dark | `termans-dark` | 深蓝夜色：ink 换蓝调、强调色偏冷，长时间盯屏更柔和 |
| `termans-light` | Termans Light | light | — | 与 `tokens.css` 的 `[data-theme='light']` 完全一致 |
| `termans-contrast` | Termans High Contrast | dark | `termans-dark` | 接近纯黑底 + 纯白字，正文对比度 21:1，投影/强光环境用 |

`DEFAULT_THEME_ID === 'termans-dark'`。第一套与第三套必须是 dark/light 的「CSS 镜像」（见 §1 漂移测试）。

### 内置主题不可编辑、不可删除

`themeDefinitionSchema.builtin === true` 的主题只由代码提供。想改就 `beginCreate(baseId)` 复制一份。
`isBuiltinTheme()` 判定用的是「`builtin === true` **或** id 命中 `BUILTIN_THEMES`」，**故意不用**
`@shared` 里的 `BUILTIN_THEME_IDS`（那里只冻结了最初的 dark/light 两个 id，而现在有 4 套）。

## 4. 主题 = token 覆盖集

```ts
interface ThemeDefinition {
  id: string            // ^[a-z0-9][a-z0-9-]{0,63}$，1-64 字符
  name: string          // 1-80 字符
  appearance: 'dark' | 'light'   // 控制 color-scheme、原生控件与滚动条
  builtin: boolean
  extends: string | null         // 自定义主题的基座（必须是一套内置主题的 id）
  tokens: ThemeTokenPatch        // 只放「被覆盖」的 token；未出现的继承基座
  createdAt: string | null
  updatedAt: string | null
}
```

- 自定义主题**只允许覆盖 `extends` 基座的子集**（SPEC M-03）：编辑器里未改动的 token 不会写进 `tokens`，
  改一个字也不会复制 52 个值，将来基座换色能继承下来。
- 覆盖集是 `Partial<Record<ThemeToken, string>>`，多余/拼错的 token 名会被
  `themeTokenPatchSchema`（strict）与 `validateTokenPatch()` 双重挡掉（SPEC M-04）。
- 完整 token 集（52 个全给）也合法——那就是「自包含主题」，`extends` 留空即可。

## 5. 运行时应用

```ts
// src/renderer/theme/apply.ts
applyThemeToDocument(tokens, { id, appearance })
```

做的事（顺序有讲究）：

1. 对 52 个 token 逐个 `documentElement.style.setProperty(token, value)`（值来自展平后的字面值）；
2. `documentElement.dataset.theme = appearance` → 让 `tokens.css` 的浅色块 / 后续 CSS 选择器也能命中；
3. `documentElement.dataset.themeId = id` → 测试与「当前主题」展示用；
4. `documentElement.style.colorScheme = appearance` → 原生滚动条、`<input type=color>`、下拉框跟着变；
5. `setActiveTokens(tokens)` → 广播给 xterm（见 §6）。

为什么用内联变量而不是「给每套主题写一个 CSS class」：主题数量无上限（用户可导入任意多套），
class 方案要么在构建期生成 CSS、要么运行期注入 `<style>`；内联变量是 O(52) 次 setProperty，
切换在同一帧完成，且不触碰样式表（**没有重排整页的样式失效**）。这也是 M-01「切换无白屏」的实现基础。

`readAppliedToken(token)` 读取当前生效值（测试用；也方便排查「变量被谁覆盖了」）。

## 6. xterm 配色联动（切主题时已打开的终端必须跟着变）

**关键事实：只改 CSS 变量 xterm 不会重绘。** xterm 在构造时把主题读进内部渲染器，之后只认
`terminal.options.theme` 的赋值。所以必须主动推送。

```ts
// src/renderer/theme/xterm.ts
buildXtermTheme(tokens): ITheme            // token → xterm ITheme 的映射（纯函数）
applyXtermTheme(terminal, theme?)          // 赋值新对象 + refresh(0, rows-1)
registerXterm(terminal): () => void        // 终端挂载时注册，立即套用当前主题，返回注销函数
subscribeXtermTheme(listener): () => void  // 订阅主题变化（React hook 用）
setActiveTokens(tokens)                    // 主题变更入口：重算 ITheme → 推给所有已注册终端 + 通知订阅者
```

映射表：

| xterm ITheme | token |
| --- | --- |
| `foreground` | `--ts-text-primary` |
| `background` | `--ts-bg-app` |
| `cursor` | `--ts-accent` |
| `cursorAccent` | `--ts-accent-contrast` |
| `selectionBackground` / `selectionInactiveBackground` | `--ts-selection` |
| `scrollbarSliderBackground` / `scrollbarSliderHoverBackground` / `scrollbarSliderActiveBackground` | `--ts-border-strong` / `--ts-text-muted` / `--ts-text-primary` |
| `black` … `brightWhite`（16 个） | `--ts-ansi-black` … `--ts-ansi-bright-white`（顺序 = ANSI 0…15） |

### T3（终端功能）集成片段

```ts
import { registerXterm } from '@renderer/theme/xterm'

useEffect(() => {
  const term = new Terminal({ theme: getXtermTheme(), /* … */ })
  term.open(containerRef.current!)
  const unregister = registerXterm(term)   // ← 只需要这一行
  return () => {
    unregister()
    term.dispose()
  }
}, [])
```

- `registerXterm` 挂上时就套用当前主题，所以「先开终端再改设置」与「先改设置再开终端」结果一致；
- 切主题走的就是 `setActiveTokens`，**不重建 Terminal 实例**（会话不中断、scrollback 不丢）；
- 想用 React hook 拿当前主题（例如自己画一个预览块）：`useXtermTheme()`。

### 真实接缝（terminal 模块当前实现，已核对代码）

`registerXterm` 是**可选**路径：terminal 模块没有用注册表，而是自己读 CSS 变量，
两条路径结果等价，**不要同时改两套**。

- `src/renderer/features/terminal/runtime.ts:189-192`：
  `new MutationObserver(() => bumpTheme())` 观察 `document.documentElement` 的
  `attributes: ['class', 'style', 'data-theme']`；
- `src/renderer/features/terminal/runtime.ts:116`：
  主题变化时执行 `handle.terminal.options.theme = readTerminalTheme(readVar)` —— **只重赋 theme，不重建实例**；
- `src/renderer/features/terminal/xterm-options.ts:43`：
  `readTerminalTheme(readVariable)` 用 `getPropertyValue` 逐 token 读取。

因此 `applyThemeToDocument()` 写 `documentElement.style` 的那一步就是**跨模块契约**：
它必须内联写（而不是加 class），否则 MutationObserver 不触发、终端不换色。
改这一行前先读本节与 `theme-xterm.test.ts`。

### 当前接线状态（给 QA / integration）

`src/renderer/app/App.tsx` 目前仍渲染 `app/placeholders/*`（真终端、真页签条由集成任务 t7 替换），
所以**现在还点不出 xterm 实例**。集成时需要做两件事：

1. 真实 `StatusBar` 里保留 `<SettingsButton />`（`import { SettingsButton } from '@renderer/theme'`），
   否则设置面板没有入口；
2. 若真实页签条/终端改用 `@renderer/theme` 的 `registerXterm`，就删掉 `runtime.ts` 里那段
   MutationObserver + `bumpTheme`，别留两套（否则一次切主题会重赋两次 theme）。

**自测判据**（QA 用，也是我的 e2e 断言）：切主题后

1. `getComputedStyle(document.documentElement).getPropertyValue('--ts-bg-app')` 变了；
2. 终端容器 `.xterm` 实际背景色变了（xterm 把 `options.theme.background` 写进 canvas/内联样式）；
3. 终端里已有的输出**没有**重新连接、scrollback 条数不变。

## 7. 存储与降级

| 位置 | 内容 | 是否进 Git 同步 |
| --- | --- | --- |
| `settings.json`（主进程，`<userData>/`） | `themeId`（当前选中）、`locale` | 否（本机偏好） |
| `theme:list` / `theme:save` / `theme:delete` IPC | 自定义主题定义 | 否（SPEC：主题是「本机外观」） |
| `localStorage['termans:themes:v1']` | 同上，**仅在 IPC 未接线时**的兜底 | 否 |

- 当前主进程的 `theme:*` 通道还是占位（`E_NOT_IMPLEMENTED`）。`useThemeStore.init()` 先走 IPC，
  命中 `isNotImplemented()` 后自动降级到 `localStorage`，并把 `storage` 置为 `'local'`；
  设置页会显示一条黄色提示（`settings:theme.storage.local`），开发控制台也会 `console.warn`。
- **绝不静默降级**：降级必须可见（UI 提示 + 控制台），否则用户会以为主题已保存到配置目录。
- 主题**不进 Git 同步**是有意的：同一套配色在另一台机器的显示器/环境光下未必合适，
  而且同步冲突会污染主机库的 diff。跨机搬主题请用「导出 JSON → 另一台导入」。

## 8. 导入 / 导出

导出（`serializeThemeFile(theme)`，2 空格缩进）：

```json
{
  "format": "termans-theme",
  "version": 1,
  "theme": {
    "id": "midnight-amber",
    "name": "Midnight Amber",
    "appearance": "dark",
    "builtin": false,
    "extends": "termans-midnight",
    "tokens": {
      "--ts-accent": "#ffb648",
      "--ts-accent-strong": "#d98b1f"
    },
    "createdAt": "2026-10-29T02:10:00.000Z",
    "updatedAt": "2026-10-29T02:10:00.000Z"
  }
}
```

导入（`parseThemeFile(text, { knownBaseIds })`）**永不抛异常**，返回 `{ok:true,theme}` 或
`{ok:false,issues}`，`issues` 的 `code` 直接对应 i18n key `settings:themeError.<code>`：

| code | 触发条件 |
| --- | --- |
| `invalidJson` | 不是合法 JSON |
| `notObject` | 顶层不是对象 / 是数组 |
| `invalidId` | id 不匹配 `^[a-z0-9][a-z0-9-]{0,63}$` |
| `invalidName` | name 空或 > 80 字符 |
| `builtinLocked` | 文件里声明 `builtin: true`（防止「导入一份内置主题」误导用户以为能覆盖内置） |
| `unknownBase` | `extends` 不是已知内置主题 id |
| `unknownToken` | token 名不在 52 个之内（含 `var(--ts-xxx)` 引用了不存在的变量） |
| `invalidColor` | 颜色类 token 值不是合法颜色 |
| `invalidLength` | 长度类 token 没带单位（`px`/`rem`/`em`/`%`） |
| `unsafeValue` | 值里含 `;` `{` `}` 或换行（**CSS 注入防线**，值会被写进内联样式） |
| `invalidSchema` | 其余结构错误（值不是字符串、tokens 不是对象…） |

`format` / `version` 目前不参与校验（宽容读取，方便将来加字段）；遇到不认识的顶层键不会报错。

**往返一致性**（SPEC M-08）：导出 → 导入 → `theme.tokens` 深相等；`builtin` 字段导出时强制为 `false`。

## 9. 对比度规则（`contrast.ts`）

9 组配对，每组有硬底线 `min`（测试断言点）与建议值 `recommended`（编辑器黄色警告点）：

| 配对 id | 前景 / 背景 | min | recommended |
| --- | --- | --- | --- |
| `body-app` | `--ts-text-primary` / `--ts-bg-app` | 4.5 | 4.5 |
| `body-surface` | `--ts-text-primary` / `--ts-bg-surface` | 4.5 | 4.5 |
| `body-elevated` | `--ts-text-primary` / `--ts-bg-elevated` | 4.5 | 4.5 |
| `secondary-surface` | `--ts-text-secondary` / `--ts-bg-surface` | 4.5 | 4.5 |
| `muted-surface` | `--ts-text-muted` / `--ts-bg-surface` | 3 | 3 |
| `button` | `--ts-accent-contrast` / `--ts-accent` | 3 | 4.5 |
| `accent-app` | `--ts-accent` / `--ts-bg-app` | 3 | 3 |
| `status-ok-surface` | `--ts-status-ok` / `--ts-bg-surface` | 3 | 3 |
| `status-error-surface` | `--ts-status-error` / `--ts-bg-surface` | 3 | 3 |

带 alpha 的颜色先按「前景叠在背景上」合成，背景自身带 alpha 时按叠在白底上处理（`color.ts` 的
`contrastRatio`），与浏览器实际叠加顺序一致。

### 实测值（`pnpm test` 里的 `theme-contrast.test.ts` 会跑同一套）

| 主题 | body-app | body-surface | body-elevated | secondary | muted | button | accent-app |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `termans-dark` | 17.08 | 15.65 | 12.53 | 7.65 | 3.74 | 9.89 | 10.35 |
| `termans-midnight` | 17.07 | 16.13 | 14.05 | 9.27 | 5.79 | 9.82 | 10.18 |
| `termans-light` | 17.31 | 18.38 | 16.11 | 6.94 | 3.49 | 5.52 | 3.58 |
| `termans-contrast` | 21.00 | 19.80 | 18.10 | 16.76 | 11.83 | 13.94 | 13.94 |

> **已修（唯一的 M-06 偏差）**：`termans-light` 的主按钮文字原先用白字 `#ffffff` 落在 `#c86a08` 上只有 **3.80:1**，
> 低于 SPEC M-06 的 4.5:1。现改为 `--ts-accent-contrast: #000000`（**5.52:1**）——`tokens.css` 浅色块与
> `builtin.ts` 的 `termans-light` 同步修改（两者被 `theme-builtin.test.ts` 逐 token 比对，只改一处会红）；
> 测试里的 `KNOWN_M06_DEVIATIONS` 豁免表已删除，现在所有内置主题一律要求 ≥ 4.5:1。
>
> **为什么改字不改底色**：另一条路是把 `--ts-accent` 换成更深的 `#a85505`（白字 5.29:1 也能过），但那样琥珀会变成褐黄，
> 品牌色是设计资产，不为了让白字达标去褪它的黄。原则是：**浅色主题的琥珀底配纯黑字，深色主题配深墨字**
> （`#0b0f18` 落在 `#f8ab24` 上 9.89:1），只调压在上面的字，保住琥珀本身的温度。

对比度**只警告不阻止保存**：用户可能故意要做低对比度的复古配色，但必须让他在保存前看到
「哪一对、实际多少、要求多少」。

## 10. 新增一套内置主题

1. 在 `src/renderer/theme/builtin.ts` 里加一个 `XXX_TOKENS: ThemeTokenPatch`（**52 个 token 全给**，
   颜色写别名或字面值都行）；
2. 加进 `BUILTIN_THEMES`（`builtin: true`、`extends: null`）；
3. 如果它是新的「默认深色/浅色镜像」，同步改 `tokens.css` 对应块——否则漂移测试会红（这是故意的）；
4. 跑 `pnpm test`：`theme-builtin.test.ts` 校验 52 个 token 全覆盖 + 值类型合法 + 与 CSS 无漂移；
   `theme-contrast.test.ts` 校验 9 组对比度的硬底线；
5. 更新本文档 §3 的表格与 §9 的实测值表（数字来自测试输出，不要手算）。

## 11. 已知限制

- 主进程 `theme:*` 三个通道仍是占位实现（属于 integration/vault 范围），自定义主题暂存 `localStorage`；
  接线后 `useThemeStore` 无需改动（走的是同一份 `ThemeDefinition` 契约）。
- 主题导入不做「合并到已有同名 id」的询问，冲突直接报 `idTaken`，需要用户自己改名。
- `--ts-font-ui` / `--ts-font-mono` 可被主题覆盖，但字体**文件**不随主题分发（只用系统已装字体）。
- 主题编辑器对带 alpha 的颜色（如 `--ts-selection`）只显示文本输入框，不提供取色器
  （`<input type="color">` 不支持 alpha，硬塞会悄悄丢透明度）。
- 高对比主题下 `--ts-border` 仍是带 alpha 的 `rgba(255, 255, 255, 0.42)`，投影仪上可能偏弱——已记录，未改。

## 12. QA 断言指南（Playwright，本文档所有期望值都是实测得到的）

启动姿势（照抄即可，两个环境坑见 `docs/ARCHITECTURE.md`）：直接跑构建产物、`TERMANS_E2E=1`
跳过单实例锁、`TERMANS_E2E_USER_DATA` 指向临时目录，且**必须** `env -u ELECTRON_RUN_AS_NODE`。

| # | 操作 | 选择器 | 期望（实测值） |
| --- | --- | --- | --- |
| 1 | 首屏 | `[data-testid="app-shell"]` | `dataset.theme === 'dark'`、`dataset.themeId === 'termans-dark'`、`--ts-bg-app === '#05080e'` |
| 2 | 打开设置 | `[data-testid="open-settings"]` → `[data-testid="settings-dialog"]` | 面板出现（点状态栏齿轮） |
| 3 | 切浅色 | `[data-testid="theme-option-termans-light"]` | `dataset.theme === 'light'`、`themeId === 'termans-light'`、`--ts-bg-app === '#f7f8fb'`、`--ts-text-primary === '#0d1424'`、该卡 `data-active === 'true'` |
| 4 | 切深蓝 | `[data-testid="theme-option-termans-midnight"]` | `--ts-bg-app === '#040a1c'` |
| 5 | 切高对比 | `[data-testid="theme-option-termans-contrast"]` | `--ts-bg-app === '#000000'`，且 `dataset.theme` 仍是 `'dark'`（外观 ≠ 主题身份） |
| 6 | 新建自定义 | `theme-create` → `theme-name` 填 `E2E Custom` → 展开任一 `details` → `token-input-accent` 填 `#2f7d32` → `theme-save` | 出现 `[data-testid="theme-option-e2e-custom"]`（id 由名称 slug 而来） |
| 7 | 用自定义主题 | 点该卡 | `--ts-accent === '#2f7d32'`，未覆盖的 `--ts-bg-app` 仍是 `'#05080e'`（继承内置，M-03） |
| 8 | 导出 | `theme-export` → `theme-export-text` | 文本含 `"format": "termans-theme"` 与 `"id": "e2e-custom"` |
| 9 | 导入往返 | 把导出的 JSON 改 `id`/`name` 后填 `theme-import-text` → `theme-import` | 出现新的 `theme-option-<新 id>`（M-08） |
| 10 | 非法导入 | 填 `{"format":"termans-theme","version":1,"theme":{"id":"bad","name":"Bad","tokens":{"--ts-nope":"#fff"}}}` → `theme-import` | `[data-testid="theme-error"]` 可见且文案含 `Unknown token: --ts-nope.`（不静默、不落盘） |
| 11 | 恢复默认 | `theme-reset` | `dataset.themeId` 回到 `'termans-dark'` |
| 12 | 重启 | 同 `TERMANS_E2E_USER_DATA` 再启一次 | `themeId` 仍是上次的选择；自定义主题仍在列表里（实测 4 内置 + 2 自定义 = 6 张卡） |

token 编辑器的 testid 规则：**去掉 `--ts-` 前缀**（`token-row-accent` / `token-input-accent` /
`token-color-accent` / `token-reset-accent`），52 个 token 全有文本输入框，其中 38 个另有原生取色器
（带 alpha 的值与 `var(--ts-*)` 别名没有取色器——浏览器取色器不支持 alpha，这时只能用文本输入框）。

另外：主进程 `theme:*` 还没接线时，设置页必须出现 `[data-testid="theme-storage-warning"]`
（当前实测 `visible === true`）。这条断言的价值是防止「静默降级」回归。
