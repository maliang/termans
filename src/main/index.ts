import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emitToAll, registerIpcHandlers } from './ipc'
import { clearStaleSingletonLock } from './singleton-lock'
import { SettingsStore } from './store/settings-store'
import type { AppInfo, AppPlatform, MenuCommand } from '@shared'

/**
 * 主进程入口：窗口创建、安全开关、菜单、应用生命周期。
 *
 * 安全基线（改任何一条都要在 ARCHITECTURE.md 里说明理由）：
 * - contextIsolation: true —— 渲染层的 window 与 preload 的隔离上下文互不可见；
 * - nodeIntegration: false —— 渲染层没有 require/process，XSS 拿不到本机能力；
 * - sandbox: true —— preload 也进沙箱，只能用 electron 的 contextBridge/ipcRenderer；
 * - 禁用新窗口、限制 will-navigate、拒绝所有权限请求（摄像头/麦克风/地理位置一律不需要）。
 */

const isE2E = process.env['TERMANS_E2E'] === '1'
// e2e 静默模式：窗口创建即放到屏幕外，跑测试不会在用户眼前闪一下（默认开启，TERMANS_E2E_VISIBLE=1 关掉）
const isE2EQuiet = isE2E && process.env['TERMANS_E2E_QUIET'] === '1'
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']

let mainWindow: BrowserWindow | null = null
let settings: SettingsStore | null = null

function currentPlatform(): AppPlatform {
  // 只在这三个平台发布；其他 unix 落到 linux 分支（界面可用，打包不提供）
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform
  }
  return 'linux'
}

function getAppInfo(): AppInfo {
  return {
    name: 'Termans',
    version: app.getVersion(),
    electron: process.versions.electron ?? '0.0.0',
    chrome: process.versions.chrome ?? '0.0.0',
    node: process.versions.node,
    platform: currentPlatform(),
    arch: process.arch,
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath()
  }
}

/** 菜单项统一走事件，渲染层自己做路由（谁拥有状态谁处理） */
function sendCommand(command: MenuCommand): void {
  emitToAll('app:menu-command', { command })
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[])
      : ([] as MenuItemConstructorOptions[])),
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => sendCommand('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('close-tab') },
        { type: 'separator' },
        { label: 'New Host…', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('open-host-form') },
        { label: 'Import ~/.ssh/config…', click: () => sendCommand('import-ssh-config') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendCommand('open-settings') },
        ...(isMac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[]))
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Find in Terminal', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find-in-terminal') },
        { label: 'Toggle AI Panel', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendCommand('toggle-ai-panel') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Termans',
    // 与 --ts-ink-900 一致：冷启动时先铺底色，避免白闪
    backgroundColor: '#05080E',
    // macOS 用内嵌标题栏（页签条即标题栏），与 Termius 的观感一致
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 16 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  // e2e 用 showInactive()：窗口必须真的存在（隐藏窗口 capturePage 可能拍出空白），但绝不抢焦点——
  // 否则 `pnpm test:e2e` 会把主人正在打字的窗口顶掉。人工启动走的仍是 show()（见 docs/TESTING.md §6）。
  win.once('ready-to-show', () => {
    if (isE2E) {
      if (isE2EQuiet) {
        // 「静默」要两层：先把窗口挪到屏幕外，再把它设成全透明。
        // 只挪位置不够——实测 `setPosition(-4000, -4000)` 被 macOS 夹回 `{x:0, y:33}`，
        // 窗口照样出现在屏幕上（主人 2026-10-30 反馈过这一点）。
        // 全透明窗口仍然正常合成，`page.screenshot()` 拍出来是有内容的（实测 1653 种颜色、最亮 236）。
        win.setOpacity(0)
        app.dock?.hide()
      }
      win.showInactive()
      if (isE2EQuiet) {
        // 显示之后再挪一次：有些版本只在窗口可见后才允许改位置
        win.setPosition(-4000, -4000)
      }
      return
    }
    win.show()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  // 外链一律走系统浏览器；应用内不开新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 阻止渲染层被导航到远程页面（钓鱼/劫持的常见入口）
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = rendererDevUrl ? url.startsWith(rendererDevUrl) : url.startsWith('file://')
    if (!allowed) event.preventDefault()
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // 文档/QA 用的截图钩子：`TERMANS_CAPTURE_PATH=/abs/shot.png pnpm dev`
  // 用 webContents.capturePage() 而不是系统截屏 —— 不需要「屏幕录制」权限，
  // 也不会把别人的桌面拍进去；只在显式给环境变量时生效。
  const capturePath = process.env['TERMANS_CAPTURE_PATH']
  if (capturePath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win.webContents
          .capturePage()
          .then((image) => {
            mkdirSync(dirname(capturePath), { recursive: true })
            writeFileSync(capturePath, image.toPNG())
            console.log(`[termans] captured ${capturePath}`)
          })
          .catch((error: unknown) => console.warn(`[termans] capture failed: ${String(error)}`))
      }, 1200)
    })
  }

  return win
}

/** 把已存在但可能被隐藏/最小化/失焦的窗口拉回前台 */
function revealWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  // 关闭窗口后 app 在 macOS 上仍驻留；从 Dock/launcher 再进来时窗口可能是隐藏态，
  // 只 focus() 不会把它显示出来（用户视角＝点了没反应）
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * 确保有一个可用的主窗口：有就拉回前台，没有就新建。
 *
 * 二次启动（`open -n -a`，多数启动器/LaunchNext 的做法）与 Dock 点击（`activate`）
 * 都走这里。此前 `second-instance` 首行 `if (!mainWindow) return` 在「用户已经关掉窗口、
 * 进程还活着」时直接返回，于是新实例被单实例锁挡掉、旧实例什么都不做——现象就是点了打不开。
 */
function ensureMainWindow(): BrowserWindow | null {
  const candidate = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

  if (candidate) {
    revealWindow(candidate)
    return candidate
  }

  // mainWindow 可能已被置空（closed 回调），但窗口对象还没销毁——先复用再谈新建
  const existing = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed())
  if (existing) {
    mainWindow = existing
    revealWindow(existing)
    return existing
  }

  // 冷启动阶段（ready 之前）拿不到 BrowserWindow，交给 whenReady 里的首次创建
  if (!app.isReady()) return null

  mainWindow = createWindow()
  return mainWindow
}

/**
 * 申请单实例锁，拿不到时先排查「陈旧锁」（实现见 `./singleton-lock.ts`）。
 *
 * 为什么要这一步：应用被强杀/崩溃后 SingletonLock 会残留并指向已死的 pid，此时
 * requestSingleInstanceLock() 可能返回 false 而实际没有任何活实例；旧代码直接 app.quit()，
 * 用户看到的就是「双击/点图标毫无反应，进程 0、无窗口、无报错」。
 * 只在锁主确实已死时清锁并重试一次，活实例时绝不干涉单实例语义。
 */
function acquireSingleInstanceLock(): boolean {
  if (app.requestSingleInstanceLock()) return true
  if (!clearStaleSingletonLock(app.getPath('userData'))) return false
  return app.requestSingleInstanceLock()
}

function bootstrap(): void {
  app.setName('Termans')

  // 单实例：第二次启动聚焦已有窗口；窗口已被关闭则重开一个（自愈，不再静默 return）。
  // e2e 例外——测试会独立起进程，抢锁会让 playwright 拿不到窗口、现象是 firstWindow 超时。
  app.on('second-instance', () => {
    ensureMainWindow()
  })

  void app.whenReady().then(() => {
    if (process.env['TERMANS_E2E'] === '1') {
      // 测试用隔离 userData，避免污染真实设置（本次运行目录由 playwright 传入）
      app.setPath('userData', process.env['TERMANS_E2E_USER_DATA'] ?? app.getPath('userData'))
    }

    settings = new SettingsStore(app.getPath('userData'))
    registerIpcHandlers({ getAppInfo, settings })

    // 应用不需要任何浏览器权限：摄像头/麦克风/地理位置/通知一律拒绝
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

    buildMenu()
    mainWindow = createWindow()

    app.on('activate', () => {
      // 窗口存在但被隐藏时也要 show()；只有真没有窗口才新建
      ensureMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// 单实例锁在 ready 之前申请；拿不到就退出（macOS 上由 second-instance 聚焦）。
// 拿不到时先自愈「陈旧锁」（进程被强杀/崩溃后残留、指向已死 pid），否则用户会看到双击没反应。
if (!isE2E && !acquireSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}
