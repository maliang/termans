# QA-REPORT（复验轮 2）· 20261101-r3-vault-unlock-lockout

- 需求：加密主机库「口令不对了，也不能新建用户」→ 口令判错四分类自救 + 保留旧库前提下另开本地库
- 被测版本：`master @ 742be01` + 27 个 M + 13 个 ?? 未提交改动（按 ADR-2026-08-27 由 host 统一收口）
- 本轮性质：**修复复验轮**（对上一轮唯一 P2「D-1 AC-7 告知条跨重启复现」的整改做复验，非全新一轮）
- 测试环境：macOS arm64 / Node 22 / Electron（Playwright-Electron 驱动 `out/main/index.js` 与 `dist/mac-arm64/Termans.app`）
- 测试日期：2026-11-02
- 环境限制（非交付缺陷）：宿主沙箱不允许启动常规 Chromium（crashpad 需 `PROCESS_ALL_ACCESS`），故不用浏览器截图；全部改为 Playwright-Electron 真机 UI 驱动 + vitest 真实落盘探针。

## 一、范围与复验口径

1. 先**逐条重跑**上一轮留在 `logs/teamflow/tf-mvxflmox-qxwiqb/scripts/` 的每个 checker（本需求的回归契约），贴通过数（第二节）。
2. 再**只对上一轮未覆盖的面**补探针（第三节），并说明漏在哪。
3. 对每条缺陷重跑其**原样写的** 检测命令 / 通过判据（第九节）；**缺陷表只列仍开放项**（第八节）。
4. 架构与接口一致性静态核查（第六节）、提交面卫生（第七节）、门禁四连与真机 pack（第四节）。
5. 不在范围：真机人眼观感、动效手感、屏幕阅读器实播（第十节人工补测清单）。

## 二、既有 checker 重跑（逐条，通过数照抄）

| # | 探针 / checker | 命令（省略 `logs/teamflow/tf-mvxflmox-qxwiqb/scripts/` 前缀） | 本轮结果 |
| --- | --- | --- | --- |
| 1 | `ac7-notice-once.probe.ts`（**上一轮为红**） | `pnpm exec vitest run --config vitest.redproof.config.ts ac7-notice-once` | **exit 0，1 passed**（上轮：`expected {variant:'trim'} to be null` 红） |
| 2 | `ac20-variants-off.probe.ts` | `... vitest.redproof.config.ts ac20-variants-off` | exit 0，**4 passed** |
| 3 | `red-proof.probe.ts` | `... vitest.redproof.config.ts red-proof` | exit 0，**4 passed** |
| 4 | 上述三支合跑 + 本轮新增 | `pnpm exec vitest run --config vitest.redproof.config.ts` | exit 0，**4 files / 12 tests passed**，1.67s |
| 5 | `hub-multilib.probe.test.ts` | `pnpm exec vitest run --config vitest.hub.probe.config.ts` | exit 0，**2 passed** |
| 6 | `hub-wiring.probe.spec.ts`（真机） | `pnpm exec playwright test --config playwright.hub.probe.config.ts` | exit 0，**1 passed**；与 7 合跑 **2 passed (15.2s)** |
| 7 | `renderer-smoke.spec.ts`（真机） | `pnpm exec playwright test --config playwright.renderer.config.ts` | exit 0，**2 passed (3.6s)** |
| 8 | `doc-vault-diagnostics.mjs`（文档判据） | `node doc-vault-diagnostics.mjs` | **PASS 31/31**（`docs/VAULT-SYNC.md` +96/−0、`memory.md` +4/−0） |
| 9 | `pack-walkthrough.spec.ts`（打包产物） | `pnpm exec playwright test --config playwright.pack.config.ts` | exit 0，**1 passed (7.7s)**，驱动 `dist/mac-arm64/Termans.app` 走「口令错→归因→新建库→切回旧库」 |

结论：上一轮红的那一支转绿，其余全绿，无一支从绿转红。

## 三、本轮新增探针（针对上一轮**没覆盖**的面）

上一轮漏的是什么：D-1 的红证是**进程级**探针（直接 new manager 读 `status()`），只证明了「字段永不清除」；AC-7 的用户可见链路——**渲染层关闭按钮 → 重启后真实主进程不再投递 → 顶部条不出现**——一次都没被驱动过（当时连通道都不存在，无法从界面验）。故本轮补两支：

**(a) `ac7-notice-delivery.probe.ts`（3 例，真实 fs + 真 scrypt，防「过度修复」）**

| 例 | 断言 | 结果 |
| --- | --- | --- |
| A 投递 ≠ 静音 | 同进程连读 3 次 `status()` 都给出同一告知条（用户还没关就消失算 bug）；`local.json.variantNotice === null`；`slot.fingerprint` 仍匹配 `^[0-9a-f]{8}$` | passed |
| B 清告知不动仓库 | 5 次 `status()` + `dismissVariantNotice()` 前后 `manifest.json`/`vault.enc` 的 sha256 不变 | passed |
| C 定向性 | 新库新命中仍给**新**告知条；dismiss 后同进程为 null；重启后仍 null（不永久静音） | passed |

命令：`pnpm exec vitest run --config vitest.redproof.config.ts ac7-notice-delivery` → **exit 0，3 passed**。

**(b) `notice-bar.probe.spec.ts`（真机 Electron UI，1 例）**

链路：`createVault()` → `invokeInPage('vault:lock')` → 用 `"  <正确口令>  "` 解锁（命中 trim 变体）→ `variant-notice` 可见且 `role=status`、文案含「空格/whitespace」→ 点 `variant-notice-dismiss` → 立即 `toHaveCount(0)` → 再等 600ms 状态推送后仍 0 → `app.close()`（保留 userData）→ 同 userData 重启 →（本产品有会话还原 AC-24，重启可能直接进外壳，故按「外壳 or 解锁卡」两种合法开局分支）→ `host-sidebar` 可见 → **`variant-notice` 计数 0**。

命令：`pnpm exec playwright test --config playwright.hub.probe.config.ts` → **exit 0，2 passed (15.2s)**（含 hub-wiring）。

## 四、门禁四连 + 真机 pack（本轮自跑，非引用 dev 数字）

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm run typecheck` | **exit 0**（node + web 两段 tsc 无输出） |
| 单测 | `pnpm test` | **exit 0：64 files / 797 tests passed，16.02s，0 failed**（上轮 796；+1 = 整改新增的「重启不复发」永久回归 `manager.test.ts:662`） |
| 构建 | `pnpm run build` | **exit 0**（renderer 2216 modules） |
| 全量 e2e | `pnpm exec playwright test` | **exit 0：41 passed (2.8m)**，含既有 12 spec 与 `e2e/unlock-lockout.spec.ts` 6 例（:71 bad-passphrase+诊断区 / :109 throttled 剩余秒数 / :139 slot-record-mismatch / :169 corrupt / :198 新建库全链路 / :307 uninitialized 反向） |
| 真机 pack | `pnpm pack:dir` 后跑 `playwright.pack.config.ts` | **exit 0**：`dist/mac-arm64/Termans.app` 重建（app.asar 13,926,257B，`CFBundleShortVersionString=0.1.1`，pack-guard arm64 校验通过），走查 1 passed |

AC-19 要求的两条显式回答（本轮）：
- **是否改了 `e2e/fixtures`：没有**。本轮整改只动实现与其单测（`find src tests e2e docs -newermt "2026-11-01 23:58"` 仅命中 `src/main/vault/manager.ts`、`src/main/vault/manager.test.ts`，另有 dev 同步更新的 `docs/VAULT-SYNC.md` §14.5 文案）。上一轮列过的 3 处 fixtures 改动仍在（`e2e/fixtures/ui.ts` 恢复码闸门、`dual-machine.spec.ts:233` 归因块载体、`fixture-electron.spec.ts:34`），本轮未再扩大。
- **是否削弱既有同步语义：没有**。`git diff -- src/main/git/sync.test.ts` 删除行 0；本轮零改动 `src/main/git/**`。

## 五、可分辨性自检（AC-25 口径，本轮做在**新补的 UI 探针**上）

把整改回退成「旧实现」后，新探针必须变红，否则它不承载信息：

1. 变异：`manager.ts:401` 由 `this.local.variantNotice = null` 改回 `= persisted`（保留持久记录，即旧行为）；
2. `pnpm run build` 后跑 `playwright.hub.probe.config.ts -g "AC-7 · 真机"` → **exit 1，1 failed**，红在 `notice-bar.probe.spec.ts:53`（重启后 `variant-notice` 期望 0 实际 1）——正是 D-1 的用户可见症状；
3. 还原：`cp` 回备份后 `diff` 为空（**RESTORED-IDENTICAL**）→ 重新 `pnpm run build` → 再跑 **2 passed (15.2s)**，`pnpm exec vitest run --config vitest.redproof.config.ts` **12 passed**。
   回退点写进探针注释，后续轮次可直接重放。

## 六、架构检查（M3 质量门）与接口一致性

| 蓝图要求 | 实测 | 判定 |
| --- | --- | --- |
| `attribution.ts` 纯函数四分类、零 IO | 存在；manager 只调用不重算 | 符合 |
| `library-index.ts` 索引/路径/判重 | 存在；`DEFAULT_LIBRARY_ID='default'`、读写/判重齐 | 符合 |
| `hub.ts` 一次只活一个 manager，切库先 lock | `src/main/ipc/index.ts:84` `new VaultHub({...})`、`:124` 一律 `hub.current().manager`；`register.ts:83/85` 经 `hub.current()` 取实例，不捕获构造期对象 | 符合 |
| 槽-盐同源「不可表示」 | `resealPayload` 收 `expectedKdfSalt` 并在 `envelope.ts:644` 入口硬断言；`deriveKek+sealBox` 拼装点收敛到私有 `sealPassphraseKey()` | 符合 |
| 成对事务暂存区在 localDir | `repo.ts:39 PAIR_TX_DIR='.pair-tx'`，`stagingDir()` 优先 `localDir` | 符合 |
| 重复实现风险清单 | `slotFingerprint` 定义 1 处（`envelope.ts:398`）、`passphraseVariants` 定义 1 处（`passphrase.ts:170`，manager 只调用 `:506`）、换盐入口仅 `resealPassphraseSlot`（`envelope.ts:679`，调用 `manager.ts:571`）、`rememberSlot` 唯一写槽点（`manager.ts:1296`，9 处调用）、渲染层 0 处 `sha256/createHash`、渲染层无 `error.reason` 反推 class | 符合 |
| 同类缺陷类级扫面（D-1 那一类：UI 消费但无清除通道的持久事实） | `slotDrift` 在成功解锁/轮换/创建/恢复/重载等 6 处清零（`manager.ts:459/544/676/746/1395/1566`），`lastUnlockFailure` 同步清零（`:353/460/543/677/747`）；`slotAudit` 为审计追加（只 slice 限额，❌不需要清除语义） | **该类命中 = 0** |
| 蓝图 `api` 字段 | 2 处可接受偏差：`manager.reload(source?: SlotDriftSource)` 为位置参数（蓝图 `reload({source})`，见 D-4）；渲染层 `api.ts` 无 `dismissVariantNotice`（蓝图列了它，整改后「清除」不再需要通道，由主进程投递即作废实现，见第八节注） | 偏差已记录，不影响功能 |

接口一致性（静态）：`pnpm run typecheck` exit 0 已覆盖「符号不存在 / 方法不存在 / 参数形状不符」（均为 TS 错误）。另对跨模块调用点逐个 grep/读：`api.ts:77/81/85`（list/create/switch）、`store.ts:58-60/127-150`（三 action）、`App.tsx:249` `<VaultNoticeBar />`、`VaultHubDeps`（`hub.ts:42-55`）六字段与接线方逐个对上。**没有只靠存在性下结论**：另有 e2e 41 例 + 真机 pack 1 例 + 真机 UI 探针 3 例实跑主路径。

## 七、提交面卫生

- `git status --porcelain --untracked-files=all`：改动全部落在 `src/ tests/ e2e/ docs/`（27 M + 13 ??），**无** `node_modules/ out/ dist/ artifacts/ test-results/ coverage/ .DS_Store` 之类噪声。
- `.gitignore` 覆盖 `node_modules/ out/ dist/ release/ artifacts/ coverage/ *.log .DS_Store .env .env.local !.env.example .data/ .vite/ playwright-report/ test-results/ *.tsbuildinfo .pnpm-store/ .agent-teams/ logs/`——与本栈匹配（`logs/` 团队暂存区不入库）。
- 收口提交须逐路径 `git commit -- <路径>`，禁 `git add -A`（AC-19）。

## 八、缺陷表（仅列**仍开放**项）

| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D-2 | P3 | 架构 / 测试 | `grep -rln "VaultHub" src tests e2e` | 多库编排器应有**永久**回归 | 只命中 5 个 `src/` 文件，`tests/` 内 0 命中：`hub.ts` 的覆盖仅存在于本轮 transient 探针（`hub-multilib` 2 例 / `hub-wiring` 1 例），run 结束随日志目录归档删除，AC-14「失败零落盘」断言将失去回归载体 | AC-12/13/14（间接） | - | - |
| D-3 | P3 | 文档口径（AC-6 括注） | 阅读 PRD AC-6 括注 | 「恢复码输入加零宽字符后仍然失败」 | 实测不成立：`normalizeRecoveryCode` 的 `replace(/[^0-9A-Z]/g,'')` 本就剥掉零宽，32 位恢复码中途插 `U+200B` 仍能归一化成功。AC-6 的真实意图（变体表不作用于恢复码：全角/多缺字符仍失败）由 `passphrase-variants.test.ts` 证明，安全性无下降 | AC-6 | - | - |
| D-4 | P3 | 架构（蓝图偏差） | 对照 tech 蓝图 `manager.reload` | 蓝图写作 `reload({ source })` 对象形 | 实现为位置参数 `reload(source?: SlotDriftSource)`（`manager.ts:1171`），内部自洽、tsc 0 错、三路径语义正确 | AC-21（间接） | - | - |
| D-5 | P3 | 工艺（键盘可达） | 对 `.ts-unlock__library-row`（`vault.css:813`）与 `.ts-vault-notice__close`（`:1078`）Tab 聚焦 | DESIGN 要求贴边元素用 `outline-offset: -2px` 防被裁 | 两处只有 `:hover`/`:active`，无专用 `:focus-visible`（全文件仅 `:202`/`:1269` 两处有），回落到全局焦点环（正值 offset），在贴边/可滚动容器里有被裁风险；无 GUI 环境无法判定实际裁切，故作观察 | DESIGN §3 | - | - |
| D-6 | P3 | 工艺 / 无障碍（观察） | 展开解锁卡「库列表」后 Tab / 方向键巡检，或读屏浏览 | `role="listbox"` + `role="option"` 语义应配套方向键巡检（roving tabindex） | `UnlockScreen.tsx:133-145` 用 `role="listbox"` 容器 + 每行 `<button role="option" aria-selected>`：读屏会按 option 播报，但未实现 ↑/↓ 巡检，Tab 才能切换；且 `role=option` 覆盖了 button 的「可按」语义 | AC-13（间接） | - | - |

> 注（D-1 的收口口径，非缺陷）：整改采用「`status()` 首次投递即把 `local.json.variantNotice` 置 null，本进程留副本」的方案（`manager.ts:397-410`），因此不需要 `vault:dismiss-variant` 通道，蓝图 `api.ts` 的 `dismissVariantNotice()` 一项**不再需要**；渲染层 `store.ts:127` 的关闭仍是内存动作（按 `at` 去重），语义正确。

## 九、round-2 复验对比（**严重级列名刻意不用「严重级」**，仅作对比，不是开放式缺陷）

| 编号 | round-1 级 | round-2 级 | 模块 | 上轮结论 | 本轮实测 | 复验命令 |
| --- | --- | --- | --- | --- | --- | --- |
| D-1 | P2 | **已关闭**（-） | 变体告知条（主进程 + 渲染层） | 「一次性」跨重启不成立，持久记录永不清除 | 整改生效：`manager.ts:397-410 takeVariantNotice()` 首次投递即清 `local.variantNotice` 并 `persistLocal()`（失败回滚，宁重不漏）；`manager.test.ts:662` 永久回归。三条独立证据全绿：① 进程级 `ac7-notice-once` **1 passed**（上轮红）；② 投放质量 `ac7-notice-delivery` **3 passed**（投递≠静音 / 清告知不动仓库 / 定向不永久静音）；③ 真机 UI `notice-bar.probe` **1 passed**（命中 trim → 顶部条 → 关闭 → 重启计数 0）。另做变异回退 → 探针 `:53` 变红，还原后 `diff` 空且重建转绿（上轮写的通过判据原文：「同一 localDir 新建 manager 的 `status().variantNotice` 必须为 null」→ 实测 null） | `pnpm exec vitest run --config logs/teamflow/tf-mvxflmox-qxwiqb/scripts/vitest.redproof.config.ts ac7-notice-once` |
| D-2 | P3 | P3（未收口） | 架构 / 测试 | hub 无永久单测 | 仍无：`tests/` 内 0 处 `VaultHub`（transient 探针不算永久回归） | `grep -rln "VaultHub" src tests e2e` |
| D-3 | P3 | P3（未收口） | AC-6 括注口径 | 零宽恢复码口径不成立 | 实现与上一轮一致（`normalizeRecoveryCode` 未改），建议在 PRD 侧订正括注而非改代码 | `grep -n "replace(/\[^0-9A-Z\]/g" src/main/crypto/*.ts` |
| D-4 | P3 | P3（未收口） | reload 签名 | 位置参数 vs 蓝图对象形 | 仍为 `reload(source?: SlotDriftSource)` | `grep -n "reload(" src/main/vault/manager.ts` |
| D-5 | P3 | P3（未收口） | 贴边焦点环 | 两处无 `:focus-visible` | 未变（`:813`/`:1078` 仍只有 hover/active） | `grep -n "focus-visible" src/renderer/features/vault/vault.css` |

## 十、人工补测清单（环境限制，非交付缺陷）

| 项 | 判据 | 方法 / 工具 |
| --- | --- | --- |
| 告知条真实观感（32px 高、左 3px 琥珀竖条、长文案省略号） | 与 DESIGN §2.9 一致，不压字、不抖动 | 真机手动 + `Cmd+Shift+4` 截图，三方主题各一次 |
| 贴边元素焦点环是否被裁（D-5） | Tab 到库行/关闭按钮，四边完整可见 | 真机键盘 + 截图放大 |
| 变体进度行（`unlock.variant.progress`）出现/消失节奏 | 失败后出现一行、成功或终结即消失 | 真机 + 录屏 30fps |
| 解锁卡慢盘下的 loading / `aria-busy` | 主按钮有进行态、不重复提交 | 真机 + DevTools 性能面板 |
| 恢复码页下载/「我已保存」真机体会（AC-16） | 未确认无法离开；Esc/点遮罩无效 | 真机键盘 + 鼠标 |
| 四类归因块与限流倒计时的读屏播报 | 只播一次，不每秒打断 | VoiceOver（数值已 `aria-live=off`，另给 10s 粒度 polite 播报） |
| 库列表 `role=listbox` 的方向键巡检缺口（D-6） | 是否必须补 roving tabindex（产品取舍） | VoiceOver + 键盘实测 |

## 十一、结论

- **可验收**。上一轮唯一 P2（D-1，AC-7「一次性」跨重启）已验证关闭：进程级、投放质量、真机 UI 三条证据全绿，且做了变异回退证明探针有判别力（回退→红、还原→绿、`diff` 空）。
- 门禁四连：typecheck **0** / vitest **797 passed（64 files，16.02s）** / build **0** / 全量 e2e **41 passed（2.8m）**；另有真机 pack 走查 1 例、真机 UI 探针 3 例、文档判据 31 项全通过。
- 开放缺陷：**0 条 P0/P1/P2**；5 条 P3 观察（D-2 hub 无永久单测 / D-3 AC-6 括注口径 / D-4 reload 签名 / D-5 贴边焦点环 / D-6 库列表方向键巡检），均不阻塞验收，建议随下个迭代收口。
- 收口提交前回归命令：`pnpm test` + `pnpm exec playwright test e2e/unlock-lockout.spec.ts` + `pnpm exec vitest run --config logs/teamflow/tf-mvxflmox-qxwiqb/scripts/vitest.redproof.config.ts`（12 例）+ `pnpm exec playwright test --config logs/teamflow/tf-mvxflmox-qxwiqb/scripts/playwright.hub.probe.config.ts`（2 例）。
