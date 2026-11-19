import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export interface AppPaths {
  dataDir: string
  mode: 'portable' | 'appdata' | 'custom'
  dbPath: string
  logsDir: string
  attachmentsDir: string
  skillsDir: string
  builtinSkillsDir: string
  memoryDir: string
  updatesStagingDir: string
  runtimeJsonPath: string
  masterKeyPath: string
}

function resolveBuiltinSkillsDir(): string {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) {
    const packaged = join(resourcesPath, 'skills')
    if (existsSync(packaged)) return packaged
  }
  const cwdCandidate = resolve(process.cwd(), 'resources', 'skills')
  if (existsSync(cwdCandidate)) return cwdCandidate

  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const relCandidate = resolve(here, '../../resources/skills')
    if (existsSync(relCandidate)) return relCandidate
    const relCandidate3 = resolve(here, '../../../resources/skills')
    if (existsSync(relCandidate3)) return relCandidate3
  } catch {
    // Ignore fileURLToPath edge cases
  }
  return cwdCandidate
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
  const memoryDir = join(dataDir, 'memory')
  const updatesStagingDir = join(dataDir, 'updates-staging')

  for (const dir of [dataDir, logsDir, attachmentsDir, skillsDir, memoryDir, updatesStagingDir]) {
    mkdirSync(dir, { recursive: true })
  }

  return {
    dataDir,
    mode,
    dbPath: join(dataDir, 'cjh.db'),
    logsDir,
    attachmentsDir,
    skillsDir,
    builtinSkillsDir: resolveBuiltinSkillsDir(),
    memoryDir,
    updatesStagingDir,
    runtimeJsonPath: join(dataDir, 'runtime.json'),
    masterKeyPath: join(dataDir, 'master.key')
  }
}
