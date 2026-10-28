# Termans 架构与契约（P0 骨架）

> 本文是**并行开发的唯一事实来源**：技术栈、目录归属、IPC 契约、主题 token、i18n 约定、构建命令。
> 任何成员要突破这里的约定（尤其改 `package.json` / `src/shared` / 通道名），先找 architect。
>
> 版本：P0（骨架）；对应提交：见 `git log -1`。

---

## 1. 产品与目标

仿 Termius 的跨平台 SSH 客户端，代码名 **Termans**（副标题 `SSH · SYNC · AI`）。Electron 桌面应用，能力清单：

| 能力 | 归属任务 | 说明 |
| --- | --- | --- |
| 主机库 / 分组 / 搜索 | t2-t3 | 数据模型 + 侧栏 UI |
| 多页签终端（xterm.js） | t4 | 页签 = 一个 SSH 会话 |
| SSH 连接（ssh2） | t2 | 主进程持有连接，渲染层只见数据流 |
| 加密同步（Git） | t5 | 密文入库、主口令、恢复码、双机迁移 |
| AI 辅助 | t6 | 第三方 API key，流式对话，命令必须二次确认 |
| 主题 / 多语言 | t8 | CSS 变量 token + i18next |
| 打包 / 验收 | t9-t10 | electron-builder，Playwright-Electron |

---

## 2. 技术栈（已锁定，改动需 architect 决策）

| 层 | 选型 | 版本 | 为什么是它 |
| --- | --- | --- | --- |
| 运行时 | Electron | `^45.1.0` | 跨平台桌面 + Node 主进程（ssh2/文件/Git 都要原生能力） |
| 构建 | electron-vite | `^6.0.0` | 一套配置同时构建 main/preload/renderer，dev 有 HMR |
| 打包器 | Vite | `^7.3.7` | electron-vite 6 的 peer；Vite 8 要求 `@vitejs/plugin-react` 6（依赖 oxc，暂不引入） |
| UI | React | `18.3.1` | 任务要求 React 18（生态与 Electron 模板最稳）；未用 19 |
| 语言 | TypeScript | `^5.9.3` | `strict` 全开；不跟 TS 7 原生端口（底座要稳） |
| 状态 | zustand | `^5.0.16` | 无 Provider、按需订阅；终端数据不走 store（高性能路径直接回调） |
| 终端 | `@xterm/xterm` + fit/search/web-links | `^6.0.0` | 事实标准；addon 覆盖自适应、查找、链接 |
| SSH | ssh2 | `^1.17.0` | 纯 JS 实现 + 可选原生加速；只在主进程用 |
| Git | isomorphic-git | `^1.44.8` | 纯 JS，不依赖用户装 git；同步逻辑可单测 |
| 校验 | zod | `^4.6.7` | 运行时边界（IPC/设置/模型）与类型同源 |
| 存储 | 自写 `JsonStore` | — | electron-store 会摸 `app`，单测起不来；自写 70 行 + 原子写 |
| i18n | i18next + react-i18next | `^26 / ^17` | 按功能 namespace，扁平 key |
| 样式 | 纯 CSS + CSS 变量 token | — | 不引 Tailwind：主题编辑器要能直接改 token 值，Tailwind 的原子类无法被用户覆盖 |
| 图标 | lucide-react | `^1.63.0` | tree-shakable、线性风格统一 |
| 测试 | vitest + `@playwright/test` | `^4.1.12 / ^1.64.1` | 契约/单测用 vitest；窗口级用 Playwright-Electron |

### 依赖的单写者规则（硬约束）

**`package.json` 只有 architect 能改。** 需要新依赖 → 发消息给 architect，说明包名、用途、体积/许可证风险。
原因：并行成员各自 `pnpm add` 会互相冲刷 lockfile，且把 native 依赖引进渲染层会把打包搞崩（见 §6 的 preload 教训）。

当前依赖分层（重要，别乱挪）：

- `dependencies`（主进程 externalize，随包发布）：`ssh2`、`isomorphic-git`、`zod`。
- `devDependencies`（被 Vite 打进 `out/renderer`）：`react`、`react-dom`、`zustand`、`@xterm/*`、`i18next`、`react-i18next`、`lucide-react` + 全部工具链。

---

## 3. 目录结构与归属

```
termans/
├── build/                     # 打包图标（design 交付：icon.png/icns/ico）
├── design/                    # 品牌源文件（BRAND.md + logo svg/png）
├── docs/                      # 本文档、SPEC.md、截图
├── e2e/                       # Playwright-Electron（architect 建冒烟，qa 扩写）
├── src/
│   ├── shared/                # ★ 契约层：全员只读、只有 architect 改
│   │   ├── errors.ts          # 错误码 + IpcResult 信封 + IpcCallError
│   │   ├── ipc.ts             # 通道名、请求/响应类型、事件名、编译期完备性断言
│   │   ├── bridge.ts          # window.termans 桥类型 + getTermansBridge()
│   │   ├── theme.ts           # --ts-* token 清单 + 主题 schema
│   │   ├── i18n.ts            # 语言/namespace/资源路径
│   │   ├── models/            # app/host/terminal/vault/ai/ssh-config/known-host/settings
│   │   └── index.ts           # 桶文件（★ 只许渲染层与主进程 import；preload 不许）
│   ├── main/                  # 主进程
│   │   ├── index.ts           # 窗口、菜单、生命周期、安全开关（architect）
│   │   ├── ipc/index.ts       # ★ 唯一接线点：汇总注册（integration）
│   │   ├── ipc/registry.ts    # handle() 封装：zod 校验 + 信封 + 日志（architect）
│   │   ├── ipc/{app,settings}.ts
│   │   ├── store/             # JsonStore + SettingsStore（architect）
│   │   ├── ssh/               # engine 成员
│   │   ├── vault/ + git/      # vault-sync 成员
│   │   └── ai/                # ai 成员
│   ├── preload/index.ts       # 白名单桥（architect；integration 只加通道常量到 shared）
│   └── renderer/
│       ├── index.html
│       ├── app/               # App.tsx + store.ts + placeholders/（integration 替换组件）
│       ├── platform/ipc.ts    # 类型化 invoke/subscribe 客户端
│       ├── features/          # terminal/tabs（terminal-ui）、hosts、settings、sync、ai
│       ├── theme/ + i18n/     # theme-i18n 成员
│       └── styles/            # tokens.css（契约）+ base.css
├── src/locales/<lang>/<feature>.json
├── tests/contract/            # 契约结构测试（architect 建，任何人都可加）
└── electron.vite.config.ts / vitest.config.ts / playwright.config.ts / electron-builder.yml
```

并行三条铁律：
1. **契约先行**：`src/shared` 由 architect 定义，成员只实现自己的命名空间。
2. **目录隔离**：各自只动自己的目录；跨目录结论走消息。
3. **接线集中**：渲染层与主进程的连接只由 integration 改 `src/main/ipc/index.ts`、`src/preload/index.ts`、`src/renderer/app`。

---

## 4. 进程模型与安全基线

```
┌──────────── renderer (sandbox, no node) ────────────┐
│  React 18 + zustand + xterm.js                      │
│  window.termans.invoke(channel, payload) ──┐        │
└────────────────────────────────────────────┼────────┘
                                             │ contextBridge（白名单）
┌──────────── preload (isolated) ────────────▼────────┐
│  只有 IPC_INVOKE_CHANNELS / IPC_EVENTS 两个集合     │
└────────────────────────────────────────────┼────────┘
                                             │ ipcRenderer.invoke / on
┌──────────── main ──────────────────────────▼────────┐
│  ipc/registry.handle() → zod 校验 → handler        │
│  ssh2 / isomorphic-git / safeStorage / fs          │
└─────────────────────────────────────────────────────┘
```

窗口安全开关（`src/main/index.ts`，改任何一条都要在这里写理由）：

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- preload 只暴露 `invoke` / `on` 两个能力 + `platform` / `versions`，**不暴露 `ipcRenderer` 本身**。
- `setWindowOpenHandler` 拒绝所有新窗口，`http(s)` 外链交系统浏览器；`will-navigate` 只允许 dev server 与打包后的 `file://`。
- 生产构建注入 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'`。
  `style-src` 必须放开 `unsafe-inline`：xterm.js 运行时注入 `<style>`，收紧会直接让终端不显示。
- dev 构建**不注入** CSP：`@vitejs/plugin-react` 的 HMR preamble 是内联 `<script>`，注入会白屏。
- 权限请求一律拒绝（`setPermissionRequestHandler(() => cb(false))`）：应用不需要摄像头/麦克风/通知。

### ★ preload 的致命细节（务必遵守）

`src/preload/index.ts` **只能** import 纯类型与 `../shared/ipc` 的**常量**，**绝不能** `import ... from '@shared'`：
桶文件会带上 `zod`，而沙箱化 preload 里 `require('zod')` 会失败 → preload 静默不执行 → `window.termans` 消失 →
界面上表现为「所有按钮都没反应」，且主进程日志干净。`tests/contract/ipc.test.ts` 会读源码断言这条。

---

## 5. IPC 契约

### 5.1 信封

Electron 会把 handler 抛出的错误序列化成 `Error invoking remote method 'x'` 字符串并**丢掉自定义 code**，
所以每个 `invoke` 都返回信封（`src/shared/errors.ts`）：

```ts
type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode; message: string; details?: unknown } }
```

渲染层不要自己拆信封：用 `src/renderer/platform/ipc.ts` 的 `call()`，失败会 `throw new IpcCallError(envelope.error)`。

错误码：`E_UNKNOWN`、`E_INVALID_ARGUMENT`、`E_NOT_IMPLEMENTED`、`E_NOT_FOUND`、`E_CONFLICT`、`E_UNAUTHORIZED`、
`E_VAULT_LOCKED`、`E_NETWORK`、`E_SSH`、`E_HOST_KEY_UNVERIFIED`、`E_AI_PROVIDER`、`E_GIT`、`E_IO`。

### 5.2 通道一览（53 个，定义在 `src/shared/ipc.ts`）

| 域 | 通道 | 用途 |
| --- | --- | --- |
| app | `app:info`、`app:open-external` | 版本/平台信息；外链 |
| settings | `settings:get`、`settings:update`、`settings:reset` | 整份设置读写（含语言/主题 id） |
| theme | `theme:list`、`theme:save`、`theme:delete` | 主题 CRUD（内置主题不可删） |
| hosts | `hosts:list`、`hosts:create`、`hosts:update`、`hosts:delete`、`hosts:reorder` | 主机 CRUD + 排序 |
| groups | `groups:create`、`groups:update`、`groups:delete` | 分组（列表随 hosts 返回） |
| credentials | `credentials:set`、`credentials:clear` | 凭据写 safeStorage（**永不进 Git**） |
| ssh | `ssh:connect`、`ssh:input`、`ssh:resize`、`ssh:disconnect`、`ssh:list-sessions`、`ssh:answer-host-key` | 连接生命周期 + 终端数据/resize |
| ssh-config | `ssh-config:default-paths`、`parse`、`write`、`import`、`export` | `~/.ssh/config` 双向解析/写回 |
| known-hosts | `known-hosts:list`、`trust`、`remove` | 指纹信任与删除 |
| vault | `vault:status`、`create`、`unlock`、`lock`、`rotate`、`recover` | 主口令/解锁/锁定/轮换/恢复码 |
| sync | `sync:status`、`bootstrap`、`pull`、`push`、`conflicts`、`resolve` | Git 同步状态、双机迁移、冲突选择 |
| ai | `ai:list-providers`、`save-provider`、`delete-provider`、`set-api-key`、`clear-api-key`、`test-provider`、`chat`、`cancel`、`list-conversations` | 供应商与流式对话 |

事件（main → renderer，`IPC_EVENTS`）：
`ssh:data`、`ssh:state-changed`、`ssh:closed`、`ssh:host-key-challenge`、
`ai:stream-delta`、`ai:stream-done`、`ai:stream-error`、`vault:state-changed`、`sync:status-changed`、
`settings:changed`、`app:menu-command`。

`app:menu-command` 的 payload 是 `{ command: MenuCommand }`（`new-tab` / `close-tab` / `open-settings` / `lock-vault` / `toggle-ai-panel` / …），
菜单与快捷键统一走它，渲染层不要各自注册 globalShortcut。

### 5.3 新增一个通道的完整步骤

1. `src/shared/ipc.ts`：在 `IPC_CHANNELS` 加通道名 → 在 `IpcInvokeContract` 加 `{ request, response }` 类型。
   （编译期断言 `_AssertEveryChannelHasContract` / `_AssertNoOrphanContract` 会强制两边同步。）
2. 主进程：在**自己模块目录**里用 `handle(channel, handler, requestSchema?)` 注册，并在 `src/main/ipc/index.ts` 里接线（integration 或本人）。
3. 渲染层：`call('domain:verb', request)`，类型自动推导；不要手写字符串。
4. 需要事件就同时加 `IPC_EVENTS` + `IpcEventMap`，并在 preload 白名单自动生效（白名单由常量推导，**不用改 preload**）。

### 5.4 未实现通道的桩

`installPlaceholders()` 在注册末尾给所有未注册通道装上抛 `E_NOT_IMPLEMENTED` 的桩。
所以队友的 UI 可以**先接线**：拿到 `E_NOT_IMPLEMENTED` 就降级显示，而不是 `No handler registered` 直接崩。
`installPlaceholders()` 必须保持**最后调用**。

当前状态：53 个通道已注册，其中 5 个真实实现（`app:info`、`app:open-external`、`settings:get/update/reset`），48 个占位。

---

## 6. shared 数据模型（不变量）

- **主机不含密钥/口令**：`hostInputSchema` 只有 `privateKeyPath` 与 `credentialRef`（指向 safeStorage 的键）。
  解析时多余的 `password` 字段会被 zod 丢弃（`tests/contract/models.test.ts` 断言）。私钥**永不进入同步目录**。
- **加密包内容策略是字面量**：`vaultContentPolicySchema` 里 `secretsExcluded: true`、`privateKeysExcluded: true`、
  `plaintextHostnamesInRepo: false` —— 传 `false`/`true` 会被 zod 拒绝，而不是「警告后继续」。这是安全开关不做成配置项的典型用法。
- **AI 命令必须确认**：`aiCommandSuggestionSchema.requiresConfirmation` 与 `settings.ai.commandConfirmation` 都是字面量 `true`。
- **终端数据在主进程已解码**：`ssh:data` 的 `data` 是 UTF-8 字符串（xterm 需要字符串；Buffer 无法跨 `contextBridge` 保序跨块）。
- **known_hosts 默认严格**：`settings.ssh.knownHostsPolicy` 默认 `strict`；指纹不匹配走 `E_HOST_KEY_UNVERIFIED` + `ssh:host-key-challenge` 事件。
- **设置整份读取**：渲染层拿到的永远是完整 `Settings`（`withDefaults()` 逐字段容错），不要写 `settings.ai?.enabled ?? false`。

---

## 7. 主题契约：`--ts-*` 变量清单（52 个）

`src/shared/theme.ts` 的 `THEME_TOKENS` 是唯一清单；`src/renderer/styles/tokens.css` 必须在 `:root` 与
`[data-theme='light']` 里**各声明一遍全部 52 个**（`tests/contract/theme-tokens.test.ts` 断言，包含「不许出现清单外的 `--ts-*`」与
「CSS 里不许有裸 hex/rgba，颜色必须走变量」）。

| 组 | token | dark 值 | light 覆盖 |
| --- | --- | --- | --- |
| 品牌 | `--ts-ink-900` | `#05080E` | `#F7F8FB` |
| | `--ts-ink-800` | `#0D1424` | `#FFFFFF` |
| | `--ts-ink-700` | `#1C2746` | `#EDF0F7` |
| | `--ts-ink-600` | `#253257` | `#DDE3EE` |
| | `--ts-amber` | `#F8AB24` | 同 |
| | `--ts-amber-soft` | `#FFE2A8` | `#7A4A08` |
| | `--ts-amber-deep` | `#C86A08` | 同 |
| | `--ts-mint` | `#1D9663` | `#16794F` |
| | `--ts-danger` | `#E0553B` | `#C23B22` |
| 语义 | `--ts-bg-app` | `var(--ts-ink-900)` | `var(--ts-ink-900)` |
| | `--ts-bg-surface` | `var(--ts-ink-800)` | `var(--ts-ink-800)` |
| | `--ts-bg-elevated` | `var(--ts-ink-700)` | `var(--ts-ink-700)` |
| | `--ts-bg-overlay` | `rgba(5,8,14,.72)` | `rgba(247,248,251,.82)` |
| | `--ts-border` / `--ts-border-strong` | 白 8% / 16% | 黑 10% / 20% |
| | `--ts-text-primary` | `#E8EDF7` | `#0D1424` |
| | `--ts-text-secondary` | `#9AA8C0` | `#4A5A78` |
| | `--ts-text-muted` | `#63718C` | `#7C8AA3` |
| | `--ts-text-inverse` | `#05080E` | `#FFFFFF` |
| | `--ts-accent` | `var(--ts-amber)` | `var(--ts-amber-deep)` |
| | `--ts-accent-strong` | `var(--ts-amber-deep)` | `#A85505` |
| | `--ts-accent-contrast` | `#0B0F18` | `#FFFFFF` |
| | `--ts-focus-ring` | 琥珀 55% | 深琥珀 45% |
| | `--ts-selection` | 琥珀 24% | 琥珀 35% |
| | `--ts-status-ok` / `--ts-status-warn` / `--ts-status-error` | mint / amber-soft / danger | 同族加深 |
| ANSI 16 | `--ts-ansi-black` … `--ts-ansi-bright-white` | 见 `tokens.css` | 同色温加深 |
| 排版 | `--ts-font-ui`、`--ts-font-mono`、`--ts-font-size-sm/base/lg` | 12/13/15px | 同 |
| 尺寸 | `--ts-radius-sm/md/lg`、`--ts-titlebar-height` | 6/10/14px、38px | 同 |

使用规则（来自 `design/BRAND.md`）：

- **琥珀只用于「可操作」**（主按钮、焦点环、选中），**薄荷绿只用于「状态正常」**，**红色只用于错误**。
- 语义 token 的值只引用品牌 token（`var(--ts-ink-800)`），不要在组件里直接写 `--ts-ink-800` 当背景。
- 布局宽度 `--ts-sidebar-width` / `--ts-ai-panel-width` **不属于主题契约**（改窗口结构用），由设置项驱动。

主题数据模型：内置主题必须给**全量** token（`themeTokenSetSchema`，`.strict()`），用户主题只允许覆盖子集
（`themeTokenPatchSchema`），缺的继承 `extends` 指向的内置主题。`BUILTIN_THEME_IDS = ['termans-dark','termans-light']`。

---

## 8. 多语言约定

- 目录：`src/locales/<lang>/<feature>.json`，`<lang> ∈ {en, zh-CN}`，`<feature>` 取
  `I18N_NAMESPACES = ['common','hosts','terminal','settings','ai','sync','auth','errors']`。
- 结构：**扁平 key**（`"empty.title": "No hosts yet"`），不嵌套对象。
- 组件里用带 namespace 的写法：`t('hosts:empty.title')`（见下方坑）；纯单 namespace 组件可用 `useTranslation('hosts')` + `t('empty.title')`。
- **en 与 zh-CN 的 key 集合必须完全相等**（`tests/contract/i18n.test.ts`），新增文案必须两份一起加。
- `fallbackLng`：zh-CN → en；漏 key 会回退英文，而不是显示原始 key。
- 资源打包：`import.meta.glob('../../locales/*/*.json', { eager: true })` 静态收进来 —— 离线零 IO，路径写错在**构建期**就报错。

### 已踩的坑（theme-i18n 必读）

`i18next.init` 里 **`nsSeparator` 必须保持默认 `':'`**。把它设成 `false` 会让 `t('hosts:empty.title')` 里的冒号变成字面量，
所有带 namespace 的 key 全部命不中，界面直接显示 `hosts:empty.title` —— 而构建、typecheck、单测**全绿**。
`keySeparator: false` 是必须的（我们的 key 本身含 `.`），别把它和 `nsSeparator` 一起关掉。

---

## 9. 构建、运行与验证

### 脚本（`package.json`）

| 命令 | 做什么 |
| --- | --- |
| `pnpm dev` | electron-vite dev：主进程/preload 构建 + 渲染层 HMR（固定端口 **5273**） |
| `pnpm build` | 产出 `out/main`、`out/preload`、`out/renderer`（生产，注入 CSP） |
| `pnpm typecheck` | `tsc -p tsconfig.node.json` + `tsc -p tsconfig.web.json`（两个 project 分开：主进程无 DOM，渲染层无 Node） |
| `pnpm test` | vitest：`tests/**/*.test.ts` + `src/**/*.test.ts` |
| `pnpm test:e2e` | 先 `pnpm build`，再 Playwright 启动 `out/main/index.js` |
| `pnpm pack:dir` | 先 `pnpm build`，再 `electron-builder --dir`：只产出**未签名**目录包 `dist/mac-arm64/Termans.app`（本机验证用，最快） |
| `pnpm pack` | 先 `pnpm build`，再 `electron-builder`：产出完整安装包（mac dmg+zip、win nsis、linux AppImage+deb，见 §9.5） |

> `dist/` 已进 `.gitignore`；旧脚本名 `package` / `package:dir` 在 P4a 改名为 `pack` / `pack:dir`
> （`package` 与 npm 内置语义太像，容易误读成 `npm pack` 出 tarball）。

### 三个环境坑（macOS + 本机实测）

1. **`ELECTRON_RUN_AS_NODE=1`**：某些 shell/工具链会导出它。此时 Electron 二进制按 Node 运行，
   Playwright 传 `--remote-debugging-port=0` 会被当成 Node 非法参数，报 `bad option: --remote-debugging-port=0`，
   所有 e2e「Process failed to launch」。`e2e/smoke.spec.ts` 里 `electronEnv()` 会显式删除它；
   手动跑 GUI 时用 `env -u ELECTRON_RUN_AS_NODE pnpm dev`。
2. **端口 5173 冲突**：本机常驻别的项目的 `vite --strictPort 5173`。默认端口会让窗口「看起来起来了」但连的是别人的 dev server。
   已在 `electron.vite.config.ts` 固定 `server: { port: 5273, strictPort: true }`（被占用时立刻失败，不悄悄换端口）。
3. **文档截图钩子**：`TERMANS_CAPTURE_PATH=/abs/shot.png pnpm dev` 会在窗口 ready 后 1.2s 用
   `webContents.capturePage()` 落盘 PNG。比系统截屏好：不需要「屏幕录制」权限，也不会把别人的桌面拍进去。
   这张 `docs/assets/shell-dev.png` 就是它生成的。

### 验证记录（真实输出，2026-10-29 01:18 +08:00）

环境：`node v26.11.1` / `pnpm 10.34.7` / macOS arm64。

`pnpm install`（electron 走 npmmirror 镜像，见 `.npmrc`）：

```
Done in 600ms using pnpm v10.34.7
│   Ignored build scripts: ssh2@1.17.0.
│   Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

> 首次安装耗时 28.9s（exit 0）。`ss2` 的 postinstall 是有意不批准的：那是可选的 native `sshcrypto` 加速，
> 不装也能跑（`pnpm.onlyBuiltDependencies` 只放行 electron/esbuild/cpu-features/electron-winstaller）。

`pnpm typecheck`：

```
> tsc -p tsconfig.node.json --noEmit     # 无输出 = 通过
> tsc -p tsconfig.web.json --noEmit      # 无输出 = 通过
```

`pnpm build`：

```
out/main/index.js  36.05 kB
out/preload/index.js  3.70 kB
../../out/renderer/index.html                   0.70 kB
../../out/renderer/assets/index-CxhVE_c3.css   17.42 kB
../../out/renderer/assets/index-D6S8nt2w.js   575.60 kB
```

> 渲染层 575 kB 主要是 zod（渲染层用它做主题/设置校验）。可接受；若后续要压，先拆 zod 到主进程侧。

`pnpm test`：

```
 Test Files  5 passed (5)
      Tests  37 passed (37)
```

`pnpm test:e2e`：

```
  ✓  1 e2e/smoke.spec.ts:66:5 › 窗口标题为 Termans，外壳四区渲染完成 (1.1s)
  ✓  2 e2e/smoke.spec.ts:82:5 › preload 桥可用，并拦截未登记通道 (1.1s)
  ✓  3 e2e/smoke.spec.ts:107:5 › 设置持久化到临时 userData，主题变量已生效 (1.6s)
  3 passed (4.2s)
```

`env -u ELECTRON_RUN_AS_NODE TERMANS_CAPTURE_PATH=docs/assets/shell-dev.png pnpm dev`：

```
  ➜  Local:   http://localhost:5273/
[ipc] registered 53 channels (48 placeholder)
[ipc] placeholders: theme:list, theme:save, … ai:list-conversations
[termans] captured /Users/maliang/Documents/develop/maliang/termans/docs/assets/shell-dev.png
```

截图：`docs/assets/shell-dev.png`（dev 窗口）、`docs/assets/shell.png`（e2e 截图）、`docs/assets/pack-dir.png`（打包后的 .app 启动截图，见 §9.5）。

---

## 9.5 打包（P4a：electron-builder）

### 配置文件与产出目录

配置在 **`electron-builder.yml`**（不用 `package.json` 的 `build` 字段），理由：
1. `build` 字段塞进 JSON 会变成一大段转义串，review 时看不出结构，改一个 target 就是一行长 diff；
2. `package.json` 在本项目是「依赖 + 脚本」的单写者文件，配置分离后调打包参数不必碰依赖文件；
3. electron-builder 原生读 yml，零额外依赖。

产出目录 `directories.output: dist`（已进 `.gitignore`）。`buildResources: build` 是图标/授权文件的来源目录。

| 平台 | target | 架构 | 说明 |
| --- | --- | --- | --- |
| mac | `dmg` + `zip` | arm64 + x64 | `identity: null` 明确**不签名**，`notarize: false`，`gatekeeperAssess: false` |
| win | `nsis` | x64 | `oneClick: false`（可选安装目录）、`shortcutName: Termans` |
| linux | `AppImage` + `deb` | x64 | `category: Development` |

`asar: true`：源码与 `node_modules` 打进单文件 `app.asar`；原生模块（`cpu-features`）自动落到 `app.asar.unpacked/`。

### files 白名单：只放运行期需要的东西

```yaml
files:
  - out/**            # 三端构建产物（main/preload/renderer）
  - package.json      # 主进程要读 version / main
  - node_modules/**   # 见下：electron-builder 按 dependencies 计算生产闭包，这里列出来是为了「看得见 + 能排除」
  - '!node_modules/**/{test,__tests__,tests,docs,example,examples}/**'
  - '!node_modules/**/*.md'
```

主进程在 `electron.vite.config.ts` 里 `externalizeDepsPlugin()`，所以**运行期靠 require**，`ssh2` / `isomorphic-git` / `zod` 一个都不能缺。
实测 asar 里只有这三个包及其传递依赖（`asn1`、`bcrypt-pbkdf`、`pako`、`simple-get`、`tweetnacl`… 共 1198 个文件），
**没有** react/typescript/vitest 等 devDependency —— 渲染层依赖由 Vite 打包进 `out/renderer/assets/*.js`，不进 `node_modules`。

### 图标接线（显式，不靠默认巧合）

electron-builder 默认会去 `build/` 找 `icon.icns|ico|png`，但「默认找得到」不算接线。本仓库在 yml 里**显式写死**
`mac.icon: build/icon.icns`、`win.icon: build/icon.ico`、`linux.icon: build/icon.png`，并做了三道实测：

1. 源文件与设计交付物逐字节一致（`design/BRAND.md` v4「错开版 `>_`」）：
   ```
   $ shasum -a 256 build/icon.icns design/logo/export/termans.icns | awk '{print $1}' | uniq -c
   2 6e295b78d38f561dd06edf84f6d56d23b944403b275a86eb5c3e6d47969f6105
   $ shasum -a 256 build/icon.png design/logo/export/termans-icon-1024.png | awk '{print $1}' | uniq -c
   2 bc879738d0f2497d16943e47686e8d9963237f3ef9e7439fb1038847563a8424
   $ shasum -a 256 build/icon.ico design/logo/export/termans.ico | awk '{print $1}' | uniq -c
   2 f770412033e6bef3d4afffb036896732da686691093b26f1052f834106e72718
   ```
   资源规格：`icon.png` 1024×1024、`icon.icns` 10 档（含 16/32/128/256/512/1024）、`icon.ico` 7 档（16…256）。
2. 打包产物里确实带上了**同一份**图标（不是被 electron-builder 重新生成或忽略）：
   ```
   $ plutil -p dist/mac-arm64/Termans.app/Contents/Info.plist | grep -i icon
     "CFBundleIconFile" => "icon.icns"
   $ shasum -a 256 dist/mac-arm64/Termans.app/Contents/Resources/icon.icns build/icon.icns
   6e295b78…f6105  dist/mac-arm64/Termans.app/Contents/Resources/icon.icns
   6e295b78…f6105  build/icon.icns
   ```
3. 包元数据正确：
   ```
   CFBundleName => Termans | CFBundleIdentifier => com.termans.app
   CFBundleShortVersionString => 0.1.0 | CFBundleExecutable => Termans
   LSApplicationCategoryType => public.app-category.developer-tools
   ```

### 实跑记录（2026-10-29 01:25 +08:00，macOS 26 arm64）

`pnpm pack:dir`：

```
  • electron-builder  version=26.18.0 os=27.0.0
  • loaded configuration  file=/Users/maliang/Documents/develop/maliang/termans/electron-builder.yml
  • executing @electron/rebuild  electronVersion=45.1.0 arch=arm64
  • packaging       platform=darwin arch=arm64 electron=45.1.0 appOutDir=dist/mac-arm64
  • searching for node modules  pm=pnpm searchDir=…
  • skipped macOS code signing  reason=identity explicitly is set to null
EXIT=0
```

> `--dir` 只出**当前架构**（arm64）。`pnpm pack`（不带 `--dir`）才会按 yml 的 arch 列表产出 arm64 + x64 各一份。

产物与体积：

| 产物 | 大小 | 备注 |
| --- | --- | --- |
| `dist/mac-arm64/Termans.app` | **270 MB** | 未压缩目录包 |
| └ `Contents/Frameworks` | 252 MB | Electron 45 运行时（Chromium + Node + SwiftShader 等） |
| └ `Contents/Resources/app.asar` | 12 MB | 1198 个文件：`out/` 628 KB + 三个生产依赖闭包 |
| `dist/Termans-0.1.0-arm64.dmg` | 118 MB | `electron-builder --mac dmg --arm64` 验证通过（exit 0） |
| `dist/Termans-0.1.0-arm64-mac.zip` | 114 MB | `electron-builder --mac zip --arm64` 验证通过（exit 0） |
| `dist/mac/Termans.app` | **290 MB** | x64 目录包，`electron-builder --mac --x64 --dir` 验证通过（exit 0，会下载 x64 Electron） |

> 两个目录包可并存（`dist/mac-arm64` 与 `dist/mac`），互不覆盖；asar 内各自的原生模块架构也各自正确
> （实测两边的 `cpu-features.node` 分别是 arm64 与 x86_64）。

启动验证（直接跑包内二进制，`env -u ELECTRON_RUN_AS_NODE` + 临时 `TERMANS_E2E_USER_DATA`，靠 `TERMANS_CAPTURE_PATH` 截图）：

```
run1: capture_after=1.70s  window_est=0.50s  png=89449B  alive=True
run2: capture_after=1.68s  window_est=0.48s  png=89449B  alive=True
（首启冷启动：capture_after=3.92s → 页面就绪 ~2.72s，差额是首次系统校验/磁盘缓存）
[ipc] registered 53 channels (48 placeholder)
[ipc] placeholders: theme:list, theme:save, … ai:list-conversations
[termans] captured /Users/maliang/Documents/develop/maliang/termans/docs/assets/pack-dir.png
```

> `window_est` = capture 时刻 − 1200 ms（截图钩子固定在 `did-finish-load` 之后 1.2 s 触发，见 §9 环境坑 3）。
> 状态条显示 `Termans 0.1.0`（打包后 `app.getVersion()` 读的是 `package.json` 的版本，与 dev/e2e 表现不同，见 §12）。

顺带发现（不是 bug）：把 `userData` 指到一个**空临时目录**时，Chromium 会打 3 行
`Failed to create directory: …/Shared Dictionary/cache`。这是缓存目录没建，功能不受影响；真实用户目录由 Electron 自己创建。

### ★ 交叉打包会就地改写 node_modules 里的原生模块

`electron-builder` 打包前跑 `@electron/rebuild`，按**目标架构**重编原生依赖，且**直接改 `node_modules` 里的二进制**
（不是往产物目录拷一份了事）。实测：

```
$ npx electron-builder --mac --x64 --dir          # 打完 x64 后
$ file node_modules/cpu-features/build/Release/cpufeatures.node
… Mach-O 64-bit bundle x86_64                     # 本机（arm64）的 node_modules 被写成 x64
$ npx electron-builder --mac --arm64 --dir        # 再打 arm64 才恢复
$ file node_modules/cpu-features/build/Release/cpufeatures.node
… Mach-O 64-bit bundle arm64
```

对开发者的两个实际后果：

1. **交叉打完 x64 之后，本机的 `pnpm dev` / vitest 会加载错架构的原生模块**。ssh2 对可选原生绑定的加载是
   try/catch，功能不坏（`node -e "require('ssh2')"` 仍 ok），但直接 `require('cpu-features')` 会报
   `incompatible architecture`。别误判成「依赖装坏了」。**规矩：在 arm64 机器上交叉打了 x64，收尾必须再打一次 arm64**
   （或 `pnpm rebuild cpu-features`）。CI 上各架构分开跑，不存在这问题。
2. **纯 `node` 加载不了 `cpu-features`**：它按 Electron 45 的 ABI（`process.versions.modules=150`）编译，
   只有 Electron 运行时能 `require`。因此**不要给原生绑定直接写单测**（vitest 跑在纯 node 下）；要测就 mock，或走 ssh2 的公开 API。

### 未签名产物的 Gatekeeper 行为（必须提前告诉用户）

`identity: null` 意味着**没有 Developer ID 签名、也没公证**。本机构建出的 `.app` 没有 quarantine 属性，直接双击能开；
但**任何通过浏览器/微信/AirDrop 传出去的 dmg/zip 都会被 macOS 打上 `com.apple.quarantine`**，首次打开报
「Termans 已损坏，无法打开」或「无法验证开发者」。这不是包坏了。

用户侧两种解法（写进 README/发布说明）：

1. **右键 → 打开**（或在「系统设置 → 隐私与安全性」底部点「仍要打开」）——只需一次，之后正常。
2. 命令行去隔离（适合脚本/CI 分发）：
   ```bash
   xattr -dr com.apple.quarantine /Applications/Termans.app
   ```

判断依据（本机实测，未签名状态）：

```
$ xattr -l dist/mac-arm64/Termans.app
com.apple.provenance:            # 只有溯源属性，没有 quarantine → 本机可直接运行
$ spctl --assess --type execute -vv dist/mac-arm64/Termans.app
dist/mac-arm64/Termans.app: code has no resources but signature indicates they must be present
$ codesign -dv dist/mac-arm64/Termans.app 2>&1 | head -4
CodeDirectory … flags=0x20002(adhoc,linker-signed)
Signature=adhoc | TeamIdentifier=not set | Sealed Resources=none
```

即：arm64 上 Electron 自带 ad-hoc 签名让**本机**能跑，但没有 Team ID 与资源封印，Gatekeeper 对外来副本一律拦。
后续里程碑补：Developer ID Application 证书 + `notarytool` 公证 + `stapler`，以及 Windows 代码签名。

### 打包相关的已知限制

1. **mac 双架构已验证，win/linux 未验证**：mac arm64（dir/dmg/zip）与 mac x64（dir）均 exit 0 且产物齐全；
   win nsis / linux AppImage+deb 的配置就绪但未在本机产出（需对应平台或 CI）。
2. **`pnpm pack:dir` 只出当前架构**（本机 = arm64）；要 x64 目录包用 `npx electron-builder --mac --x64 --dir`，
   代价是下载 x64 版 Electron（约 110 MB）并按上文规矩再打回 arm64。
3. **无签名/公证/自动更新**：本期明确不做；`electron-updater` 未引入。
4. **`dist/` 会越滚越大**：每次 `pack` 都重新生成，非 CI 环境记得手动清。
5. **cpu-features 原生模块**：ssh2 的可选加速，已随包进 `app.asar.unpacked/`；它和 `nan/buildcheck` 是打包时
   `@electron/rebuild` 的唯一工作来源（日志里的 `preparing moduleName=cpu-features`）。

---

## 10. 契约测试清单（`tests/contract/`）

| 文件 | 挡什么 |
| --- | --- |
| `ipc.test.ts` | 通道命名规范/去重、必须存在的通道、事件与通道不冲突、preload 不许 import 桶文件、白名单来自常量、只有 registry 调 `ipcMain.handle`、桩必须最后装 |
| `theme-tokens.test.ts` | 52 个 token 在 dark/light 都齐全、无清单外的 `--ts-*`、ANSI 顺序与越界、CSS 里无裸色值 |
| `i18n.test.ts` | 8 namespace × 2 语言文件存在、扁平 key、无空值、中英 key 完全相等、关键键存在 |
| `models.test.ts` | 主机不接受明文口令、端口/主机名越界、加密包策略是字面量、设置补齐与越界、AI 命令必须确认、终端尺寸边界、ssh_config 用 null 表示删除 |
| `json-store.test.ts` | 缺失/损坏文件的兜底、原子写、`update()`、`normalize()` 补字段、reset |

---

## 11. 各成员边界（并行不冲突）

| 成员 | 只动这些目录 | 不能动 |
| --- | --- | --- |
| engine | `src/main/ssh/`、`src/main/hosts/`（主机库存储） | shared、preload、package.json |
| vault-sync | `src/main/{vault,git}/`、`src/main/known-hosts/` | ssh/、renderer/ |
| ai | `src/main/ai/`、`src/renderer/features/ai/` | 其它 renderer 目录 |
| terminal-ui | `src/renderer/features/{terminal,tabs}/` | `src/renderer/app/` 结构（只往里挂组件） |
| theme-i18n | `src/renderer/{theme,i18n}/`、`src/locales/` | `styles/tokens.css` 的**变量名**（值可有主题覆盖） |
| qa | `e2e/`、`tests/`（新增文件） | 不改 `e2e/smoke.spec.ts` 的既有断言 |
| integration | `src/main/ipc/index.ts`、`src/preload/index.ts`、`src/renderer/app/` | shared 的类型定义 |
| architect | `src/shared/`、`package.json`、构建配置、根文档 | 成员的业务目录 |

---

## 12. 已知限制 / 风险

1. **48 个通道是占位桩**：渲染层现在点按钮得到 `E_NOT_IMPLEMENTED`，这是设计意图，不是 bug。
2. **`app.getVersion()` 在未打包运行时**：Playwright 直接启动 `out/main/index.js` 时拿到的是 Electron 版本（状态条显示 `45.1.0`）；
   用 `pnpm dev`/打包运行时是 `package.json` 的 `0.1.0`。不要拿它当「打包是否生效」的判据。
3. **CSP 只在生产注入**：dev 没有 CSP（理由见 §4），所以别在 dev 里验证 CSP 行为。
4. **sandbox 化 preload**：不能用 `fs`/`path` 的同步能力，所有文件访问都必须走 IPC 到主进程。
5. **ssh2 未启用原生加速**：可选依赖，忽略即可；若某天需要，走 architect 审批 `pnpm approve-builds`。
6. **打包：mac arm64 已跑通，其余平台未验证**：`pnpm pack:dir` / `dmg` / `zip` 均 exit 0，产物能启动并截图（§9.5）；
   win nsis / linux AppImage+deb / mac x64 只有配置、没有实跑。签名/公证/自动更新按计划留到后续里程碑。
