import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export interface PortableUpdateManifest {
  version: string
  url: string
  sha256?: string
  notes?: string
  publishedAt?: string
}

export interface PortableUpdateStatus {
  currentVersion: string
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error'
  latest?: PortableUpdateManifest | null
  error?: string | null
  stagedExtractDir?: string | null
  stagedZipPath?: string | null
  actualSha256?: string | null
  sha256Verified?: boolean
}

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
  }
  return 0
}

export class PortableUpdater {
  private status: PortableUpdateStatus

  constructor(
    private currentVersion: string,
    private stagingRoot: string
  ) {
    this.status = {
      currentVersion,
      state: 'idle',
      latest: null,
      error: null,
      stagedExtractDir: null
    }
  }

  getStatus(): PortableUpdateStatus {
    return { ...this.status }
  }

  async check(feedUrl: string): Promise<PortableUpdateStatus> {
    const cleanFeed = feedUrl.trim().replace(/\/+$/, '')
    if (!cleanFeed) {
      this.status = {
        ...this.status,
        state: 'error',
        error: '尚未配置免安装更新源地址 (例如 https://hk.example.com/cjh-updates)'
      }
      return this.getStatus()
    }

    this.status = { ...this.status, state: 'checking', error: null }
    try {
      const manifestUrl = cleanFeed.endsWith('.json') ? cleanFeed : `${cleanFeed}/latest.json`
      const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) {
        throw new Error(`拉取 latest.json 失败 (HTTP ${res.status})`)
      }
      const manifest = (await res.json()) as PortableUpdateManifest
      if (!manifest.version || !manifest.url) {
        throw new Error('latest.json 缺少 version 或 url 字段')
      }

      if (compareSemver(manifest.version, this.currentVersion) > 0) {
        this.status = {
          currentVersion: this.currentVersion,
          state: 'available',
          latest: manifest,
          error: null
        }
      } else {
        this.status = {
          currentVersion: this.currentVersion,
          state: 'up-to-date',
          latest: manifest,
          error: null
        }
      }
      return this.getStatus()
    } catch (err) {
      this.status = {
        ...this.status,
        state: 'error',
        error: err instanceof Error ? err.message : String(err)
      }
      return this.getStatus()
    }
  }

  async downloadAndStage(): Promise<PortableUpdateStatus> {
    const manifest = this.status.latest
    if (!manifest) {
      throw new Error('请先检查更新')
    }
    this.status = { ...this.status, state: 'downloading', error: null }

    try {
      rmSync(this.stagingRoot, { recursive: true, force: true })
      mkdirSync(this.stagingRoot, { recursive: true })
      const zipPath = join(this.stagingRoot, `cjh-${manifest.version}.zip`)
      const extractDir = join(this.stagingRoot, 'extracted')

      const res = await fetch(manifest.url)
      if (!res.ok || !res.body) {
        throw new Error(`下载更新包失败 (HTTP ${res.status})`)
      }

      await pipeline(res.body as any, createWriteStream(zipPath))

      const actualSha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
      let sha256Verified = false
      if (manifest.sha256) {
        if (actualSha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
          throw new Error(`SHA-256 校验不匹配 (期望 ${manifest.sha256}，实际 ${actualSha256})`)
        }
        sha256Verified = true
      }

      if (process.platform === 'win32') {
        const ps = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`
          ],
          { windowsHide: true, timeout: 120_000 }
        )
        if (ps.status !== 0) {
          throw new Error(`解压绿色更新包失败: ${ps.stderr?.toString() || ''}`)
        }
      } else {
        mkdirSync(extractDir, { recursive: true })
      }

      this.status = {
        ...this.status,
        state: 'ready',
        stagedExtractDir: extractDir,
        stagedZipPath: zipPath,
        actualSha256,
        sha256Verified,
        error: null
      }
      return this.getStatus()
    } catch (err) {
      this.status = {
        ...this.status,
        state: 'error',
        error: err instanceof Error ? err.message : String(err)
      }
      return this.getStatus()
    }
  }

  verifyStagedAndPrepareInstall(): PortableUpdateStatus {
    const manifest = this.status.latest
    if (this.status.state !== 'ready' || !this.status.stagedExtractDir || !existsSync(this.status.stagedExtractDir)) {
      throw new Error('更新包尚未就绪，请先检查并下载更新')
    }
    if (manifest?.sha256 && this.status.stagedZipPath && existsSync(this.status.stagedZipPath)) {
      const actual = createHash('sha256').update(readFileSync(this.status.stagedZipPath)).digest('hex')
      if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
        throw new Error(`安装前 SHA-256 二次校验失败 (期望 ${manifest.sha256}，实际 ${actual})`)
      }
    }
    this.status = {
      ...this.status,
      state: 'installing',
      error: null
    }
    return this.getStatus()
  }

  /**
   * Launches a detached PowerShell swap script that waits for cjh.exe to exit,
   * replaces application files EXCEPT `./data` (preserving portable database & logs),
   * and restarts `cjh.exe`.
   */
  spawnAtomicSwapOnExit(appExePath: string, mainPid: number): boolean {
    if (process.platform !== 'win32' || !this.status.stagedExtractDir) return false
    if (!existsSync(this.status.stagedExtractDir)) return false

    const targetDir = dirname(appExePath)
    const scriptPath = join(this.stagingRoot, 'apply-portable-update.ps1')
    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
for ($i = 0; $i -lt 60; $i++) {
  if (-not (Get-Process -Id ${mainPid} -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
Get-ChildItem -LiteralPath '${this.status.stagedExtractDir.replace(/'/g, "''")}' | ForEach-Object {
  if ($_.Name -ne 'data') {
    Copy-Item -LiteralPath $_.FullName -Destination '${targetDir.replace(/'/g, "''")}' -Recurse -Force
  }
}
Start-Process -FilePath '${appExePath.replace(/'/g, "''")}'
`
    writeFileSync(scriptPath, psScript, 'utf8')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    return true
  }
}
