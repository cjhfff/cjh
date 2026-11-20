import { contextBridge, ipcRenderer } from 'electron'

const cjhShell = {
  getDaemonInfo: (): Promise<{
    port: number
    token: string
    dataDir: string
    mode: 'portable' | 'appdata' | 'custom'
    appExe: string
    version: string
  }> => ipcRenderer.invoke('cjh:get-daemon-info'),

  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('cjh:pick-directory'),

  pickFile: (): Promise<string | null> => ipcRenderer.invoke('cjh:pick-file'),

  openPath: (targetPath: string): Promise<boolean> =>
    ipcRenderer.invoke('cjh:open-path', targetPath),

  setTitleBarTheme: (isDark: boolean): Promise<void> =>
    ipcRenderer.invoke('cjh:set-titlebar-theme', isDark),

  applyPortableUpdate: (): Promise<boolean> =>
    ipcRenderer.invoke('cjh:apply-portable-update'),

  syncDesktopPrefs: (prefs: {
    autoLaunch?: boolean
    globalShortcutEnabled?: boolean
    globalShortcut?: string
  }): Promise<{ shortcutRegistered: boolean; accelerator: string }> =>
    ipcRenderer.invoke('cjh:sync-desktop-prefs', prefs),

  showNotification: (payload: {
    title: string
    body: string
    terminalAddress?: string
  }): Promise<boolean> => ipcRenderer.invoke('cjh:show-notification', payload),

  onFocusTerminal: (cb: (address: string) => void): (() => void) => {
    const handler = (_evt: unknown, address: string) => {
      if (typeof address === 'string' && address) cb(address)
    }
    ipcRenderer.on('cjh:focus-terminal', handler)
    return () => {
      ipcRenderer.off('cjh:focus-terminal', handler)
    }
  }
}

export type CjhShellBridge = typeof cjhShell

contextBridge.exposeInMainWorld('cjhShell', cjhShell)
