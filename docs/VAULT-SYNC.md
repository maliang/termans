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
| `manifest.json` | 是 | `format/version/cipher/kdf(N,r,p)/revision/payload_sha256/keywrap_sha256/updated_at` + 两个「包裹主密钥」的密文盒。**没有任何主机信息**（测试断言它连 `hosts` 字样都没有） |
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
2. 恶意仓库可以把 `N` 写成 2^22 把用户内存打爆，所以有 `COST_LIMITS = {minN: 2^14, maxN: 2^20, maxR: 32, maxP: 8}`，
   越界 → `bad-params`（`E_INVALID_ARGUMENT`），不是「尝试解密」。

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
  `HostSidebar` 不挂载 `<HostTree>`——不是 CSS 隐藏，DOM 里没有主机名/IP。

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

### 5.3 状态机

`off | idle | syncing | ahead | behind | diverged | error`。
关键细节：**冲突导致的 push 失败属于 `diverged`，不是 `error`**（`fail()` 里按 `pending.conflicts.length` 分流），
否则 UI 会把「等你选边」渲染成吓人的同步故障（这是实现中修掉的第 3 个真实 bug）。

### 5.4 认证

`auth: 'none' | 'token' | 'ssh-agent'`。token 时 `onAuth` 返回 `{username: 'termans', password: token}`；
token 本身存在**本机** `credentials.json`（`git:token`），不进仓库。`ssh-agent` 目前显式拒绝
（`E_INVALID_ARGUMENT`，isomorphic-git 没有 agent 传输），不静默降级成 token。

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
| `git:token` / `vault:session` | 本机凭据库 | 否 |
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

另外三个测试写法陷阱（避免假绿/假红）：断言缩进不能用 `not.toContain('  User root\n')`（子串会命中 4 空格的版本）；
`manifest.json` 是 2 空格 pretty JSON（断言要写 `"format": "termans-vault"` 带空格）；ESM 测试里不能用 `require()`。

---

## 10. 与冻结契约 / SPEC 的有意偏差

> 每一项都经 captain 逐条裁定（2026-10-29）。下面「裁定」列写的是最终口径，含 captain 要求补写的副作用与代价。

| 项 | 裁定 |
| --- | --- |
| 主机密码进密文包 | **通过，且这是唯一正确解**。B 机拿到条目却连不上就是废条目。`src/shared/models/vault.ts:13` 那句「密码只存 safeStorage」是 t1 时期旧口径，**architect 已在 shared 侧更正该注释**（本任务不碰 `src/shared/**`）；本文件即为更正后的口径依据。 |
| `payload.hostNotes` | 通过（`HostInput` 冻结，另开字段是对的）。 |
| `vault:recover` 沿用原恢复码 | 通过。**恢复码不是一次性的**：用掉之后仍然有效，可以反复救命（见下方 §10.1 的测试坐标）。 |
| 「导出恢复码」复用 `vault:rotate` | 接受，但**它不是纯读操作**：会换新盐、`revision+1`、并生成新恢复码，等于「只想看一眼恢复码，结果推进了仓库」。因此 UI 文案是**「重新生成恢复码」**并带一步显式确认，确认框里写明「仓库会前进一次 revision，之后需要重新 push；旧恢复码不再可用」。 |
| `origins` 无 hostId | 通过。导入后的 UX 必须让用户看见「这次带进来哪些 Host」，被跳过的项（wildcard / no-hostname / duplicate / excluded）单独列出——`importSshConfig` 已返回 `importedAliases` + `skipped[{alias,reason}]`，t7 接线时验证展示。 |
| AI key 进密文包、Git token 只存本机 | 通过。**代价写明：换机后 Git token 要重新输入**。这是有意为之——token 泄漏等于把仓库写权限交出去，它不该跟密文包一起漂到别人的机器上。 |


| 项 | 契约/SPEC 的要求 | 实际实现 | 理由 |
| --- | --- | --- | --- |
| 主机密码存放 | `src/shared/models/host.ts` 头注释：「密码/passphrase 只存 safeStorage，同步包里只有 credentialRef」 | 密码/passphrase 进 `vault.enc` 的 `secrets` | 任务书明确要求「B 机用同口令 clone 后密码可解密、能连上」；只存本机 safeStorage 的话跨机迁移就只能靠用户重输。密文包同样是加密的，风险边界不变（且 `credentialRef` 仍是稳定映射） |
| 主机备注 | `HostInput` 没有 notes 字段 | 存 `payload.hostNotes`，`hosts:list` 响应里挂回 `notes` | 契约冻结不能加字段；备注是敏感信息，必须进密文包 |
| `vault:recover` 返回体 | SPEC S-08 期望「旧恢复码失效、返回新恢复码」 | 返回 `VaultStatus`（无 recoveryCode），**沿用原恢复码** | `VaultRecoveryRequest`/响应类型冻结，无处返回新码；沿用原码保证「用户抄一次就能反复恢复」。已在此文档与测试里显式记录 |
| 导出恢复码 | 需要一个「导出恢复码（需重验证）」入口 | 复用 `vault:rotate({current, new: current})` | 不能新增 IPC 通道；该调用语义正是「重验证当前口令 → 新盐 → 新恢复码 → 一次提交」 |
| `sshConfigImportResult.origins` | 语义上想带 hostId | 只填 `{file, alias}` | `sshConfigOriginSchema` 冻结为 `{file,alias}` |
| AI key 存放 | `src/shared/models/ai.ts` 头注释：「API key 只存 safeStorage，永不进 Git 同步包」 | `payload.integrations.aiApiKeys`（密文包内，随仓库同步） | 任务书要求「AI key 与 Git token 进同一加密包（由 t5 接入）」。仓库里仍是密文；**Git token 例外地只存本机**（`git:token`），因为它本身就是仓库的访问凭据 |

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
