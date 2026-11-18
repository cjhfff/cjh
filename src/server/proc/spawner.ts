import { ChildProcess, spawn, spawnSync } from 'node:child_process'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const CACHE_TTL_MS = 30_000

interface CachedPathEntry {
  resolvedPath: string | null
  expiresAt: number
}

const pathCache = new Map<string, CachedPathEntry>()

const SANITIZED_INHERITED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CJH_MASTER_KEY_HEX',
  'CJH_LOCAL_TOKEN',
  'CJH_DAEMON_AUTOSTART',
  'CJH_APP_EXE',
  'CJH_PORT',
  'CJH_API_URL',
  'CJH_API_TOKEN'
]

export function clearCommandResolutionCache(): void {
  pathCache.clear()
}

export function buildAugmentedPath(basePath = process.env.PATH || ''): string {
  const home = homedir()
  const extraDirs =
    process.platform === 'win32'
      ? [
          join(home, '.local', 'bin'),
          join(home, 'AppData', 'Roaming', 'npm'),
          join(home, '.bun', 'bin'),
          'C:\\Program Files\\nodejs'
        ]
      : [
          join(home, '.local', 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin'
        ]
  const existing = basePath.split(delimiter).filter(Boolean)
  const seen = new Set(existing.map(p => (process.platform === 'win32' ? p.toLowerCase() : p)))
  for (const dir of extraDirs) {
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir
    if (!seen.has(key) && existsSync(dir)) {
      existing.push(dir)
      seen.add(key)
    }
  }
  return existing.join(delimiter)
}

export function findExecutableInPath(
  command: string,
  envPath = buildAugmentedPath(),
  bypassCache = false
): string | null {
  if (!command) return null
  if (isAbsolute(command)) {
    return existsSync(command) ? command : null
  }
  const cacheKey = `${command}::${envPath}`
  const now = Date.now()
  if (!bypassCache) {
    const hit = pathCache.get(cacheKey)
    if (hit && hit.expiresAt > now) return hit.resolvedPath
  }

  const dirs = envPath.split(delimiter).filter(Boolean)
  const exts =
    process.platform === 'win32'
      ? extname(command)
        ? ['']
        : ['.exe', '.cmd', '.bat', '.com']
      : ['']

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, command + ext)
      if (existsSync(full)) {
        pathCache.set(cacheKey, { resolvedPath: full, expiresAt: now + CACHE_TTL_MS })
        return full
      }
    }
  }

  pathCache.set(cacheKey, { resolvedPath: null, expiresAt: now + CACHE_TTL_MS })
  return null
}

/**
 * Parses standard npm/pnpm Windows .cmd shims to extract the underlying JS script
 * so we can invoke Node directly with `shell: false` and an argument array,
 * completely avoiding cmd.exe space-splitting bugs (e.g., `C:\Program Files\nodejs\npx.cmd`).
 */
export function parseWindowsCmdShim(cmdFilePath: string): {
  nodeExecutable: string
  scriptPath: string
} | null {
  try {
    const content = readFileSync(cmdFilePath, 'utf8')
    const baseDir = dirname(cmdFilePath)
    // Match patterns like "%dp0%\node_modules\...\bin.js" or "%~dp0\..\...\cli.js"
    const regex = /"(?:%~dp0|%dp0%)[\\/]([^"\r\n]+?\.(?:c?m?js))"/gi
    let match: RegExpExecArray | null
    let lastScriptRel: string | null = null
    while ((match = regex.exec(content)) !== null) {
      lastScriptRel = match[1]
    }
    if (!lastScriptRel) return null

    const scriptPath = resolve(baseDir, lastScriptRel)
    if (!existsSync(scriptPath)) return null

    const bundledNode = join(baseDir, 'node.exe')
    const pathNode = findExecutableInPath('node')
    const nodeExecutable = existsSync(bundledNode)
      ? bundledNode
      : pathNode && pathNode.toLowerCase().endsWith('.exe')
        ? pathNode
        : process.execPath

    return { nodeExecutable, scriptPath }
  } catch {
    return null
  }
}

function quoteWinCmdArg(arg: string): string {
  if (!arg.length) return '""'
  if (!/[ \t"&()<>^|]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export interface SpawnSafeOptions {
  command: string
  args?: string[]
  cwd?: string
  extraEnv?: Record<string, string>
  borrowedAuth?: {
    kind: 'anthropic' | 'openai'
    apiKey: string
    baseUrl?: string | null
  } | null
  daemonEnv?: {
    apiUrl: string
    apiToken: string
  }
}

export function buildCleanSubprocessEnv(opts: SpawnSafeOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of SANITIZED_INHERITED_ENV) {
    delete env[k]
  }
  env.PATH = buildAugmentedPath(env.PATH)

  if (opts.borrowedAuth) {
    if (opts.borrowedAuth.kind === 'anthropic') {
      delete env.ANTHROPIC_API_KEY
      env.ANTHROPIC_AUTH_TOKEN = opts.borrowedAuth.apiKey
      if (opts.borrowedAuth.baseUrl) {
        env.ANTHROPIC_BASE_URL = opts.borrowedAuth.baseUrl
      }
    } else {
      env.OPENAI_API_KEY = opts.borrowedAuth.apiKey
      if (opts.borrowedAuth.baseUrl) {
        env.OPENAI_BASE_URL = opts.borrowedAuth.baseUrl
      }
    }
  }

  if (opts.daemonEnv) {
    env.CJH_API_URL = opts.daemonEnv.apiUrl
    env.CJH_API_TOKEN = opts.daemonEnv.apiToken
  }

  if (opts.extraEnv) {
    for (const [k, v] of Object.entries(opts.extraEnv)) {
      if (k.trim()) env[k.trim()] = v
    }
  }

  delete env.CJH_MASTER_KEY_HEX
  delete env.CJH_LOCAL_TOKEN

  return env
}

export function prepareSafeSpawnPlan(opts: SpawnSafeOptions): {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: boolean
} {
  const env = buildCleanSubprocessEnv(opts)
  const rawArgs = opts.args || []
  const resolved = findExecutableInPath(opts.command, env.PATH) || opts.command

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const parsedShim = parseWindowsCmdShim(resolved)
    if (parsedShim) {
      const isElectronExec =
        parsedShim.nodeExecutable.toLowerCase() === process.execPath.toLowerCase() &&
        Boolean(process.versions.electron)
      if (isElectronExec) {
        env.ELECTRON_RUN_AS_NODE = '1'
      }
      return {
        executable: parsedShim.nodeExecutable,
        args: [parsedShim.scriptPath, ...rawArgs],
        env,
        windowsVerbatimArguments: false
      }
    }

    // Fallback for custom user .cmd/.bat wrapper scripts: invoke ComSpec safely with quoted verbatim block
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    const inner = [quoteWinCmdArg(resolved), ...rawArgs.map(quoteWinCmdArg)].join(' ')
    return {
      executable: comspec,
      args: ['/d', '/s', '/c', `"${inner}"`],
      env,
      windowsVerbatimArguments: true
    }
  }

  return {
    executable: resolved,
    args: rawArgs,
    env,
    windowsVerbatimArguments: false
  }
}

export function spawnSafeProcess(opts: SpawnSafeOptions): ChildProcess {
  const plan = prepareSafeSpawnPlan(opts)
  return spawn(plan.executable, plan.args, {
    cwd: opts.cwd || process.cwd(),
    env: plan.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments
  })
}

export function probeExecutableVersion(commandOrPath: string): string | null {
  try {
    const plan = prepareSafeSpawnPlan({ command: commandOrPath, args: ['--version'] })
    const res = spawnSync(plan.executable, plan.args, {
      env: plan.env,
      encoding: 'utf8',
      timeout: 5000,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments
    })
    const out = `${res.stdout || ''}\n${res.stderr || ''}`.trim()
    if (!out) return null
    const firstLine = out.split(/\r?\n/)[0].trim()
    return firstLine.slice(0, 80)
  } catch {
    return null
  }
}
