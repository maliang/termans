#!/usr/bin/env node
/**
 * pack-guard —— 打包收尾守卫（原生模块架构恢复 + 图标一致性断言）
 *
 * 为什么需要它（不是文档不够，是文档挡不住手滑）：
 *   electron-builder 打包前会跑 @electron/rebuild，按**目标架构**重编原生依赖，并且**直接改写
 *   node_modules 里的二进制**（不是往产物目录拷一份）。所以在 arm64 机器上打 x64 包之后，
 *   工作区里的 cpu-features.node 会变成 x86_64，随后的 `pnpm dev` / vitest / e2e 都会加载错架构。
 *   实测记录见 docs/ARCHITECTURE.md「★ 交叉打包会就地改写 node_modules 里的原生模块」。
 *
 * 本脚本把「收尾必须恢复 arm64」变成可执行断言，而不是一句提醒：
 *   1. electron-builder.yml 里挂了 afterAllArtifactBuild 钩子（覆盖 pnpm pack 与 pnpm pack:dir）；
 *   2. 恢复失败 / 恢复后架构仍不对 → throw → electron-builder 以非 0 退出，CI 立刻红；
 *   3. 也可手动 `node scripts/pack-guard.cjs restore`（构建中途崩溃、node_modules 被污染时用）。
 *
 * 图标一致性同理：产物 Contents/Resources/icon.icns 必须与 build/icon.icns 与设计交付
 * design/logo/export/termans.icns 三处 shasum 完全相等（t11 证明值 6e295b78…）。默认的
 * 「build/ 目录恰好有同名文件」只是个巧合，换个 CI 目录就不成立，所以这里逐字节校验。
 *
 * 用法：
 *   node scripts/pack-guard.cjs report          # 只打印现状（架构 + 图标 hash + 产物元数据）
 *   node scripts/pack-guard.cjs verify          # 断言（CI 用），失败 exit 1
 *   node scripts/pack-guard.cjs restore         # 把原生模块 rebuild 回 arm64 并断言
 *   node scripts/pack-guard.cjs pack -- --mac --x64 --dir   # 包一层：无论成败都恢复架构
 *
 * 作为 electron-builder 钩子使用时导出 afterAllArtifactBuild。
 */

'use strict'

const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

/** electron-rebuild 会碰的原生模块（ssh2 的可选加速、fsevents 的文件监听）。 */
const PRIMARY_NATIVE = [
  'node_modules/cpu-features/build/Release/cpufeatures.node',
  'node_modules/fsevents/fsevents.node',
]

/**
 * 自带多平台预编译产物的包：它们的 .node 文件名里就写着平台，架构与宿主机不同是**正常的**，
 * 既不该被 rebuild 也不该被断言。用包名前缀排除，避免误报。
 */
const PREBUILT_PER_PLATFORM = [
  /^@rollup\//,
  /^@rolldown\//,
  /^@electron-internal\//,
  /^@esbuild\//,
  /^@parcel\//,
  /^@swc\//,
  /^@napi-rs\//,
  /^lightningcss/,
  /^sharp\//,
]

/** 图标三处一致性：同一组的文件必须 shasum 相同。 */
const ICON_GROUPS = [
  {
    name: 'icns',
    sources: ['build/icon.icns', 'design/logo/export/termans.icns'],
    bundles: ['Contents/Resources/icon.icns'],
  },
  {
    name: 'ico',
    sources: ['build/icon.ico', 'design/logo/export/termans.ico'],
    bundles: [],
  },
  {
    name: 'png',
    sources: ['build/icon.png', 'design/logo/export/termans-icon-1024.png'],
    bundles: [],
  },
]

const EXPECTED_BUNDLE_ICON_FILE = 'icon.icns'
const EXPECTED_APP_ID = 'com.termans.app'

const ok = (message) => console.log(`  \u2713 ${message}`)
const bad = (message) => console.log(`  \u2717 ${message}`)
const info = (message) => console.log(`  · ${message}`)
const head = (message) => console.log(`\n[pack-guard] ${message}`)

class GuardError extends Error {}

function fail(message, details) {
  const error = new GuardError(message)
  if (details) error.details = details
  throw error
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

function sha256(absolutePath) {
  return createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
}

/** `file -b` 的结果里只有架构这一段有意义：Mach-O 是 `arm64`/`x86_64`，ELF 是 `x86-64`/`ARM aarch64`。 */
function archOf(absolutePath) {
  const output = run('file', ['-b', absolutePath]).trim()
  if (/\barm64\b|aarch64/i.test(output)) return 'arm64'
  if (/\bx86_64\b|x86-64/i.test(output)) return 'x86_64'
  if (/universal/i.test(output)) return 'universal'
  return 'unknown'
}

function fileDescription(absolutePath) {
  return run('file', ['-b', absolutePath]).trim()
}

function expectedHostArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x86_64'
}

/** 当前工作区（node_modules）里原生模块的真实架构。 */
function nativeReport() {
  const primary = PRIMARY_NATIVE.filter((relative) => fs.existsSync(path.join(ROOT, relative))).map(
    (relative) => ({
      path: relative,
      description: fileDescription(path.join(ROOT, relative)),
      arch: archOf(path.join(ROOT, relative)),
    }),
  )

  // 其余 .node 只做信息展示：排除自带多平台预编译产物的包，其余若架构不符也报出来。
  const others = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(absolute, depth + 1)
        continue
      }
      if (!entry.name.endsWith('.node')) continue
      const relative = path.relative(ROOT, absolute)
      if (PRIMARY_NATIVE.includes(relative)) continue
      const packageName = relative.split(path.sep).slice(1, 3).join('/')
      if (PREBUILT_PER_PLATFORM.some((pattern) => pattern.test(packageName))) continue
      others.push({ path: relative, arch: archOf(absolute) })
    }
  }
  walk(path.join(ROOT, 'node_modules'), 0)

  return { primary, others }
}

function assertNativeArch(expected = expectedHostArch()) {
  head(`原生模块架构（期望 ${expected}）`)
  if (process.platform !== 'darwin') {
    info(`当前平台 ${process.platform}：架构守卫只在 macOS 上实测过，跳过断言`)
    return
  }

  const report = nativeReport()
  if (report.primary.length === 0) {
    info('未找到 cpu-features / fsevents，跳过（纯 JS 依赖树）')
    return
  }

  const wrong = report.primary.filter((entry) => entry.arch !== expected)
  for (const entry of report.primary) {
    const line = `${entry.arch.padEnd(9)} ${entry.path}`
    if (entry.arch === expected) ok(line)
    else bad(line)
  }
  for (const entry of report.others) {
    if (entry.arch === expected) ok(`${entry.arch.padEnd(9)} ${entry.path}`)
    else bad(`${entry.arch.padEnd(9)} ${entry.path}（非 rebuild 目标，但架构异常）`)
  }

  if (wrong.length > 0 || report.others.some((entry) => entry.arch !== expected)) {
    fail(
      `node_modules 里的原生模块架构不是 ${expected}：dev / vitest / e2e 会加载到错架构的二进制。\n` +
        `  修复：node scripts/pack-guard.cjs restore\n` +
        `  （交叉打完 x64 之后必须恢复，见 docs/RELEASING.md「原生模块架构保护」）`,
    )
  }
}

/**
 * 只在架构不对时才 rebuild —— 钩子与 pack 包装层都会调用它，重复 rebuild 是无谓的 4 秒 + 噪音日志。
 * 返回 true 表示本次真的执行了 rebuild。
 */
function ensureNativeArch(expected = expectedHostArch()) {
  if (process.platform !== 'darwin') {
    info(`当前平台 ${process.platform}：架构守卫只对 macOS 实测生效，跳过`)
    return false
  }
  const report = nativeReport()
  const wrong = report.primary.filter((entry) => entry.arch !== expected)
  if (wrong.length === 0 && report.others.every((entry) => entry.arch === expected)) {
    head(`原生模块已在本机架构 ${expected}，无需 rebuild`)
    for (const entry of report.primary) ok(`${entry.arch.padEnd(9)} ${entry.path}`)
    return false
  }
  restoreNativeArch(expected)
  return true
}

/** @electron/rebuild 会就地改写 node_modules，所以恢复必须显式 rebuild，不能只靠装回依赖。 */
function restoreNativeArch(expected = expectedHostArch()) {
  head(`把原生模块 rebuild 回 ${expected}`)
  if (process.platform !== 'darwin') {
    info(`当前平台 ${process.platform}：跳过（守卫只对 macOS 实测生效）`)
    return
  }

  const rebuildBin = path.join(ROOT, 'node_modules', '.bin', 'electron-rebuild')
  if (!fs.existsSync(rebuildBin)) {
    fail(
      '@electron/rebuild 未安装（node_modules/.bin/electron-rebuild 不存在）。\n' +
        '  它随 electron-builder 一起装；若缺失先 `pnpm install`，不要指望 pnpm rebuild —— 那会按纯 node 的 ABI 编译，Electron 里 require 直接报 NODE_MODULE_VERSION 不匹配。',
    )
  }

  const args = ['-f']
  const targets = PRIMARY_NATIVE.filter((relative) => fs.existsSync(path.join(ROOT, relative))).map(
    (relative) => relative.split('/')[1],
  )
  for (const name of targets) args.push('-w', name)
  args.push('-a', expected)

  try {
    run(rebuildBin, args, { inherit: true })
  } catch (error) {
    fail(`electron-rebuild 失败：${error.message}\n  手工重试：./node_modules/.bin/electron-rebuild ${args.join(' ')}`)
  }

  assertNativeArch(expected)
}

function listBundles() {
  const distDir = path.join(ROOT, 'dist')
  if (!fs.existsSync(distDir)) return []
  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .map((entry) => path.join('dist', entry.name, 'Termans.app'))
    .filter((relative) => fs.existsSync(path.join(ROOT, relative)))
}

function plistValue(bundleRelative, key) {
  try {
    return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(ROOT, bundleRelative, 'Contents/Info.plist')]).trim()
  } catch {
    return null
  }
}

function assertIcons() {
  head('图标三处一致性（build/ 与 design/ 与产物 Contents/Resources/）')
  const version = readJson('package.json').version
  const bundles = listBundles()

  for (const group of ICON_GROUPS) {
    const hashToFiles = new Map()
    for (const source of group.sources) {
      const absolute = path.join(ROOT, source)
      if (!fs.existsSync(absolute)) fail(`图标缺失：${source}`)
      const hash = sha256(absolute)
      if (!hashToFiles.has(hash)) hashToFiles.set(hash, [])
      hashToFiles.get(hash).push(source)
    }

    for (const bundle of bundles) {
      for (const inner of group.bundles) {
        const relative = path.posix.join(bundle, inner)
        const absolute = path.join(ROOT, relative)
        if (!fs.existsSync(absolute)) continue // 例如 win/linux 产物不带 icns
        const hash = sha256(absolute)
        if (!hashToFiles.has(hash)) hashToFiles.set(hash, [])
        hashToFiles.get(hash).push(relative)
      }
    }

    const hashes = [...hashToFiles.keys()]
    for (const [hash, files] of hashToFiles) {
      const label = `${hash.slice(0, 12)}…`
      if (hashes.length === 1) ok(`${group.name} ${label} ← ${files.join(' + ')}`)
      else bad(`${group.name} ${label} ← ${files.join(' + ')}`)
    }
    if (hashes.length > 1) {
      fail(
        `${group.name} 图标在三处之间不一致（设计交付 → build/ → 产物必须逐字节相同）。\n` +
          '  说明：electron-builder 不会重画图标，不一致只可能是 build/ 里的文件过期或被漏拷。',
      )
    }
  }

  if (bundles.length === 0) {
    info('dist/ 下暂无 Termans.app，跳过产物图标与元数据断言（先跑 pnpm pack:dir）')
    return
  }

  head('产物元数据')
  for (const bundle of bundles) {
    const iconFile = plistValue(bundle, 'CFBundleIconFile')
    const bundleId = plistValue(bundle, 'CFBundleIdentifier')
    const bundleVersion = plistValue(bundle, 'CFBundleShortVersionString')

    if (iconFile === EXPECTED_BUNDLE_ICON_FILE) ok(`${bundle} CFBundleIconFile=${iconFile}`)
    else fail(`${bundle} 的 CFBundleIconFile 是 ${iconFile}，期望 ${EXPECTED_BUNDLE_ICON_FILE}`)

    if (bundleId === EXPECTED_APP_ID) ok(`${bundle} CFBundleIdentifier=${bundleId}`)
    else fail(`${bundle} 的 CFBundleIdentifier 是 ${bundleId}，期望 ${EXPECTED_APP_ID}`)

    if (bundleVersion === version) ok(`${bundle} CFBundleShortVersionString=${bundleVersion}`)
    else if (/^\d{17}$/.test(bundleVersion ?? '')) {
      fail(
        `${bundle} 的版本号是 Electron 的 17 位构建号（${bundleVersion}），不是 package.json 的 ${version}。\n` +
          '  原因：electron-builder 只在没有 version 时回落到 Electron 版本；出现这个值说明读到了别的 package.json（asar 内或依赖里的）。',
      )
    } else {
      fail(`${bundle} 的版本号是 ${bundleVersion}，与 package.json 的 ${version} 不一致`)
    }
  }
}

function report() {
  const version = readJson('package.json').version
  head(`termans ${version} 打包现状`)
  const nativeModules = nativeReport()
  if (nativeModules.primary.length === 0) info('未找到 rebuild 目标原生模块')
  for (const entry of nativeModules.primary) info(`${entry.arch.padEnd(9)} ${entry.path}`)

  const bundles = listBundles()
  if (bundles.length === 0) info('dist/ 下暂无 Termans.app')
  for (const bundle of bundles) {
    info(`${bundle} 版本=${plistValue(bundle, 'CFBundleShortVersionString')} 图标=${plistValue(bundle, 'CFBundleIconFile')}`)
    const packed = path.join(ROOT, bundle, 'Contents/Resources/app.asar.unpacked/node_modules/cpu-features/build/Release/cpufeatures.node')
    if (fs.existsSync(packed)) info(`  包内 cpufeatures.node → ${archOf(packed)}`)
  }
}

function verify() {
  assertNativeArch()
  assertIcons()
  head('全部断言通过')
}

/**
 * electron-builder 钩子：所有产物生成之后调用（`--dir` 也会走到这里，见 app-builder-lib/out/index.js）。
 * 这里做两件事——校验刚打出来的包，再把 node_modules 恢复成本机架构。
 * 失败一律 throw，让 electron-builder 以非 0 退出，而不是留一条「看起来成功」的日志。
 */
function afterAllArtifactBuild(buildResult) {
  head('afterAllArtifactBuild 收尾')
  const artifacts = buildResult && Array.isArray(buildResult.artifactPaths) ? buildResult.artifactPaths : []
  info(`产物 ${artifacts.length} 个${artifacts.length === 0 ? '（--dir 目录包不产 artifact，属正常）' : ''}`)
  for (const artifact of artifacts) info(path.relative(ROOT, artifact))

  assertIcons()

  const before = nativeReport()
  if (before.primary.length > 0) {
    head('打包后 node_modules 原生模块（交叉打包会变成目标架构）')
    for (const entry of before.primary) info(`${entry.arch.padEnd(9)} ${entry.path}`)
  }
  ensureNativeArch()
  head('收尾完成：产物已校验，node_modules 已恢复本机架构')
  return []
}

/** `pack` 子命令：包一层 electron-builder，无论成败都在 finally 里恢复架构。 */
function packAndRestore(extraArgs) {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'electron-builder')
  if (!fs.existsSync(bin)) fail('electron-builder 未安装（node_modules/.bin/electron-builder 不存在）')
  let exitCode = 0
  try {
    run(bin, extraArgs, { inherit: true })
  } catch (error) {
    exitCode = typeof error.status === 'number' && error.status > 0 ? error.status : 1
    head(`electron-builder 以 ${exitCode} 退出，仍会尝试恢复原生模块架构`)
  }
  try {
    ensureNativeArch()
  } catch (restoreError) {
    console.error(`\n[pack-guard] ✗ 原生模块恢复失败：${restoreError.message}\n`)
    process.exit(exitCode || 1)
  }
  process.exit(exitCode)
}

function main(argv) {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'report':
        report()
        return
      case 'verify':
        verify()
        return
      case 'restore':
        restoreNativeArch()
        return
      case 'pack': {
        const args = rest[0] === '--' ? rest.slice(1) : rest
        packAndRestore(args)
        return
      }
      case undefined:
      case '--help':
      case '-h':
        console.log('用法: node scripts/pack-guard.cjs <report|verify|restore|pack [-- args...]>')
        return
      default:
        fail(`未知子命令：${command}`)
    }
  } catch (error) {
    if (error instanceof GuardError) {
      console.error(`\n[pack-guard] ✗ ${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
}

module.exports = afterAllArtifactBuild
module.exports.afterAllArtifactBuild = afterAllArtifactBuild
module.exports.verify = verify
module.exports.restoreNativeArch = restoreNativeArch
module.exports.ensureNativeArch = ensureNativeArch

if (require.main === module) main(process.argv.slice(2))
