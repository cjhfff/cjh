import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildCleanSubprocessEnv,
  findExecutableInPath,
  prepareSafeSpawnPlan
} from '../proc/spawner'

const DEFAULT_MAX_OUTPUT_BYTES = 30 * 1024

function killProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        timeout: 3000
      })
    } catch {
      // Fallback handled by caller
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Ignore already exited
      }
    }
  }
}

export async function executeShellCommand(opts: {
  command: string
  args?: string[]
  workspacePath: string | null | undefined
  timeoutSec?: number
  maxOutputBytes?: number
  abortSignal?: AbortSignal
  daemonEnv?: {
    apiUrl: string
    apiToken: string
  }
}): Promise<{
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  stdout: string
  stderr: string
}> {
  if (opts.abortSignal?.aborted) {
    const abortErr = new Error('已手动停止生成')
    abortErr.name = 'AbortError'
    throw abortErr
  }

  if (!opts.workspacePath || !opts.workspacePath.trim()) {
    throw new Error('请先为该线程绑定工作目录')
  }
  const cwd = resolve(opts.workspacePath)
  if (!existsSync(cwd)) {
    throw new Error(`绑定的工作目录不存在: ${opts.workspacePath}`)
  }

  const commandStr = opts.command.trim()
  if (!commandStr) {
    throw new Error('执行命令不能为空')
  }

  const timeoutMs = Math.min(600, Math.max(1, opts.timeoutSec ?? 120)) * 1000
  const maxBytes = Math.max(1024, opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)

  let executable: string
  let spawnArgs: string[]
  let env: NodeJS.ProcessEnv
  let windowsVerbatimArguments = false

  if (Array.isArray(opts.args) && opts.args.length > 0) {
    const probeEnv = buildCleanSubprocessEnv({
      command: commandStr,
      cwd,
      daemonEnv: opts.daemonEnv
    })
    const directExe =
      findExecutableInPath(commandStr, probeEnv.PATH) ||
      ((commandStr.includes('/') || commandStr.includes('\\')) &&
      existsSync(resolve(cwd, commandStr))
        ? resolve(cwd, commandStr)
        : null)

    if (directExe || process.platform !== 'win32') {
      const plan = prepareSafeSpawnPlan({
        command: directExe || commandStr,
        args: opts.args,
        cwd,
        daemonEnv: opts.daemonEnv
      })
      executable = plan.executable
      spawnArgs = plan.args
      env = plan.env
      windowsVerbatimArguments = plan.windowsVerbatimArguments
    } else {
      // PowerShell cmdlet / builtin with structured args array (no unsafe shell string interpolation)
      executable = 'powershell.exe'
      const safeCmdToken = /^[A-Za-z][A-Za-z0-9_.-]*$/.test(commandStr) ? commandStr : '& $c'
      const argTokens = opts.args.map((arg, idx) =>
        /^-[A-Za-z][A-Za-z0-9_-]*$/.test(arg) ? arg : `$a[${idx}]`
      )
      const psBridgeScript = [
        '$c = $env:CJH_PS_CMD',
        '$a = @((ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CJH_PS_ARGS_B64)))).items)',
        'Remove-Item Env:CJH_PS_CMD,Env:CJH_PS_ARGS_B64 -EA SilentlyContinue',
        `${safeCmdToken} ${argTokens.join(' ')}`
      ].join('; ')
      spawnArgs = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        psBridgeScript
      ]
      env = {
        ...probeEnv,
        CJH_PS_CMD: commandStr,
        CJH_PS_ARGS_B64: Buffer.from(JSON.stringify({ items: opts.args }), 'utf8').toString(
          'base64'
        )
      }
    }
  } else if (process.platform === 'win32') {
    executable = 'powershell.exe'
    spawnArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      commandStr
    ]
    env = buildCleanSubprocessEnv({
      command: executable,
      cwd,
      daemonEnv: opts.daemonEnv
    })
  } else {
    executable = 'sh'
    spawnArgs = ['-c', commandStr]
    env = buildCleanSubprocessEnv({
      command: executable,
      cwd,
      daemonEnv: opts.daemonEnv
    })
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, spawnArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const appendChunk = (target: Buffer[], chunk: Buffer) => {
      if (totalBytes >= maxBytes) {
        truncated = true
        return
      }
      const remaining = maxBytes - totalBytes
      if (chunk.byteLength > remaining) {
        target.push(chunk.subarray(0, remaining))
        totalBytes += remaining
        truncated = true
      } else {
        target.push(chunk)
        totalBytes += chunk.byteLength
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdoutChunks, chunk))
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderrChunks, chunk))

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid)
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore
      }
    }, timeoutMs)
    timer.unref?.()

    const onAbort = () => {
      killProcessTree(child.pid)
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore
      }
    }
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      clearTimeout(timer)
      opts.abortSignal?.removeEventListener('abort', onAbort)
    }

    child.on('error', err => {
      if (settled) return
      settled = true
      cleanup()
      rejectPromise(err)
    })

    child.on('close', code => {
      if (settled) return
      settled = true
      cleanup()
      let stdout = Buffer.concat(stdoutChunks).toString('utf8')
      let stderr = Buffer.concat(stderrChunks).toString('utf8')
      if (truncated) {
        const notice = '\n...(输出已超过 30KB，已截断)'
        if (stdout.length >= stderr.length) stdout += notice
        else stderr += notice
      }
      resolvePromise({
        exitCode: code,
        timedOut,
        truncated,
        stdout,
        stderr
      })
    })
  })
}
