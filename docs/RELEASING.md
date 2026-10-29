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

按顺序执行，任何一步不通过就停：

```bash
pnpm install --frozen-lockfile          # 依赖可复现
pnpm typecheck                          # node + web 都 0 error
pnpm test                               # 全绿（单文件更快：npx vitest run src/main/vault）
pnpm build                              # out/ 产出正常
pnpm pack                               # 出安装包；收尾钩子必须打印「node_modules 已恢复本机架构」
node scripts/pack-guard.cjs verify      # 图标 / 架构 / 元数据三条断言全绿
file node_modules/cpu-features/build/Release/cpufeatures.node   # 必须是本机架构（arm64）
```

手工验收（至少一次，别只看断言）：

| 检查 | 怎么确认 |
| --- | --- |
| 包能启动 | 跑包内二进制：`env -u ELECTRON_RUN_AS_NODE dist/mac-arm64/Termans.app/Contents/MacOS/Termans`（`ELECTRON_RUN_AS_NODE=1` 会让 Electron 起不来，见 `docs/ARCHITECTURE.md` 环境坑） |
| 版本一致 | `plutil -p <app>/Contents/Info.plist \| grep -E 'ShortVersion|BundleIdentifier'` 与 `package.json` 一致；tag 名 `v<version>` |
| 首启锁定 | 用临时 `userData`（`TERMANS_E2E_USER_DATA=<tmp>`）启动，应停在解锁/创建口令界面 |
| 加密边界 | `git -C <vault repo> show main:vault.enc \| grep -c '<某个 IP>'` = 0；`ls -R` 只有 `manifest.json` / `vault.enc` / `themes/` |
| 锁定态 DOM | 锁定时 `document.body.innerText` 不含任何主机名与 IP |
| 图标真的换了 | 应用坞/Dock 里看到的是新图标（hash 相同也可能是缓存，切换一次系统主题或重启 Dock 再确认） |

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
