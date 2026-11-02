# 加密主机库与 Git 同步（Termans）

本文是「主机库 / 加密 / Git 同步」这一块的**设计说明 + 验收证据**。读完之后应当能回答四个问题：

1. Git 仓库里到底有什么？为什么明文主机信息不可能泄漏？
2. 口令、恢复码、私钥、Git token、AI key 各自存在哪、怎么保护？
3. 两台机器同时改动时，为什么不会互相覆盖？
4. 哪些地方与 `src/shared` 的冻结契约、`docs/SPEC.md` 有**有意偏差**，理由是什么？

> 代码位置：主进程 `src/main/crypto/**`、`src/main/vault/**`、`src/main/git/**`；
> 渲染层 `src/renderer/features/vault/**`、`src/renderer/features/unlock/**`。
> 本文出现的口令 / 密码 / IP 都是夹具（`src/main/vault/test-fixtures.ts`），不是真实凭据。

---

## 1. 仓库里只有三样东西

`ls -R` 的真实输出（来自 `src/main/vault/repo-layout.test.ts`，测试会把它打印出来并断言）：

```console
$ npx vitest run src/main/vault/repo-layout.test.ts
ls -R /var/folders/.../termans-repo-kbZbM4/vault
manifest.json
themes
vault.enc

/var/folders/.../termans-repo-kbZbM4/vault/themes:
ocean.json
```

| 文件 | 明文? | 内容 |
| --- | --- | --- |
| `manifest.json` | 是 | **十个字段**：`format` / `version` / `cipher` / `kdf{name,N,r,p}` / `passphraseKey` / `recoveryKey` / `keywrap_sha256` / `revision` / `payload_sha256` / `updated_at`。其中 `passphraseKey`/`recoveryKey` 只是「被 KEK 包裹的 VMK 密文 + 各自 salt」，**不含任何主机信息**（测试断言它连 `hosts` 字样都没有） |
| `vault.enc` | 否 | 唯一的敏感载体：hosts（主机名/IP、端口、用户、备注、标签、分组、IdentityFile 路径、ProxyJump、启动命令）、groups、snippets、settings、known_hosts 指纹、完整 ssh_config 文本、主机密码与私钥 passphrase、AI key 与 Git token |
| `themes/*.json` | 是（非敏感） | 主题定义，保留 git diff 可读性 |

**私钥文件本体永不同步**：只同步 `IdentityFile` 路径引用。B 机缺私钥时连接前明确报错并给三个入口（见 §7）。

本机私有目录（**在仓库外**，`userData/vault-local/`）：

```text
vault-local/
├── local.json          # 本地元数据（上次同步 revision / repo 配置 / lastUnlockedAt）
├── session.json        # 「记住本机 7 天」的会话密钥（SecretBox 包裹，含到期时间）
├── credentials.json    # Git token / 会话密钥 / 本机导入的私钥（永不进仓库）
├── machine.key         # 无 safeStorage 时的兜底密钥（0600；只是静态混淆）
└── conflicts/          # 冲突快照（state.enc + 双方 vault.enc + base.vault.enc）
```

---

## 2. 加密设计

### 2.1 三层密钥

```text
主口令 ──scrypt(N,r,p, salt_passphrase)──┐
                                        ├─ KEK_pass ──AES-256-GCM──▶ 包裹 [VMK]  ← manifest.passphraseKey
恢复码 ──scrypt(N,r,p, salt_recovery)───┤
                                        └─ KEK_rec  ──AES-256-GCM──▶ 包裹 [VMK]  ← manifest.recoveryKey
VMK（32B 随机主数据密钥）──AES-256-GCM──▶ vault.enc（payload 明文 JSON）
```

* **VMK 是唯一的「数据密钥」**；口令/恢复码只用于**包裹**它。改口令、用恢复码重置，都只重写包裹层，VMK 不变
  ——所以「A 机轮换口令后推送，B 机（内存里已有 VMK）能解开新 payload」，这一点有测试
  （`envelope.test.ts` 的「轮换后 VMK 不变」与 `sync.test.ts` 的 A→B 流程）。
* 每次加密都用**新的随机 12B nonce**（测试断言两次加密 nonce 不同）。
* AAD 把上下文钉死，防止把 A 处密文搬到 B 处：
  * payload：`termans-vault|v1|payload`
  * 口令槽：`termans-vault|v1|key|passphrase|N=<N>|r=<r>|p=<p>|salt=<b64>`
  * 恢复码槽：`termans-vault|v1|key|recovery|salt=<b64>`
  改任何一个 KDF 参数或 salt，都会让 GCM 认证失败（不会「解出别的数据」）。
* 密钥材料不落盘、不进日志：`zeroize()` 在 lock/轮换后 best-effort 清零；错误信息里只有 reason 码，
  唯一可能带外泄风险的是 Git 远端 URL 里的 token，`GitEngine` 用 `/(https?:\/\/)[^@\s]+@/g → '$1***@'` 脱敏。

### 2.2 KDF 参数与实测成本

| 场景 | N | r | p | 实测耗时（Node 26 / Apple Silicon） |
| --- | --- | --- | --- | --- |
| 生产默认 | 131072 (2^17) | 8 | 1 | ≈297 ms |
| 测试专用 `SCRYPT_TEST` | 16384 (2^14) | 8 | 1 | ≈36 ms |

注意两个坑（都写在代码注释里）：

1. `crypto.scrypt` 默认 `maxmem = 32MB`，N=2^17,r=8 需要 ≈134MB，**不显式传 maxmem 会直接抛错**；
   实现里传 `128 * N * r * 2 + 1MB`。
2. 恶意仓库可以把 `N` 写成 2^20 让客户端分配 4 GiB 内存（kdf 参数来自**远端** `manifest.json`，
   而摘要都是公开算法，攻击者能造一个「自洽」的坏仓库）。所以设**两道独立闸门**，越界一律
   `bad-params`（`E_INVALID_ARGUMENT`），**不是「尝试解密」**：
   * 逐字段区间：`COST_LIMITS = {minN: 2^14, maxN: 2^18, maxR: 16, maxP: 4}`；
   * 内存预算：按 `128*N*r` 实算，**达到或超过 512 MiB 即拒**（`maxmem` 是这块唯一的硬闸）。
     `N=2^18,r=16` 每个字段都合法，但正好 512 MiB → 拒绝。
   闸门位置：`assertCostWithinBounds()` 在 `assertIntegrity()` 里、**任何派生之前**被调用，
   `deriveKek()` 里再兜一次（内存里的 VMK 路径也绕不过去）。回归用例见
   `src/main/crypto/envelope.test.ts`（伪造 `N=2^20,r=32,p=8` 必须 <100ms 就抛，不 OOM、不卡死）。

### 2.3 「口令错」与「数据损坏」必须能区分

`assertIntegrity()` 的判定顺序是刻意设计的：

1. `manifest.payload_sha256` ≠ 实际 `vault.enc` 字节的 sha256 → **corrupt**；
2. `manifest.keywrap_sha256` ≠ 两个密钥槽规范化后的 sha256 → **corrupt**（有人动了密钥槽）；
3. `manifest.kdf` 与 `vault.enc.kdf` 的 `N/r/p` 不一致 → **corrupt**；
4. 参数越界 → **bad-params**；`format/version/cipher` 不认识 → **unsupported-format**；
5. 以上全过之后 GCM 仍然认证失败 → **bad-passphrase**（或 `bad-recovery-code`）。

也就是说：**哈希对 + GCM 失败 = 口令错；哈希不对 = 数据损坏**。两者在 UI 上是不同文案
（`error.bad-passphrase` vs `error.corrupt`），绝不吞异常回退明文——`openBox()` 失败一律抛错，
没有任何「解不开就当空库」的分支（`envelope.test.ts` 用「密文改 1 bit 且同步重算摘要」验证过：仍然失败）。

### 2.4 密文信封格式

`vault.enc` 是自描述 JSON（`JSON.stringify(env) + '\n'`，落盘字节即被摘要覆盖的对象）：

```json
{
  "format": "termans-vault",
  "version": 1,
  "cipher": "aes-256-gcm",
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64 32B>" },
  "nonce": "<base64 12B>",
  "tag": "<base64 16B>",
  "ciphertext": "<base64>"
}
```

**口令 KDF 的 salt 只存在于 `vault.enc.kdf.salt`**（`manifest.json` 只记 N/r/p）——这与 `src/shared/models/vault.ts`
的 `vaultKdfSchema = {name,N,r,p}`（没有 salt）保持一致，也让「一个文件即完整信封」成立。

---

## 3. 主口令、恢复码、轮换

### 3.1 口令强度与「弱口令二次确认」

`assessPassphrase()`：长度按**码点**算（中文口令不会被 UTF-16 双计），熵 = 长度 × log2(字符集大小)，
并对常见的坏模式降档（命中常见口令表 cap 18bit、重复字符占比 <0.4 cap 24bit、6 连键盘序列 cap 32bit）。

* 长度 < 12 → `E_INVALID_ARGUMENT reason 'too-short'`，**直接拒绝**；
* 长度 ≥ 12 但强度 weak → 第一次返回 `E_INVALID_ARGUMENT reason 'weak-passphrase' + warnings + entropyBits`，
  主进程在内存里记 `sha256(NFKC(passphrase))`（TTL 5 分钟）；**同一口令再提交一次即接受**。

为什么是「重试即确认」而不是一个 `confirmed` 字段：`vault:create` 的请求体只有 `{passphrase}`（P0 冻结的 IPC 契约，
不能新增通道也不能改请求形状），所以确认动作只能靠「同值重发」表达。渲染层就是这么实现的
（`UnlockScreen` 收到 `weak-passphrase` 后展示警告条，再点一次同一个按钮）。

### 3.2 恢复码

* 20 字节 = 160 bit 熵，Crockford base32（去掉 I/L/O/U，避免抄错）→ 32 字符，展示成 8 组 × 4（`XXXX-XXXX-…`，总长 39）；
* `normalizeRecoveryCode()` 容错：小写、空格、`O→0`、`I/L→1`；长度非 32 或在字母表外 → `null`；
* `formatRecoveryCode()` **幂等**（先剥掉非字母数字再分组，见 §9 的 bug #2）。

### 3.3 轮换与恢复的语义

| 操作 | VMK | 口令槽 | 恢复码槽 | 提交次数 |
| --- | --- | --- | --- | --- |
| `vault:rotate` | 不变 | 用**新口令 + 新 salt** 重包裹 | 生成**新恢复码**重包裹 | 1 次 |
| `vault:recover` | 不变 | 用**新口令 + 新 salt** 重包裹 | **沿用原恢复码**（只重包裹） | 1 次 |

**旧密文用旧口令仍可解**——这是有意行为，必须写清楚（也是任务书要求「写入文档并测」的那一条）：
Git 历史里的旧 `vault.enc` 快照不会被「轮换」追溯性保护，谁拿到旧快照 + 旧口令就还能解开它。
真正让旧口令失效的只有两件事：B 机拿到新快照、或用户在远端改写了历史（force push / 重写仓库）。
`manager.test.ts` 与 `envelope.test.ts` 都断言了这一点。

### 3.3.1 恢复码不是一次性的（可反复救命）

`vault:recover` 只重写**口令槽**，恢复码槽保持不变，所以同一个恢复码在恢复之后**仍然有效**，可以再救一次
（与 SPEC S-08 期望的「旧码失效」相反，理由与裁定见 §10）。测试坐标：

* `src/main/vault/manager.test.ts:210` → `恢复码恢复：换口令、旧口令失效、同一恢复码仍可用（与 SPEC S-08 的偏差已在文档写明）`：
  先 `recover` → `lock` → 再用**同一个**恢复码 `recover` 一次并断言成功；
* `src/main/crypto/envelope.test.ts:262` → `recover 只换口令槽：恢复码槽保持原样（契约 vault:recover 不返回新恢复码）`：
  恢复前后 `manifest.recoveryKey` 逐字节相等。

要主动作废旧恢复码的唯一途径是「重新生成恢复码」（见 §10 第 4 行：它是一次真实的写操作，会 `revision+1`）。

### 3.4 「重新生成恢复码」是一次真实的写操作

入口在安全面板，文案刻意不叫「查看/导出恢复码」：它用 `vault:rotate({currentPassphrase, newPassphrase: currentPassphrase})`
重验证口令 → 写新 salt → 生成新恢复码 → `revision+1`。**副作用是仓库前进一次、远端需要重新 push**，
所以点击后先出一步显式确认（写明上述三件事，并提示旧恢复码此后不可用），确认后才真正执行。

---

## 4. 解锁 / 锁定 UX

* **启动即锁定**：`VaultManager.init()` 默认 `requirePassphraseOnLaunch: true` → `state='locked'`；
  只有本机存在**未过期**的 `session.json` 且策略允许免口令，才会自动解锁。
* **记住本机 7 天**：`vault:unlock {rememberWithKeychain:true}` 把 VMK 用 SecretBox 包裹写进
  `vault-local/session.json`（含 `until` 时间戳，默认 7 天）。`keychainBacked` 如实反映「有可用会话」。
  * 有 Electron `safeStorage` 时用系统钥匙串；**没有时退化为本机文件密钥**（`vault-local/machine.key`，0600），
    文档与 UI 都不谎称它是硬件保护。
* **闲置自动上锁**：`policy.autoLockMinutes`（默认 15，来自 `settings.security.autoLockMinutes`），
  每次写操作重置计时器；`lock()` 清内存 payload 并 `zeroize(VMK)`。
* **锁定时不显示任何主机信息**：`useVaultStore.applyStatus()` 收到非 unlocked 立刻清空 library/sync/conflicts，
  `HostSidebar` 不挂载 `<HostTree>`——主机节点在 DOM 里根本不存在（不是 CSS 隐藏）。
  整壳（终端/页签/AI 面板）则用 `.ts-app[data-locked='true'] > :not(.ts-unlock){visibility:hidden}`：
  **内容不出现在截图、纯文本复制与可访问性树里，但 DOM 仍挂载**——卸载会销毁 xterm 实例、
  解锁后 scrollback 全丢（仓库没有 serialize addon），这条边界写在 README §11 第 11 条。
* **上锁不终止已建立的 SSH 会话**（产品裁定，2026-10-29）：`lock()` / 被动回锁（`forceLock`）都会调
  `VaultManager.onLock`，组合根据此执行 `SshEngine.releaseCredentials()` —— 遍历存活会话
  `SshSession.clearCachedSecrets()`，**只清主进程内存里的明文凭据副本**，不动连接。
  理由：自动上锁可能由 15 分钟空闲触发，用户可能正在跑长任务；已建连的通道用的是 ssh2 内部
  协商出的会话密钥，与本处缓存的明文无关。会话收尾（`teardownTransport()`，close/error/远端 exit
  都经过它）同样会清空副本，所以不依赖调用方记得清。代价：锁屏时远端仍有一条活会话，
  要断线需显式断开页签（README §11 第 12 条）。

---

## 5. Git 同步与乐观锁

### 5.1 传输层现状（一个必须知道的限制）

同步用 `isomorphic-git`（纯 JS，不依赖系统 git）。它的 `getRemoteHelperFor()` **只认 http/https**：

```console
$ node -e "…git.clone({url:'file:///tmp/x.git',…})"
UnknownTransportError: Git remote "file:///tmp/x.git" uses an unrecognized transport protocol: "file"
```

所以：

* 生产场景正常（GitHub / GitLab / Gitea / 自建 http(s) 都是 http 传输）；
* **测试里没有用它连 file:// 或本地目录**（会失败）。`src/main/git/test-git-server.ts` 起一个本地 smart-HTTP 服务，
  把请求转给系统 `git receive-pack/upload-pack --stateless-rpc`，被测代码走的仍是**真实 http 客户端路径**，
  既验证了协议栈又不需要外网。

（这个服务端实现踩过两次：路径必须剥掉 `/info/refs` 等后缀才是仓库目录；GET 靠 `?service=`、POST 靠 path 后缀判定
upload-pack / receive-pack，写反会出现 `expected "001e# service=git-upload-pack" but received: 001f# service=git-receive-pack`。）

### 5.2 密文不能三路合并 → revision + payload_sha256 做乐观锁

`manifest.revision` 单调递增，`manifest.payload_sha256` 覆盖 `vault.enc` 字节。同步流程：

```text
pull:  fetch → remote 为空? → 本地推上去
       remote == local?    → idle
       本地干净且可快进?    → fast-forward + reload
       否则                → mergeFlow

push:  有未解决冲突? → E_CONFLICT（拒绝推送）
       commitAll → fetch → remote == local? → push
                         可快进? → fast-forward + reload → push
                         否则   → mergeFlow → push
```

`mergeFlow`（**在没有 base 的情况下也能工作**，有 base 时更精确）：

* 用内存里的 VMK 解开远端 `vault.enc`（如果解不开 → `E_CONFLICT`，提示远端被换过密钥）；
* `mergePayloads(base, local, remote)` 做**逐字段**三方合并：
  * 一边改、一边没改 → 自动采用改动方（`autoApplied`）；
  * 两边都改同一字段 → 生成一条冲突（`hosts.<id>.<field>` / `settings.<k>.<k>` / `secrets.<ref>.password` / `integrations.gitToken` …）；
  * 纯新增（base 里没有该实体）→ 并集，不打扰用户；
  * `updatedAt` 这类元数据永远取较新的一份，**不产生冲突**；
  * `sshConfig.text` 整体作为**一格**参与冲突（不做行级合并），其余 sshConfig 键逐键合并；
  * 密码/密钥类字段的摘要恒为 `••••`（渲染层拿到的 `SyncConflict` 里根本不含 `localValue/remoteValue`）。
* 有冲突 → 写 `conflicts/<stamp>/{local,remote}.vault.enc` 快照 + `conflicts/state.enc`，
  再把本地工作区 `resetTo(remoteHead)` 与远端对齐（这样最后能快进推送），`state='diverged'`；
* 无冲突 → 应用合并结果 → commit → push → `finishSync`（同时更新 base 线 `conflicts/base.vault.enc`）。

冲突解决（`sync:resolve`）只有三种策略，**没有静默覆盖**：`local` / `remote` / `duplicate`（本地实体复制成新 uuid，字段取远端）。
全部解决后自动 commit + push，push 失败会保留 conflict state 并报 `E_GIT`（明确告诉用户「远端又动了」）。

### 5.2.1 新机首次对齐（本地空库 + 远端有内容）

App 的安全模型要求「先建库并解锁，才能进主界面」，而新机器又要从远端拉库——这两件事原本是互斥的，
在真实链路里表现为 **S-07 双机迁移 100% 失败**（qa 在 e2e 里复现，见 §9 第 8 条）：

```
sync:status → {"state":"error","localCommit":null,"remoteCommit":null,
  "error":"Your local changes to the following files would be overwritten by checkout: manifest.json, vault.enc"}
```

现在的语义（`SyncCoordinator.alignFreshFromRemote`，pull / push / bootstrap 三条路径共用）：

| 现场 | 动作 |
| --- | --- |
| 本机 `localHead === null`（从未提交过）+ 远端有内容 | 走「首次对齐」：删掉刚建的空库那三个未提交文件 → 重新 clone 远端 → `reload()` |
| 本机已经提交过（`localHead !== null`） | **不走这段**，仍然走 §5.2 的乐观锁 / 冲突快照 |
| 未初始化（还没建库） | 允许对齐（没有东西可丢） |
| 已解锁但本地有数据（主机/分组/known_hosts/片段/主题/ssh_config 文本任一非空） | **拒绝**：`E_CONFLICT` + `details.localItems`，提示先把本地推到远端 |
| 锁定 | **拒绝**：`E_VAULT_LOCKED`（不解锁就无法确认「本地没东西可丢」） |

对齐后本地陈列的就是远端那份密文，因此会**重新锁上**——内存里那把 VMK 属于刚建的空库，解不开远端的
payload。用户用同一个主口令再解锁即可（这正是 §7 的 A→B 语义），渲染层会自动回到解锁屏。

另外 `GitEngine.clone()` 改成 `noCheckout: true` + 显式 `checkout(force)`：isomorphic-git 的 clone 收尾
自己做一次**非 force** checkout，只要目录里已有同名文件就抛 `CheckoutConflictError`——这是本条故障的
直接触发点，光加「先删文件」不够稳（未来仓库里多一类文件就复发）。

### 5.3 状态机

`off | idle | syncing | ahead | behind | diverged | error`。
关键细节：**冲突导致的 push 失败属于 `diverged`，不是 `error`**（`fail()` 里按 `pending.conflicts.length` 分流），
否则 UI 会把「等你选边」渲染成吓人的同步故障（这是实现中修掉的第 3 个真实 bug）。

### 5.4 认证

`auth: 'none' | 'token' | 'ssh-agent'`。token 时 `onAuth` 返回 `{username: 'termans', password: token}`。

token 的解析顺序（`src/main/git/sync.ts:158-162`）：

```ts
const fromVault = this.manager.isUnlocked() ? this.manager.payloadForSync().integrations.gitToken : null
const token = fromVault ?? this.readLocalToken()   // readLocalToken: <localDir>/credentials.json 的 entries['git:token']
```

即 **token 随密文包同步**（`payload.integrations.gitToken`，`src/main/vault/model.ts:73`，
也是 `conflicts.ts:175` 认可的合并路径）；本机 `credentials.json` 里的 `git:token` 只是**兜底**——
用在「还没有 vault / 还没解锁就拿不到 `integrations.gitToken`」的首次 bootstrap（clone 阶段）。
代价因此是：**换机后第一次 clone 需要重新输入 token，解锁之后 token 就跟着密文包走了**。

`ssh-agent` 目前显式拒绝（`E_INVALID_ARGUMENT`，isomorphic-git 没有 agent 传输），不静默降级成 token。

---

## 6. 数据模型、迁移与脏数据

`vaultPayloadSchema`（`src/main/vault/model.ts`）：

```text
schemaVersion, hosts[], groups[], knownHosts[], themes[], snippets[],
hostNotes{hostId→text}, secrets{ref→{password,passphrase,updatedAt}}, settings,
sshConfig{text, aliasMap, sourcePath}, integrations{gitToken, aiApiKeys{}, aiProvidersConfig}, updatedAt
```

* `serializePayload()` **稳定键序**（hosts/groups 按 sortIndex→id，secrets/aiApiKeys/hostNotes 按键名排序），
  所以「同一逻辑内容 → 同一份 JSON」，`payload_sha256` 才有比较意义；
* `migratePayload()`：缺失 `schemaVersion` 视为 v0；`version > 1` → `unsupported-format`（不猜语义、不丢数据）；
  逐版本前进（v0→v1 补 `sortIndex`、`withDefaults(settings)`、`sshConfig`/`integrations`/`hostNotes` 默认值）；
* **脏数据拒绝**：迁移后仍过不了 zod → `E_INVALID_ARGUMENT reason 'invalid-payload'` + 前 12 条 `path: message`。

---

## 7. 私钥引导（B 机必读）

B 机同步下来只有 `IdentityFile` 路径。`manager.resolveHostAuth(hostId)` 返回
`{password, passphrase, privateKey, privateKeyPath, privateKeyStatus}`，`privateKeyStatus` 三态：

* `not-required`：认证方式不是 publickey；
* `present`：本机已导入私钥，或 `privateKeyPath` 真实存在且是文件；
* `missing`：以上都不满足 → **连接前就报错**，不要让用户等 `Permission denied (publickey)`。

UI（`PrivateKeyGuide`）给三个入口：导入私钥文件 / 粘贴私钥 / 改用密码。
导入后内容进 `vault-local/credentials.json`（SecretBox 包裹），**不进仓库**；`host.privateKeyPath` 可选同步更新。
`credentials:set` 用引用前缀分流：

| 引用 | 去向 | 是否同步 |
| --- | --- | --- |
| `privatekey:<hostId>` | 本机私钥库 | 否 |
| `git:token` / `vault:session` | 本机凭据库（`git:token` 仅作首次 bootstrap 的兜底，见 §5.4） | 否 |
| `passphrase:<ref>` | 密文包里的 `secrets[ref].passphrase` | **是** |
| 其它（如 `ref-<uuid>`） | 密文包里的 `secrets[ref].password` | **是** |

---

## 8. ssh_config 双向维护

* 密文包里维护**完整文本**（`sshConfig.text`），解析/写回都是纯文本操作：
  * 只改指定 alias 的指定字段，区间外文本逐字节保留（注释、未知指令、行内注释都原样）；
  * 已有行沿用原缩进与原关键字大小写；缺字段插在 `Host` 行之后，4 空格缩进；`null` 删行；
  * alias 不存在则追加块；
  * `sshConfigParseResult.entries` 带 `startLine/endLine`，`Match` 块跳过并给 warning。
* 另给**显式**的「导出到 `~/.ssh/config`」/「从 `~/.ssh/config` 导入」，**默认不写系统文件**：
  * 写前备份 `<path>.termans-backup-<ts>`；`dryRun` 返回 diff 不落盘；落盘原子替换 + 0600；
  * 相对路径直接拒绝（`E_INVALID_ARGUMENT`）——它会被解析到 main 进程 cwd，用户预期不到。

---

## 9. 实现过程中修掉的真实 bug（测试驱动发现的）

| # | 问题 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | `envelope.ts` ↔ `passphrase.ts` 循环依赖 | ESM 下 `RECOVERY_CODE_CHARS` 触发 TDZ，`ReferenceError: normalizeRecoveryCode is not defined` | 抽出 `src/main/crypto/recovery-code.ts`，两边都从它导入 |
| 2 | `formatRecoveryCode` 不幂等 | 对已带连字符的码再格式化 → `XXXX--N25-D-BF…` | 先剥非字母数字再每 4 位分组 |
| 3 | `parseEnvelope` 归类错 | `{}` 被报成 `unsupported-format`（误导排查方向） | JSON 坏→corrupt、format 不认识→unsupported、zod 不过→corrupt |
| 4 | `assertIntegrity` 不校验版本 | `version=99` 的密文能解密成功 | 前置 format/version/cipher 三条检查 + envelope 与 manifest 版本一致性 |
| 5 | `mergePayloads` 把「纯新增」当成「删一个改一个」 | A、B 各加一台主机就弹两条无意义冲突 | `base===null 且只有一边有` → 直接并入 merged |
| 6 | `updatedAt` 参与冲突判定 | 每台被改过的主机都要求用户选 `updatedAt` | 元数据自动取较新的一份 |
| 7 | 冲突导致 push 失败时 `state='error'` | 用户以为同步坏了，而不是「等你选边」 | `state = pending.conflicts.length > 0 ? 'diverged' : 'error'` |
| 8 | 新机「先建库再连远端」后首次 pull 必失败（S-07） | `clone` 内部非 force checkout 撞上刚建的空库文件 → `CheckoutConflictError`，B 机永远拿不到主机 | `clone(noCheckout:true)` + `alignFreshFromRemote()`：仅 `localHead===null` 且本地无数据时删文件重 clone，否则 `E_CONFLICT`/`E_VAULT_LOCKED` |

另外三个测试写法陷阱（避免假绿/假红）：断言缩进不能用 `not.toContain('  User root\n')`（子串会命中 4 空格的版本）；
`manifest.json` 是 2 空格 pretty JSON（断言要写 `"format": "termans-vault"` 带空格）；ESM 测试里不能用 `require()`。

---

## 10. 与冻结契约 / SPEC 的有意偏差

> 每一项都经 captain 逐条裁定（2026-10-29）。下面「裁定」列写的是最终口径，含 captain 要求补写的副作用与代价。

| 项 | 裁定 |
| --- | --- |
| 主机密码进密文包 | **通过，且这是唯一正确解**。B 机拿到条目却连不上就是废条目。`src/shared/models/vault.ts:13` 的注释是 t1 时期旧口径（当时计划「凭据留在本机钥匙串、仓库里只放引用」），**architect 已在 shared 侧更正**（现口径：密码/passphrase 进 `vault.enc` 的 `secrets`，模型层仍不收明文）；本任务不碰 `src/shared/**`。 |
| `payload.hostNotes` | 通过（`HostInput` 冻结，另开字段是对的）。 |
| `vault:recover` 沿用原恢复码 | 通过。**恢复码不是一次性的**：用掉之后仍然有效，可以反复救命（见下方 §10.1 的测试坐标）。 |
| 「导出恢复码」复用 `vault:rotate` | 接受，但**它不是纯读操作**：会换新盐、`revision+1`、并生成新恢复码，等于「只想看一眼恢复码，结果推进了仓库」。因此 UI 文案是**「重新生成恢复码」**并带一步显式确认，确认框里写明「仓库会前进一次 revision，之后需要重新 push；旧恢复码不再可用」。 |
| `origins` 无 hostId | 通过。导入后的 UX 必须让用户看见「这次带进来哪些 Host」，被跳过的项（wildcard / no-hostname / duplicate / excluded）单独列出——`importSshConfig` 已返回 `importedAliases` + `skipped[{alias,reason}]`，t7 接线时验证展示。 |
| AI key 进密文包、Git token 的存放 | **AI key 进 `payload.integrations.aiApiKeys`（随仓库同步，密文内）**；**Git token 也进密文包**（`payload.integrations.gitToken`，`sync.ts:159` 优先取它，`conflicts.ts:175` 把它当合并路径），本机 `credentials.json` 的 `git:token` 只是「首次 bootstrap / 未解锁」的兜底。代价写清：**换机后第一次 clone 必须重新输入 token（那时 vault 还没解锁），解锁后即随密文包同步**。 |


> 模型层不变的部分：`host.ts` 仍然只收 `credentialRef`、不收明文凭据，私钥内容也永不进模型——变的是**引用的指向**：
> `credentialRef` 现在指向 `payload.secrets[ref]`（密文包内），而不再是本机钥匙串条目。
> `src/shared/models/{host,ai}.ts` 的头注释还留着 t1 时期的旧描述（「指向 safeStorage 密文条目」/「API key 永不进 Git 同步包」），
> 这两处不在本任务范围，已由 architect 报给 captain 决定并入 t7 还是单独一笔。

---

### 10.1 恢复码可重复使用的证据

见 §3.3.1 的两个用例坐标。之所以要在文档里单独点名，是因为「一次性恢复码」是直觉默认值：
若实现成一次性、而文档没写，用户第二次遇险时会拿着一个已经失效的码来试，且没有任何提示能纠正他的预期。

---

## 11. IPC 接线（30 个通道，t7 只需一行）

`src/main/vault/register.ts` 导出 `registerVaultHandlers({manager, sync})`，在 `src/main/ipc/index.ts` 的
`installPlaceholders()` **之前**调用：

```ts
registerVaultHandlers({ manager: vaultManager, sync: syncCoordinator })
```

覆盖通道：`hosts:list|create|update|delete|reorder`、`groups:create|update|delete`、`credentials:set|clear`、
`known-hosts:list|trust|remove`、`ssh-config:default-paths|parse|write|import|export`、
`vault:status|create|unlock|lock|rotate|recover`、`sync:status|bootstrap|pull|push|conflicts|resolve`。
请求侧一律 zod 校验（`.strict()`，未知字段直接拒绝）；事件侧发 `vault:state-changed` 与 `sync:status-changed`。

自检（防止通道名写错/漏注册）：`grep -oE "IPC_CHANNELS\.[a-zA-Z]+\.[a-zA-Z]+" src/main/vault/register.ts | sort -u | wc -l` → **30**，
且每个通道出现次数都是 1（无重复注册，否则 `handle()` 会抛 `IPC handler already registered`）。

渲染层替换两个占位组件即可：

```tsx
// src/renderer/app/App.tsx
import { HostSidebar, initializeVaultFeature } from '../features/vault'
import { UnlockScreen } from '../features/unlock'
// 启动时：await initializeVaultFeature()（幂等）
```

---

## 12. 验收证据

### 12.1 单元测试（本任务范围）

```console
$ npx vitest run src/main/crypto src/main/vault src/main/git
 ✓ src/main/git/conflicts.test.ts (16 tests) 13ms
 ✓ src/main/vault/repo-layout.test.ts (1 test) 137ms
 ✓ src/main/crypto/envelope.test.ts (22 tests) 2146ms
 ✓ src/main/git/sync.test.ts (3 tests) 2141ms
     ✓ A 写 3 台含密码 → push → B 同口令 clone 到独立 userData → 3 台出现且密码可解密 → 错口令失败  748ms
     ✓ 乐观锁：远端前进且本地有改动 → 自动三方合并后仍以快进推回；同一字段两边都改 → 产出冲突并要求显式解决  1368ms
 ✓ src/main/vault/manager.test.ts (22 tests) 2444ms
     ✓ 轮换口令：旧口令失效、新口令可用、恢复码同时换新  311ms
     ✓ 恢复码恢复：换口令、旧口令失效、同一恢复码仍可用（与 SPEC S-08 的偏差已在文档写明）  305ms

 Test Files  9 passed (9)
      Tests  106 passed (106)
```

每个文件覆盖什么：

| 文件 | 例数 | 关键断言 |
| --- | --- | --- |
| `src/main/crypto/envelope.test.ts` | 22 | 往返；错口令/错恢复码分流；**篡改 1 bit 必失败**（含「重算摘要后仍失败」）；manifest 与 vault.enc 里 grep 不到 IP/主机名/口令；nonce 每次不同；轮换/恢复的密钥槽语义；旧快照仍可用旧口令解 |
| `src/main/crypto/passphrase.test.ts` | 9 | 长度/熵/弱口令分级；中文按码点；恢复码字符集、归一化、幂等格式化 |
| `src/main/vault/model.test.ts` | 7 | 默认值、稳定键序、迁移、未来版本拒绝、脏数据 `invalid-payload` + issues |
| `src/main/vault/library.test.ts` | 14 | 分组/sortIndex、跳板机与成环校验、删主机后的引用清理、known_hosts `E_CONFLICT`、snippets |
| `src/main/vault/manager.test.ts` | 22 | 生命周期、锁定态全通道 `E_VAULT_LOCKED`、弱口令二次提交、节流（第 4 次被拦）、记住本机、轮换、恢复、**仓库里没有明文**、私钥引导三态、ssh_config 双向、AI 槽位、旧 payload 兼容 |
| `src/main/vault/ssh-config-text.test.ts` | 12 | 逐字段写回、注释/未知指令保留、缩进沿用、`null` 删字段、追加块、diff |
| `src/main/vault/repo-layout.test.ts` | 1 | 真实 `ls -R` 只有 `manifest.json` / `vault.enc` / `themes` |
| `src/main/git/conflicts.test.ts` | 16 | 三方合并、冲突路径与摘要打码、密码不出现在渲染层视图、三种策略、快照读写 |
| `src/main/git/sync.test.ts` | 3 | A→B 全流程（含密码可解密、错口令失败）、乐观锁冲突与显式解决、未配置仓库时拒绝 |

### 12.2 全量测试

```console
$ pnpm exec vitest run
 FAIL  src/main/ssh/__tests__/host-key.test.ts > 主机密钥校验（strict 默认策略） > 没有待决挑战时回答 answerHostKey：session-not-found（过期弹窗不崩溃、不误解）
 Test Files  1 failed | 45 passed (46)
      Tests  1 failed | 577 passed (578)
   Duration  3.9s
```

唯一的失败用例属于 **t2 的 SSH 层**（`src/main/ssh/__tests__/*`），而且**每轮跑的失败点都不一样**
（另一次是 `tests/fixtures/ssh-server.test.ts` 的 publickey 用例，该文件单独跑 11/11 通过），
是 ssh2 夹具的偶发失败，与主机库/加密/同步无关。`src/main/{crypto,vault,git}` 的 106 个用例全绿（见 12.1）。

### 12.3 类型检查

```console
$ npx tsc -p tsconfig.node.json --noEmit | grep -E "src/main/(crypto|vault|git)"
（无输出）

$ npx tsc -p tsconfig.web.json --noEmit
（无输出）
```

即 `src/main/{crypto,vault,git}`、`src/renderer/features/{vault,unlock}` 上**零错误**，`tsconfig.web.json` 整体零错误。
全量 `pnpm typecheck` 的剩余 3 条错误全部落在 t2 的夹具文件：

```console
$ npx tsc -p tsconfig.node.json --noEmit | grep -c "error TS"
3
tests/fixtures/ssh-server.ts(146,49): error TS2339: Property 'getPublicSSH' does not exist on type 'Error | ParsedKey'.
tests/fixtures/ssh-server.ts(335,19): error TS2339: …
tests/fixtures/ssh-server.ts(461,54): error TS2339: …
```

---

## 13. 已知限制

1. **`ssh-agent` 传输未实现**：`sync:bootstrap` 收到 `auth:'ssh-agent'` 直接 `E_INVALID_ARGUMENT`，不静默降级。
2. **只有 http(s) 远端**：`file://` 与本地目录不可用（isomorphic-git 限制，见 §5.1）；局域网裸仓库需自己起 http 网关。
3. **冲突粒度是「字段」而非「行」**：`sshConfig.text` 整体一格；两个人在不同 Host 块里改不同指令也会要求选边
   （安全侧的选择：宁可多问一次，也不静默覆盖）。
4. **轮换不追溯历史快照**：旧 `vault.enc` 快照仍可用旧口令解开（见 §3.3）。
5. **无 safeStorage 的平台**（部分 Linux 无 keyring）退化为本机文件密钥，**不是硬件级保护**，UI 与文档都不这么声称。
6. **单文件仓库**：所有主机在一个 `vault.enc` 里，仓库到几千台主机时 diff/合并会变慢（当前规模够用）。
7. **系统休眠自动上锁需要 t7 接线**：本模块提供 `lock()` 与闲置计时器（`autoLockMinutes`），
   `powerMonitor.on('suspend', () => vaultManager.lock())` 属于主进程入口（`src/main/index.ts`），
   不在本任务范围；不接也不会漏锁（闲置计时器仍在跑），只是休眠唤醒后还要等计时器到点。

---

## 14. 多库与口令诊断（20261101-r3 起）

这一节回答第五个问题：**「口令明明没记错却进不去」时，产品怎么让用户自己判断，以及「另开一个本地库」和旧库是什么关系。**
它是 §2.3（口令错 vs 数据损坏）的延伸，不是替代：§2.3 讲密文层怎么分流，本节讲**写链怎么保证不制造"假口令错"**、以及用户能看到的证据。

### 14.1 库布局：老库原位不动，新库是兄弟目录

| 路径（相对 `userData`） | 属于哪只库 | 进 Git？ |
| --- | --- | --- |
| `vault/`（`manifest.json`、`vault.enc`、`themes/*.json`） | **默认库**（老安装升级后原库就是它） | 是 |
| `vault-local/`（`local.json`、`session.json`、`credentials.json`、`.pair-tx/`、`conflicts/`） | 默认库的本机私有目录 | 否 |
| `vaults/<id>/repo/` + `vaults/<id>/local/` | 新建的库（`id` 形如 `lib-<8hex>`） | repo 进它自己的远端 |
| `libraries.json` | 多库索引 | 否 |

- **默认库路径永久不变**：`repoDir:'vault'`、`localDir:'vault-local'` 与升级前逐字相同，不移动、不改写、不改名；老安装第一次启动时索引**惰性建立**一条 `{ id:'default', name:null }` 记录，磁盘上一个字节都不动（升级兼容的落点，`repo-layout.test.ts` 的不变式仍按默认库成立）。
- **新库是物理隔离的兄弟目录**：各自一份 `manifest.json` + `vault.enc` + `themes/`、各自独立的 session/remember 与同步状态。「新建库」不复制、不移动、不覆盖旧库；旧库目录在新建前后 sha256 不变。
- **索引只存路由，不存真相**：`libraries.json` 里的 `createdAt` / `lastUnlockedAt` 只是缓存（真正来源是该库自己的 `local.json`），索引写失败不影响解锁；写盘走同目录 `.tmp` + rename。
- **同一时刻只有一只库的 VMK 在内存**：切库 = 先 `lock()` 旧库（清零 VMK）再 `init()` 新库；换库后是否自动进入，完全看目标库自己的 `session.json`（「记住本机」是**按库**设置的）。因此「两只库互不自动解锁」有代码落点，不是靠界面藏按钮。
- **拒绝覆盖**：新建时名称按 `trim().toLowerCase()` 全等判重、目录按存在性判重，两项校验都前置于任何 `mkdir`/写盘 ⇒ 失败时目标目录内文件数与 sha256 完全不变（`E_INVALID_ARGUMENT` + `details.reason`）。

### 14.2 槽-盐不变量（r3 的真修复）

口令槽 `manifest.passphraseKey` 是「用某个 salt 派生出的 KEK」包裹的 VMK 密文，而 **salt 只存在于 `vault.enc.kdf.salt`**（见 §2.4）。两者必须**成对且同源**：

1. **盐只有一个来源**：信封里的 `envelope.kdf.salt`。重封函数不再接收"自由 salt"，只接收调用方声明的**期望值** `expectedKdfSalt`，与当前信封不一致时**在函数入口就抛错**——而不是等下游摘要全过之后、在 GCM 上退化成 `bad-passphrase`。这样「槽是这台机器的、盐是那台机器的」这种组合在 API 层就**无法表示**。
2. **唯一换盐入口**：`resealPassphraseSlot()`（AC-7 的规范形重封与将来的轮换共用一处）。它产出成对结果并当场自检 `assertSlotBinding`；任何「新 salt + 直接 seal」的第二处实现都会重新打开这个缺陷。
3. **本机记录是权威**：`vault-local/local.json` 新增 `slot` 记录 —— 槽密文本体（与仓库里同一份，不引入新的离线爆破面）+ **与它成对的 `salt`** + 8 位指纹 + `recordedAt`。它回答的问题是「**这台机器上次能开的是什么**」，锁定时也能自证；槽写入只走一条 `rememberSlot()`（创建 / 解锁成功 / 轮换 / 恢复 / 会话还原 / 规范形重封 / 同步保槽七个时机），禁止散落成补丁。
4. **成对落盘**：`manifest.json` 与 `vault.enc` 同一次事务写（写 `.new` → fsync → `journal.json(phase:'prepared')` → 两次 rename → `phase:'done'` → 清暂存区）。暂存区在 `localDir/.pair-tx/`，**不在 `repoDir`**——仓储根永远只有 `manifest.json` / `vault.enc` / `themes`（§1 的不变式，任何一次启动都会先跑自愈：看到 `prepared` 就补完第二次 rename，看到只剩 `.old` 就回滚）。
5. **会话还原零写入**：「记住本机」的还原成功路径不写仓库任何文件（还原后同口令仍能解锁，两只文件 sha256 不变）。

> 为什么把槽密文本体也记在本机：不放它，「本机权威」就只剩一个指纹，锁定时无法自证、同步后也无法把槽写回去；而它与仓库里那份**完全相同**，攻击者拿到仓库就已经有同一份，不扩大攻击面。

### 14.3 同步不换槽（拉取、合并、推送都不改「用谁的锁」）

同步只能决定「**接不接受远端的库内容**」，不能决定「**用哪台机器的口令槽**」。三条路径统一收口：

| 路径 | 行为 |
| --- | --- |
| 快进（远端落后/持平） | 先要求本地处于解锁态（无法保槽时不许静默接受远端库），再按 `source:'sync-fast-forward'` 重载 |
| 无冲突三方合并 | 合并结果**只**通过 `adoptRemotePayload({payload, revision, source:'sync-merge'})` 写入：只写 payload 与 revision，**绝不动本地口令槽** |
| 冲突解决后推送 | 同上，`source:'sync-push'` |

- 解锁态拉取时若发现远端槽与本机记录不一致：**保本地槽**——用 `local.json.slot`（槽 + 它的 salt）回填并重封 payload，成对写盘，本机审计表记一条 `slot-preserved`（含 `fromFingerprint` / `toFingerprint` / 来源），然后才接受远端内容。
- 锁定态遇到不一致：**不写盘**，只记 `local.slotDrift` 供归因使用（见 14.4）。
- **唯一例外**：本机还没有任何槽（B 机首次 bootstrap），此时才接受远端槽——这是刻意保留的唯一一处，代码里有注释写明原因。
- 由此得到的可回归承诺：**拉取 / 合并 / 推送之后锁定，再用本机口令解锁，一定开得开**（r3 之前恰好相反，症状就是"口令不对了"）。

### 14.4 口令槽指纹与四类归因

**指纹口径**（唯一实现 `src/main/crypto/envelope.ts` 的 `slotFingerprint`，归因层与界面只消费不重算）：

```text
fingerprint = sha256( Buffer.from(manifest.passphraseKey.ciphertext, 'base64') ) 的前 8 位小写十六进制
```

解锁失败必须落在**四类之一且互不混淆**（判定优先级从高到低）：

| 类别 | 判据 | 用户看到 | 下一步 |
| --- | --- | --- | --- |
| `throttled` | 短时间内失败次数超阈值 | 剩余等待**秒数**（必须有数字） | 等倒计时结束再试 |
| `slot-record-mismatch` | 磁盘上的槽指纹 ≠ 本机 `local.json` 记录，**且本机确实有记录** | 「本库的口令槽与本机上次成功解锁时记录的不一致（本次解锁未改动任何文件）」+ 8 位指纹 | 用诊断区证据判断，必要时另开本地库 |
| `corrupt` | 摘要不符 / 文件损坏（§2.3 的第 1–3 步） | 「数据损坏」（本屏唯一的红色） | 从备份或远端恢复成对文件（14.6） |
| `bad-passphrase` | 以上都不成立、GCM 认证失败 | 「口令错误」——**这四个字只允许出现在这一类** | 重输口令；忘口令走恢复码 |

- **无记录不得判 mismatch**：老库首次升级后本机还没有 `slot` 记录时，诊断区显示「未知（本机无解锁记录）」，失败一律不进 `slot-record-mismatch`。这是最容易被写错的一条：没有第二份副本时，「不一致」和「没记录」看起来都是"对不上"。
- **措辞边界（硬约束）**：因为没有旧库副本，产品**只允许**陈述「与本机上次成功解锁记录不一致」，**禁止**出现「被换过 / 被篡改 / 被盗 / 来自另一台机器」这类需要第二份副本才能成立的判断，也不承诺"可与副本对比"。
- **诊断区是证据区，不是调试区**：固定六项 —— 创建时间 / 最近成功解锁 / 最近同步 / `revision` / KDF `N/r/p` / 8 位槽指纹。**不显示任何文件路径**（`/Users/<用户名>/…` 本身就是用户名泄露）、不显示主机名、IP、库内部 id、salt 与口令原文。无记录的项显示「未知」，不填 0、不填当前时间。
- **日志同样受限**：错误日志之前先脱敏，只允许出现类别、剩余秒数与 8 位指纹。

### 14.5 输入变体表：只吸收编码差异，绝不放宽比较

主口令是纯 ASCII，但仍保留一层**受控**的输入变体兜底（P1）：

- **恰好 4 种、固定顺序**：`identity`（原样）→ `nfkc`（`normalize('NFKC')`）→ `trim`（去首尾空白）→ `strip-zero-width`（去 `U+200B`–`U+200D`、`U+2060`、`U+FEFF`）。按**结果值**去重 ⇒ 一次解锁最多 4 次 KDF 派生，这是硬上界。
- **`identity` 永远排第一、首个成功即停** ⇒ 口令本来就没问题的那条路径派生次数仍是 **1**，界面零增量（不出现进度行、不出现归因块、不出现告知条）。
- **失败计数只加一次**：变体循环整体算一次失败（不是每个变体一次），否则 4 次上限与限流阈值都会错。
- **命中非原样变体**：用规范形 + 新 salt/新 nonce 重封口令槽（VMK 不变、payload 同步换盐重封），写审计 `slot-resealed`，然后**立即用规范形复验一次**（重封后必须能开，失败即按 `corrupt` 处理，绝不静默），并在主窗口顶部给一条**一次性**告知条（说明是按哪种变体修正的；`local.json` 里的记录在**首次投递后即作废**，用户手动关闭只是提前收起，重启后不会再出现这条过期事实）。
- **任何字符差异仍然必须失败**：仅大小写不同、仅多一个空格、仅少一个字符……一律失败并正常计入限流。变体只吸收**输入编码**差异，不放宽比较语义。
- **只用于口令槽**：恢复码继续走既有的 `normalizeRecoveryCode`，两套归一化不得互相套用。
- **单点入口**：`src/main/crypto/passphrase.ts` 的 `passphraseVariants()` / `canonicalPassphrase()`；管理器只调用、禁止内联 normalize。守卫：`grep -rn "passphraseVariants" src` 应当只命中"一处定义 + 一处调用"。
- 变体层可整体关闭（`passphraseVariants:false`）：关掉之后回归用例必须仍然绿，否则说明修的是输入而不是写链。

### 14.6 备份与自救建议

- **要备份的只有两样（必须成对）**：`manifest.json` + `vault.enc`，可选再加 `themes/`（非敏感）。这两只文件就是整个库，缺任何一只都开不了（`manifest.json` 记摘要与槽，`vault.enc` 是密文本体）。
- **不必备份、也不建议跨机复制**：`local.json` / `libraries.json` / `session.json` / `credentials.json`。它们是**设备私有**状态；把 `local.json` 挪到别的机器上，只会让指纹对账显示「与本机记录不一致」，反而制造一次假警报。换机器要带的是**口令或恢复码**。
- **首选备份是 Git 远端**：push 之后另一台机器 clone + 同一口令即可（`sync:bootstrap` 会做首次对齐）。**恢复码可反复使用**（§3.3.1），忘记口令时它是离线救命通道。
- **旧快照仍用旧口令**：轮换口令不追溯历史快照（§13 第 4 条），所以备份里可能同时躺着多个时代的 `vault.enc`——各自用**当时**的口令/恢复码才开得开，别拿新口令去开旧快照然后判成"坏文件"。
- **产品永久不提供「重置本地库 / 清空 / 删除库 / 用新口令接管旧库」**：口令判错只能靠**归因**（四分类 + 槽指纹对账）与**另开一个本地库**解决。「重置」一旦存在，加密就不再回答"除了我没人能进"这个唯一问题时——这是明确的产品立场，不是待办。
- **另开本地库与旧库的关系**：旧库目录一个字节都不动、凭据不变；新库是空库，不会把旧库的主机"搬"过来（所以别把它当导出/导入用）；随时可以切回旧库，用**旧库自己的**口令。
- **快速排查顺序**：① 看归因类别（是 `bad-passphrase` 还是别的？）；② 展开诊断区，比 8 位槽指纹与本机记录；③ 回想最近是否在**另一台机器**上同步/改过口令（远端内容会进本地，但**不该**换掉本机口令槽）；④ 都排不掉就用恢复码恢复，或另开一个本地库先把工作继续下去，旧库留着排查。

> 与既有章节的关系：§1 / §4 / §5 的仓库布局、解锁 UX 与同步语义**不变**；§11 里那条通道自检的期望值由 **30 变为 33**（新增 `vault:libraries` / `vault:library-create` / `vault:library-switch`），其余通道与「请求一律 zod `.strict()`」的约定不变，且**任何** `reset/clear/wipe/overwrite` 类通道都不允许出现。

## Git 令牌：多个令牌、系统令牌与令牌文件（t57）

在此之前「同步凭据」只有一个来源：本机 `credentials.json` 里的 `git:token`（密文包里的
`integrations.gitToken` 只被清空、从未被写入）。主人要求「令牌可以复制、可以指定令牌路径、
软件会查看系统令牌并默认加载、多个令牌可以指定默认令牌」，于是扩展成下面这套：

**存储（全部在加密包内，随仓库同步）**

| 字段 | 含义 |
| --- | --- |
| `integrations.gitTokens[]` | 多条令牌：`{id, label, source, token, createdAt}`，`source` ∈ `manual` / `env` / `gh` / `git-credentials` / `file` / `migrated` |
| `integrations.defaultGitTokenId` | 默认令牌 id；删掉默认时会顺位给剩余第一条 |
| `integrations.gitTokenFilePath` | 令牌文件路径（绝对路径；**不复制文件内容**，每次同步前实时读） |
| `integrations.gitToken` | 旧字段，保留兼容。写默认令牌时会同步它，所以老的 `GitSyncEngine` 取法不必改 |

三个新字段都带 `.default(...)`：这是**旧 vault 解包不炸**的前提。`serializePayload` 必须显式
列出这三个字段并按 id 排序 `gitTokens` —— 漏写等于丢数据，顺序抖动会让 `payload_sha256`
每次都不一样、乐观锁误判「本地有改动」。

**取令牌优先级（`src/main/git/sync.ts` 的 `resolveToken()`，写进代码而不是文档）**

1. `integrations.gitTokenFilePath`：每次同步前实时读，**轮换文件不需要回来点保存**。
   读失败（文件被删/权限不足）**退回**第 2 步并记一条 `warn` 日志——一次读不到不该让同步直接失败。
2. `integrations.gitToken`（默认令牌，随密文包同步到别的机器）。
3. 本机 `credentials.json` 的 `git:token`：只服务「首次 clone / 还没解锁」的兜底。

**系统令牌检测**（`src/main/git/tokens.ts` 的 `detectSystemGitTokens()`）
按顺序探测 `GITHUB_TOKEN` / `GH_TOKEN` / `GITLAB_TOKEN` / `TERMANS_GIT_TOKEN` →
`gh auth token`（3 秒超时）→ `~/.git-credentials`，**按令牌值去重**（否则界面上会出现
三条一模一样的 `••••abcd`，用户不知道该点哪个）。每个来源单独 try/catch：没装 `gh`、
没有该文件都是正常情况，不能让一个来源失败毁掉整个检测。

打开设置页时，**只有一条令牌都没有**的情况下才会自动检测并「默认加载」第一条；
已有令牌时一律不打扰（用户可能正等着用自己那条）。明文令牌只在主进程里流转，
下发给渲染层的只有掩码；点「复制」走一次性的 `sync:token-reveal`，那是用户主动动作。

**剪贴板为什么走主进程**：`src/main/index.ts:276` 把网页权限统一拒了
（`setPermissionRequestHandler(… => callback(false))`），渲染层 `navigator.clipboard`
会**静默失效**——按钮点了什么都不发生。所以 `app:clipboard-write` 在主进程里
`clipboard.writeText()` 后用 `await clipboard.readText()` 回读校验再返回 `copied`，
按钮只在真复制成功时才变绿。（Electron 45 的 `readText()` 返回 Promise，不 await 恒 false。）
