# Termans 验收矩阵（SPEC）

> 给 **qa** 用的可执行判据。每一条都要能回答「怎么跑」「看什么」「什么算过」。
> 编号即缺陷引用号：报告里写 `H-03` / `S-07` 即可定位。
>
> 约定：
> - **A** = 自动化（Playwright / vitest，落点写在「落点」列）；**M** = 人工目视（附截图要求）。
> - 「操作」里出现的 `data-testid` 是契约的一部分，改动要同步本表。
> - SSH 相关用例对**本地临时 sshd** 执行（`/usr/sbin/sshd -f <tmp>/sshd_config -D -p 2222`，不要碰真实服务器）。
> - 同步相关用例对**本地 bare 仓库**执行（`git init --bare <tmp>/remote.git`），不依赖 GitHub 网络。
> - 失败判定：任何一条 A 类判据失败 = 该特性不可交付；M 类失败需附截图与复现步骤。

---

## 0. 基线与门禁

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| B-01 | 干净检出不装额外依赖即可通过类型检查 | `pnpm install && pnpm typecheck`，两行 `tsc` 均无输出、exit 0 | 手工/CI |
| B-02 | 生产构建成功且三端产物齐全 | `pnpm build` 后存在 `out/main/index.js`、`out/preload/index.js`、`out/renderer/index.html` | 手工/CI |
| B-03 | 单测与契约测试全绿 | `pnpm test`，`Test Files N passed`、`0 failed` | vitest |
| B-04 | 窗口级冒烟全绿 | `pnpm test:e2e`（内部先 build），3 用例通过 | `e2e/smoke.spec.ts` |
| B-05 | dev 模式能起窗口 | `env -u ELECTRON_RUN_AS_NODE pnpm dev` 出现窗口且控制台打印 `[ipc] registered 53 channels` | 手工 |
| B-06 | 渲染层无未捕获异常 | dev 窗口 DevTools Console 无红色 error（允许 `E_NOT_IMPLEMENTED` 相关的黄色 warning） | M |

---

## 1. 主机管理（H）

数据落点：`userData/library.json`（主机 + 分组，schemaVersion 1）。**不得**出现在同步目录之外的位置。

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| H-01 | 新建主机：必填校验到位 | 点 `[data-testid="host-new"]` → 主机名留空提交 → 表单报错且**不**落库 | e2e 新增 `hosts.spec.ts` |
| H-02 | 新建主机成功并出现在侧栏 | 填 label=`demo`、hostname=`127.0.0.1`、port=`2222`、user=`tester`、auth=`password` → 保存 → `[data-testid="host-tree"]` 内出现该 label | 同上 |
| H-03 | 主机持久化 | 重启应用（关闭窗口再 `pnpm dev`）→ `demo` 仍在 | 同上（用两次 `_electron.launch`） |
| H-04 | 编辑与删除 | 改 label 为 `demo2` → 树内显示 `demo2`；删除 → 树内消失且 `library.json` 不再含该 id | 同上 |
| H-05 | 分组与树形结构 | 新建分组 `lab`，把 `demo2` 拖入/移入 → 树内 `lab` 下出现 `demo2`；删分组时主机不被删除（移到根） | 同上 |
| H-06 | 搜索过滤 | 侧栏搜索框输入 `dem` → 只剩匹配项；输入 `zzz` → 显示 `hosts:empty.title` | 同上 |
| H-07 | 排序持久化 | 拖拽调整两台主机顺序 → 重启 → 顺序不变（`library.json` 的 `sortIndex` 与 UI 一致） | 同上 |
| H-08 | **主机不保存明文口令/私钥** | 用密码认证保存主机后 `grep -i password userData/library.json` 无命中；`grep -i "PRIVATE KEY"` 无命中；`credentialRef` 有值 | vitest（模型层）+ shell 断言 |
| H-09 | 凭据走 safeStorage | 设置密码后 `library.json` 不含明文口令，macOS 钥匙串出现 `Termans` 条目；清除凭据后再次连接要求重新输入 | M + shell |

---

## 2. 多页签终端（T）

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| T-01 | 新建页签 | `Cmd/Ctrl+T` 或 `[data-testid="tab-new"]` → `[data-testid="tab-strip"]` 内页签数 +1，新页签为 active | e2e `tabs.spec.ts` |
| T-02 | 页签切换保留会话 | 两页签各连一个 sshd 会话，各 `echo A` / `echo B`；来回切换后终端回滚内容各自保留（A 页签仍显示 A，不串流） | e2e（读 xterm buffer 文本） |
| T-03 | 关闭页签释放会话 | 关闭页签 → 该 `sessionId` 从 `ssh:list-sessions` 消失（主进程无残留连接）；剩余页签自动聚焦右邻/左邻 | e2e + IPC 断言 |
| T-04 | 关闭有活动会话的页签需确认 | `settings.ui.confirmOnCloseTab=true` 时关闭已连接页签弹确认；选「取消」页签仍在 | e2e |
| T-05 | 终端自适应尺寸 | 调整窗口宽度 400px → `ssh:resize` 的 cols 变化，远端 `stty size` 输出与 cols/rows 匹配；无横向滚动条错位 | e2e + 人工 |
| T-06 | 终端外观跟随主题 | 切换 `termans-light` → 终端背景变亮、ANSI 16 色改变、文字可读；切回无残留 | M（截图）+ 主题用例 |
| T-07 | 查找与链接 | `Cmd/Ctrl+F` 打开搜索、命中高亮；点击输出里的 URL 走 `app:open-external`（系统浏览器），**不在应用内导航** | e2e |
| T-08 | 复制粘贴与回滚 | 选中即复制（`copyOnSelect` 开）；`scrollback` 达上限后不崩；粘贴超 10KB 不卡顿 | M |
| T-09 | 页签标题可辨识 | 页签显示 `user@host`（或自定义 title），连接中/已连接/错误的圆点状态与 `settings` 一致 | M |

---

## 3. SSH 连接（C）

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| C-01 | 密码认证连接成功 | 对本地 sshd 用密码连接 → `[data-testid="terminal-area"]` 出现 shell 提示符，状态条 `connected` | e2e `ssh.spec.ts` |
| C-02 | 公钥认证连接成功 | `publickey` + `privateKeyPath`（临时生成 ed25519）→ 连接成功；passphrase 保护的私钥能提示输入口令 | e2e |
| C-03 | agent 认证 | `SSH_AUTH_SOCK` 有 agent 时 `agent` 认证成功；无 agent 时给出可读错误而非崩溃 | M |
| C-04 | 认证失败可读 | 错误口令 → 错误信息含「认证失败」且不泄露服务端 banner 之外的细节；页签状态变 `error`，可重试 | e2e |
| C-05 | 未知主机指纹必须询问 | 首次连接未知 host key → 出现指纹对话框（`SHA256:` 前缀、keyType、host:port），**未确认前不建立会话**；确认后连接继续 | e2e |
| C-06 | 指纹不匹配必须阻断 | 换掉 sshd 的 host key 后重连 → 对话框标红「指纹已变更」并显示新旧指纹；选拒绝 → 连接中断，`known_hosts` 未被覆盖 | e2e |
| C-07 | known_hosts 记忆 | 接受并勾选记住 → `known_hosts` 出现该条目（`fingerprintSha256` 正确）；再次连接不再询问 | e2e + IPC |
| C-08 | known_hosts 删除后重新询问 | 删除条目 → 重连再次询问 | e2e |
| C-09 | 连接超时与不可达 | 连 `127.0.0.1:1` → 10s 内失败（`connectTimeoutMs`）、错误可读、无残留 session | e2e |
| C-10 | 断开与重连 | 远端 `exit` → 页签状态 `closed` 并显示 exit code；断网（kill sshd）→ `disconnected`，配置了 `autoReconnectAttempts` 时自动重试且 UI 有倒计时/次数 | e2e + M |
| C-11 | keepalive 生效 | `keepaliveSeconds=5` 静置 30s 连接不断；`ss -tnp` 能看到周期包 | M |
| C-12 | 端口转发（若纳入本期） | `local` 转发 `-L` 建立后 `curl localhost:<port>` 到达远端服务；断开时自动回收 | M |
| C-13 | 启动命令与环境变量 | 主机配置 `startupCommand="cd /tmp && pwd"` → 连接后终端输出 `/tmp`；`env` 生效 | e2e |
| C-14 | 多会话并发 | 同时 5 个会话 → 互不串流、内存与句柄无泄漏（`ssh:list-sessions` = 5） | e2e |
| C-15 | 输出保序 | `seq 1 5000` 完整输出、无丢字符、无乱序（xterm buffer 文本以 `5000` 结尾且行数合理） | e2e |

---

## 4. AI 辅助（A）

安全底线：**AI 输出的命令必须先展示、必须二次确认、默认不自动执行**；API key 存 safeStorage，**不进同步目录、不进日志**。

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| A-01 | 供应商可配置 | 设置页填 `baseUrl`/`model`/api key → 保存后 `[data-testid="ai-panel"]` 可用；`grep -r "<key 前 8 位>" userData/` 无命中（key 不应明文落盘） | e2e + shell |
| A-02 | api key 不落明文 | `grep -ri "$KEY" userData/ 2>/dev/null` 空；`settings.ai` 只有 `defaultProviderId`，无 key 字段 | shell |
| A-03 | 连通性测试 | 点「测试」→ 成功显示延迟/模型名；错误 key → 显示 `E_AI_PROVIDER` 可读信息，不打印 key | e2e（mock server） |
| A-04 | 流式输出 | 发一条消息 → 面板文本**逐步**增长（>=2 次增量事件），不是一次性出现；`ai:stream-done` 后按钮恢复 | e2e + mock SSE |
| A-05 | 取消 | 流式中点「停止」→ 停止增长，状态回到可输入，主进程无悬挂请求 | e2e |
| A-06 | 上下文注入 | 开启 `autoContext` → 请求体包含最近 `contextLines` 行终端输出与 `hostLabel`；关闭时不包含 | vitest（请求构造） |
| A-07 | 命令建议必须确认 | 建议里出现命令块 → 面板显示命令 + 解释 + 「执行/取消」；未点执行时**终端不收任何字符**；点执行才通过 `ssh:input` 写入 | e2e |
| A-08 | 危险命令拦截 | 建议 `rm -rf /` 类命令 → 额外红色警告仍需显式确认；`requiresConfirmation` 恒为 true | vitest + M |
| A-09 | 无 key 时的降级 | 未配置供应商 → 面板显示去配置的引导，不报错、不发请求 | e2e |
| A-10 | 错误可恢复 | 401/429/超时分别给出可读文案与「重试」；页面不白屏 | e2e（mock） |

---

## 5. 加密同步（S）★核心

**安全模型（验收必须逐条确认）**

1. 仓库里只有密文：`hosts.enc`、`groups.enc`、`settings.enc`、`known_hosts.enc`、`themes.enc`（+ `vault.json` 元数据：KDF 参数、cipher、salt，**无任何明文**）。
2. **私钥不同步**：`~/.ssh/id_*` 永不复制进仓库；`library.json`/仓库内不含 `PRIVATE KEY` 字符串。
3. **凭据不同步**：safeStorage 里的密码/口令/AI key 留在本机，仓库里只有 `credentialRef` 且指向本机条目。
4. 主口令只存在于内存与用户脑中；磁盘上只能有 KDF 派生出的密钥（且用主口令包裹）。
5. 恢复码 = 一次性展示的高熵字符串，可用于重置主口令；轮换后旧恢复码失效。

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| S-01 | 初始化加密包 | 首次「启用同步」→ 设主口令（>=12）→ 生成恢复码并**只显示一次**（可复制）；`vault:status` 变 `unlocked` | e2e `sync.spec.ts` |
| S-02 | 弱口令拒绝 | 主口令 `<12` 位 → 拒绝并提示；不落任何文件 | e2e |
| S-03 | 锁定/解锁 | 点锁定（或 `autoLockMinutes` 到点）→ 出现 `[data-testid="lock-screen"]`，主机库不可见；输入正确主口令 → 恢复；错误口令 → 提示且**不**解锁、失败计数有节流 | e2e |
| S-04 | 错误口令不丢数据 | 连续 5 次错误口令后，正确口令仍能解锁（无自毁、无数据损坏） | e2e |
| S-05 | 仓库内容确为密文 | `git -C <clone> grep -i "127.0.0.1"` 无命中；`grep -r "PRIVATE KEY"` 无命中；`.enc` 文件不可被 `openssl` 直接读成 JSON；`vault.json` 不含 hostname | shell（**必做**） |
| S-06 | 推送/拉取 | 本地 bare 仓库为 remote：push 后 `git log` 有新提交；改远端（第二工作副本）后 pull → 本地出现对方改动 | e2e + shell |
| S-07 | **双机迁移 A→B** | 机器 A：创建 vault + 3 主机 + 主题 → push。机器 B（新 userData，`TERMANS_E2E_USER_DATA` 换目录）：`sync:bootstrap` 填 remote+branch+主口令 → 拉到 3 主机与主题；`ssh:list-sessions` 为空（不迁移会话）；本机凭据仍缺（提示重新输入） | e2e（两个 launch，不同 userData） |
| S-08 | 恢复码重置主口令 | 忘记口令 → 用恢复码 `vault:recover` 设新口令 → 数据可解、可 push；旧口令解锁失败、旧恢复码失效（生成新恢复码） | e2e |
| S-09 | 主口令轮换 | `vault:rotate`（当前口令 + 新口令）→ 重新加密并 push；新口令解锁成功，旧口令失败；恢复码同步轮换 | e2e |
| S-10 | 冲突必须显式选择 | A、B 各改同一主机 → pull 出现冲突列表（local/remote 摘要 + 时间）；选 `local`/`remote`/`duplicate` 后结果符合选择；**不得静默覆盖** | e2e |
| S-11 | 同步状态可见 | 状态条显示 `off/idle/syncing/ahead/behind/diverged/error`；断网时 `error` + 可重试，不崩 | e2e + M |
| S-12 | 锁定态禁止同步 | 锁定后点同步 → `E_VAULT_LOCKED`，不发网络请求 | e2e |
| S-13 | 明文不落临时目录 | 同步过程中 `userData/` 下无明文临时文件残留（`find userData -name "*.plain*"` 空） | shell |
| S-14 | 密钥派生参数可见且合理 | `vault.json` 的 `kdf` = `{name:"scrypt",N>=2^15,r>=8,p>=1}`，salt 随机（两次初始化 salt 不同） | vitest/shell |
| S-15 | 加密包不含 secretsPolicy 退让 | `vaultContentPolicySchema` 三字段恒为 `secretsExcluded:true`/`privateKeysExcluded:true`/`plaintextHostnamesInRepo:false`；尝试写入 `false` 被拒 | vitest |
| S-16 | ssh_config 导入 | 准备含 `Host`/`HostName`/`Port`/`User`/`IdentityFile`/`ProxyJump`/通配 `Host *` 的 `~/.ssh/config` → 导入列表显示可选项、通配被跳过（`reason:"wildcard"`）、重复被跳过；导入后主机字段与配置一致（port 数字、identityFile 路径） | vitest（解析）+ e2e |
| S-17 | ssh_config 写回 | 编辑主机并「写回 ssh_config」→ 原文件出现/更新对应 `Host` 段落，**其它行与注释逐字节不变**；`createBackup` 生成 `.bak`；`dryRun` 只返回 diff 不写盘 | vitest（黄金文件对比）+ shell |
| S-18 | ssh_config 写回幂等 | 连续写回两次 → 第二次 `changedLineCount === 0`、文件字节不变 | vitest |
| S-19 | 删除字段 | 清空 `Port` 写回 → 该行被移除而非留空值；`fields: {Port: null}` 语义正确 | vitest |
| S-20 | known_hosts 同步 | 机器 A 信任指纹 → push；机器 B pull 后连接同一主机不再询问；`known_hosts.enc` 在仓库中，明文 hosts 名不可见 | e2e |
| S-21 | 私钥不跟着同步（反向验证） | 仓库里放入 `~/.ssh` 私钥路径字段（`privateKeyPath`）→ 目标机该路径不存在时给出「私钥缺失」提示，**不**尝试下载私钥 | e2e |

---

## 6. 主题（M）

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| M-01 | 内置主题切换 | `termans-dark` ↔ `termans-light` → 立即生效（<100ms）、无闪烁白屏、重启后保持 | e2e |
| M-02 | token 完整性 | 切到 light 后 `getComputedStyle(document.documentElement).getPropertyValue('--ts-bg-app')` 非空且与 dark 不同；52 个 token 全有值 | vitest + e2e |
| M-03 | 自定义主题 | 新建主题只覆盖 `--ts-accent` → 其它 token 继承 extends 的内置主题；保存后出现在主题列表并可启用 | e2e |
| M-04 | 非法 token 拒绝 | 保存含 `--ts-not-exist` 或错类型的值 → `E_INVALID_ARGUMENT` 且不落盘 | vitest |
| M-05 | 内置主题不可删 | 删除 `termans-dark` → 拒绝；自定义主题可删，删除后回退内置 | e2e |
| M-06 | 对比度 | 正文与背景对比度 ≥ 4.5:1（light/dark 都测），主按钮文字 ≥ 4.5:1 | M（axe 或计算值） |
| M-07 | 品牌规则 | 琥珀只出现在可操作元素；薄荷绿只出现在正常状态；红色只出现在错误（全屏截图人工核对） | M（截图入 docs/assets） |
| M-08 | 主题导入导出（若纳入） | 导出 JSON 再导入 → token 完全一致；导入失败有可读错误 | e2e |

---

## 7. 多语言（L）

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| L-01 | 中英切换 | 设置切 `zh-CN` → 侧栏/页签/状态条文案全中文；切回 `en` 全英文；重启保持 | e2e |
| L-02 | 无原始 key 泄漏 | 两种语言下全界面 `document.body.innerText` 不含 `:` 连接 namespace 的形态（如 `hosts:empty.title`）和裸 key（如 `app.name`） | e2e（断言文本不含 `\b[a-z]+:[a-z]` 与已知 key 列表） |
| L-03 | key 对等 | `src/locales/en/*.json` 与 `zh-CN/*.json` key 集合逐 namespace 相等 | vitest（已有） |
| L-04 | 缺失回退 | 临时删掉 zh-CN 的某 key → 显示英文而非 key 名 | vitest |
| L-05 | 长文案不破版 | 中文/英文切换后侧栏按钮、页签、设置项不溢出/不截断（截图对比） | M |
| L-06 | 语言影响错误文案 | 认证失败、口令错误等错误提示跟随当前语言 | e2e |

---

## 8. 打包（P）

| 编号 | 判据 | 操作 | 落点 |
| --- | --- | --- | --- |
| P-01 | 目录包可启动 | `pnpm package:dir` → `release/mac-arm64/Termans.app` 双击能起窗口、能连 SSH（连本地 sshd） | M |
| P-02 | asar 内不含源码泄露敏感物 | `npx asar list release/.../app.asar` 不含 `src/`、`.env`、`*.pem`、测试快照 | shell |
| P-03 | 图标与元数据 | Dock 图标为品牌 chevron；`CFBundleName=Termans`、`CFBundleIdentifier=com.termans.app`、版本与 package.json 一致 | shell（`plutil -p`）+ M |
| P-04 | 生产 CSP 生效 | 打包产物里 `out/renderer/index.html` 含 CSP meta；运行后 DevTools Console 无 CSP 违规刷屏、终端仍正常显示（xterm 内联样式） | shell + M |
| P-05 | 三平台产物 | mac dmg（arm64/x64）、win nsis（x64/arm64）、linux AppImage 构建命令成功（CI 或本机至少 mac） | CI |
| P-06 | 卸载/升级不丢数据 | 覆盖安装新版本 → `userData` 里的主机库与 vault 仍在、可解锁 | M |
| P-07 | 首次启动引导 | 全新 userData 启动 → 无报错，引导设置主口令/导入 ssh_config 的入口可见 | M |

---

## 9. 非功能与安全回归

| 编号 | 判据 | 操作 |
| --- | --- | --- |
| N-01 | 冷启动 < 2s（空库） | 计时从进程启动到 `host-sidebar` 可见 |
| N-02 | 20 主机 / 10 页签稳定 | 内存 < 800MB、无 UI 卡顿 > 200ms、无崩溃 |
| N-03 | 渲染层无 Node 能力 | DevTools 里 `typeof require === 'undefined'`、`typeof process === 'undefined'`、`window.termans` 只有白名单方法 |
| N-04 | 未登记通道被阻断 | `window.termans.invoke('app:definitely-not-registered', {})` 被拒（`Blocked IPC channel`） |
| N-05 | 外链不外泄 | 点击 `https://example.com` 走系统浏览器；`file:///etc/passwd` 与 `javascript:` 被拒 |
| N-06 | 日志不含密钥 | 全流程后 `userData/logs`（若有）与 stdout 内 `grep -Ei "passphrase|api[_-]?key|BEGIN .*PRIVATE KEY"` 无命中 |
| N-07 | 崩溃可恢复 | 同步中途 kill 进程 → 重启后仓库可 `git fsck` 通过、可解锁 |

---

## 10. 交付判据汇总

t1（骨架）完成即视为通过：
`B-01`、`B-02`、`B-03`、`B-04`、`B-05` 全绿 + `docs/ARCHITECTURE.md`/`docs/SPEC.md` 存在 + 首次提交完成。

其余特性由各自任务在完成时附「本表对应编号 → 实测结果」，qa 在 t10 汇总一张最终矩阵（每条标注 通过/未通过/未实现 + 证据路径）。
**不允许**用「构建通过」代替判据；每条附一行真实输出或截图路径。
