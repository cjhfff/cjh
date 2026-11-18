import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
  utilityProcess,
  UtilityProcess
} from 'electron'
import { resolveAppPaths } from '../server/paths'

interface DaemonReadyInfo {
  port: number
  token: string
  dataDir: string
  mode: 'portable' | 'appdata' | 'custom'
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let serverProc: UtilityProcess | null = null
let daemonInfo: DaemonReadyInfo | null = null
let isQuitting = false

function showAndFocusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function triggerPortableUpdateInstall(): void {
  isQuitting = true
  if (serverProc) {
    serverProc.postMessage({
      type: 'apply_portable_update_and_exit',
      appExePath: app.getPath('exe'),
      mainPid: process.pid
    })
  }
  setTimeout(() => app.quit(), 400)
}

function applyDesktopPrefs(prefs: {
  autoLaunch?: boolean
  globalShortcutEnabled?: boolean
  globalShortcut?: string
}): { shortcutRegistered: boolean; accelerator: string } {
  if (typeof prefs.autoLaunch === 'boolean') {
    try {
      app.setLoginItemSettings({ openAtLogin: prefs.autoLaunch })
    } catch {
      // Ignore in unsupported dev environments
    }
  }

  const accelerator = (prefs.globalShortcut || 'Alt+Space').trim() || 'Alt+Space'
  let shortcutRegistered = false
  try {
    globalShortcut.unregisterAll()
    if (prefs.globalShortcutEnabled !== false) {
      shortcutRegistered = globalShortcut.register(accelerator, () => {
        showAndFocusMainWindow()
      })
    }
  } catch {
    shortcutRegistered = false
  }
  return { shortcutRegistered, accelerator }
}

function loadOrCreateDpapiMasterKey(dataDir: string): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    const dpapiFile = join(dataDir, 'master.dpapi')
    if (existsSync(dpapiFile)) {
      const encrypted = readFileSync(dpapiFile)
      const decrypted = safeStorage.decryptString(encrypted).trim()
      if (/^[0-9a-fA-F]{64}$/.test(decrypted)) {
        return decrypted
      }
    }
    const freshHex = randomBytes(32).toString('hex')
    const encrypted = safeStorage.encryptString(freshHex)
    writeFileSync(dpapiFile, encrypted)
    return freshHex
  } catch {
    return undefined
  }
}

function startDaemonSubprocess(): Promise<DaemonReadyInfo> {
  process.env.CJH_APP_EXE = app.getPath('exe')
  const paths = resolveAppPaths()
  const masterKeyHex = loadOrCreateDpapiMasterKey(paths.dataDir)
  const authToken = randomBytes(32).toString('hex')
  const serverEntry = join(__dirname, 'server.js')

  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(serverEntry, [], {
      serviceName: 'cjh-local-daemon',
      env: {
        ...process.env,
        CJH_DAEMON_AUTOSTART: '1',
        CJH_APP_EXE: app.getPath('exe')
      }
    })
    serverProc = proc
    // Deliver master key & auth token over Electron UtilityProcess IPC instead of process environment
    proc.postMessage({
      type: 'daemon_bootstrap',
      authToken,
      masterKeyHex
    })

    const timeout = setTimeout(() => {
      reject(new Error('本地守护服务启动超时 (15s)'))
    }, 15_000)

    proc.on('message', (msg: any) => {
      if (msg?.type === 'daemon_ready') {
        clearTimeout(timeout)
        const info: DaemonReadyInfo = {
          port: Number(msg.port),
          token: String(msg.token),
          dataDir: String(msg.dataDir),
          mode: msg.mode
        }
        daemonInfo = info
        resolve(info)
      } else if (msg?.type === 'request_apply_portable_update') {
        triggerPortableUpdateInstall()
      }
    })

    proc.once('exit', code => {
      if (!daemonInfo) {
        clearTimeout(timeout)
        reject(new Error(`本地守护服务异常退出 (code=${code})`))
      }
    })
  })
}

function createTrayIcon() {
  // Build a crisp 32x32 BGRA bitmap directly so Windows Tray always renders a valid visible icon
  const size = 32
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      // Rounded corner mask (radius 7)
      const dx = Math.max(0, 7 - x, x - (size - 8))
      const dy = Math.max(0, 7 - y, y - (size - 8))
      if (dx * dx + dy * dy > 49) {
        buf[idx + 3] = 0
        continue
      }
      // Subtle C glyph in white at center
      const cx = x - 16
      const cy = y - 16
      const dist = Math.sqrt(cx * cx + cy * cy)
      const isRing = dist >= 5.2 && dist <= 8.5 && !(cx > 2.5 && Math.abs(cy) < 4.5)
      if (isRing) {
        buf[idx] = 255     // B
        buf[idx + 1] = 255 // G
        buf[idx + 2] = 255 // R
        buf[idx + 3] = 255 // A
      } else {
        // Electric violet gradient (#7c5cff -> #4f46e5) in BGRA
        buf[idx] = 245     // B
        buf[idx + 1] = Math.round(92 - (y / size) * 22) // G
        buf[idx + 2] = Math.round(124 - (y / size) * 45) // R
        buf[idx + 3] = 255 // A
      }
    }
  }
  const image = nativeImage.createFromBitmap(buf, { width: size, height: size })

  try {
    tray = new Tray(image)
    tray.setToolTip('cjh · 本地 AI 与 ACP 工作台')
  } catch {
    tray = null
    return
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开 cjh 工作台',
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      }
    },
    {
      label: '打开数据目录',
      click: () => {
        if (daemonInfo?.dataDir) {
          void shell.openPath(daemonInfo.dataDir)
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出 cjh',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'cjh',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#09090b',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'default',
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#0f0f12',
            symbolColor: '#a1a1aa',
            height: 40
          }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', e => {
    if (!isQuitting && tray) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(details => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('cjh:get-daemon-info', () => {
    return {
      ...daemonInfo,
      appExe: app.getPath('exe'),
      version: app.getVersion()
    }
  })

  ipcMain.handle('cjh:pick-directory', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return res.canceled ? null : res.filePaths[0] || null
  })

  ipcMain.handle('cjh:pick-file', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile']
    })
    return res.canceled ? null : res.filePaths[0] || null
  })

  ipcMain.handle('cjh:open-path', async (_evt, targetPath: string) => {
    if (targetPath) {
      await shell.openPath(targetPath)
    }
    return true
  })

  ipcMain.handle('cjh:set-titlebar-theme', (_evt, isDark: boolean) => {
    if (process.platform === 'win32' && mainWindow) {
      mainWindow.setTitleBarOverlay({
        color: isDark ? '#0f0f12' : '#f3f1ec',
        symbolColor: isDark ? '#a1a1aa' : '#52525b',
        height: 40
      })
    }
  })

  ipcMain.handle('cjh:apply-portable-update', () => {
    triggerPortableUpdateInstall()
    return true
  })

  ipcMain.handle(
    'cjh:sync-desktop-prefs',
    (
      _evt,
      prefs: {
        autoLaunch?: boolean
        globalShortcutEnabled?: boolean
        globalShortcut?: string
      }
    ) => {
      return applyDesktopPrefs(prefs || {})
    }
  )
}

const gotSingleLock = app.requestSingleInstanceLock()
if (!gotSingleLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showAndFocusMainWindow()
  })

  app.whenReady().then(async () => {
    registerIpcHandlers()
    const info = await startDaemonSubprocess()
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/settings`, {
        headers: { Authorization: `Bearer ${info.token}` }
      })
      if (res.ok) {
        const settings = (await res.json()) as {
          general?: {
            autoLaunch?: boolean
            globalShortcutEnabled?: boolean
            globalShortcut?: string
          }
        }
        applyDesktopPrefs({
          autoLaunch: settings.general?.autoLaunch ?? false,
          globalShortcutEnabled: settings.general?.globalShortcutEnabled ?? true,
          globalShortcut: settings.general?.globalShortcut || 'Alt+Space'
        })
      } else {
        applyDesktopPrefs({ globalShortcutEnabled: true, globalShortcut: 'Alt+Space' })
      }
    } catch {
      applyDesktopPrefs({ globalShortcutEnabled: true, globalShortcut: 'Alt+Space' })
    }
    createTrayIcon()
    createMainWindow()
  })

  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll()
    } catch {
      // Ignore
    }
  })

  app.on('before-quit', () => {
    isQuitting = true
    if (serverProc) {
      serverProc.postMessage({ type: 'shutdown' })
    }
  })
}
