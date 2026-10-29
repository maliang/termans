# RELEASING —— Termans 打包与发布手册

面向：负责出包的人（也面向半年后的自己）。目标是把「怎么打、打出什么、怎么确认打对了」写成可执行步骤，
而不是靠记忆。**能写成断言的就不写提醒**——所以本文出现的检查项都有对应命令，多数已收进
`scripts/pack-guard.cjs`。

当前版本 **0.1.0**（P4 里程碑）。已实测：macOS arm64（dir / dmg / zip）与 macOS x64（dir），
以及 2026-10-29 的 x64 目录包 + 架构自动恢复链路。未实测：Windows（NSIS）与 Linux（AppImage / deb）——
配置就绪，需在对应平台或 CI 上跑。

---

## 1. 先决条件

| 项 | 要求 | 实测环境 |
| --- | --- | --- |
| Node | ≥ 20 | 26.11.1 |
| pnpm | 10.x | 10.34.7 |
| Electron | 45.1.0（`devDependencies` 锁定） | ✅ |
| electron-builder | 26.18.0（随依赖安装） | ✅ |
| 依赖镜像 | `.npmrc` 固定了 `electron_mirror` 与 `electron_builder_binaries_mirror`（npmmirror） | ✅ |
| 平台 | macOS（主）、Windows、Linux | 仅 macOS 实跑 |

`node-linker=hoisted` 是刻意写的：electron-builder 收集原生模块与 asar 打包对 pnpm 的符号链接布局兼容性差。

---

## 2. 版本号策略

**唯一真源是 `package.json` 的 `version`**（当前 `0.1.0`）。electron-builder 把它写进：

- macOS：`CFBundleShortVersionString` / `CFBundleVersion`
- Windows：NSIS 的显示版本与安装目录名
- Linux：deb 的 `Version:`、AppImage 的文件名

规则：

| 场景 | 变更 | 例 |
| --- | --- | --- |
| 修 bug、改文案、调样式 | patch | `0.1.0` → `0.1.1` |
| 新功能、新通道、新供应商预设 | minor | `0.1.x` → `0.2.0` |
| 破坏兼容（IPC 契约变更、密文格式升版） | 0.x 阶段仍走 minor，并在 `docs/` 写明迁移 | `0.9.0` → `0.10.0` |
| 预发布 | 后缀 `-rc.N`（semver 预发布） | `0.2.0-rc.1` |

- 改版本号**只能由 package.json 的单写者（architect）执行**：
  `pnpm version patch --no-git-tag-version`（不自动打 tag、不自动 commit）。
- 密文格式若升版（`MANIFEST_VERSION` +1），必须同步写 `docs/VAULT-SYNC.md` 的迁移段落，否则旧版客户端会
  把新仓库判成 `unsupported-format`（这是刻意的 fail-closed，不是 bug）。
- 发布 tag 用 `v<version>`（`v0.1.0`），tag 与安装包里的版本必须一致——检查方法见 §7。

---

## 3. 打包入口

### 3.1 脚本（`package.json`）

| 命令 | 实际执行 | 用途 |
| --- | --- | --- |
| `pnpm build` | `electron-vite build` | 只产 `out/`（main / preload / renderer） |
| `pnpm pack` | `pnpm build && electron-builder` | 按 yml 的 arch 列表产安装包（mac：arm64 + x64 各 dmg+zip） |
| `pnpm pack:dir` | `pnpm build && electron-builder --dir` | 只产当前架构的目录包，最快（自测用） |
| `node scripts/pack-guard.cjs verify` | — | 断言图标三处一致 + 原生模块架构 + 产物元数据 |
| `node scripts/pack-guard.cjs restore` | — | 手动把原生模块 rebuild 回本机架构（构建崩溃后的兜底） |
| `node scripts/pack-guard.cjs pack -- <args>` | `electron-builder <args>` | 包一层：无论成败都在 finally 里恢复架构（交叉打包推荐） |

> 脚本名刻意用 `pack` 而不是 `package`：`npm package` 会让人以为是打 tarball。

### 3.2 `electron-builder.yml` 关键项

| 配置 | 值 | 为什么 |
| --- | --- | --- |
| `appId` | `com.termans.app` | 断言在 `pack-guard verify` 里（产物 `CFBundleIdentifier` 必须等于它） |
| `productName` | `Termans` | 决定 `.app` 名与 `CFBundleName` |
| `directories.output` | `dist`（已 gitignore） | 产物不进库 |
| `directories.buildResources` | `build` | 图标等构建资源 |
| `files` | `out/**`、`package.json`、`node_modules/**`（剔除 tests/docs/*.md） | 运行期只需要这三块；主进程 externalize 了 ssh2 / isomorphic-git / zod |
| `asar` | `true` | 原生 `.node` 会自动落到 `app.asar.unpacked/` |
| `mac.icon` / `win.icon` / `linux.icon` | `build/icon.icns` / `.ico` / `.png` | 显式写死，不依赖「build/ 恰好有同名文件」的默认巧合 |
| `mac.identity` | `null` | 明确不签名；arm64 上 electron-builder 退化为 ad-hoc 签名（否则内核拒载） |
| `mac.notarize` / `gatekeeperAssess` | `false` / `false` | 本期不做公证 |
| `mac.target` | `dmg` + `zip`，`arch: [arm64, x64]` | 两个架构各两份 |
| `win.target` | `nsis`，`arch: [x64]`；`oneClick: false` | 允许改安装目录 |
| `linux.target` | `AppImage` + `deb`，`arch: [x64]` | |
| `afterAllArtifactBuild` | `scripts/pack-guard.cjs` | **收尾守卫**：图标断言 + 原生模块架构恢复；失败即非 0 退出（详见 §5、§6） |

---

## 4. 三平台打包步骤与产物清单

### 4.1 macOS（在 macOS 上做）

```bash
pnpm install
pnpm pack                       # 产 arm64 + x64 的 dmg 与 zip（耗时取决于是否已下载 x64 Electron）
# 或者只要目录包自测：
pnpm pack:dir                   # → dist/mac-arm64/Termans.app（当前架构）
node scripts/pack-guard.cjs verify
```

| 产物 | 大小（0.1.0 实测） |
| --- | --- |
| `dist/Termans-0.1.0-arm64.dmg` | 118 MB |
| `dist/Termans-0.1.0-arm64-mac.zip` | 114 MB |
| `dist/Termans-0.1.0.dmg`（x64） | 未在本轮产出（需 `--mac dmg --x64`，会下载 x64 Electron） |
| `dist/mac-arm64/Termans.app` | 270 MB（目录包；Frameworks 252 MB + `app.asar` 12 MB） |
| `dist/mac/Termans.app`（x64） | 290 MB |

> 两个目录包可并存（`dist/mac` 与 `dist/mac-arm64`），各自的原生模块架构正确
> （实测：`dist/mac/.../cpu-features.node` = x86_64，`dist/mac-arm64/...` = arm64）。

### 4.2 Windows（在 Windows 上做）

```powershell
pnpm install
pnpm pack                        # → dist\Termans Setup 0.1.0.exe
node scripts\pack-guard.cjs verify
```

产物：`Termans Setup 0.1.0.exe`（NSIS，x64，可选择安装目录、创建快捷方式 `Termans`）。
未签名 → SmartScreen 会拦一次（点「更多信息 → 仍要运行」，或下载后右键 exe →「属性 → 勾选解除锁定」）。

### 4.3 Linux（在 Linux 上做）

```bash
pnpm install
pnpm pack                        # → dist/Termans-0.1.0.AppImage + dist/termans_0.1.0_amd64.deb
node scripts/pack-guard.cjs verify
```

验证：`chmod +x Termans-0.1.0.AppImage && ./Termans-0.1.0.AppImage`；deb 用 `sudo dpkg -i` 后执行 `termans`。
部分发行版需要 `--no-sandbox` 或在 `chrome-sandbox` 上设 setuid——这属于 Electron 基线问题，不是本项目的定制。

> **诚实标注**：Windows / Linux 的上述命令**尚未在本项目实跑**（开发机只有 macOS）。首次在真机出包时，
> 请把实际产物名与大小补进本表，并把期间踩到的坑写进 §9。

---

## 5. 原生模块架构保护（脚本，不是提醒）

### 5.1 危险是什么

`electron-builder` 打包前会跑 `@electron/rebuild`，按**目标架构**重编原生依赖，而且**直接改写
`node_modules` 里的二进制**（不是往产物目录拷一份了事）。所以在 arm64 机器上打完 x64 包之后：

- `node_modules/cpu-features/build/Release/cpufeatures.node` 变成 `x86_64`；
- 随后的 `pnpm dev`、`vitest`、`pnpm test:e2e` 都会加载错架构的二进制；
- ssh2 对可选原生绑定是 try/catch，**功能看着没事**，但直接 `require('cpu-features')` 会报
  `incompatible architecture`——极易误判成「依赖装坏了」。

### 5.2 机制

`electron-builder.yml` 挂了 `afterAllArtifactBuild: scripts/pack-guard.cjs`：

1. 校验产物（图标三处一致、`CFBundleIconFile`、`CFBundleIdentifier`、版本号）；
2. 打印**打包后**工作区原生模块的真实架构；
3. 架构不是本机架构就 `electron-rebuild -f -w cpu-features -a arm64` 恢复，并**再次断言**；
4. 任何一步失败都 `throw` → electron-builder 以非 0 退出（不给「日志看着成功」的机会）。

为什么钩子能覆盖 `pnpm pack:dir`：`--dir` 不产 artifact，但 `app-builder-lib/out/index.js` 在
`packager.build()` 之后**无条件**调用 `afterAllArtifactBuild`。这一点是读源码确认的，不是猜的。

构建**中途崩溃**时钩子不会执行（进程已死），所以保留手动入口 `node scripts/pack-guard.cjs restore`。
交叉打包更稳的姿势是走包装层，`finally` 一定执行：

```bash
pnpm build && node scripts/pack-guard.cjs pack -- --mac --x64 --dir
```

### 5.3 真实证据（2026-10-29 09:24 +08:00，arm64 Mac，`--mac --x64 --dir`）

打包后（钩子打印，工作区已被改成目标架构）：

```
[pack-guard] 打包后 node_modules 原生模块（交叉打包会变成目标架构）
  · x86_64    node_modules/cpu-features/build/Release/cpufeatures.node
  · arm64     node_modules/fsevents/fsevents.node
```

恢复并断言：

```
[pack-guard] 原生模块架构（期望 arm64）
  ✓ arm64     node_modules/cpu-features/build/Release/cpufeatures.node
  ✓ arm64     node_modules/fsevents/fsevents.node
  ✓ arm64     node_modules/cpu-features/bin/darwin-arm64-150/cpu-features.node
[pack-guard] 收尾完成：产物已校验，node_modules 已恢复本机架构
```

进程退出后独立复核（不依赖脚本自述）：

```
$ file node_modules/cpu-features/build/Release/cpufeatures.node
…: Mach-O 64-bit bundle arm64
$ file dist/mac/Termans.app/Contents/Resources/app.asar.unpacked/node_modules/cpu-features/build/Release/cpufeatures.node
…: Mach-O 64-bit bundle x86_64
```

即：**工作区回到 arm64（dev/e2e 可用），而 x64 产物里带的是 x86_64（该产物自己正确）**。两者必须不同，
如果它们相同，说明打包时没按目标架构重编，x64 包在 Intel 机器上会崩。

### 5.4 CI 建议

各架构分开跑（`macos-14` 出 arm64、`macos-13` 出 x64、`windows-latest`、`ubuntu-latest`），
不要在同一台机器上串行交叉打包；真要串行，必须走 §5.2 的包装层。纯 `node` 加载不了 `cpu-features`
（它按 Electron 45 的 ABI 编译，`process.versions.modules=150`），所以**不要给原生绑定写 vitest 单测**。

---

## 6. 图标三处一致性（可执行判定表）

设计交付 → `build/` → 产物，三处必须**逐字节**相同。实测值（0.1.0，`shasum -a 256`）：

| 组 | 期望 sha256 | 三处 |
| --- | --- | --- |
| `icon.icns` | `6e295b78d38f561dd06edf84f6d56d23b944403b275a86eb5c3e6d47969f6105` | `build/icon.icns`、`design/logo/export/termans.icns`、`dist/mac*/Termans.app/Contents/Resources/icon.icns` |
| `icon.ico` | `f770412033e6bef3d4afffb036896732da686691093b26f1052f834106e72718` | `build/icon.ico`、`design/logo/export/termans.ico` |
| `icon.png` | `bc879738d0f2497d16943e47686e8d9963237f3ef9e7439fb1038847563a8424` | `build/icon.png`、`design/logo/export/termans-icon-1024.png` |

判定（一条命令，非 0 即失败）：

```bash
node scripts/pack-guard.cjs verify
```

实测输出（节选）：

```
[pack-guard] 图标三处一致性（build/ 与 design/ 与产物 Contents/Resources/）
  ✓ icns 6e295b78d38f… ← build/icon.icns + design/logo/export/termans.icns
      + dist/mac/Termans.app/Contents/Resources/icon.icns + dist/mac-arm64/Termans.app/Contents/Resources/icon.icns
  ✓ ico f770412033e6… ← build/icon.ico + design/logo/export/termans.ico
  ✓ png bc879738d0f2… ← build/icon.png + design/logo/export/termans-icon-1024.png

[pack-guard] 产物元数据
  ✓ dist/mac/Termans.app CFBundleIconFile=icon.icns
  ✓ dist/mac/Termans.app CFBundleIdentifier=com.termans.app
  ✓ dist/mac/Termans.app CFBundleShortVersionString=0.1.0
```

**这条断言不是恒绿的**——把 `build/icon.icns` 末尾追加一个字节再跑，立刻红（实测）：

```
$ printf 'X' >> build/icon.icns && node scripts/pack-guard.cjs verify ; echo EXIT=$?
  ✗ icns 046cf6ba7b81… ← build/icon.icns
  ✗ icns 6e295b78d38f… ← design/logo/export/termans.icns + dist/mac/... + dist/mac-arm64/...
[pack-guard] ✗ icns 图标在三处之间不一致（设计交付 → build/ → 产物必须逐字节相同）。
EXIT=1
```

（验证完记得从备份还原；`shasum` 复核应回到 `6e295b78…`。图标的设计规范见 `design/BRAND.md`，生成链路见
`docs/ARCHITECTURE.md`：没有 rsvg/ImageMagick 时用 Playwright 的 headless chrome 出 PNG，`iconutil` 打 icns，
`ico` 用脚本手写容器。）

---

## 7. 发布前检查清单

按顺序执行，任何一步不通过就停。

### 7.1 产物新鲜度（第一道门，别跳过）

**冒烟或验收前必须先确认产物 mtime ≥ 目标 HEAD 的 commit 时间。** 否则你验的不是当前代码，
而是一份「能正常启动」的旧包——它不崩、不报错，只是行为停在几天前。
**旧产物会以「能启动」的形态骗过验收，比崩溃更危险。**

真实案例（2026-10-29，本仓库 t21 打包冒烟时的实测）：

| | 旧产物（当天 01:32 打包） | 按 HEAD `0afbb7f` 重打包（09:57） |
| --- | --- | --- |
| 启动日志 | `[ipc] registered 53 channels (48 placeholder)` | `[ipc] registered 53 channels (0 placeholder)` |
| 首屏 | `[ipc] vault:status failed: E_NOT_IMPLEMENTED`，界面靠「预览模式」兜住，肉眼看不出异常 | 真实加密库启动 |
| 实质 | 验的是旧代码 | 验的才是当前代码 |

判据命令（macOS，`stat -f` 语法；判据不过就**重新打包**，不是「反正能启动就拿来凑证据」）：

```bash
head_ts=$(git log -1 --format=%ct)                              # 目标 HEAD 的提交时间（epoch 秒）
pkg_ts=$(stat -f %m dist/mac-arm64/Termans.app)                 # 产物 mtime（epoch 秒）
printf 'HEAD  %s\n' "$(git log -1 --format='%h %ci')"
printf 'PKG   %s\n' "$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' dist/mac-arm64/Termans.app)"
[ "$pkg_ts" -ge "$head_ts" ] && echo '✅ 产物不旧于 HEAD' || echo '❌ 产物比 HEAD 旧：先重打包再冒烟'
```

- 同一判据也适用于 `out/`（`electron out/main/index.js` 的 dev 模式同样会跑旧产物）。
- Windows / Linux：时间戳取值换成 `stat -c %Y <path>`（GNU）或
  `powershell -c '(Get-Item .\dist\win-unpacked\Termans.exe).LastWriteTimeUtc'`；比较逻辑不变。
- 反例信号：启动日志里出现 `(N placeholder)` 这类占位通道，或某个本应实现的通道回 `E_NOT_IMPLEMENTED`
  ——基本可以直接判定「产物是旧的」。

### 7.2 命令清单

```bash
# 0) 先过 7.1 的产物新鲜度判据（旧产物会以「能启动」的形态骗过验收）
pnpm install --frozen-lockfile          # 依赖可复现
pnpm typecheck                          # node + web 都 0 error
pnpm test                               # 全绿（单文件更快：npx vitest run src/main/vault）
pnpm build                              # out/ 产出正常
pnpm pack                               # 出安装包；收尾钩子必须打印「node_modules 已恢复本机架构」
node scripts/pack-guard.cjs verify      # 图标 / 架构 / 元数据三条断言全绿
file node_modules/cpu-features/build/Release/cpufeatures.node   # 必须是本机架构（arm64）
```

### 7.3 手工验收（至少一次，别只看断言）

| 检查 | 怎么确认 |
| --- | --- |
| 包能启动 | 跑包内二进制：`env -u ELECTRON_RUN_AS_NODE dist/mac-arm64/Termans.app/Contents/MacOS/Termans`（`ELECTRON_RUN_AS_NODE=1` 会让 Electron 起不来，见 `docs/ARCHITECTURE.md` 环境坑） |
| 版本一致 | `plutil -p <app>/Contents/Info.plist \| grep -E 'ShortVersion|BundleIdentifier'` 与 `package.json` 一致；tag 名 `v<version>` |
| 首启锁定 | 用临时 `userData`（`TERMANS_E2E_USER_DATA=<tmp>`）启动，应停在解锁/创建口令界面 |
| 加密边界 | `git -C <vault repo> show main:vault.enc \| grep -c '<某个 IP>'` = 0；`ls -R` 只有 `manifest.json` / `vault.enc` / `themes/` |
| 锁定态 DOM | 锁定时 `document.body.innerText` 不含任何主机名与 IP |
| 图标真的换了 | 应用坞/Dock 里看到的是新图标（hash 相同也可能是缓存，切换一次系统主题或重启 Dock 再确认） |

### 7.4 发布物与校验和

发布物：`dist/*.dmg`、`dist/*-mac.zip`、`dist/*.exe`、`dist/*.AppImage`、`dist/*.deb` + `SHA256SUMS`：

```bash
cd dist && shasum -a 256 *.dmg *.zip *.exe *.AppImage *.deb > SHA256SUMS
```

---

## 8. 未签名产物的分发行为（写给用户，也要写进 release notes）

`identity: null` 意味着没有 Developer ID、也没有公证：

- **本机**构建的 `.app` 没有 quarantine 属性，双击可开；
- **经浏览器 / 微信 / AirDrop 传出去的** dmg/zip 会被打上 `com.apple.quarantine`，首次打开报
  「Termans 已损坏，无法打开」或「无法验证开发者」——**不是包坏了**。

自解两种方法（release notes 必须带）：① 右键 → 打开（一次即可）；② `xattr -dr com.apple.quarantine /Applications/Termans.app`。

判定依据（本机实测）：

```bash
$ xattr -l dist/mac-arm64/Termans.app        # 只有 com.apple.provenance，没有 quarantine → 本机可直接运行
$ spctl --assess --type execute -vv dist/mac-arm64/Termans.app
…: code has no resources but signature indicates they must be present
$ codesign -dv dist/mac-arm64/Termans.app 2>&1 | head -3
… flags=0x20002(adhoc,linker-signed) | Signature=adhoc | TeamIdentifier=not set
```

后续里程碑：Developer ID Application 证书 + `notarytool` 公证 + `stapler` 装订；Windows 代码签名。

---

## 9. 已知限制与后续里程碑

1. **Windows / Linux 未实跑**：配置就绪，需在对应平台或 CI 首验（首次出包后补产物名与大小）。
2. 无签名 / 无公证 / 无自动更新（`electron-updater` 未引入）。
3. `dist/` 会越滚越大（每次 pack 重生成），注意磁盘；`dist` 已 gitignore。
4. **不要并行打包**：两个 electron-builder 同时在跑会互相改写 `node_modules` 的原生模块架构。
5. 交叉打包必须走收尾守卫；崩在半路就跑 `node scripts/pack-guard.cjs restore`。
6. mac x64 的 dmg/zip 本轮未产出（只验证了 x64 目录包 + 架构恢复），首发若需 Intel 安装包，
   用 `node scripts/pack-guard.cjs pack -- --mac dmg zip --x64` 并复核 `SHA256SUMS`。
7. **Electron 45 的 `safeStorage.isEncryptionAvailable` 已弃用（已知技术债，本轮不修）**

   - 现象：每次启动 stdout 都会打印
     `(electron) 'safeStorage.isEncryptionAvailable' is deprecated and will be removed. Please use 'safeStorage.isAsyncEncryptionAvailable' instead.`
     功能不受影响（sync 版在 Electron 45 仍可用），只是告警。
   - 坐标：`src/main/ipc/index.ts:54`（组合根决定用 safeStorage 还是文件密钥）、
     `src/main/vault/secret-box.ts:110`（`SafeStorageLike` 接口成员）、
     `src/main/vault/secret-box.ts:118`、`src/main/vault/secret-box.ts:119`（`isOsBacked()` / `available()` 的实际调用）。
     同一段落里 `src/main/ipc/index.ts:56` 的注释也提到该 API（Linux 下可能抛异常）。
   - **为什么现在不修**：`SecretBox` / `VaultManager` 的状态判定（`isUnlocked()`，见
     `src/main/vault/manager.ts:798`，以及解锁屏/锁屏分支）目前全是**同步** API；改成 async 会波及
     解锁流程与 IPC 组合根（`registerVaultHandlers` 的装配时序），属于收口期不该动的重构。
     这是 captain 在 2026-10-29 的明确裁定。
   - **何时该修**：升级到「移除 sync 版 API」的 Electron 大版本**之前**（升级前先看 release notes 的
     `safeStorage` 小节），或者解锁流程本来就要改成 async 时**一并**做。
   - **修法草稿**：给 `SafeStorageLike`（`src/main/vault/secret-box.ts:109-113`）加可选
     `isAsyncEncryptionAvailable?(): Promise<boolean>`；组合根改成 `await` 之后再决定用 `wrapSafeStorage()`
     还是 `createFileSecretBox()` 兜底；`SecretBox.available()` 仍然是同步布尔（启动时求值一次后缓存），
     这样解锁流程保持同步，改动面收敛在装配处。

8. **ssh2 1.17.0 的 ed25519 密钥生成缺陷（上游，未修；我们靠夹具规避）**

   - 现象：`ssh2.utils.generateKeyPairSync('ed25519')` 生成的私钥里，约 **1/256** 会把内嵌公钥串
     写成 31 字节（正常 32），于是整个 OpenSSH 私钥容器的公钥段是 **50 字节而非 51**，
     连 ssh2 **自己的** `utils.parseKey()` 都解析不了，报 `Malformed OpenSSH private key`。
     机制是「公钥按大整数往返」时前导 `0x00`（mpint 的正号填充）被吞掉，长度前缀随之少 1。
   - **本地实测（2026-10-29，本机 Node 26 / ssh2 1.17.0）**：两轮各 20000 次生成，
     `errCount = 76`（0.38% ≈ 1/263）与 `errCount = 90`（**0.45% ≈ 1/222**），
     合起来约 **1/240**，与「约 1/256」一致（坏样本 `pubBlobLen=50` / `declaredKeyLen=31`），
     把同一把 key 的**公钥单行**单独 `parseKey` 也返回 Error。
     核对命令（**注意 `parseKey` 是「返回 Error」而不是抛异常**，`try/catch` 统计会得 0）：
     ```bash
     node -e '
     const { utils } = require("ssh2")
     let bad = 0
     for (let i = 0; i < 20000; i++) if (utils.parseKey(utils.generateKeyPairSync("ed25519").private) instanceof Error) bad++
     console.log({ bad, rate: bad / 20000 })'
     # 实测输出（两轮）：{ bad: 76, rate: 0.0038 } / { bad: 90, rate: 0.0045 }
     ```
   - 影响的三条代码路径（逐条核过）：
     1. `src/main/ssh/auth.ts` 的 `parsePrivateKey()`（`:87-102`）—— **受影响**：`utils.parseKey`
        返回 Error 时映射成 `SshError('key-invalid', 'Cannot parse private key: …')`，
        用户看到的是「私钥解析失败」。只影响**用 ssh2 自己生成**的私钥文本（用户从 `ssh-keygen`
        或 ssh2 以外工具生成的密钥不受影响：OpenSSH 的写入器不会少这一个字节）。
     2. `src/main/ssh/known-hosts.ts` 的 `keyTypeFromPublicKeyBlob()` / `fingerprintSha256FromKey()`
        —— **不受影响**：吃的是 SSH **线格式二进制 blob**（握手时拿到的），不解析私钥文本。
     3. `src/main/ssh/session.ts` 的 `hostVerifier` —— **不受影响**：比对的是握手得到的
        `ParsedKey`，同样与私钥文本无关。
   - 我们的规避（已落库，别「顺手简化」）：
     * `src/main/ssh/__tests__/helpers/keys.ts` 头注释完整记录了这条缺陷，并钉死
       `FIXTURE_HOST_KEY`（常量私钥 + 公钥单行 + 指纹三者互相一致，有用例守着）；
       需要「另一把密钥」时走 `generateValidKeyPair()`——生成后**自校验、坏了重掷**。
     * `src/main/ssh/__tests__/helpers/fake-server.ts:305-309` 默认用钉死的宿主密钥。
     * `tests/fixtures/ssh-server.ts:32-38` 的 `FIXTURE_HOST_KEY` 与 `:51` 写死的
       `FIXTURE_HOST_KEY_FINGERPRINT`（`SHA256:JFBdXZUT972M8J3vCxY7vjCbanHm8qQYb7UI28O4dLk`）。
       不钉死的后果不是「偶尔一把坏密钥」，而是**每次全量跑约 1/3 概率随机红一条用例**（单跑绿、全量红）。
     * 客户端密钥用 `node:crypto` 的 RSA（`harness.ts:260-284`），不碰 ssh2 的 ed25519 生成器。
   - 以后升级 ssh2 时的复查动作：① 重跑上面那条 20000 次核对命令，`bad` 必须为 0；
     ② 跑 `npx vitest run src/main/ssh/__tests__/keys.test.ts`；③ 全量 `pnpm test` 连跑 3 次
     （用 `--sequence.shuffle` 更稳），确认无「随机红」；④ 若上游已修，可以考虑把
     `generateValidKeyPair()` 的重掷逻辑简化掉（但钉死夹具仍然值得保留：跨进程指纹稳定、
     断言可读）。
   - 上游 issue：属于 ssh2（`mscdex/ssh2`）的 `utils.generateKeyPairSync` 实现问题，
     **issue 编号未在本轮核实**（没有可靠链接就不写编号，免得下游当事实引用）；
     判定依据以上面的本地实测为准。

---

## 10. README §1 功能表取证（2026-10-29，HEAD `aef5ef8` 之后）

发版文档里的「功能表」是**声明**，声明必须有代码坐标支撑，否则它会被下游当成事实继承（本项目已经因此写过
「端口转发」「导入/导出」这类不存在的功能）。本节把 README §1 的 9 行逐条拆成「声明 → 证据 → 结论」，
供审查（t10）逐行复核。**证据都是当场 grep / 读文件得到的 `file:line`，不是记忆。**

| # | 能力 | README §1 声明（当前措辞） | 证据 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 多页签终端 | WebGL 渲染、失败回退 DOM、自适应尺寸、搜索、选中即复制、右键粘贴、链接走系统浏览器 | `src/renderer/features/terminal/xterm-factory.ts:6` 引 `@xterm/addon-webgl`；`:58-70` `attachRenderer(…, () => new WebglAddon(), () => { renderer = 'dom'; input.onRendererChange?.('dom') })`（回退分支）；同文件 `fit.fit()` + 注释「真正的尺寸由 ResizeObserver 收敛」；`:4,38` SearchAddon；`XtermSurface.tsx:57,64` `addEventListener('mouseup', …)`（注释：用 mouseup 而非 onSelectionChange）；`XtermSurface.tsx:71` `addEventListener('contextmenu', …)`；`runtime.ts:91` `void call('app:open-external', { url: uri })` | 已做（逐项对上） |
| 2 | 主机库 | 分组树、分组与标签（可编辑、参与搜索）、搜索、跳板机（**单层** ProxyJump）、启动命令、备注；`~/.ssh/config` **导入**（导出通道已实现，界面暂无入口） | 分组树 `HostTree.tsx:41,54-63`（`buildGroups` + `.ts-vault__group`）；搜索 + 标签参与搜索 `HostSidebar.tsx:53` `host.tags.some((tag) => tag.toLowerCase().includes(needle))`、`:116-118` 搜索框；标签编辑 `HostEditor.tsx:195-196`、模型 `src/shared/models/host.ts:67`（标签**不在**树里渲染 chip，只渲染色点 + 名称 + `hostname:port`）；启动命令 `src/shared/models/host.ts:65` + `src/main/ssh/session.ts:682` + `HostEditor.tsx:252-255`；备注 `HostEditor.tsx:52`（注释：随 `hosts:update` 扩展键提交，落 `payload.hostNotes`）、`:61,84-85`；跳板机 `src/main/ssh/jump.ts`（多级 → `jump-unsupported`，8 例测试 `src/main/ssh/__tests__/jump.test.ts`）；导入 `HostSidebar.tsx:69-79,141` + `src/main/vault/register.ts:197-202`；导出 handler 真实（`register.ts:206-213`）但**全 renderer 无 tsx 调用 `exportSshConfig`**（仅 `api.ts:180` wrapper） | 已做，但两处措辞必须改：删「端口转发」；「导入/导出」→「导入（导出暂无 UI）」 |
| 3 | 加密主机库 | 主口令 scrypt + AES-256-GCM；IP/端口/用户名/密码/passphrase/known_hosts/ssh_config 全在密文里 | `src/main/crypto/envelope.ts:1,18-19`（`scryptSync`；注释 `passphrase --scrypt--> KEK_pass --AES-GCM--> [包裹 VMK]`）；`src/shared/models/vault.ts:8` payload 注释 `payload{hosts, groups, knownHosts, secrets, integrations, settings, sshConfig, …}`；`:16`「主机密码与私钥 passphrase 存在 `payload.secrets`」；`:59` `secretsExcluded` 保证明文里不出现密码/passphrase/API key/Git token | 已做 |
| 4 | Git 同步 | 只推 `manifest.json` + `vault.enc`（有自定义主题时另加明文 `themes/*.json`）；换机解锁即见主机 | `src/main/vault/manager.ts:104` 注释「仓库工作区（userData/vault）：只有 manifest.json / vault.enc / themes/*.json」；`src/main/git/sync.test.ts:116` 与 `sync-robustness.test.ts:93` 断言无主题时仓库树 `toEqual(['manifest.json','vault.enc'])`；`src/main/vault/manager.test.ts:475,492`「themes 落成明文 `themes/*.json`（保留 git diff 可读性），其余仍在密文里」 | 已做；原文把 `themes/*.json` 写成恒有，需加「有自定义主题时」 |
| 5 | 私钥 | 私钥本体**永不同步**，只记路径；缺文件时连接前明确报错，并给「导入私钥 / 粘贴私钥 / 改用密码」三个入口 | `src/renderer/features/vault/PrivateKeyGuide.tsx:61` `t('key.import')`、`:65` `t('key.paste')`、`:68` `t('key.usePassword')`；`src/renderer/features/vault/i18n.ts:101-105` 三处英文文案（'Import key file' / 'Paste key' / 'Switch to password'）；不进同步见 `src/shared/models/vault.ts:59` 的 `secretsExcluded` | 已做 |
| 6 | AI 辅助 | 11 个供应商预设 + 自定义；流式对话、带终端上下文；生成的命令必须先确认 | `src/renderer/features/ai/presets.ts` 的 `PROVIDER_PRESETS` 条目 id 依次 openai / deepseek / moonshot / dashscope / openrouter / vllm / lmstudio / ollama / anthropic / gemini / gemini-native = **11 个**（`grep -c 'id:'` 得 15 是因为同文件还有别的对象，不能用来数预设）；命令确认写死在契约 `src/shared/models/settings.ts:57` `commandConfirmation: z.literal(true)`；聊天门禁 `src/main/ai/service.ts:214-228` | 已做 |
| 7 | 主题 | 4 套内置（Dark / Midnight / Light / High Contrast）+ 自定义主题编辑器（导入导出、实时预览） | `src/renderer/theme/builtin.ts:277-280` `builtinTheme('termans-dark', …)` / `('termans-midnight', …)` / light / contrast；`:8-11` 注释说明 midnight/contrast 只在 TS 里存在，切换时整组覆盖 CSS 变量 | 已做 |
| 8 | 多语言 | English / 简体中文，即时切换 | `src/locales/{en,zh-CN}/` 各有 8 个 namespace JSON（ai/auth/common/errors/hosts/settings/sync/terminal）；即时切换 `src/renderer/i18n/useLocale.ts`；缺 key 告警与兜底见 `docs/i18n.md` §5 | 已做 |
| 9 | 安全默认 | known_hosts 严格校验、空闲 15 分钟自动上锁、锁定时不渲染任何主机名与 IP | `src/shared/models/settings.ts:128` `knownHostsPolicy: 'strict'`、同块 `autoLockMinutes: 15`；锁定清空内存 `src/renderer/features/vault/store.ts:16,55-60`（收到非 `unlocked` 即清 `library` / `selectedHostId` / `conflicts`，「锁定态不缓存主机数据」）；锁定时整层隐藏 `src/renderer/app/App.tsx:106,113,139,150`（`data-locked` + `.ts-app[data-locked='true'] > :not(.ts-unlock){visibility:hidden}`） | 已做 |

### 10.1 复核用命令（贴实跑输出即可，不用重读代码）

```bash
# 端口转发：只应出现在 §11（功能表已移除）
grep -n "端口转发" README.md

# 跳板机措辞：功能表与 §11 都应写「单层」
grep -n "单层" README.md

# ssh_config 导出没有 UI：只应命中 api.ts 的 wrapper
grep -rn "exportSshConfig" src/renderer --include=*.tsx   # 期望：无输出
grep -rn "exportSshConfig" src/renderer                  # 期望：仅 features/vault/api.ts:180

# 锁定时不渲染主机名：vault store 收到非 unlocked 即清库
grep -n "status.state === 'unlocked' ? get().library : null" src/renderer/features/vault/store.ts
```

### 10.2 本轮对 README 的实际改动

1. §1 第 2 行：删「端口转发」；「跳板机（ProxyJump）」→「跳板机（**单层** ProxyJump）」；「标签」→「分组与标签（可编辑、参与搜索）」；「导入/导出」→「导入（导出通道已实现，界面暂无入口）」。
2. §1 第 4 行：`themes/*.json` 加上「有自定义主题时」这一前提（无主题时仓库里只有 `manifest.json` + `vault.enc`）。
3. §11 追加 3 条：第 8 条端口转发未实现（`PortForward` 只有类型预留）、第 9 条多级跳板明确报错不静默直连、第 10 条 `ssh_config` 导出暂无界面入口。
4. `src/renderer/features/vault/HostEditor.tsx` 跳板机字段加一行辅助文案（`data-testid="jump-host-hint"`），文案走 i18n：
   新增 key `hosts:editor.jumpHostHint`（`src/locales/{en,zh-CN}/hosts.json`）。

> 与 t24 派单的一处偏离：派单写「写进 `src/locales/{en,zh-CN}/vault.json`」，但仓库里**没有** `vault.json`；
> vault / 解锁界面的文案在 `src/renderer/features/vault/i18n.ts` 里以运行时 bundle（namespace `vaultsync`）注入，
> 而 `vaultsync` 不在 `src/shared/i18n.ts` 的 `I18N_NAMESPACES` 里。HostEditor 用的是 `useTranslation('vaultsync')`，
> 因此新 key 落在契约内的 `hosts` namespace，调用处写带前缀的 `t('hosts:editor.jumpHostHint')`
> （i18next 的 `extractFromKey` 在 `nsSeparator: ':'`、`keySeparator: false` 下必然解析前缀，见
> `node_modules/i18next/dist/cjs/i18next.js:519-537`）。
