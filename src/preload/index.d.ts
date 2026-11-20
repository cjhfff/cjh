export interface CjhShellBridge {
  getDaemonInfo: () => Promise<{
    port: number
    token: string
    dataDir: string
    mode: 'portable' | 'appdata' | 'custom'
    appExe: string
    version: string
  }>
  pickDirectory: () => Promise<string | null>
  pickFile: () => Promise<string | null>
  openPath: (targetPath: string) => Promise<boolean>
  setTitleBarTheme: (isDark: boolean) => Promise<void>
  applyPortableUpdate: () => Promise<boolean>
  syncDesktopPrefs: (prefs: {
    autoLaunch?: boolean
    globalShortcutEnabled?: boolean
    globalShortcut?: string
  }) => Promise<{ shortcutRegistered: boolean; accelerator: string }>
  showNotification: (payload: {
    title: string
    body: string
    terminalAddress?: string
  }) => Promise<boolean>
  onFocusTerminal: (cb: (address: string) => void) => () => void
}

declare global {
  interface Window {
    cjhShell?: CjhShellBridge
  }
}
