# 测试基建（qa / t13）

三类夹具 + 一套启动器，供 t8 的验收矩阵直接复用。**这里只放"怎么用、为什么这么设计"，不放业务断言** ——
连接、known_hosts、Git 同步、双机迁移的断言都写在 t8 的用例里。

| 文件 | 作用 | 谁用 |
| --- | --- | --- |
| `tests/fixtures/ssh-server.ts` | 进程内真 SSH 服务（密码 / publickey / shell / exec / 固定 host key） | vitest 用例（SSH 引擎、known_hosts、认证失败路径） |
| `e2e/harness.ts` | Electron 启动器（独立 userData、`env -u ELECTRON_RUN_AS_NODE`、固定窗口、稳定就绪信号、`capture()`） | 所有 e2e 用例，**不要自己写 `_electron.launch`** |
| `e2e/fixtures/dual-machine.ts` | 双机迁移夹具（本地 bare git 仓库 + 两套独立 userData A/B） | S-07 双机 A→B 迁移 |
| `e2e/selfcheck.spec.ts` | 夹具自检（不是业务用例） | 每次改夹具后先跑这个 |

---

## 0. 三条命令

```bash
pnpm typecheck                                   # 两个 tsconfig（node + web）都过
npx vitest run tests/fixtures/ssh-server.test.ts # SSH 夹具自检，12 个用例
pnpm build && npx playwright test e2e/           # e2e（必须先 build：测的是 out/ 构建产物）
```

`pnpm test:e2e` 已经内置 `pnpm run build`，等价于第三行。三条命令的实测输出见任务 t13 的报告。

**红的时候先分辨是谁的 bug**：SSH 相关用例一红，先单独跑 `npx vitest run tests/fixtures/ssh-server.test.ts`。
它绿而业务用例红 → 引擎/接线的问题；它红 → 夹具的问题。没有这一层，"连不上"每次都要人工判断十分钟。

---

## 1. 进程内 SSH 夹具

```ts
import { createHash } from 'node:crypto'
import { Client } from 'ssh2'
import { startSshFixture } from './ssh-server'

const fingerprint = (blob: Buffer): string =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`

const ssh = await startSshFixture()          // 端口 listen(0)，系统分配
try {
  const conn = await new Promise<Client>((resolve, reject) => {
    const c = new Client()
    c.on('error', reject)                    // 常驻，不要只挂 once（见下方坑 3）
    c.once('ready', () => resolve(c))
    c.connect({
      host: ssh.host, port: ssh.port,
      hostVerifier: (key: Buffer) => fingerprint(key) === ssh.hostKeyFingerprint,
      username: ssh.username, password: ssh.password
    })
  })
  // conn.exec('…') / conn.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, cb)
} finally {
  await ssh.stop()
}
```

### 为什么是进程内 `ssh2.Server`，而不是开系统 sshd

1. **不需要 sudo、不改系统配置**：`/etc/ssh/sshd_config` 一个字都不用动，CI 与开发机都能直接跑；
2. **host key 可注入**：夹具把 `SHA256:` 指纹交回用例，known_hosts 的「首连写入 / 指纹被改必须硬失败」才有确定性的断言对象
   （真 sshd 只能改配置+重启，指纹还随机器而变）；
3. **失败路径可断言**：错误密码、未授权公钥、错误用户名、主机密钥不符，全部可以稳定复现，并把
   `authAttempts`（每次认证尝试的 method / accepted / reason）与 `execs`（命令、stdout、stderr、退出码）交回用例；
4. **每个用例独立起停**：`listen(0)` 让系统分配端口，不写死 2222（本机常见被占），并行跑不会互相踩。

### 能力与返回字段

- **认证**：密码（固定账号/密码，缺省 `termans` / `termans-test`）与 publickey（夹具自带 ed25519 密钥对 `ssh.clientKey.privateKey`，
  另可用 `authorizedKeys` 追加白名单公钥）；
- **shell 通道**：收到 `echo hi\r` 回 `hi\r\n`（终端语义：回车 `\r`、输出 `\r\n`），收到 `exit` 关通道；
  缺省**不回显**输入（断言确定性强），需要真实 tty 行为时传 `echoInput: true`；
- **exec 通道**：`echo hi` → stdout `hi\n`、退出码 0；
- **固定 host key**：`FIXTURE_HOST_KEY` / `FIXTURE_HOST_KEY_FINGERPRINT` 是写死的测试密钥（见下），`hostKey` 选项可覆盖；
- **`stop()`**：幂等，强制断开所有活连接并关闭监听（不会因为客户端还连着而挂住进程）。

### 固定 host key 为什么写死

`FIXTURE_HOST_KEY`（ed25519，**仅测试用，绝不要拿去连真实主机**）默认生效，指纹写死为
`FIXTURE_HOST_KEY_FINGERPRINT = 'SHA256:JFBdXZUT972M8J3vCxY7vjCbanHm8qQYb7UI28O4dLk'`。

如果每次启动都现生成，指纹每次都不一样：known_hosts 用例先写指纹、再把指纹改错、然后断言"必须失败"，
**改错也能过**（期望值本来就随机），校验等于没测。写死之后，两个独立夹具（= 两次进程、两次运行）的指纹完全相同，
`hostKey` 传另一把钥匙就能造"主机密钥变了"的中间人场景。自检里有一条用例专门在罚这件事：
`hostKeyFingerprint === FIXTURE_HOST_KEY_FINGERPRINT` 且公钥匹配 `^ssh-ed25519 [A-Za-z0-9+/=]+$`。

> 换密钥的唯一合法姿势：同时改 `FIXTURE_HOST_KEY` 与 `FIXTURE_HOST_KEY_FINGERPRINT`（自检会立刻红，不会静默漂移）。
> 密钥是空口令的，仓库里放测试私钥是可接受的；但**任何真实主机都不要用**。

### 不做什么

- **不做 SFTP / 子系统**：SPEC 的验收矩阵（S-01..S-09、H-*）里没有 SFTP 项，而 SFTP 子系统要手写协议处理
  （属"为了夹具写一个文件系统"）。真需要时按 `node_modules/ssh2/examples/sftp-server-download-only.js` 就地扩写，
  现在 `session.on('sftp')` 是**明确拒绝**，不会让客户端一直等。
- 不做端口转发 / agent 转发（同上，没有用例需要）。

### 三个坑（都已在夹具里处理，改夹具前先读）

1. **ssh2 `Server` 的 `'connection'` 事件给的不是 socket**，而是它内部的 `Client` 包装对象
   （`server.emit('connection', client, info)`）。按 `Socket` 用会得到 `socket.destroy is not a function`，
   而且 `stop()` 就没办法强制断开活连接（`server.close()` 的回调要等客户端自己走，用例失败时会挂住 vitest）。
   夹具因此自建 `net.Server` 持有**原始 socket**，再用 ssh2 的公开入口 `injectSocket(socket)` 交进去。
2. **publickey 是两段式**：客户端先发不带签名的探测请求（恢复 `PK_OK`），再发带签名的正式请求，
   所以 `authAttempts` 里会出现两条 `method: 'publickey', accepted: true`。断言写 `new Set(...)` 而不是数组相等。
3. **客户端必须常驻 `error` 监听**：`stop()` 会强制断开还活着的 socket，客户端侧是 `ECONNRESET`；
   只挂 `once('error')` 的话握手成功后这条错误无人接，会变成 unhandled error 直接冒到进程上（vitest 里表现为"测试全绿但有 4 个 Uncaught Exception"）。

---

## 2. Electron e2e 启动器

```ts
import { launchApp } from './harness'

const running = await launchApp()          // 缺省新建临时 userData
try {
  await expect(running.window).toHaveTitle('Termans')
  await running.capture('artifacts/screens/whatever.png')
} finally {
  await running.cleanup()                  // 关应用 + 删目录，删完断言目录真的不在了
}
```

- `launchApp({ userDataDir })`：复用现成目录（双机用例的 A/B）；不传就新建临时目录；
- `close()`：只关应用、**保留** userData（双机 A→B 要复用同一份数据）；
- `cleanup()`：关应用 + 删目录，`rmSync` 之后还会 `existsSync` 复查一次，删不掉就抛（不留假绿）；
- `capture(app, path)` / `running.capture(path)`：截图；返回前校验 PNG 魔数与落盘字节数；
- `settingsFile`：`<userData>/settings.json`，要直接断言落盘 JSON 时用它；
- 额外就绪条件：`waitFor: (page) => page.getByTestId('…').waitFor()`。

### 统一的四件事与理由

1. **独立 userData**：每个启动一个临时目录，用例之间不共享 `settings.json` / `known_hosts.json` / vault。
   实现走两条同源通道、指向**同一个**目录：启动参数 `--user-data-dir=<dir>`（Chromium 层开关，进程 init 阶段就生效）
   ＋ 环境 `TERMANS_E2E=1` / `TERMANS_E2E_USER_DATA=<dir>`（主进程 `app.setPath('userData')` 钩子，见 `src/main/index.ts` 的 whenReady）。
   两条并用是为了不让"settings 落在 A、Chromium 缓存落在 B"。**实测断言**：应用进程内 `app.getPath('userData')`
   经 `realpath` 后必须等于传入目录（macOS 上 `os.tmpdir()` 是 `/var/folders/…`，Chromium 会规范化成 `/private/var/folders/…`，
   直接字符串比较会假失败）。
2. **`env -u ELECTRON_RUN_AS_NODE`**：本机 shell 导出了 `ELECTRON_RUN_AS_NODE=1`，此时 Electron 二进制按 Node 运行，
   Playwright 传的 `--remote-debugging-port=0` 会被当成 Node 的非法参数，报 `bad option: --remote-debugging-port=0`，
   所有用例都是 "Process failed to launch"。Playwright 的 `env` 选项是**整体替换**，所以 harness 在进程内拼 env 时 `delete`
   掉它（等价 `env -u`），顺带剔掉 `ELECTRON_ENABLE_LOGGING`（会把主进程 stdout 灌满）与残留的 `ELECTRON_RENDERER_URL`
   （会让 prod 构建去连别人的 dev server）。用例里有实测断言：应用进程内 `process.env.ELECTRON_RUN_AS_NODE === null`。
3. **固定窗口尺寸**：默认 1320×860（与 `src/main/index.ts` 的 createWindow 一致）。尺寸不固定 → xterm 列数随宿主窗口变化 →
   截图对比和"一行多少列"类断言都会飘。
4. **稳定就绪信号**：`firstWindow()` 只保证窗口对象存在。harness 等三件事：webContents 的 `did-finish-load`、页面 `load` 状态、
   `document.readyState === 'complete'`。只等 `domcontentloaded` 会在 React 首帧之前断言，报出来的是"元素不存在"（误导成本更高）。

### `capture()` 为什么用 `webContents.capturePage()`

不用系统截屏：后者在 macOS 需要「屏幕录制」权限，CI 上没有，本机第一次跑会弹权限框把用例卡住。`capturePage()` 是应用自己
渲染出栅格，无需任何权限。它也能拍"窗口内真实像素"，对主题/布局回归足够用。

---

## 3. 双机迁移夹具

```ts
import { withDualMachine } from './fixtures/dual-machine'
import { launchApp } from './harness'

await withDualMachine(async ({ dirA, dirB, bareRepo, bareRepoUrl }) => {
  const a = await launchApp({ userDataDir: dirA })
  // …A 里建主机/改设置、推到 bareRepo…
  await a.close()                      // 注意是 close，不是 cleanup：目录要留给 B
  const b = await launchApp({ userDataDir: dirB })
  // …B 从 bareRepo clone，断言看到同一份数据（这才是 S-07）…
  await b.close()
})
// 退出时目录已删，且夹具内部断言过 root/dirA/dirB/bareRepo 全部不存在
```

- **本地 bare 仓库**（`git init --bare --initial-branch=main`）+ 两份 userData。用 `file://`/目录路径当 remote：
  离线可跑、不依赖凭证与网络、不用起 HTTP 服务（没有端口冲突与进程清理问题），但走的是和真实远端同一套 object/pack 格式；
- **`--initial-branch=main` 必须写死**：否则宿主机 `init.defaultBranch` 是 `master` 时，A push 到 main、B clone 到 master，
  "同步成功但看不到数据"会伪装成环境问题；
- **两份 userData 而不是两个进程**：「双机」的本质是两套互不相干的本地目录。同一个 Electron 可执行文件串行起两次即可；
  并发起两个进程只会让 window 归属与 userData 锁变复杂（S-07 是串行的 A→B，不需要并发）；
- **清理要断言**：`rmSync(force: true)` 会吞掉部分错误，残留的 tmp 目录会被下一次运行复用，症状是"上一次的设置还在"——
  假绿。夹具在删完之后逐个 `existsSync` 复查，有残留就抛（回调本身失败时用 `AggregateError` 保留两个错误，不让清理失败盖掉断言失败）。

---

## 4. 本机三个坑

1. **`ELECTRON_RUN_AS_NODE=1` 是导出的**（`printenv ELECTRON_RUN_AS_NODE` → `1`）。任何绕过 `launchApp()` 自己写
   `_electron.launch` 的代码都会踩到 "Process failed to launch"。用 harness，别绕过。
2. **5273 端口常驻被占**：本仓库的渲染层 dev server 固定 `5273`（`electron.vite.config.ts`，`strictPort: true`；
   Vite 默认的 5173 在本机被别的项目占着）。实测 `lsof -i :5273` 命中的是 `node …/electron-vite dev`，cwd 就是本仓库。
   含义有三层：① 别再起第二个 dev server，`strictPort` 会直接失败；② **e2e 不需要 dev server**，测的是 `out/` 构建产物，
   所以跑 e2e 前不要以为要先 `pnpm dev`；③ 要清端口就按 cwd 找进程，别按进程名乱杀（可能误杀别的项目）。
3. **Playwright 的 chromium 已经在缓存里**：`~/Library/Caches/ms-playwright` 下已有 `chromium-1248` /
   `chromium_headless_shell-1248` / `ffmpeg-1013`，**不必再跑 `npx playwright install`**（本机网络不稳，重下大概率失败）。
   另外 Electron e2e 用的是仓库里的 `electron` 依赖，本来也不走 Playwright 的 chromium。

---

## 5. t8 验收矩阵 → 夹具映射（建议）

| 用例 | 用哪个夹具 | 关键断言点 |
| --- | --- | --- |
| 密码登录 / 错误密码 | `startSshFixture()` | `authAttempts` 的 `accepted` / `reason: 'bad-password'` |
| publickey 登录 / 未授权 key | `startSshFixture()` + `authorizedKeys` | `reason: 'unauthorized-key'`；两段式 accepted 用 Set 断言 |
| known_hosts 首连写入 / 指纹变更硬失败 | `FIXTURE_HOST_KEY` + `FIXTURE_HOST_KEY_FINGERPRINT`，配合 `hostKey` 覆盖 | 应用里读 `known_hosts.json`；指纹不符时连接必须失败（`Host denied`） |
| 终端 echo / 退出码 / 多页签 | `startSshFixture()` + `launchApp()` | shell 输出 `hi\r\n`；`execs`/`shellLines` |
| S-07 双机 A→B 迁移 | `withDualMachine()` + 两次 `launchApp()` | bareRepo 里的密文与 B 读到的数据一致；A/B 的 `userData` 互不相干 |
| S-10 乐观锁冲突逐字段选边 | `withDualMachine()` + `serveBareRepo()` + 两台 `launchApp()` | `sync-conflicts` 里 `.ts-vault__conflict` 一条、bare `HEAD:manifest.json` 的 `revision` 未前进；选边后本地/远端各自落地 |
| 主题 / 布局截图回归 | `launchApp()` + `capture()` | 落盘 PNG（`artifacts/` 已 gitignore；要入库的放 `docs/assets/`） |

### 5.1 e2e 侧那套夹具与 tests/fixtures 的区别（t26 补）

`e2e/fixtures/ssh-server.ts` **不是** `tests/fixtures/ssh-server.ts` 的包装，两者刻意不共享代码：

| | `tests/fixtures/ssh-server.ts`（engine 维护） | `e2e/fixtures/ssh-server.ts`（qa 维护） |
| --- | --- | --- |
| 监听方式 | 自建 `net.Server` + `server.injectSocket()`（为拿到原始 socket） | 标准 `ssh2.Server.listen(0,'127.0.0.1')` |
| 用途 | 主进程单测（不经 Electron） | 真 Electron 里跑端到端 |
| 额外能力 | host key 固定、两段式 publickey 校验 | **shell banner 可定制**（`banner`），**direct-tcpip 转发**（`forwardTo` + `tcpips` 记录） |

`forwardTo` 是 S-12 跳板机用例的地基：跳板机夹具收到 direct-tcpip 就接到真实目标机上，
于是「目标机主机条目写 `127.0.0.1:1`（直连必拒）」也能连通 —— 跳板逻辑一旦没生效，用例必然红，
而不是「不走跳板恰好也能连上」这类假绿。

### 5.2 S-11 / S-12 用例要点（t26）

- **S-11 双机迁移**（`e2e/dual-machine.spec.ts`，3 条）：A 推 → B 拉 → 3 台主机 + 真登夹具；错口令机器看不到主机。
  两个易踩点：
  1. `pullSync()` 结束后同步面板的模态还在 DOM 里，`dblclick` 会被 `.ts-modal` 吃掉 —— 连线前先 `closeSyncPanel()`；
  2. 要断言「这个 IPC 必须失败」（如 `E_VAULT_LOCKED`）时用 `invokeInPageRaw()`，`invokeInPage()` 在 `ok:false` 时会抛，
     会把「断言通过」变成「测试红」。
  另外该文件**不要**加 `describe.configure({ mode: 'serial' })`：串行模式下前一条红会让后面显示 "did not run"，
  判定表就没法逐条给结论（配置里已 `workers: 1`，用例之间本来无共享状态）。
- **S-12 跳板机**（`e2e/jump-host.spec.ts`，2 条）：经跳板机连上目标机、终端 banner 来自目标机、`jump.tcpips` 有 dest 记录；
  反面是跳板机指纹被改成错值 → 硬失败、目标机 `authAttempts` 与 `tcpips` 都不增长。
  夹具侧靠 `startE2eSshServer({ forwardTo, banner })`：跳板机夹具收到 `direct-tcpip` 就接到真实目标机，
  目标机 banner 换成 `termans-e2e target ready` 用来证明「终端内容确实来自目标机」。
  **别用「点掉两个 host-key 确认框再数次数」的方式断言**：两台夹具共用同一把固定 host key、指纹一模一样，
  机器繁忙时两个框重叠重渲染，`toHaveCount(0)` 会稳定假失败（实测 3 连跑红过 1 次）。
  正确做法是 `known-hosts:trust` 预置指纹，把「指纹接受/拒绝」交给本文件反面用例与 `vault-security.spec.ts` ⑧，
  这里只断言隧道被用上。

### 5.3 终端文本与 `--disable-gpu`（对所有读终端的用例都成立）

xterm 在 GPU 可用时挂 WebGL，文字在 canvas 里，`.xterm-rows` 数量为 0；`launchApp({ args: ['--disable-gpu'] })`
回退 DOM 渲染器后才有文本。**凡是会读终端内容的用例都必须带这个参数**，否则报
「没有 .xterm-rows」。同理：截图落 `artifacts/`（已 gitignore），`docs/assets/shell.png` 由发布流程单独更新，
测试直接写它会把别人未提交的版本覆盖掉。

### 5.4 S-10 乐观锁冲突（t8 补，`e2e/conflict.spec.ts`）

三条用例：同一现场分别选**保留本地 / 保留远端 / 两边都留**，每一条都真点面板按钮（不直调 `sync:resolve`），
并核对三件事：冲突快照落盘、远端没被静默推进、选边结果能传到另一台机器。

造现场的四条硬经验（不按这个来，用例会「看起来绿」）：

1. **必须两边改同一个字段**。`mergePayloads()` 是逐字段三方合并，两边改不同字段会自动并入、不产生冲突
   （见 `src/main/git/conflicts.ts` `mergePayloads`）。所以 base=2201、A→2222、B→2300，冲突路径是
   `hosts.<id>.port`；若 A 改 port、B 改 username，只会干净合并，测不到任何东西。
2. **冲突未解决时工作副本会回到远端内容**（`mergeFlow` 里 `resetTo(remote)` + `manager.reload()`），
   本地值只活在冲突记录与快照里。所以「不静默覆盖」要断言的是「本地值在冲突面板/快照里可读 + 远端 revision 未前进」，
   而不是「`hosts:list` 里还是 2222」——后者是错误期望，会稳定假红。
3. **主机改动走 `hosts:update`**：当前外壳没有编辑已有主机的 UI 入口（双击=连接，见 `HostLibraryPane.tsx`
   的 `onDoubleClickCapture`），这是产品缺口不是用例要验的东西；但**选边必须点 UI**，两件事别混。
4. **解决后清理是异步的**：`state.enc` 在推送成功之后才删（实测有几百毫秒窗口），断言要 `expect.poll`；
   时间戳快照目录是留证，不清。

回锁竞态（同一文件里踩到、`e2e/fixtures/ui.ts` 已提供 `waitForVaultUnlocked()`）：连远端做首轮对齐时
产品会把 vault 回锁，`.ts-app` 的 `data-locked` **先**翻成 `"true"`、解锁屏**后**绘制，中间那一瞬
「解锁屏还没出现、外壳看着还在、同步面板按钮已经 hidden」——此时直接 `click()` 会 30s 超时。
`waitForVaultUnlocked(page, passphrase)` 要求「已解锁」连续两次抽样成立才返回，并在遇到解锁屏时自动解锁。
`createVault()` 同样改成了重试循环：口令判弱要求「同口令再点一次创建」，而弱口令提示与外壳渲染谁先到是竞态的。

---

## 6. `e2e/` 目录的硬规则（t8 收口时定的团队约束）

**`e2e/` 只放交付用例。** 截图、探针、一次性的"看一眼渲染结果"脚本一律不许进来，放
`scripts/shots/<名字>.mjs`（node 直接跑，不进 Playwright）或仓库外 `/tmp` + 独立 config。

原因不是洁癖，而是这个目录被**三处**自动捡起，放进去的东西会被当成交付物对待：

| 捡起它的地方 | 后果 |
| --- | --- |
| `playwright.config.ts` 的 `testDir: './e2e'` | 被当正式用例执行：`npx playwright test e2e/` 的条数变了，红一条就整套红 |
| `tsconfig.node.json` 的 include `e2e/**/*.ts` | 被 tsc 检查：`TS6133 声明未使用`、`TS2488 NodeListOf 不是可迭代` 这类**只在临时脚本里出现**的错误会让全仓 `pnpm typecheck` 变红 |
| `git ls-files e2e` 对账 | `git ls-files e2e \| wc -l` 与 `find e2e -type f ! -name '.DS_Store' \| wc -l` 不再相等 |

**禁止 `zz-` 前缀的 spec 留在 `e2e/`**（历史上这些是最常见的脚手架命名）。`playwright.config.ts` 里加了
`testIgnore: ['**/zz-*']` —— 那是**安全带不是许可**：它只能保证别人的脚手架不在验收窗口把整套 e2e 拖红，
不能解决 tsc 报错与对账不齐，所以规则照旧禁止。

验收窗口的处置权：跑三条命令之前，`e2e/` 里出现任何 `zz-*.spec.ts` 直接删（都是未跟踪脚本，能重建），
在报告里记一行"清除了哪些"即可，不必等作者。

**`probe-*` / `*-shots` 同样会被收集执行**——`testIgnore: ['**/zz-*']` 只挡 `zz-` 前缀，其余命名一律照跑。
2026-10-29 有个 `e2e/probe-t37.spec.ts` 因此混进别人的全量窗口，用例条数与耗时都对不上。临时探针一律放
`/tmp` 或 `scripts/`，放进 `e2e/` 就等于交付。

**"退回旧版复现"必须在独立 worktree 里做**：

```bash
git worktree add /tmp/repro-<hash> <hash>     # 共享树里一个字节都不许动
```

理由：共享工作树是 5 个人同时在用的同一份文件。captain 曾在共享树里把 `e2e/fixtures/ui.ts` 退回补丁前版
（13:21:52，跑了约 3 分钟再还原）做差异对照，正好覆盖了同时段 qa 的 6 轮稳定性测量——于是 qa 量出了一份
"2/6 红"的假结论，还差点当成产品缺陷上报。做不到 worktree 的（例如要复用同一份 `userData`），就先在团队里
声明「我要临时改 X 文件，窗口约 N 分钟」，改完 `git hash-object` 复核还原。

**跑测试不许抢焦点（零打扰）**：`pnpm test:e2e` 会在桌面上真的开一个窗口——**窗口可以有，焦点不能抢**。
共享的那台机器上有人正在打字、开会、录屏，一条 e2e 把窗口顶到最前面就是事故（最轻也是把别人的输入打断）。

| 允许 | 禁止 |
| --- | --- |
| `win.showInactive()`（e2e 分支，窗口出现但不激活） | `open -a` / `osascript … activate` / `tell application "X" to quit` |
| `webContents.capturePage()`（应用自己出栅格，零权限） | `screencapture`（要「屏幕录制」权限，本机第一次跑会弹权限框把用例卡住） |
| `app.dock.hide()`（仅 e2e 分支，省掉 Dock 图标闪动） | `win.focus()` / `win.moveTop()` / `setAlwaysOnTop(true)` |

实现落在 `src/main/index.ts` 的 `const isE2E = process.env.TERMANS_E2E === '1'`（同 `harness.ts` 设的那条）：
`win.once('ready-to-show', () => (isE2E ? win.showInactive() : win.show()))`。这个开关**只对 e2e 生效**，
打包产物里那段代码存在但永不触发（用户环境里不存在 `TERMANS_E2E`），人工启动走的仍是 `show()`。

`app.dock.hide()` 同理，必须严格写在 `if (isE2E)` 里——写漏了装给用户的 App 会从 Dock 里消失。

### 6.1 三条 verify 命令的判定口径

只看 `passed` 数会误判——同一天里出现过 `Tests 622 passed` 与 `exit code 1` 同时成立（子进程 EPIPE 的
unhandled error 不会让用例失败，只会让进程退出码变红，见 t29）。所以一条命令算"绿"要**四个**条件同时成立：

1. 退出码 0；
2. 用例数符合预期——**判据里的数字会随并行成员加用例而变化**，所以报告里要写"当时是多少"而不是背一个固定值
   （实测轨迹：t8 早期 `51 files / 622 passed`，t30/t31 落地后 `52 files / 626 passed`；`pnpm test:e2e` 一直是 26 passed）；
3. 输出里 `grep -c "Unhandled Errors"` 等于 0；
4. **跑前、跑后各记一次 `git rev-parse --short HEAD`，两次必须相同。** 并行成员一直在提交，HEAD 变了说明你验的是
   另一个 commit——那样的绿必须重跑，不能当成"本次交付绿的"。
5. **flake 结论必须先证明"测的是同一份文件"**：每轮前后各记一次被测文件的 `git hash-object <file>`（以及
   `git rev-parse --short HEAD`），任何一次变了就把该轮标 `FILE_CHANGED` **作废**，并在报告里写明作废理由。

   这条是从一次真实事故里长出来的：qa 量 `dual-machine.spec.ts` 的稳定性，6 轮里 2 轮红（18 次执行 4 次红），
   报错全是 `fixtures/ui.ts:516` 那一行 `/取消|cancel/i` —— 而那一行**只存在于补丁前的版本**
   （`git show <补丁前>:e2e/fixtures/ui.ts` 第 516 行正是单分支点击）。真因是 captain 同时在同一棵树里
   `git show <hash>^:e2e/fixtures/ui.ts > e2e/fixtures/ui.ts` 做「补丁前 vs 补丁后」对照，跑了 3 分钟又还原。
   **4/18 红不是产品 flake，是两个人在同一棵树上测不同版本的同一个文件。**

   判据不是"看一眼 git status 干净"——**未跟踪/未修改 ≠ 内容没被替换过**。要用内容哈希，且要跑前跑后各一次。
   结论表里把作废轮次一并列出（哪一轮、为什么作废），**作废的理由本身是证据**。

### 6.2 已知时序：双机用例的 clone 等待为什么是 60s

`e2e/dual-machine.spec.ts` 里 B/C 机"等仓库被对齐到远端那次提交"的上限从 30s 放宽到 60s。
这不是掩盖偶发红：实测全量跑（26 条、workers=1、前面还压着 20 多条 Electron 启动）时，clone 落地
偶发超过 30s，单独跑该文件则 3 passed (18~20s)。等待本身是 `expect.poll` 轮询 `git log --oneline -1`
里出现 `termans:`（目标状态），不是固定 sleep；60s 只是给"机器忙"留的余量。如果后续再红，
先看是不是轮询条件本身错了（例如此刻仓库还没 init），而不是继续加时间。

措辞上要守住两条，别让后人读成"超时可以随便放大"：①这是**轮询到目标状态**（`git log -1` 里出现 `termans:`），
不是固定 sleep，所以放宽上限不增加常规耗时（命中即返回）；②放宽的正当理由是"机器忙时同样的目标状态达成更慢"，
若某次红是**判据**错了（例如此刻仓库还没 init、`termans:` 永远不会出现），加时间只会让它从"30s 红"变成"60s 红"。

### 6.3 截图是证据：先确认它对应哪个 commit

- **症状**：图是新生成的时间戳，内容却是改之前的画面，被当成"改后证据"贴进报告（ai 差点这么交上去）。
- **判据**：截图脚本驱动的是 `out/` 里的构建产物，不是源码。**别拿 commit 时间比**——提交时间必然晚于
  文件修改时间，docs-only 或"改完立刻提交"都会让对比误报。真正的判据是「有没有比产物更新的源码」：

  ```bash
  find src src/shared -type f -newer out/main/index.js   # 输出非空 = 源码比产物新，必须先 build
  stat -f %m out/main/index.js                           # macOS；Linux 用 stat -c %Y
  ```

  实测反例（同一台机器 2026-10-29）：`HostSidebar.tsx` 改于 `12:51:53`、`out/main/index.js` 是 `12:51:55`、
  对应提交 `44e6bce` 的时间是 `12:52:12`。若拿"产物 vs commit 时间"比，会判成"产物比 HEAD 旧、需要重 build"；
  而 `find src -type f -newer out/main/index.js` 返回 **0 个文件**——改动在 build 之前就落盘了，产物其实是最新的。
  **看源码 mtime，不看 commit 时间。**
- **正确顺序**：`git rev-parse --short HEAD` 记下 → `pnpm build` → 截图（或跑 e2e） → 再 `git rev-parse --short HEAD`
  复核没变 → 把两个 hash 与 `stat -f '%Sm' out/main/index.js` 一起写进报告。任何"改完立刻截/立刻跑"的脚本，
  第一条命令都必须是 build（`npx playwright test` 不 build，见 §6.3.1）。

---

## 7. 两条"看一眼就少走十分钟"的实测坑（ai 截图时踩的，captain 要求收进来）

**7.1 读终端内容前必须 `--disable-gpu`**

- 症状：`terminalText(page)` 抛异常，或断言"终端里没有 banner"，而界面上文字明明看得见；截图里文字也正常。
- 原因：xterm 在 GPU 可用时装载 WebGL 渲染器，文字画在 canvas 里，DOM 中 `.xterm-rows` 数量为 0。
- 正确写法：`launchApp({ args: ['--disable-gpu'] })`——**所有会读 `.xterm-rows` 的用例（含截图脚本）都加**，
  漏了就只有 WebGL 路径，`terminalText()` 永远取不到文本。

**7.2 `enableAi()` 之后要重新 `openAiPanel(page)` 才能截图 AI 面板**

- 症状：开了 AI 总开关后立刻截 AI 面板，截出来的是别的界面，或 `ai-panel` 不可见。
- 原因：`settings:changed` 会同步外壳状态 `aiPanelVisible`，把面板收起来（开关变 true ≠ 面板打开）。
- 正确写法：`enableAi()` → `openAiPanel(page)` → 等 `ai-panel` 可见 → 再截图/断言。

**6.3.1 三条入口的差别：`npx playwright test` 不建产物**

| 入口 | 是否 build | 适合 |
| --- | --- | --- |
| `pnpm test:e2e` = `pnpm run build && playwright test` | **是** | 验收、收口、CI（等价写法） |
| `npx playwright test e2e/…` | **否** | 改完 fixture/断言后快速迭代（前提：刚 build 过） |
| `npx playwright test --list` | 否，且不跑 `globalSetup` | 只数用例 |

反例（2026-10-29，captain 实测，值得贴墙——但**先说结论：这条红不是产物过期造成的，captain 的初判错了**）：

```
13:04  npx playwright test e2e/dual-machine.spec.ts  → 3 failed
       out/main/index.js mtime = 12:55:16（晚于 44e6bce @12:52:12，产物其实已含内嵌改动）
13:07  同一文件、out 已被重建为 13:06:53            → exit=0 全绿
```

真正的因果链是：`44e6bce` 把侧栏同步/安全入口切到 `openSettingsDialog(...)` 后，`sync-panel` 由设置弹窗内嵌渲染、
按契约不渲染「取消」按钮；而 `e2e/fixtures/ui.ts` 的 `closeSyncPanel()` 当时只写了「找取消按钮点它」一条分支，
于是 30s 超时。`9354272` 给它补了「没有取消按钮就点 `settings-close`」的第二分支后即绿。
**13:07 那次之所以全绿，是因为补丁当时已在工作树里（未提交），不是因为产物被重建**——产物时间戳只是同一次
build 顺手更新的，不构成解释。

所以：**产物过期是另一类真实存在的假红（见 6.3），但它解释不了这次的 3 条红。** 判据要落到「helper 依赖的
DOM 契约是否还存在」，而不是「谁的产物旧」。这条曾被我误判成"没人 build"，写进文档后又被 terminal-ui 用
`git log` + 同一产物的两次复跑顶回来——**归因错比对错更危险，因为它会让人停止追查**。

现在的防线是两层：①配置层 `globalSetup: './e2e/global-setup.ts'` 在任何用例开跑前断言
「没有比产物更新的源码」，否则 0.7 秒内带着文件名清单失败（实测：`touch src/renderer/app/App.tsx` 后
`npx playwright test` 立即报 `产物过期：先 pnpm build…` 并列出 `src/renderer/app/App.tsx`）；
②`pnpm test:e2e` 自带 build。**两者是冗余关系，不是替代关系**——闸门只能挡住「忘了 build」，
挡不住「build 失败但旧产物还在」（那种情况 build 命令本身会 exit≠0，别把它的输出吞掉）。

**共享工作树里这道闸门会经常红，这是它该有的样子**：5 个成员并行改 `src/`，你 `pnpm build` 之后 30 秒内就可能
有人动了 `HostSidebar.tsx`，于是下一轮 `npx playwright test` 被闸门拦下、一条用例都没跑。实测 6 轮里 2 轮就是
这样被拦的（闸门报 `产物过期…` 并列出来源文件），**这两轮要记成"作废（并发改动导致产物过期）"，不是"2 条红"**。
所以：①官方入口用 `pnpm test:e2e`（它先 build）；②手动 `npx playwright test` 前必须紧挨着 build 一次；
③看到闸门消息先看它列的文件，那是**别人刚改的**，不是你的错，重 build 再跑。
