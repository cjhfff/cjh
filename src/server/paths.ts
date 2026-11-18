import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface AppPaths {
  dataDir: string
  mode: 'portable' | 'appdata' | 'custom'
  dbPath: string
  logsDir: string
  attachmentsDir: string
  skillsDir: string
  updatesStagingDir: string
  runtimeJsonPath: string
  masterKeyPath: string
}

export function resolveAppPaths(): AppPaths {
  let dataDir: string
  let mode: AppPaths['mode']

  if (process.env.CJH_DATA_DIR) {
    dataDir = resolve(process.env.CJH_DATA_DIR)
    mode = 'custom'
  } else {
    const appExe = process.env.CJH_APP_EXE || process.execPath
    const exeDir = dirname(appExe)
    const portableDir = join(exeDir, 'data')
    const isElectronBinary =
      appExe.toLowerCase().endsWith('cjh.exe') || process.env.CJH_PORTABLE_FORCE === '1'

    if (isElectronBinary && existsSync(portableDir)) {
      dataDir = portableDir
      mode = 'portable'
    } else {
      const appDataBase =
        process.platform === 'win32'
          ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
          : process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Application Support')
            : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
      dataDir = join(appDataBase, 'cjh')
      mode = 'appdata'
    }
  }

  const logsDir = join(dataDir, 'logs')
  const attachmentsDir = join(dataDir, 'attachments')
  const skillsDir = join(dataDir, 'skills')
  const updatesStagingDir = join(dataDir, 'updates-staging')

  for (const dir of [dataDir, logsDir, attachmentsDir, skillsDir, updatesStagingDir]) {
    mkdirSync(dir, { recursive: true })
  }

  return {
    dataDir,
    mode,
    dbPath: join(dataDir, 'cjh.db'),
    logsDir,
    attachmentsDir,
    skillsDir,
    updatesStagingDir,
    runtimeJsonPath: join(dataDir, 'runtime.json'),
    masterKeyPath: join(dataDir, 'master.key')
  }
}
