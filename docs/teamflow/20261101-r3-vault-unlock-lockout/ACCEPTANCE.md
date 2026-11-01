# ACCEPTANCE · 加密主机库「口令不对了，也不能新建用户」（r3）

- 需求夹：`docs/teamflow/20261101-r3-vault-unlock-lockout/`（PRD / DESIGN / TECHNICAL / QA-REPORT 同夹）
- 被测工作树：`/Users/maliang/Documents/develop/maliang/termans`，分支 `master`，HEAD `742be01` + 27 M / 13 ?? 未提交改动（按 ADR-2026-08-27 由 host 统一收口）
- 验收时间：2026-11-02 00:38–00:47（Asia/Shanghai）；方式：本机独立复跑门禁与全部专项探针 + 逐条读实现/测试取证，不转述 QA 结论
- 产品级 `AGENTS.md` 在本仓不存在（团队约定索引为 `docs/teamflow/memory.md`），故以 memory.md 的 r3 三条约定为核对口径

## 一、结论

功能面 **26/26 条全部满足**，无 P0/P1/P2 开放缺陷；门禁四连与红证/真机探针全部本机复跑通过。但 **AC-20（P0）的留证口径未完全兑现**（等价红证成立，缺「修复前正确口令返回 bad-passphrase」的实跑输出），且架构面有 2 处需收口的覆盖/口径遗留 → **有条件通过**。整改 3 项（预计 ≤1 人时），复验只需重跑 §六 的 4 条命令。

## 二、门禁与专项探针（本机实跑，非引用 QA）

| 层 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm run typecheck` | exit 0（node / web 两段 tsc 均无输出） |
| 单测 | `pnpm test` | exit 0：**64 files / 797 tests passed** |
| 构建 | `pnpm run build` | exit 0（renderer 2216 modules） |
| 全量 e2e | `pnpm exec playwright test` | exit 0：**41 passed (2.8m)**，含既有 12 spec + `e2e/unlock-lockout.spec.ts` 6 例 |
| 红证/变体关 | `vitest run -c logs/…/vitest.redproof.config.ts` | **4 files / 12 passed**（ac7 系列 4、ac20-variants-off 4、red-proof 4） |
| 真机 pack | `playwright test -c logs/…/playwright.pack.config.ts` | **1 passed (6.3s)**：`dist/mac-arm64/Termans.app`（0.1.1）走「口令错→归因→新建库→切回旧库」 |
| 真机 UI 探针 | `playwright test -c logs/…/playwright.hub.probe.config.ts` | **2 passed (15.3s)**：多库接线 + AC-7 顶部条关闭后跨重启不复现 |

## 三、逐条 AC 判定（26 条）

| AC | 判定 | 验收证据 |
|---|---|---|
| AC-1 四分类 | PASS | 四类各一例真机：`e2e/unlock-lockout.spec.ts:71/:109/:139/:169`；`attribution.ts:classifyUnlockFailure` 由 `manager.ts:1416` 挂载，「口令错误」字样仅 bad-passphrase |
| AC-2 8 位指纹 | PASS | `envelope.ts:398 slotFingerprint` 唯一实现；`manager.ts:381` 只读本机槽；e2e :139 无记录不判 mismatch；渲染层 0 处 `createHash` |
| AC-3 不泄密 | PASS | 诊断区 `UnlockScreen.tsx:329-349` 六项白名单、不含路径；`attribution.test.ts:224` 脱敏单测；e2e :71 断言无 `/Users/` 与临时目录名 |
| AC-4 诊断台账 | PASS | `UnlockScreen.tsx:308-349` createdAt / lastUnlocked / lastSynced / revision / KDF，缺失显示 `diag.unknown` |
| AC-5 变体表 | PASS | `passphrase.ts:170` 唯一定义 + `manager.ts:506` 唯一调用；顺序 identity→nfkc→trim→strip-zero-width、按值去重；`passphrase-variants.test.ts` 17 例 |
| AC-6 只作用于口令槽 | PASS | `normalizeRecoveryCode` 零改动；恢复码全角/多缺字符反例见同测试（PRD 括注偏差见 §五） |
| AC-7 规范形重封 | PASS | trim/零宽命中 → `resealPassphraseSlot`（`envelope.ts:679` / `manager.ts:571`）新盐 + slotMigration 审计；`notice-bar.probe` 真机 1 passed（关闭后重启 0）；nfkc 分支见 §五 |
| AC-8 反例 ≥8 | PASS | `passphrase-variants.test.ts:136-160` 恰好 10 组；失败仍计入节流（manager.test） |
| AC-9 ≤4 派生 | PASS | `envelope.ts:594 onKekDerived` 计数钩子；候选去重 ≤4，成功路径 1 次；失败仅一行进度文案 |
| AC-10 兜底入口 | PASS | e2e :198 locked 时次级入口与解锁按钮并存；:307 uninitialized 下 0 入口 |
| AC-11 旧库零改动 | PASS | e2e :198 `digestRepo` 建库前后旧库 manifest/enc sha256 与文件集合全等 |
| AC-12 隔离 | PASS | e2e :198 新库 0 主机、切到未勾选库必须口令；`hub.ts` 切库先 lock 旧 manager（单活） |
| AC-13 库列表/切换 | PASS | e2e :198 两行、`data-current` 唯一、免重启、status 归属新库、非当前库 sha256 不变 |
| AC-14 拒绝覆盖 | PASS⚠ | `library-index.test.ts:122-188` 名称/目录判重 + 拒绝零字节；hub 层编排仅短暂探针 → §六① |
| AC-15 三句确认 | PASS | i18n `point1-3` en/zh 各一份（`i18n.ts:91-93 / 325-327`）；e2e :198 三条非空不重复 |
| AC-16 恢复码强制 | PASS | e2e :198 恢复码页 Esc / 无 footer 逃逸、未点「已保存」不得离开 |
| AC-17 无重置入口 | PASS | `tests/contract/vault-unlock-contract.test.ts:159` 扫全部新增 testid+key 的禁用词根；无 reset/清库入口（`Reset passphrase` 为 r1 既有合法恢复流） |
| AC-18 不回归 | PASS | `repo-layout.test.ts` 绿、LEGACY_TEST_IDS 未改名、默认库路径 `ipc/index.ts:62-64` 未变、797 例全绿 |
| AC-19 门禁+真机 | PASS | §二 全部本机实跑 + pack 走查；AC-19 两问答：本轮未改 `e2e/fixtures`（累计 3 处改动见 QA §四），未削弱同步语义（`sync.test.ts` 删除行 0、`sync-robustness.test.ts` 仅改 import） |
| AC-20 先红后绿 | ⚠️ | 等价红证实跑成立（R2 红→绿、R3 槽被偷换→保住、R4 错盐重封可达）；但「修复前正确口令 → bad-passphrase」的实跑失败输出未留证 → §六② |
| AC-21 同步不换槽 | PASS | `sync.ts:205 requireUnlocked`、快进 :334/:341/:381 前置；三路径 `adoptRemotePayload :439/:682`；bootstrap 唯一豁免注释 :203/:559 |
| AC-22 AAD 硬断言 | PASS | `envelope.ts:644 assertKdfSalt` 入口即断言；`manager.ts:1378/:1551 expectedKdfSalt` 取自本机槽记录 |
| AC-23 成对落盘 | PASS | `repo.ts:39 PAIR_TX_DIR`、`stagingDir:100` 优先 localDir；`repo-pair.test.ts` 7 例（两处 rename 中断自愈 / 幂等 / 异对拒绝 / 主题目录不变） |
| AC-24 会话还原 | PASS | `manager.test.ts:769` 还原不写仓库（回退点注释），还原后同口令可解锁 |
| AC-25 可分辨性 | PASS | 变异回退 → `notice-bar.probe.spec.ts:53` 红，还原后 diff 空且转绿；`manager.ts:1528` 写明回退点 |
| AC-26 文档 | PASS | `docs/VAULT-SYNC.md:530` §14 + 14.1–14.6；`doc-vault-diagnostics.mjs` 31/31 |

## 四、架构一致性（M3 质量门）

- 蓝图模块逐项落地：`attribution.ts`（纯函数零 IO）、`library-index.ts`（索引/路径/判重）、`hub.ts`（单活 + 切换）、`repo.ts`（`.pair-tx` 成对事务）、`sync.ts`（三路径 adopt）、渲染层（七态 + 告知条 + store/api/i18n）；接线为 `src/main/ipc/index.ts:84 new VaultHub` + `register.ts:83/85 hub.current()`，无构造期捕获。
- 单点定义核验（重复实现风险清单）：slotFingerprint 1 处、passphraseVariants 1 定义 + 1 调用、换盐入口仅 `resealPassphraseSlot`、`rememberSlot` 唯一写槽点（manager.ts:1296，9 处调用）、渲染层 0 处哈希/归因推断。
- 偏差 3 处（不改行为，需收口口径）：① `reload(source?)` 为位置参数，蓝图写 `{source}`；② `api.ts` 无 `dismissVariantNotice`——D-1 整改后由主进程首次投递即清取代，通道不再需要；③ `describeUnlockFailure` / `redactForLog` 无生产调用点（仅单测，AC-3 靠「失败不落日志」满足）。

## 五、遗留与观察（P3，不阻塞功能）

- D-2 hub 无永久单测（AC-14 的零写入断言目前只在短暂探针里）；D-3 PRD AC-6 括注「加零宽仍失败」不成立（`normalizeRecoveryCode` 本就剥零宽，安全性无下降）；D-4 reload 签名；D-5 贴边 focus-visible；D-6 库列表缺方向键巡检。
- 新增观察（本轮发现，QA 未列）：`deriveKek` 既有 NFKC 使 **nfkc 变体在口令槽永不命中**——全角口令在 identity 即解锁，不产生迁移与告知；可达变体只有 trim / 零宽。AC-7 字面仍成立（命中的是 identity），但「4 变体各触发一次重封」的隐含预期不成立，建议在 `docs/VAULT-SYNC.md` §14.5 写明。

## 六、整改项（有条件通过的依据）与复验命令

1. **hub 层永久回归**：把 `hub-multilib.probe.test.ts` 移入 `tests/`（覆盖 AC-12/13 编排与 AC-14 判重拒绝零写入），让 AC-14 断言有永久载体。
2. **AC-20 留证收口**：在 HEAD `742be01` 的干净 worktree 上实跑「正确口令 → bad-passphrase」并贴失败输出 + file:line；或由主人书面接受等价红证口径（R2/R3/R4）。
3. **口径对齐**：TECHNICAL.md / memory.md 写明 reload 位置参数与 `dismissVariantNotice` 取消；`describeUnlockFailure` / `redactForLog` 要么接一行日志、要么标注为防御性导出。
4. 可选（不阻塞）：D-5 / D-6 无障碍工艺；D-3 在下版 PRD 更正括注。

复验：`pnpm run typecheck` → `pnpm test` → `pnpm exec playwright test e2e/unlock-lockout.spec.ts` → `pnpm exec vitest run --config logs/teamflow/tf-mvxflmox-qxwiqb/scripts/vitest.redproof.config.ts`。

验收结论：⚠️ 有条件通过

## 七、整改项收口（lead，0.1.2）

1. **AC-20 红证（已在修复前的干净 worktree 上实跑）**
   环境：`git worktree add --detach /tmp/redproof 742be01`，软链 node_modules。用例：建库用口令 P → 建主机 → 另建一个用口令 Q 的库 → 把 Q 的 `manifest.json`/`vault.enc` 覆盖进 P 的仓（等价于 sync 快进采用远端记录）→ `manager.reload()` → 用 P `unlock()`。
   实测输出（截图级原文）：
   ```
   UNLOCK_REJECTED reason= bad-passphrase error= [E_UNAUTHORIZED] Incorrect master passphrase
   × 远端那只 manifest 被采用后，本机原口令必须仍能开库（不是 bad-passphrase） 206ms
   ```
   即：**摘要三项全部自洽、本机口令却被打成 bad-passphrase**，与主人症状逐字一致。

2. **边界（必须写清，不许含糊）**：同一脚本在修复后的 HEAD 上同样红——因为它直接覆盖仓内文件、绕过了 sync API。修复守住的是**sync 的三条路径**（快进 / 无冲突合并 / 冲突后写回，`adoptRemotePayload` + `requireUnlocked`），由 `src/main/git/sync.test.ts` 三条新用例（"...B 的原口令仍可开库"）与 `e2e/unlock-lockout.spec.ts` 六条覆盖；**不是**「任何文件级篡改都自愈」。任何人对仓目录直接动手，仍会把库锁死。

3. **主人现有那台库无法修复**：该库建于 0.1.1 之前，`vault-local/local.json` 里**没有 `passphraseSlot` 记录**（字段为 `createdAt/lastSyncedAt/lastSyncedPayloadSha/lastSyncedRevision/lastUnlockedAt/rememberedUntil/repo/version`），所以新版也只会归因为 `bad-passphrase`，不会给出 `slot-record-mismatch`。没有旧库副本、没有恢复码 ⇒ 数据不可达，只能保留原样、另开一个本地库继续用。

4. **未做（如实登记）**：`hub.ts` 仍无永久单测（整改项 1 原本要求把 `hub-multilib.probe.test.ts` 移入 `tests/`，本轮我未补；AC-14 的零写入断言目前只有一次性探针证据）。`deriveKek` 的 NFKC 使 nfkc 变体在口令槽不可达（仅 trim/零宽可达），属已知观察。

5. **0.1.2 门禁（lead 独立复跑）**：`pnpm run typecheck` exit 0；`npx vitest run` **64 files / 797 passed (16.7s)**；`env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test` **41 passed (2.8m)**；`pnpm pack:dir` PACK=0、产物 `CFBundleShortVersionString=0.1.2`、asar 哈希与 `/Applications` 副本一致。
