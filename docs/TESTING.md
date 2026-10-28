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
| 主题 / 布局截图回归 | `launchApp()` + `capture()` | 落盘 PNG（`artifacts/` 已 gitignore；要入库的放 `docs/assets/`） |
