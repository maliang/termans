import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { emitToAll, registerIpcHandlers } from './ipc'
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

  win.once('ready-to-show', () => win.show())
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

function bootstrap(): void {
  app.setName('Termans')

  // 单实例：第二次启动只聚焦已有窗口。
  // e2e 例外——测试会独立起进程，抢锁会让 playwright 拿不到窗口、现象是 firstWindow 超时。
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
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
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// 单实例锁在 ready 之前申请；拿不到就退出（macOS 上由 second-instance 聚焦）
if (!isE2E && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}
