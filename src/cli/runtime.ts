import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolveAppPaths } from '../server/paths'

export class CliNotRunningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliNotRunningError'
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

export async function resolveCliTarget(): Promise<{ baseUrl: string; token: string }> {
  if (process.env.CJH_API_URL && process.env.CJH_API_TOKEN) {
    return {
      baseUrl: process.env.CJH_API_URL.replace(/\/+$/, ''),
      token: process.env.CJH_API_TOKEN
    }
  }

  const paths = resolveAppPaths()
  if (!existsSync(paths.runtimeJsonPath)) {
    throw new CliNotRunningError(`cjh 未运行 (${paths.runtimeJsonPath} 不存在)`)
  }

  let runtime: any
  try {
    runtime = JSON.parse(readFileSync(paths.runtimeJsonPath, 'utf8'))
  } catch {
    throw new CliNotRunningError(`cjh 未运行 (${paths.runtimeJsonPath} 解析失败)`)
  }

  const port = Number(runtime?.port)
  const token = typeof runtime?.token === 'string' ? runtime.token : ''
  const pid = typeof runtime?.pid === 'number' ? runtime.pid : null

  if (!Number.isInteger(port) || port <= 0 || !token) {
    throw new CliNotRunningError(`cjh 未运行 (runtime.json 缺少有效的 port/token)`)
  }

  if (pid !== null && !isPidAlive(pid)) {
    try {
      rmSync(paths.runtimeJsonPath, { force: true })
    } catch {
      // Ignore cleanup error
    }
    throw new CliNotRunningError(`cjh 未运行 (原进程 PID ${pid} 已退出)`)
  }

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    const healthRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000)
    })
    if (!healthRes.ok) {
      throw new CliNotRunningError(`cjh 未运行 (/api/health 返回 HTTP ${healthRes.status})`)
    }
  } catch (err) {
    if (err instanceof CliNotRunningError) throw err
    try {
      rmSync(paths.runtimeJsonPath, { force: true })
    } catch {
      // Ignore cleanup error
    }
    throw new CliNotRunningError(`cjh 未运行 (无法连接到 ${baseUrl})`)
  }

  return { baseUrl, token }
}
