/**
 * Herdr Core (`herdr-core.exe connect`) Dual-Connection JSON-RPC 2.0 Client.
 *
 * Verified wire protocol for `herdr-core.exe connect` (v0.1.21, plain mode):
 * - Transport: newline-delimited JSON-RPC 2.0 over stdio (`\n`-terminated JSON lines),
 *   initiated by `hello` with `{ generation: 1, framed: false }`.
 * - Critical constraint from `herdr-schema.json` (`SubscribeResult.channel`):
 *   In plain mode (`framed: false`), once `events.subscribe` is called on a connection,
 *   that connection carries ONLY server notifications (`event`, `heartbeat`, `missed`)
 *   and accepts NO further RPC calls.
 * - Therefore `HerdrClient` maintains TWO long-lived `herdr-core.exe connect` child processes:
 *   1. RPC connection: `hello({ generation: 1, framed: false })` -> `server.status` ->
 *      all request/response RPC calls matched by numeric `id`.
 *   2. Events subscription connection: `hello({ generation: 1, framed: false })` ->
 *      `events.subscribe({})` -> snapshots + live notification stream (`event`, `heartbeat`, `missed`).
 */

import { ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInterface, Interface as ReadlineInterface } from 'node:readline'
import {
  DEFAULT_HERDR_AGENT_COMMANDS,
  HERDR_WS_EVENTS,
  HerdrAnswerResult,
  HerdrClientLike,
  HerdrClientStatusDto,
  HerdrCoreInfo,
  HerdrForeground,
  HerdrInterruptResult,
  HerdrKeysResult,
  HerdrMachineView,
  HerdrPutResult,
  HerdrReadResult,
  HerdrRemoveResult,
  HerdrRunRequest,
  HerdrSendRequest,
  HerdrSendResult,
  HerdrStatus,
  HerdrTemplateInfo,
  HerdrTerminal,
  HerdrTerminalListResponseDto,
  HerdrTerminalTransitionEvent,
  HerdrWaitResult,
  HerdrWorkspaceGroupDto,
  HerdrWorkspaceListResponseDto
} from '@shared/herdr-types'
import { AppDatabase } from '../db/database'
import { TaggedLogger } from '../logger'
import {
  buildCleanSubprocessEnv,
  findExecutableInPath,
  prepareSafeSpawnPlan
} from '../proc/spawner'
import { WsHub } from '../ws-hub'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RECONNECT_BASE_MS = 1_000
const DEFAULT_RECONNECT_MAX_MS = 30_000
const DEFAULT_SELF_INITIATED_WINDOW_MS = 6_000

const KNOWN_SHELL_NAMES = new Set([
  'powershell',
  'pwsh',
  'cmd',
  'bash',
  'zsh',
  'sh',
  'fish',
  'nu',
  'xonsh',
  'elvish'
])

export class HerdrUnavailableError extends Error {
  readonly code = 'HERDR_UNAVAILABLE'
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'HerdrUnavailableError'
    this.reason = reason
  }
}

export class HerdrRpcError extends Error {
  readonly rpcCode: number
  readonly kind: string
  readonly hint?: string

  constructor(rpcCode: number, message: string, kind = 'rpc_error', hint?: string) {
    super(message)
    this.name = 'HerdrRpcError'
    this.rpcCode = rpcCode
    this.kind = kind
    this.hint = hint
  }
}

export interface HerdrClientOptions {
  execPathOverride?: string | null
  getFollower?: (address: string) => string | null
  requestTimeoutMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
}

interface PendingRpc {
  method: string
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface ManagedConnection {
  role: 'rpc' | 'events'
  child: ChildProcess
  stdoutRl: ReadlineInterface | null
  stderrRl: ReadlineInterface | null
  pending: Map<number, PendingRpc>
  nextId: number
  closing: boolean
}

function normalizeBinaryToken(raw: string): string {
  const base = basename(raw.trim()).toLowerCase()
  return base.replace(/\.(exe|cmd|bat|com)$/i, '')
}

function matchAgentToken(token: string): string | null {
  const norm = normalizeBinaryToken(token)
  if (!norm) return null
  if (norm === 'antigravity' || norm === 'agy') return 'agy'
  if (norm === 'codex' || norm === 'codex-acp') return 'codex'
  if (norm === 'claude' || norm === 'claude-code' || norm === 'claude-agent-acp') return 'claude'
  if (norm === 'pi') return 'pi'
  if (KNOWN_SHELL_NAMES.has(norm)) return 'shell'
  return null
}

export function deriveTerminalAgent(
  terminal: Pick<HerdrTerminal, 'status' | 'template' | 'foreground' | 'argv'>
): string | null {
  const app = terminal.status?.app?.trim()
  if (app) {
    const matched = matchAgentToken(app)
    if (matched) return matched
    return app.toLowerCase()
  }

  const tpl = terminal.template?.trim()
  if (tpl) {
    const matched = matchAgentToken(tpl)
    if (matched) return matched
    return tpl
  }

  const fgArgv = terminal.foreground?.argv || []
  for (const arg of fgArgv.slice(0, 3)) {
    const matched = matchAgentToken(arg)
    if (matched) return matched
  }
  if (terminal.foreground?.name) {
    const matched = matchAgentToken(terminal.foreground.name)
    if (matched) return matched
  }

  const argv = terminal.argv || []
  for (const arg of argv.slice(0, 3)) {
    const matched = matchAgentToken(arg)
    if (matched) return matched
  }

  if (argv.length === 0) return 'shell'
  return null
}

export function resolveAgentArgv(
  agent: string,
  customCommand?: string[],
  settingsAgentCommands?: Record<string, string[]>
): string[] {
  if (customCommand && customCommand.length > 0) {
    return [...customCommand]
  }
  const key = agent.trim()
  if (settingsAgentCommands && settingsAgentCommands[key]?.length) {
    return [...settingsAgentCommands[key]]
  }
  if (Object.prototype.hasOwnProperty.call(DEFAULT_HERDR_AGENT_COMMANDS, key)) {
    return [...DEFAULT_HERDR_AGENT_COMMANDS[key]]
  }
  return key ? [key] : []
}

export function resolveHerdrExecutablePath(opts?: {
  execPathOverride?: string | null
  settingsExecPath?: string | null
  platform?: NodeJS.Platform
  localAppData?: string
  homeDir?: string
  fileExists?: (path: string) => boolean
  findInPath?: (cmd: string) => string | null
}): { path: string | null; reason: string | null } {
  const fileExists = opts?.fileExists ?? existsSync

  if (opts?.execPathOverride !== undefined) {
    const override = opts.execPathOverride?.trim()
    if (override && fileExists(override)) {
      return { path: override, reason: null }
    }
    return {
      path: null,
      reason: override
        ? `指定的 herdr-core 路径不存在: ${override}`
        : '未找到 herdr-core 可执行文件'
    }
  }

  const configured = opts?.settingsExecPath?.trim()
  if (configured && fileExists(configured)) {
    return { path: configured, reason: null }
  }

  const platform = opts?.platform ?? process.platform
  if (platform === 'win32') {
    const localAppData =
      opts?.localAppData ||
      process.env.LOCALAPPDATA ||
      join(opts?.homeDir || homedir(), 'AppData', 'Local')
    const winDefault = join(localAppData, 'Programs', 'herdr-core', 'herdr-core.exe')
    if (fileExists(winDefault)) {
      return { path: winDefault, reason: null }
    }
  }

  const findInPath = opts?.findInPath ?? ((cmd: string) => findExecutableInPath(cmd))
  const fromPath = findInPath('herdr-core') || findInPath('hc')
  if (fromPath) {
    return { path: fromPath, reason: null }
  }

  return {
    path: null,
    reason: '未检测到 herdr-core (hc)，请安装 herdr-core 或在设置中填写可执行文件路径'
  }
}

export class HerdrClient implements HerdrClientLike {
  private rpcConn: ManagedConnection | null = null
  private eventsConn: ManagedConnection | null = null
  private terminalsMap = new Map<string, HerdrTerminal>()
  private transitionListeners = new Set<(evt: HerdrTerminalTransitionEvent) => void>()
  private selfInitiatedAt = new Map<string, number>()

  private disposed = false
  private started = false
  private startPromise: Promise<void> | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts = 0
  private lastSeq = 0
  private lastHeartbeatAt: number | null = null

  private available = false
  private connected = false
  private reconnecting = false
  private reason: string | null = '尚未连接到 herdr-core'
  private execPath: string | null = null
  private version: string | null = null
  private core: HerdrCoreInfo | null = null
  private liveCount = 0
  private finishedCount = 0
  private uptimeMs: number | null = null

  private readonly requestTimeoutMs: number
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number

  constructor(
    private db: AppDatabase,
    private logger: TaggedLogger,
    private wsHub: WsHub,
    private opts?: HerdrClientOptions
  ) {
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.reconnectBaseDelayMs = opts?.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMaxDelayMs = opts?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_MS
  }

  async start(): Promise<void> {
    if (this.disposed) return
    if (this.startPromise) return this.startPromise
    this.started = true
    this.startPromise = this.connectAll().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.started = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.teardownConnections(true)
    this.connected = false
    this.available = false
    this.reconnecting = false
    this.reason = '已停止'
  }

  getStatus(): HerdrClientStatusDto {
    return {
      available: this.available,
      connected: this.connected,
      reason: this.reason,
      execPath: this.execPath,
      version: this.version,
      core: this.core,
      live: this.liveCount,
      finished: this.finishedCount,
      uptimeMs: this.uptimeMs,
      reconnecting: this.reconnecting
    }
  }

  getSnapshot(): HerdrTerminal[] {
    return [...this.terminalsMap.values()].map(t => this.enrichTerminal(t))
  }

  getCachedTerminal(addressOrName: string): HerdrTerminal | null {
    const raw = this.findRawTerminal(addressOrName)
    return raw ? this.enrichTerminal(raw) : null
  }

  resolveCachedAddress(addressOrName: string): string | null {
    return this.findRawTerminal(addressOrName)?.address ?? null
  }

  // Raw snapshot lookup. Must not call enrichTerminal: enrichTerminal -> getFollower ->
  // follow.resolveAddress would otherwise recurse forever.
  private findRawTerminal(addressOrName: string): HerdrTerminal | null {
    const key = addressOrName.trim()
    if (!key) return null
    const direct = this.terminalsMap.get(key)
    if (direct) return direct

    let fallbackFinished: HerdrTerminal | null = null
    for (const term of this.terminalsMap.values()) {
      if (term.name === key) {
        if (term.state === 'live') return term
        fallbackFinished = term
      }
    }
    return fallbackFinished
  }

  onTransition(listener: (evt: HerdrTerminalTransitionEvent) => void): () => void {
    this.transitionListeners.add(listener)
    return () => {
      this.transitionListeners.delete(listener)
    }
  }

  markSelfInitiated(address: string): void {
    const key = address.trim()
    if (!key) return
    const now = Date.now()
    this.selfInitiatedAt.set(key, now)
    const cached = this.getCachedTerminal(key)
    if (cached && cached.address !== key) {
      this.selfInitiatedAt.set(cached.address, now)
    }
  }

  wasRecentlySelfInitiated(
    address: string,
    windowMs = DEFAULT_SELF_INITIATED_WINDOW_MS
  ): boolean {
    const ts = this.selfInitiatedAt.get(address)
    if (ts === undefined) return false
    if (Date.now() - ts <= windowMs) return true
    this.selfInitiatedAt.delete(address)
    return false
  }

  async listTerminals(opts?: {
    all?: boolean
    labels?: Record<string, string>
  }): Promise<HerdrTerminalListResponseDto> {
    if (!this.connected || !this.rpcConn) {
      return {
        available: false,
        reason: this.reason || 'herdr-core 未连接',
        terminals: [],
        hiddenFinished: 0,
        machines: []
      }
    }

    const res = await this.callRpc<{
      terminals?: HerdrTerminal[]
      hidden_finished?: number
      machines?: HerdrMachineView[]
    }>('terminal.list', {
      all: Boolean(opts?.all),
      ...(opts?.labels && Object.keys(opts.labels).length > 0 ? { labels: opts.labels } : {})
    })

    const enriched = (res.terminals || []).map(t => this.enrichTerminal(t))
    for (const t of enriched) {
      this.terminalsMap.set(t.address, t)
    }
    this.recomputeCounts()

    return {
      available: true,
      reason: null,
      terminals: enriched,
      hiddenFinished: res.hidden_finished ?? 0,
      machines: res.machines ?? []
    }
  }

  async listWorkspaces(all = false): Promise<HerdrWorkspaceListResponseDto> {
    const listRes = await this.listTerminals({ all })
    if (!listRes.available) {
      return {
        available: false,
        reason: listRes.reason ?? null,
        workspaces: []
      }
    }

    const groups = new Map<string, HerdrWorkspaceGroupDto>()
    for (const term of listRes.terminals) {
      const cwd = (term.foreground?.cwd || term.cwd || '').trim()
      let group = groups.get(cwd)
      if (!group) {
        const name = cwd ? basename(cwd) || cwd : '默认工作区'
        group = {
          cwd,
          name,
          terminals: [],
          liveCount: 0,
          workingCount: 0,
          blockedCount: 0
        }
        groups.set(cwd, group)
      }
      group.terminals.push(term)
      if (term.state === 'live') {
        group.liveCount++
        if (term.status?.state === 'working') group.workingCount++
        if (term.status?.state === 'blocked') group.blockedCount++
      }
    }

    const workspaces = [...groups.values()].sort(
      (a, b) => b.liveCount - a.liveCount || a.name.localeCompare(b.name)
    )
    return {
      available: true,
      reason: null,
      workspaces
    }
  }

  async getTerminal(terminal: string): Promise<HerdrTerminal> {
    const raw = await this.callRpc<HerdrTerminal>('terminal.get', { terminal })
    const enriched = this.enrichTerminal(raw)
    this.terminalsMap.set(enriched.address, enriched)
    this.recomputeCounts()
    return enriched
  }

  async readTerminal(terminal: string, lines = 0): Promise<HerdrReadResult> {
    return this.callRpc<HerdrReadResult>('terminal.read', {
      terminal,
      lines: Math.max(0, Math.floor(lines))
    })
  }

  async runTerminal(
    input: Partial<HerdrRunRequest> & { agent?: string }
  ): Promise<HerdrTerminal> {
    const settings = this.db.getSettings()
    const agent = (input.agent || 'shell').trim()
    const baseArgv = resolveAgentArgv(agent, input.command, settings.herdr.agentCommands)

    const params: Record<string, unknown> = {
      wait: false,
      labels: {
        ...(input.labels || {}),
        cjh: '1'
      }
    }

    if (input.cwd) params.cwd = input.cwd
    if (input.name) params.name = input.name
    if (input.on) params.on = input.on
    if (input.size) params.size = input.size

    if (input.line) {
      params.line = input.line
    } else if (agent === 'shell' && baseArgv.length === 0) {
      if (input.task) {
        params.line = input.task
      }
    } else {
      const argv = [...baseArgv]
      if (input.task) {
        if (agent === 'agy' && !argv.includes('-i')) {
          argv.push('-i', input.task)
        } else {
          argv.push(input.task)
        }
      }
      if (argv.length > 0) {
        params.argv = argv
      }
    }

    const raw = await this.callRpc<HerdrTerminal>('terminal.run', params)
    this.markSelfInitiated(raw.address)
    const enriched = this.enrichTerminal(raw)
    this.terminalsMap.set(enriched.address, enriched)
    this.recomputeCounts()
    return enriched
  }

  async sendTerminal(
    terminal: string,
    input: Partial<HerdrSendRequest> & { text: string }
  ): Promise<HerdrSendResult> {
    this.markSelfInitiated(terminal)
    const timeoutMs = input.wait
      ? ((input.timeout ?? 180) + 15) * 1000
      : this.requestTimeoutMs
    const params: Record<string, unknown> = {
      terminal,
      text: input.text,
      force: Boolean(input.force),
      wait: Boolean(input.wait)
    }
    if (input.if) params.if = input.if
    if (input.timeout !== undefined) params.timeout = input.timeout

    return this.callRpc<HerdrSendResult>('terminal.send', params, timeoutMs)
  }

  async keysTerminal(terminal: string, keys: string[]): Promise<HerdrKeysResult> {
    return this.callRpc<HerdrKeysResult>('terminal.keys', { terminal, keys })
  }

  async interruptTerminal(terminal: string, timeout?: number): Promise<HerdrInterruptResult> {
    const timeoutMs =
      timeout !== undefined ? Math.max(this.requestTimeoutMs, (timeout + 10) * 1000) : this.requestTimeoutMs
    return this.callRpc<HerdrInterruptResult>(
      'terminal.interrupt',
      {
        terminal,
        ...(timeout !== undefined ? { timeout } : {})
      },
      timeoutMs
    )
  }

  async answerTerminal(
    terminal: string,
    input: { choice?: number | string; text?: string; useArrows?: boolean }
  ): Promise<HerdrAnswerResult> {
    if (input.choice !== undefined) {
      const rawChoice = input.choice
      const numeric =
        typeof rawChoice === 'number'
          ? rawChoice
          : /^\d+$/.test(String(rawChoice).trim())
            ? Number(String(rawChoice).trim())
            : null

      let keys: string[]
      if (numeric !== null && Number.isInteger(numeric) && numeric >= 1 && numeric <= 99) {
        keys = input.useArrows
          ? [...Array(numeric - 1).fill('down'), 'enter']
          : [String(numeric), 'enter']
      } else {
        keys = [String(rawChoice), 'enter']
      }

      const result = await this.keysTerminal(terminal, keys)
      return { ok: true, mode: 'keys', keys, result }
    }

    if (input.text !== undefined) {
      const result = await this.sendTerminal(terminal, {
        text: input.text,
        force: true
      })
      return { ok: true, mode: 'send', result }
    }

    throw new HerdrRpcError(-32602, '必须提供 choice 或 text 参数', 'invalid_params')
  }

  async waitTerminal(
    terminal: string,
    opts?: { timeout?: number; output?: string }
  ): Promise<HerdrWaitResult> {
    const timeoutMs = ((opts?.timeout ?? 180) + 15) * 1000
    const params: Record<string, unknown> = { terminal }
    if (opts?.timeout !== undefined) params.timeout = opts.timeout
    if (opts?.output !== undefined) params.output = opts.output
    return this.callRpc<HerdrWaitResult>('terminal.wait', params, timeoutMs)
  }

  async killTerminal(terminal: string): Promise<HerdrTerminal> {
    const raw = await this.callRpc<HerdrTerminal>('terminal.kill', { terminal })
    const enriched = this.enrichTerminal(raw)
    this.terminalsMap.set(enriched.address, enriched)
    this.recomputeCounts()
    return enriched
  }

  async rmTerminal(terminal: string): Promise<HerdrRemoveResult> {
    const res = await this.callRpc<HerdrRemoveResult>('terminal.rm', { terminal })
    const removedAddr = res.removed || terminal
    this.terminalsMap.delete(removedAddr)
    if (removedAddr !== terminal) {
      this.terminalsMap.delete(terminal)
    }
    this.recomputeCounts()
    return res
  }

  async labelTerminal(terminal: string, labels: Record<string, string>): Promise<HerdrTerminal> {
    const raw = await this.callRpc<HerdrTerminal>('terminal.label', { terminal, labels })
    const enriched = this.enrichTerminal(raw)
    this.terminalsMap.set(enriched.address, enriched)
    return enriched
  }

  async setMuted(
    terminal: string,
    muted: boolean
  ): Promise<{ terminal: HerdrTerminal; muted: boolean }> {
    const updated = await this.labelTerminal(terminal, {
      'cjh.mute': muted ? '1' : ''
    })
    const currentMuted = this.db.getSettings().herdr.mutedTerminals
    const nextSet = new Set(currentMuted)
    if (muted) {
      nextSet.add(updated.address)
    } else {
      nextSet.delete(updated.address)
      nextSet.delete(terminal)
    }
    this.db.updateSettings({
      herdr: {
        mutedTerminals: [...nextSet]
      }
    })
    const enriched = this.enrichTerminal(updated)
    this.terminalsMap.set(enriched.address, enriched)
    return { terminal: enriched, muted: Boolean(enriched.muted) }
  }

  async putFile(terminal: string, name: string, dataBase64: string): Promise<HerdrPutResult> {
    return this.callRpc<HerdrPutResult>('terminal.put', {
      terminal,
      name,
      data: dataBase64
    })
  }

  async listMachines(): Promise<HerdrMachineView[]> {
    const res = await this.callRpc<{ machines?: HerdrMachineView[] }>('machine.list', {})
    return res.machines ?? []
  }

  async listTemplates(): Promise<HerdrTemplateInfo[]> {
    const res = await this.callRpc<{ templates?: HerdrTemplateInfo[] }>('templates.list', {})
    return res.templates ?? []
  }

  // ==================== Internal Connection & Protocol Management ====================

  private spawnHerdrConnect(execPath: string, role: 'rpc' | 'events'): ManagedConnection {
    const env = buildCleanSubprocessEnv({ command: execPath })
    let child: ChildProcess

    const ext = extname(execPath).toLowerCase()
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      child = spawn(process.execPath, [execPath, 'connect'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      })
    } else if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
      const plan = prepareSafeSpawnPlan({ command: execPath, args: ['connect'] })
      child = spawn(plan.executable, plan.args, {
        env: plan.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments
      })
    } else {
      child = spawn(execPath, ['connect'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      })
    }

    const conn: ManagedConnection = {
      role,
      child,
      stdoutRl: null,
      stderrRl: null,
      pending: new Map(),
      nextId: 1,
      closing: false
    }

    if (child.stderr) {
      conn.stderrRl = createInterface({ input: child.stderr })
      conn.stderrRl.on('line', line => {
        if (line.trim()) {
          this.logger.debug(`Herdr:${role}:stderr`, line)
        }
      })
    }

    if (child.stdout) {
      conn.stdoutRl = createInterface({ input: child.stdout })
      conn.stdoutRl.on('line', line => {
        this.handleLine(conn, line)
      })
    }

    child.on('error', err => {
      this.logger.warn(`Herdr:${role}`, `Child process error: ${err.message}`)
      this.rejectAllPending(conn, new HerdrUnavailableError(`herdr-core 进程错误: ${err.message}`))
    })

    child.on('exit', (code, signal) => {
      this.rejectAllPending(
        conn,
        new HerdrUnavailableError(`herdr-core 连接已断开 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      )
      if (!conn.closing && !this.disposed) {
        this.handleUnexpectedDisconnect(role, code, signal)
      }
    })

    return conn
  }

  private async connectAll(): Promise<void> {
    if (this.disposed) return

    const settings = this.db.getSettings()
    const resolved = resolveHerdrExecutablePath({
      execPathOverride: this.opts?.execPathOverride,
      settingsExecPath: settings.herdr.execPath
    })

    this.execPath = resolved.path
    if (!resolved.path) {
      this.available = false
      this.connected = false
      this.reconnecting = false
      this.reason = resolved.reason
      this.logger.info('Herdr', resolved.reason || 'herdr-core unavailable')
      this.broadcastStatusChanged()
      return
    }

    this.teardownConnections(true)

    let rpcConn: ManagedConnection | null = null
    let eventsConn: ManagedConnection | null = null

    try {
      rpcConn = this.spawnHerdrConnect(resolved.path, 'rpc')
      eventsConn = this.spawnHerdrConnect(resolved.path, 'events')
      this.rpcConn = rpcConn
      this.eventsConn = eventsConn

      const [rpcHello, statusRes] = await (async () => {
        const hello = await this.sendOnConnection<{
          generation: number
          version: string
          core: HerdrCoreInfo
          framed: boolean
        }>(rpcConn, 'hello', { generation: 1, framed: false }, this.requestTimeoutMs)
        const status = await this.sendOnConnection<{
          core: HerdrCoreInfo
          version: string
          live: number
          finished: number
          uptime_ms: number
        }>(rpcConn, 'server.status', {}, this.requestTimeoutMs)
        return [hello, status] as const
      })()

      await this.sendOnConnection(
        eventsConn,
        'hello',
        { generation: 1, framed: false },
        this.requestTimeoutMs
      )

      const subRes = await this.sendOnConnection<{
        seq: number
        terminals: HerdrTerminal[]
      }>(eventsConn, 'events.subscribe', {}, this.requestTimeoutMs)

      if (this.disposed) {
        this.teardownConnections(true)
        return
      }

      this.version = statusRes.version || rpcHello.version || null
      this.core = statusRes.core || rpcHello.core || null
      this.uptimeMs = typeof statusRes.uptime_ms === 'number' ? statusRes.uptime_ms : null
      this.lastSeq = typeof subRes.seq === 'number' ? subRes.seq : 0

      this.applySnapshot(subRes.terminals || [])

      this.available = true
      this.connected = true
      this.reconnecting = false
      this.reason = null
      this.reconnectAttempts = 0

      this.logger.info(
        'Herdr',
        `Connected to herdr-core v${this.version || '?'} (${this.core?.name || 'local'}), terminals=${this.terminalsMap.size}`
      )
      this.broadcastStatusChanged()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn('Herdr', `Failed to connect to herdr-core: ${msg}`)
      this.teardownConnections(true)
      this.available = false
      this.connected = false
      this.reason = msg
      this.broadcastStatusChanged()
      if (!this.disposed && this.started) {
        this.scheduleReconnect()
      }
    }
  }

  private handleUnexpectedDisconnect(
    role: 'rpc' | 'events',
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const wasConnected = this.connected
    this.logger.warn(
      'Herdr',
      `${role} connection exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    )
    this.teardownConnections(true)
    this.available = false
    this.connected = false
    this.reason = `herdr-core ${role} 连接断开 (code=${code ?? 'null'})`
    if (wasConnected || !this.reconnecting) {
      this.scheduleReconnect()
    }
    this.broadcastStatusChanged()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    this.reconnecting = true
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts)
    )
    this.reconnectAttempts++
    this.logger.info('Herdr', `Scheduling reconnect #${this.reconnectAttempts} in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.disposed && this.started) {
        void this.connectAll()
      }
    }, delay)
    this.reconnectTimer.unref()
  }

  private teardownConnections(closing: boolean): void {
    for (const conn of [this.rpcConn, this.eventsConn]) {
      if (!conn) continue
      conn.closing = closing
      this.rejectAllPending(conn, new HerdrUnavailableError('herdr-core 连接已关闭'))
      try {
        conn.stdoutRl?.close()
      } catch {
        // ignore
      }
      try {
        conn.stderrRl?.close()
      } catch {
        // ignore
      }
      try {
        if (!conn.child.killed) {
          conn.child.kill()
        }
      } catch {
        // ignore
      }
    }
    this.rpcConn = null
    this.eventsConn = null
  }

  private rejectAllPending(conn: ManagedConnection, err: Error): void {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    conn.pending.clear()
  }

  private sendOnConnection<T = unknown>(
    conn: ManagedConnection,
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<T> {
    if (conn.closing || !conn.child.stdin || conn.child.stdin.destroyed) {
      return Promise.reject(new HerdrUnavailableError('herdr-core 连接未就绪'))
    }
    const id = conn.nextId++
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(new HerdrRpcError(-32000, `herdr RPC "${method}" 超时`, 'timeout'))
      }, timeoutMs)

      conn.pending.set(id, {
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer
      })

      conn.child.stdin!.write(line, err => {
        if (err) {
          clearTimeout(timer)
          conn.pending.delete(id)
          reject(new HerdrUnavailableError(`写入 herdr-core 失败: ${err.message}`))
        }
      })
    })
  }

  private callRpc<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    if (!this.connected || !this.rpcConn) {
      return Promise.reject(new HerdrUnavailableError(this.reason || 'herdr-core 不可用'))
    }
    return this.sendOnConnection<T>(this.rpcConn, method, params, timeoutMs)
  }

  private handleLine(conn: ManagedConnection, rawLine: string): void {
    const trimmed = rawLine.trim()
    if (!trimmed) return
    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.logger.debug(`Herdr:${conn.role}`, `Ignored non-JSON line: ${trimmed.slice(0, 120)}`)
      return
    }

    if (msg.id !== undefined && msg.method === undefined) {
      const id = Number(msg.id)
      const pending = conn.pending.get(id)
      if (!pending) return
      clearTimeout(pending.timer)
      conn.pending.delete(id)
      if (msg.error) {
        const kind = typeof msg.error?.data?.kind === 'string' ? msg.error.data.kind : 'rpc_error'
        const hint = typeof msg.error?.data?.hint === 'string' ? msg.error.data.hint : undefined
        pending.reject(
          new HerdrRpcError(
            Number(msg.error.code ?? -32000),
            String(msg.error.message || kind || 'herdr RPC error'),
            kind,
            hint
          )
        )
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (conn.role === 'events' && typeof msg.method === 'string') {
      this.handleEventsNotification(msg.method, msg.params)
    }
  }

  private handleEventsNotification(method: string, params: any): void {
    if (method === 'heartbeat') {
      this.lastHeartbeatAt = Date.now()
      return
    }

    if (method === 'missed') {
      if (typeof params?.seq === 'number') {
        this.lastSeq = params.seq
      }
      this.applySnapshot(Array.isArray(params?.terminals) ? params.terminals : [])
      this.broadcastStatusChanged()
      return
    }

    if (method !== 'event' || !params || typeof params !== 'object') {
      return
    }

    if (typeof params.seq === 'number') {
      if (params.seq <= this.lastSeq) return
      this.lastSeq = params.seq
    }

    const address = String(params.terminal || '')
    const type = String(params.type || '')
    const data = params.data
    const now = Date.now()

    switch (type) {
      case 'created': {
        const rawTerm = (data?.terminal ?? data) as HerdrTerminal | undefined
        if (!rawTerm || !rawTerm.address) break
        const prev = this.terminalsMap.get(rawTerm.address) || null
        const enriched = this.enrichTerminal(rawTerm)
        this.terminalsMap.set(enriched.address, enriched)
        this.recomputeCounts()
        this.emitTransition({
          type: 'created',
          address: enriched.address,
          terminal: enriched,
          prevTerminal: prev,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_CREATED, {
          address: enriched.address,
          terminal: enriched
        })
        break
      }

      case 'status': {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        const prevStatus = existing?.status ?? null

        let nextStatus: HerdrStatus | null = null
        let nextStatusMs: number | null = now
        if (data === null) {
          nextStatus = null
        } else if (typeof data === 'object' && 'status' in data) {
          nextStatus = (data.status as HerdrStatus | null) ?? null
          if (typeof data.status_ms === 'number') nextStatusMs = data.status_ms
        } else if (typeof data === 'object' && typeof data.state === 'string') {
          nextStatus = data as HerdrStatus
        }

        const updated = existing
          ? this.enrichTerminal({
              ...existing,
              status: nextStatus,
              status_ms: nextStatusMs,
              reported: existing.reported || nextStatus !== null
            })
          : undefined

        if (updated) {
          this.terminalsMap.set(address, updated)
        }

        const initiatedByCjh = this.wasRecentlySelfInitiated(address)
        this.emitTransition({
          type: 'status',
          address,
          terminal: updated,
          prevTerminal,
          prevStatus,
          status: nextStatus,
          initiatedByCjh,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_STATUS, {
          address,
          status: nextStatus,
          prevStatus,
          status_ms: nextStatusMs,
          terminal: updated ?? null
        })
        break
      }

      case 'turn': {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        const prevTurn = existing?.turn ?? 0
        const nextTurn =
          typeof data === 'number' ? data : typeof data?.turn === 'number' ? data.turn : prevTurn
        const updated = existing
          ? this.enrichTerminal({ ...existing, turn: nextTurn })
          : undefined
        if (updated) {
          this.terminalsMap.set(address, updated)
        }
        this.emitTransition({
          type: 'turn',
          address,
          terminal: updated,
          prevTerminal,
          prevTurn,
          turn: nextTurn,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_TURN, {
          address,
          turn: nextTurn,
          prevTurn,
          terminal: updated ?? null
        })
        break
      }

      case 'title': {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        const nextTitle =
          typeof data === 'string' ? data : typeof data?.title === 'string' ? data.title : ''
        const updated = existing
          ? this.enrichTerminal({ ...existing, title: nextTitle })
          : undefined
        if (updated) {
          this.terminalsMap.set(address, updated)
        }
        this.emitTransition({
          type: 'title',
          address,
          terminal: updated,
          prevTerminal,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_TITLE, {
          address,
          title: nextTitle,
          terminal: updated ?? null
        })
        break
      }

      case 'labels': {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        const rawLabels =
          data && typeof data === 'object' && 'labels' in data ? data.labels : data
        const nextLabels: Record<string, string> =
          rawLabels && typeof rawLabels === 'object' ? { ...rawLabels } : {}
        const updated = existing
          ? this.enrichTerminal({ ...existing, labels: nextLabels })
          : undefined
        if (updated) {
          this.terminalsMap.set(address, updated)
        }
        this.emitTransition({
          type: 'labels',
          address,
          terminal: updated,
          prevTerminal,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_LABELS, {
          address,
          labels: nextLabels,
          muted: Boolean(updated?.muted),
          terminal: updated ?? null
        })
        break
      }

      case 'foreground': {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        const nextFg: HerdrForeground | null =
          data && typeof data === 'object' && 'foreground' in data
            ? (data.foreground as HerdrForeground | null)
            : ((data as HerdrForeground | null) ?? null)
        const updated = existing
          ? this.enrichTerminal({ ...existing, foreground: nextFg })
          : undefined
        if (updated) {
          this.terminalsMap.set(address, updated)
        }
        this.emitTransition({
          type: 'foreground',
          address,
          terminal: updated,
          prevTerminal,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_FOREGROUND, {
          address,
          foreground: nextFg,
          terminal: updated ?? null
        })
        break
      }

      case 'finished': {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        const prevStatus = existing?.status ?? null
        const exitCode = typeof data?.exit_code === 'number' ? data.exit_code : null
        const finishedMs = typeof data?.finished_ms === 'number' ? data.finished_ms : now
        const finishReason = typeof data?.reason === 'string' ? data.reason : existing?.reason ?? null
        const signal = typeof data?.signal === 'number' ? data.signal : null

        const updated = existing
          ? this.enrichTerminal({
              ...existing,
              state: 'finished',
              exit_code: exitCode,
              finished_ms: finishedMs,
              reason: finishReason,
              signal,
              foreground: null,
              status: null
            })
          : undefined

        if (updated) {
          this.terminalsMap.set(address, updated)
        }
        this.recomputeCounts()

        this.emitTransition({
          type: 'finished',
          address,
          terminal: updated,
          prevTerminal,
          prevStatus,
          status: null,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_FINISHED, {
          address,
          exit_code: exitCode,
          finished_ms: finishedMs,
          reason: finishReason,
          signal,
          terminal: updated ?? null
        })
        break
      }

      case 'removed': {
        const prevTerminal = this.terminalsMap.get(address) || null
        this.terminalsMap.delete(address)
        this.recomputeCounts()
        this.emitTransition({
          type: 'removed',
          address,
          prevTerminal,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_REMOVED, {
          address,
          terminal: prevTerminal
        })
        break
      }

      default: {
        const existing = this.terminalsMap.get(address) || null
        const prevTerminal = existing ? { ...existing } : null
        let updated: HerdrTerminal | undefined
        if (existing) {
          const patch: Partial<HerdrTerminal> = {}
          if (type === 'size' && data && typeof data === 'object') {
            if (typeof data.cols === 'number') patch.cols = data.cols
            if (typeof data.rows === 'number') patch.rows = data.rows
          } else if (type === 'keep' && data && typeof data === 'object') {
            if (typeof data.keep === 'boolean') patch.keep = data.keep
          } else if (type === 'lost' && data && typeof data === 'object') {
            if (typeof data.reason === 'string') patch.reason = data.reason
          } else if (type === 'restarted' && data && typeof data === 'object') {
            if (typeof data.pid === 'number') patch.pid = data.pid
            if (typeof data.state === 'string') patch.state = data.state
          }
          updated = this.enrichTerminal({ ...existing, ...patch })
          this.terminalsMap.set(address, updated)
        }
        this.emitTransition({
          type: 'updated',
          address,
          terminal: updated,
          prevTerminal,
          timestamp: now
        })
        this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINAL_UPDATED, {
          address,
          eventType: type,
          terminal: updated ?? null
        })
        break
      }
    }
  }

  private applySnapshot(terminals: HerdrTerminal[]): void {
    this.terminalsMap.clear()
    for (const term of terminals) {
      if (term?.address) {
        this.terminalsMap.set(term.address, this.enrichTerminal(term))
      }
    }
    this.recomputeCounts()
    const snapshot = this.getSnapshot()
    this.emitTransition({
      type: 'snapshot',
      address: '*',
      timestamp: Date.now()
    })
    this.wsHub.broadcast(HERDR_WS_EVENTS.TERMINALS_SNAPSHOT, {
      terminals: snapshot
    })
  }

  private recomputeCounts(): void {
    let live = 0
    let finished = 0
    for (const term of this.terminalsMap.values()) {
      if (term.state === 'finished') finished++
      else live++
    }
    this.liveCount = live
    this.finishedCount = finished
  }

  private enrichTerminal(term: HerdrTerminal): HerdrTerminal {
    const mutedTerminals = this.db.getSettings().herdr.mutedTerminals
    const muted =
      term.labels?.['cjh.mute'] === '1' || mutedTerminals.includes(term.address)
    const agent = deriveTerminalAgent(term)
    const followedByThreadId = this.opts?.getFollower
      ? this.opts.getFollower(term.address)
      : term.followedByThreadId ?? null

    return {
      ...term,
      labels: term.labels ? { ...term.labels } : {},
      agent,
      muted,
      followedByThreadId
    }
  }

  private emitTransition(evt: HerdrTerminalTransitionEvent): void {
    for (const listener of [...this.transitionListeners]) {
      try {
        listener(evt)
      } catch (err) {
        this.logger.warn('Herdr', 'Transition listener error', err)
      }
    }
  }

  private broadcastStatusChanged(): void {
    this.wsHub.broadcast(HERDR_WS_EVENTS.STATUS_CHANGED, this.getStatus())
  }
}
