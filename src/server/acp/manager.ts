import { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { nanoid } from 'nanoid'
import {
  AcpCliInspectResult,
  AcpModeOption,
  ContextUsageDto,
  ModelDefinition,
  PendingPermissionRequestDto,
  PermissionOptionDto,
  ProviderDto,
  ThreadDto
} from '@shared/schemas'
import { AppDatabase, guessModelCapabilities } from '../db/database'
import { TaggedLogger } from '../logger'
import {
  clearCommandResolutionCache,
  findExecutableInPath,
  probeExecutableVersion,
  spawnSafeProcess
} from '../proc/spawner'

const ACP_INIT_TIMEOUT_MS = 60_000
const ACP_SESSION_TIMEOUT_MS = 60_000
const DEFAULT_ACP_SESSION_IDLE_MS = 30 * 60_000

const PRESET_PACKAGES: Record<
  string,
  { alias: string; npmPkg: string; extraArgs?: string[]; cliBinary?: string }
> = {
  claude: {
    alias: 'claude-agent-acp',
    npmPkg: '@agentclientprotocol/claude-agent-acp',
    cliBinary: 'claude'
  },
  codex: {
    alias: 'codex-acp',
    npmPkg: '@zed-industries/codex-acp',
    cliBinary: 'codex'
  },
  gemini: {
    alias: 'gemini',
    npmPkg: '@google/gemini-cli',
    extraArgs: ['--experimental-acp'],
    cliBinary: 'gemini'
  }
}

export interface AcpToolCallUpdatePatch {
  toolCallId: string
  status?: 'running' | 'completed' | 'failed'
  title?: string
  toolName?: string
  kind?: string
  input?: unknown
  output?: unknown
  isError?: boolean
}

export interface AcpTurnUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
}

export interface AcpStreamCallbacks {
  onTextDelta: (text: string) => void
  onReasoningDelta: (text: string) => void
  onToolCallStart: (
    toolCallId: string,
    toolName: string,
    title: string,
    input: unknown,
    kind?: string,
    status?: 'running' | 'completed' | 'failed'
  ) => void
  onToolCallUpdate: (patch: AcpToolCallUpdatePatch) => void
  onContextUsageUpdate?: (usage: ContextUsageDto) => void
  onModeUpdate?: (modeId: string, availableModes: AcpModeOption[]) => void
  onCommandsUpdate?: (commands: Array<{ name: string; description?: string }>) => void
}

export interface AcpPromptAttachment {
  fileName: string
  mimeType: string
  byteSize: number
  diskPath?: string
  fileUri?: string
  dataUrl?: string
}

export interface AcpManagerOptions {
  idleTimeoutMs?: number
  onThreadMetadataChanged?: (thread: ThreadDto) => void
  onModeUpdated?: (payload: {
    threadId: string
    providerId: string
    currentModeId: string
    availableModes: AcpModeOption[]
  }) => void
  onProviderModeDiscovered?: (provider: ProviderDto) => void
  onCommandsUpdated?: (payload: {
    threadId: string
    commands: Array<{ name: string; description?: string }>
  }) => void
}

interface JsonRpcPending {
  resolve: (val: any) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface ActiveAcpSession {
  key: string
  threadId: string | null
  providerId: string
  cwd: string
  mcpSignature: string
  child: ChildProcess
  sessionId: string
  availableModes: AcpModeOption[]
  currentModeId: string | null
  modeConfigOptionId: string | null
  commands: Array<{ name: string; description?: string }>
  currentCallbacks: AcpStreamCallbacks | null
  currentThreadId: string | null
  currentTurnToken: number
  activeTurnPromise: Promise<unknown> | null
  idleTimer: NodeJS.Timeout | null
  rpcIdCounter: number
  pendingRpc: Map<number, JsonRpcPending>
  disposed: boolean
  agentCapabilities?: {
    loadSession: boolean
    promptCapabilities: {
      image: boolean
      audio: boolean
      embeddedContext: boolean
    }
  }
}

interface PendingPermissionEntry {
  dto: PendingPermissionRequestDto
  resolve: (outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }) => void
  rejectOptionId: string | null
  timer: NodeJS.Timeout
}

function mapToolCallStatus(raw: unknown): 'running' | 'completed' | 'failed' | undefined {
  if (raw === undefined || raw === null) return undefined
  const s = String(raw).trim()
  if (!s) return undefined
  if (s === 'failed' || s === 'error' || s === 'cancelled') return 'failed'
  if (s === 'completed') return 'completed'
  if (s === 'in_progress' || s === 'pending' || s === 'running') return 'running'
  return undefined
}

function extractPromptUsage(res: any): AcpTurnUsage {
  const raw = res?.usage || res?._meta?.quota?.token_count
  if (!raw || typeof raw !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    }
  }
  const inputTokens = Number(raw.inputTokens ?? raw.input_tokens ?? 0) || 0
  const outputTokens = Number(raw.outputTokens ?? raw.output_tokens ?? 0) || 0
  const cachedInputTokens =
    Number(raw.cachedReadTokens ?? raw.cachedInputTokens ?? raw.cache_read_input_tokens ?? 0) || 0
  const reasoningTokens =
    Number(raw.thoughtTokens ?? raw.reasoningTokens ?? raw.reasoningOutputTokens ?? 0) || 0
  const rawTotal = raw.totalTokens ?? raw.total_tokens
  const totalTokens =
    typeof rawTotal === 'number' && Number.isFinite(rawTotal)
      ? rawTotal
      : inputTokens + outputTokens + reasoningTokens
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningTokens,
    totalTokens
  }
}

export class AcpAgentManager {
  private sessions = new Map<string, ActiveAcpSession>()
  private sessionsByAcpId = new Map<string, ActiveAcpSession>()
  private sessionInits = new Map<string, Promise<ActiveAcpSession>>()
  private pendingPermissions = new Map<string, PendingPermissionEntry>()
  private threadCommands = new Map<string, Array<{ name: string; description?: string }>>()
  private turnTokenCounter = 1
  private readonly idleTimeoutMs: number

  constructor(
    private db: AppDatabase,
    private logger: TaggedLogger,
    private daemonInfo: () => { apiUrl: string; apiToken: string },
    private onPermissionRequested: (dto: PendingPermissionRequestDto) => void,
    private onPermissionResolved: (payload: {
      requestId: string
      threadId: string
      outcome: string
    }) => void,
    private opts?: AcpManagerOptions
  ) {
    this.idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_ACP_SESSION_IDLE_MS
  }

  inspectCli(provider: ProviderDto, bypassCache = false): AcpCliInspectResult {
    if (bypassCache) clearCommandResolutionCache()

    if (provider.acpExecutablePath) {
      const ver = probeExecutableVersion(provider.acpExecutablePath)
      return {
        activeSource: 'explicit',
        resolvedPath: provider.acpExecutablePath,
        localVersion: ver,
        bundledVersion: null,
        checkedAt: Date.now()
      }
    }

    const preset = provider.acpPreset ? PRESET_PACKAGES[provider.acpPreset] : null
    const cmdName = provider.acpCommand || preset?.alias || ''
    const resolvedAdapter = cmdName ? findExecutableInPath(cmdName, undefined, bypassCache) : null

    const cliName = preset?.cliBinary
    const resolvedCli = cliName ? findExecutableInPath(cliName, undefined, bypassCache) : null
    const localVer = resolvedCli ? probeExecutableVersion(resolvedCli) : null

    if (resolvedAdapter) {
      return {
        activeSource: 'local',
        resolvedPath: resolvedAdapter,
        localVersion: localVer || probeExecutableVersion(resolvedAdapter),
        bundledVersion: null,
        checkedAt: Date.now()
      }
    }

    if (preset) {
      return {
        activeSource: 'npx',
        resolvedPath: resolvedCli,
        localVersion: localVer,
        bundledVersion: 'npx 按需拉取最新包',
        checkedAt: Date.now()
      }
    }

    return {
      activeSource: 'unknown',
      resolvedPath: null,
      localVersion: null,
      bundledVersion: null,
      checkedAt: Date.now()
    }
  }

  private resolveLaunchSpec(provider: ProviderDto): {
    command: string
    args: string[]
    extraEnv: Record<string, string>
    borrowedAuth: { kind: 'anthropic' | 'openai'; apiKey: string; baseUrl?: string | null } | null
  } {
    const preset = provider.acpPreset ? PRESET_PACKAGES[provider.acpPreset] : null
    const baseCmd = (provider.acpCommand || preset?.alias || '').trim()
    if (!baseCmd) {
      throw new Error(`ACP Provider "${provider.name}" 未配置启动命令`)
    }

    const extraEnv: Record<string, string> = { ...(provider.acpEnv || {}) }
    if (provider.acpExecutablePath && (provider.acpPreset === 'claude' || /claude/i.test(baseCmd))) {
      extraEnv.CLAUDE_CODE_EXECUTABLE = provider.acpExecutablePath
    }

    let borrowedAuth: {
      kind: 'anthropic' | 'openai'
      apiKey: string
      baseUrl?: string | null
    } | null = null

    if (provider.acpApiProviderId) {
      const targetProv = this.db.getProvider(provider.acpApiProviderId)
      const targetKey = this.db.getProviderSecretKey(provider.acpApiProviderId)
      if (targetProv && targetKey) {
        const isClaude =
          provider.acpPreset === 'claude' ||
          /claude/i.test(baseCmd) ||
          targetProv.apiFormat === 'anthropic' ||
          targetProv.type === 'anthropic'
        borrowedAuth = {
          kind: isClaude ? 'anthropic' : 'openai',
          apiKey: targetKey,
          baseUrl: targetProv.baseUrl
        }
      }
    }

    const inPath = findExecutableInPath(baseCmd)
    const userArgs = [...(preset?.extraArgs || []), ...(provider.acpArgs || [])]

    if (inPath) {
      return { command: inPath, args: userArgs, extraEnv, borrowedAuth }
    }

    if (preset) {
      return {
        command: 'npx',
        args: ['-y', preset.npmPkg, ...userArgs],
        extraEnv,
        borrowedAuth
      }
    }

    return { command: baseCmd, args: userArgs, extraEnv, borrowedAuth }
  }

  private clearIdleTimer(session: ActiveAcpSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
  }

  private scheduleIdleTimer(session: ActiveAcpSession): void {
    this.clearIdleTimer(session)
    if (session.disposed || !session.threadId || this.idleTimeoutMs <= 0) return
    const tid = session.threadId
    session.idleTimer = setTimeout(() => {
      if (session.disposed || session.currentCallbacks) return
      this.logger.info(
        `ACP:${session.providerId}`,
        `Idle timeout (${Math.round(this.idleTimeoutMs / 1000)}s) releasing ACP session ${session.sessionId} for thread ${tid}`
      )
      this.releaseThreadSession(tid, 'idle timeout')
    }, this.idleTimeoutMs)
    session.idleTimer.unref()
  }

  private createRpcSession(
    provider: ProviderDto,
    cwd: string,
    threadId: string | null,
    mcpSignature: string
  ): ActiveAcpSession {
    const spec = this.resolveLaunchSpec(provider)
    const daemonEnv = this.daemonInfo()
    this.logger.info(
      `ACP:${provider.id}`,
      `Spawning agent cmd="${spec.command}" args=${JSON.stringify(spec.args)} cwd="${cwd}" thread=${threadId || 'discovery'}`
    )

    const child = spawnSafeProcess({
      command: spec.command,
      args: spec.args,
      cwd,
      extraEnv: spec.extraEnv,
      borrowedAuth: spec.borrowedAuth,
      daemonEnv
    })

    const key = threadId || `discovery_${nanoid(6)}`
    const session: ActiveAcpSession = {
      key,
      threadId,
      providerId: provider.id,
      cwd,
      mcpSignature,
      child,
      sessionId: '',
      availableModes: [],
      currentModeId: null,
      modeConfigOptionId: null,
      commands: [],
      currentCallbacks: null,
      currentThreadId: null,
      currentTurnToken: 0,
      activeTurnPromise: null,
      idleTimer: null,
      rpcIdCounter: 1,
      pendingRpc: new Map(),
      disposed: false
    }

    if (child.stderr) {
      const errRl = createInterface({ input: child.stderr })
      errRl.on('line', line => {
        if (line.trim()) {
          this.logger.debug(`ACP:${provider.id}:stderr`, line)
        }
      })
    }

    if (child.stdout) {
      const outRl = createInterface({ input: child.stdout })
      outRl.on('line', line => {
        this.handleIncomingJsonRpcLine(session, line)
      })
    }

    child.on('exit', (code, signal) => {
      this.logger.info(
        `ACP:${provider.id}`,
        `Agent process exited code=${code} signal=${signal} thread=${threadId || 'discovery'}`
      )
      this.clearIdleTimer(session)
      session.disposed = true
      if (session.threadId && this.sessions.get(session.threadId) === session) {
        this.sessions.delete(session.threadId)
      }
      if (session.sessionId && this.sessionsByAcpId.get(session.sessionId) === session) {
        this.sessionsByAcpId.delete(session.sessionId)
      }
      for (const [, pending] of session.pendingRpc) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`ACP 进程已退出 (code=${code ?? 'null'})`))
      }
      session.pendingRpc.clear()
    })

    child.on('error', err => {
      this.logger.error(`ACP:${provider.id}`, 'Process error', err)
    })

    return session
  }

  private sendRpcRequest<T = any>(
    session: ActiveAcpSession,
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<T> {
    if (session.disposed || !session.child.stdin || session.child.stdin.destroyed) {
      return Promise.reject(new Error('ACP 进程未就绪或已关闭'))
    }
    const id = session.rpcIdCounter++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingRpc.delete(id)
        reject(new Error(`ACP 请求 "${method}" 超时 (${Math.round(timeoutMs / 1000)}s)`))
      }, timeoutMs)

      session.pendingRpc.set(id, { resolve, reject, timer })
      session.child.stdin!.write(payload, err => {
        if (err) {
          clearTimeout(timer)
          session.pendingRpc.delete(id)
          reject(err)
        }
      })
    })
  }

  private sendRpcResponse(session: ActiveAcpSession, id: number | string, result: unknown): void {
    if (session.disposed || !session.child.stdin || session.child.stdin.destroyed) return
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
    session.child.stdin.write(payload)
  }

  private sendRpcError(
    session: ActiveAcpSession,
    id: number | string,
    code: number,
    message: string
  ): void {
    if (session.disposed || !session.child.stdin || session.child.stdin.destroyed) return
    const payload = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'
    session.child.stdin.write(payload)
  }

  private handleIncomingJsonRpcLine(session: ActiveAcpSession, rawLine: string): void {
    const trimmed = rawLine.trim()
    if (!trimmed || !trimmed.startsWith('{')) return

    let msg: any
    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.logger.debug(`ACP:${session.providerId}`, `Ignored non-JSON stdout: ${trimmed.slice(0, 120)}`)
      return
    }

    // 1. Response to client-initiated request
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = session.pendingRpc.get(Number(msg.id))
      if (!pending) return
      clearTimeout(pending.timer)
      session.pendingRpc.delete(Number(msg.id))
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      } else {
        // Synchronously bind sessionId before subsequent lines in the same stdout chunk arrive
        if (typeof msg.result?.sessionId === 'string' && msg.result.sessionId.trim()) {
          session.sessionId = msg.result.sessionId.trim()
          this.sessionsByAcpId.set(session.sessionId, session)
        }
        pending.resolve(msg.result)
      }
      return
    }

    // 2. Agent-initiated RPC request (e.g. session/request_permission)
    if (msg.id !== undefined && typeof msg.method === 'string') {
      if (msg.method === 'session/request_permission') {
        this.handleAgentPermissionRequest(session, msg.id, msg.params)
        return
      }
      // Client intentionally declares no fs/terminal host execution; return JSON-RPC Method not found
      this.logger.warn(`ACP:${session.providerId}`, `Unsupported agent request: ${msg.method}`)
      this.sendRpcError(session, msg.id, -32601, `Unsupported client method: ${msg.method}`)
      return
    }

    // 3. Agent notification (no id) — Pitfall #7: NEVER throw on unknown notifications!
    if (typeof msg.method === 'string') {
      if (msg.method === 'session/update') {
        this.handleSessionUpdate(session, msg.params)
      } else {
        this.logger.debug(`ACP:${session.providerId}`, `Ignored notification: ${msg.method}`)
      }
    }
  }

  private resolveTargetSession(
    sourceSession: ActiveAcpSession,
    params: any
  ): ActiveAcpSession | null {
    const incomingSessionId =
      typeof params?.sessionId === 'string' && params.sessionId.trim()
        ? params.sessionId.trim()
        : null
    if (!incomingSessionId) {
      return sourceSession.disposed ? null : sourceSession
    }
    const mapped = this.sessionsByAcpId.get(incomingSessionId)
    if (mapped && !mapped.disposed) return mapped
    if (!sourceSession.disposed && (sourceSession.sessionId === incomingSessionId || !sourceSession.sessionId)) {
      return sourceSession
    }
    return null
  }

  private syncThreadModeState(
    session: ActiveAcpSession,
    nextModeId: string,
    availableModes?: AcpModeOption[]
  ): void {
    session.currentModeId = nextModeId
    if (availableModes && availableModes.length) {
      session.availableModes = availableModes
    }
    const tid = session.currentThreadId || session.threadId
    if (tid) {
      const updatedThread = this.db.updateThreadMetadata(tid, {
        acpMode: {
          currentModeId: nextModeId,
          availableModes: session.availableModes
        }
      })
      if (updatedThread) {
        this.opts?.onThreadMetadataChanged?.(updatedThread)
      }
      this.opts?.onModeUpdated?.({
        threadId: tid,
        providerId: session.providerId,
        currentModeId: nextModeId,
        availableModes: session.availableModes
      })
    }
    const updatedProv = this.db.updateProviderAcpModeInfo(
      session.providerId,
      session.availableModes,
      nextModeId
    )
    if (updatedProv) {
      this.opts?.onProviderModeDiscovered?.(updatedProv)
    }
    session.currentCallbacks?.onModeUpdate?.(nextModeId, session.availableModes)
  }

  private handleSessionUpdate(sourceSession: ActiveAcpSession, params: any): void {
    const session = this.resolveTargetSession(sourceSession, params)
    if (!session) return

    const update = params?.update || params
    if (!update || typeof update !== 'object') return

    const kind = update.sessionUpdate
    const cb = session.currentCallbacks

    if (kind === 'available_commands_update' && Array.isArray(update.availableCommands)) {
      session.commands = update.availableCommands.map((c: any) => ({
        name: String(c.name || ''),
        description: c.description ? String(c.description) : undefined
      }))
      const tid = session.currentThreadId || session.threadId
      if (tid) {
        this.threadCommands.set(tid, session.commands)
        this.opts?.onCommandsUpdated?.({ threadId: tid, commands: session.commands })
      }
      cb?.onCommandsUpdate?.(session.commands)
      return
    }

    if (kind === 'current_mode_update' && typeof update.currentModeId === 'string') {
      const nextModeId = update.currentModeId.trim()
      if (nextModeId) {
        this.logger.info(
          `ACP:${session.providerId}`,
          `Session ${session.sessionId} mode updated -> "${nextModeId}"`
        )
        this.syncThreadModeState(session, nextModeId)
      }
      return
    }

    if (kind === 'config_option_update' && Array.isArray(update.configOptions)) {
      const extracted = this.extractModeStateFromNewSession({ configOptions: update.configOptions })
      if (extracted.currentModeId) {
        this.logger.info(
          `ACP:${session.providerId}`,
          `Session ${session.sessionId} mode config option updated -> "${extracted.currentModeId}"`
        )
        this.syncThreadModeState(session, extracted.currentModeId, extracted.availableModes)
      }
      return
    }

    if (!cb) return

    switch (kind) {
      case 'agent_message_chunk': {
        const text = update.content?.text ?? update.text ?? ''
        if (text) cb.onTextDelta(String(text))
        break
      }
      case 'agent_thought_chunk': {
        const text = update.content?.text ?? update.text ?? ''
        if (text) cb.onReasoningDelta(String(text))
        break
      }
      case 'tool_call': {
        const toolCallId = String(update.toolCallId || nanoid(8))
        const title = String(update.title || update.name || update.kind || 'Tool')
        const toolName = String(update.name || update.kind || title)
        const kindVal = typeof update.kind === 'string' && update.kind ? update.kind : undefined
        const status = mapToolCallStatus(update.status) ?? 'running'
        const input = update.rawInput !== undefined ? update.rawInput : update.locations
        cb.onToolCallStart(toolCallId, toolName, title, input, kindVal, status)
        break
      }
      case 'tool_call_update': {
        const toolCallId = String(update.toolCallId || '')
        if (!toolCallId) break
        const status = mapToolCallStatus(update.status)
        const title =
          typeof update.title === 'string' && update.title.length > 0 ? update.title : undefined
        const kindVal =
          typeof update.kind === 'string' && update.kind.length > 0 ? update.kind : undefined
        const toolName =
          typeof update.name === 'string' && update.name.length > 0 ? update.name : kindVal
        const input =
          update.rawInput !== undefined && update.rawInput !== null ? update.rawInput : undefined
        const output =
          update.rawOutput !== undefined && update.rawOutput !== null
            ? update.rawOutput
            : update.content !== undefined && update.content !== null
              ? update.content
              : undefined
        const isError = status === 'failed' ? true : status === 'completed' ? false : undefined
        cb.onToolCallUpdate({
          toolCallId,
          ...(status !== undefined ? { status } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(toolName !== undefined ? { toolName } : {}),
          ...(kindVal !== undefined ? { kind: kindVal } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(isError !== undefined ? { isError } : {})
        })
        break
      }
      case 'usage_update': {
        // ACP UsageUpdate reports context window occupancy (used / size), NOT per-turn consumption
        const used = Number(update.used ?? 0)
        const size = Number(update.size ?? 0)
        if (Number.isFinite(used) || Number.isFinite(size)) {
          cb.onContextUsageUpdate?.({
            used: Number.isFinite(used) ? used : 0,
            size: Number.isFinite(size) ? size : 0,
            cost:
              update.cost && typeof update.cost === 'object'
                ? {
                    amount: Number(update.cost.amount || 0),
                    currency: String(update.cost.currency || 'USD')
                  }
                : null,
            updatedAt: Date.now()
          })
        }
        break
      }
      default:
        break
    }
  }

  /**
   * Fail-Closed Permission Gate:
   * Never auto-approves! If timeout expires or user rejects, resolves to reject option or cancelled.
   */
  private handleAgentPermissionRequest(
    sourceSession: ActiveAcpSession,
    rpcId: number | string,
    params: any
  ): void {
    const rawOptions: any[] = Array.isArray(params?.options) ? params.options : []
    const options: PermissionOptionDto[] = rawOptions.map(o => ({
      optionId: String(o.optionId || o.id || ''),
      name: String(o.name || o.optionId || '选项'),
      kind: String(o.kind || 'allow_once')
    }))

    const rejectOption = options.find(
      o => /reject|deny|cancel/i.test(o.kind) || /reject|拒绝/i.test(o.name)
    )
    const rejectOptionId = rejectOption?.optionId ?? null

    const session = this.resolveTargetSession(sourceSession, params)

    // If no active thread is bound, fail-closed immediately
    if (!session || !session.currentThreadId) {
      this.sendRpcResponse(sourceSession, rpcId, {
        outcome: rejectOptionId
          ? { outcome: 'selected', optionId: rejectOptionId }
          : { outcome: 'cancelled' }
      })
      return
    }

    const timeoutSec = this.db.getSettings().acp.permissionTimeoutSec || 60
    const requestId = `perm_${nanoid(10)}`
    const toolCall = params?.toolCall || {}
    const dto: PendingPermissionRequestDto = {
      requestId,
      threadId: session.currentThreadId,
      providerId: session.providerId,
      title: String(toolCall.title || '请求执行敏感操作'),
      toolName: String(toolCall.kind || toolCall.title || 'tool'),
      rawInput: toolCall.rawInput ?? toolCall.content ?? {},
      cwd: session.cwd,
      options,
      expiresAt: Date.now() + timeoutSec * 1000
    }

    const timer = setTimeout(() => {
      this.logger.warn(
        `ACP:${session.providerId}`,
        `Permission ${requestId} timed out after ${timeoutSec}s -> auto-rejecting (fail-closed)`
      )
      this.resolvePermission(requestId, rejectOptionId || '__cancel__')
    }, timeoutSec * 1000)

    this.pendingPermissions.set(requestId, {
      dto,
      rejectOptionId,
      timer,
      resolve: outcome => {
        this.sendRpcResponse(session, rpcId, { outcome })
      }
    })

    this.onPermissionRequested(dto)
  }

  resolvePermission(requestId: string, selectedOptionId: string): boolean {
    const entry = this.pendingPermissions.get(requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pendingPermissions.delete(requestId)

    if (selectedOptionId === '__cancel__' || selectedOptionId === '__reject__') {
      const outcome = entry.rejectOptionId
        ? ({ outcome: 'selected', optionId: entry.rejectOptionId } as const)
        : ({ outcome: 'cancelled' } as const)
      entry.resolve(outcome)
      this.onPermissionResolved({
        requestId,
        threadId: entry.dto.threadId,
        outcome: 'rejected'
      })
      return true
    }

    entry.resolve({ outcome: 'selected', optionId: selectedOptionId })
    this.onPermissionResolved({
      requestId,
      threadId: entry.dto.threadId,
      outcome: selectedOptionId
    })
    return true
  }

  getPendingPermissionsForThread(threadId: string): PendingPermissionRequestDto[] {
    const out: PendingPermissionRequestDto[] = []
    for (const entry of this.pendingPermissions.values()) {
      if (entry.dto.threadId === threadId) out.push(entry.dto)
    }
    return out
  }

  getThreadCommands(threadId: string): Array<{ name: string; description?: string }> {
    return this.threadCommands.get(threadId) || []
  }

  private extractModeStateFromNewSession(sessRes: any): {
    availableModes: AcpModeOption[]
    currentModeId: string | null
    hasModesField: boolean
    modeConfigOptionId: string | null
  } {
    const availableModes: AcpModeOption[] = []
    let currentModeId: string | null = null
    const hasModesField = Boolean(sessRes?.modes && typeof sessRes.modes === 'object')

    if (hasModesField) {
      if (typeof sessRes.modes.currentModeId === 'string' && sessRes.modes.currentModeId.trim()) {
        currentModeId = sessRes.modes.currentModeId.trim()
      }
      if (Array.isArray(sessRes.modes.availableModes)) {
        for (const m of sessRes.modes.availableModes) {
          const id = String(m?.id || '').trim()
          if (!id) continue
          availableModes.push({
            id,
            name: String(m.name || id),
            description: m.description ? String(m.description) : undefined
          })
        }
      }
    }

    let modeConfigOptionId: string | null = null
    if (Array.isArray(sessRes?.configOptions)) {
      const modeOpt = sessRes.configOptions.find(
        (o: any) => o?.id === 'mode' || o?.category === 'mode'
      )
      if (modeOpt) {
        modeConfigOptionId = String(modeOpt.id || 'mode')
        if (!currentModeId && typeof modeOpt.currentValue === 'string' && modeOpt.currentValue.trim()) {
          currentModeId = modeOpt.currentValue.trim()
        }
        if (!availableModes.length && Array.isArray(modeOpt.options)) {
          const rawOptions: any[] = modeOpt.options.flatMap((item: any) =>
            Array.isArray(item?.options) ? item.options : [item]
          )
          for (const opt of rawOptions) {
            const id = String(opt?.value || opt?.id || '').trim()
            if (!id) continue
            availableModes.push({
              id,
              name: String(opt.name || id),
              description: opt.description ? String(opt.description) : undefined
            })
          }
        }
      }
    }

    return { availableModes, currentModeId, hasModesField, modeConfigOptionId }
  }

  /**
   * Pitfalls #6, #8, #9:
   * - Two-stage 60s timeouts (initialize -> session/new)
   * - Reads both `configOptions[id==="model"]` AND legacy `models.availableModels`
   * - Preserves full `description` alongside model aliases
   */
  async discoverProviderModels(provider: ProviderDto): Promise<{
    models: ModelDefinition[]
    availableModes: AcpModeOption[]
    currentModeId: string | null
    agentInfo?: { name?: string; version?: string }
  }> {
    const session = this.createRpcSession(provider, process.cwd(), null, 'discovery')
    try {
      const initRes = await this.sendRpcRequest(
        session,
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'cjh', version: '0.1.0' }
        },
        ACP_INIT_TIMEOUT_MS
      )

      const sessRes = await this.sendRpcRequest(
        session,
        'session/new',
        {
          cwd: process.cwd(),
          mcpServers: []
        },
        ACP_SESSION_TIMEOUT_MS
      )

      const parsedModels = this.extractModelsFromNewSession(sessRes, provider.models)
      const modeInfo = this.extractModeStateFromNewSession(sessRes)
      return {
        models: parsedModels,
        availableModes: modeInfo.availableModes,
        currentModeId: modeInfo.currentModeId,
        agentInfo: initRes?.agentInfo
      }
    } finally {
      session.disposed = true
      session.child.kill()
    }
  }

  private extractModelsFromNewSession(
    sessRes: any,
    existingModels: ModelDefinition[]
  ): ModelDefinition[] {
    const existingById = new Map(existingModels.map(m => [m.id, m]))
    const out: ModelDefinition[] = []

    // 1. Modern ACP: configOptions where id === 'model' or category === 'model'
    if (Array.isArray(sessRes?.configOptions)) {
      const modelOpt = sessRes.configOptions.find(
        (o: any) => o?.id === 'model' || o?.category === 'model'
      )
      if (modelOpt) {
        const rawOptions: any[] = Array.isArray(modelOpt.options)
          ? modelOpt.options.flatMap((item: any) =>
              Array.isArray(item.options) ? item.options : [item]
            )
          : []
        for (const opt of rawOptions) {
          const id = String(opt.value || opt.id || '').trim()
          if (!id) continue
          const prev = existingById.get(id)
          const caps = prev?.capabilities || guessModelCapabilities(id)
          out.push({
            id,
            name: String(opt.name || id),
            description: opt.description ? String(opt.description) : undefined,
            enabled: prev ? prev.enabled : true,
            capabilities: caps,
            autoCapabilities: caps
          })
        }
      }
    }

    // 2. Legacy ACP fallback: models.availableModels
    if (!out.length && Array.isArray(sessRes?.models?.availableModels)) {
      for (const m of sessRes.models.availableModels) {
        const id = String(m.modelId || m.id || '').trim()
        if (!id) continue
        const prev = existingById.get(id)
        const caps = prev?.capabilities || guessModelCapabilities(id)
        out.push({
          id,
          name: String(m.name || id),
          description: m.description ? String(m.description) : undefined,
          enabled: prev ? prev.enabled : true,
          capabilities: caps,
          autoCapabilities: caps
        })
      }
    }

    return out
  }

  private async tryApplyModeViaConfigOption(
    session: ActiveAcpSession,
    configId: string,
    targetMode: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const cfgRes = await this.sendRpcRequest(
        session,
        'session/set_config_option',
        {
          sessionId: session.sessionId,
          configId,
          value: targetMode
        },
        15_000
      )
      const updatedOpt = Array.isArray(cfgRes?.configOptions)
        ? cfgRes.configOptions.find(
            (o: any) => o?.id === configId || o?.id === 'mode' || o?.category === 'mode'
          )
        : null
      const reportedValue =
        typeof updatedOpt?.currentValue === 'string' && updatedOpt.currentValue.trim()
          ? updatedOpt.currentValue.trim()
          : null

      if (reportedValue && reportedValue !== targetMode) {
        session.currentModeId = reportedValue
        return {
          ok: false,
          error: `session/set_config_option 返回当前模式 "${reportedValue}"，而非目标模式 "${targetMode}"`
        }
      }

      session.currentModeId = reportedValue || targetMode
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  private async enforceSessionPermissionMode(
    session: ActiveAcpSession,
    provider: ProviderDto,
    threadId: string,
    newSess: unknown,
    isLoadedSession = false,
    desiredModeOverride?: string | null
  ): Promise<{ effectiveMode: string }> {
    const modeInfo = this.extractModeStateFromNewSession(newSess)
    session.availableModes = modeInfo.availableModes
    session.currentModeId = modeInfo.currentModeId
    session.modeConfigOptionId = modeInfo.modeConfigOptionId

    const targetMode =
      (desiredModeOverride || provider.acpPermissionMode || 'default').trim() || 'default'
    const supportsModes =
      modeInfo.hasModesField ||
      Boolean(modeInfo.modeConfigOptionId) ||
      (isLoadedSession && (provider.acpAvailableModes?.length || 0) > 0)

    if (!supportsModes) {
      this.logger.warn(
        `ACP:${provider.id}`,
        `Agent session ${session.sessionId} (thread=${threadId}) does not advertise modes or mode config option; continuing without enforcing permission mode "${targetMode}"`
      )
      const effectiveMode = session.currentModeId || targetMode
      this.logger.info(
        `ACP:${provider.id}`,
        `Session ${session.sessionId} (thread=${threadId}) permission mode active="${effectiveMode}" (configured="${targetMode}", initial="${modeInfo.currentModeId || 'none'}", explicitSet=false)`
      )
      return { effectiveMode }
    }

    let appliedExplicitMode = false
    let lastError: string | undefined

    if (modeInfo.hasModesField || (isLoadedSession && (provider.acpAvailableModes?.length || 0) > 0)) {
      try {
        await this.sendRpcRequest(
          session,
          'session/set_mode',
          {
            sessionId: session.sessionId,
            modeId: targetMode
          },
          15_000
        )
        session.currentModeId = targetMode
        appliedExplicitMode = true
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (modeInfo.modeConfigOptionId) {
          const fallback = await this.tryApplyModeViaConfigOption(
            session,
            modeInfo.modeConfigOptionId,
            targetMode
          )
          if (fallback.ok) {
            appliedExplicitMode = true
            lastError = undefined
          } else {
            lastError = fallback.error || lastError
          }
        }
      }
    } else if (modeInfo.modeConfigOptionId) {
      const cfgAttempt = await this.tryApplyModeViaConfigOption(
        session,
        modeInfo.modeConfigOptionId,
        targetMode
      )
      if (cfgAttempt.ok) {
        appliedExplicitMode = true
      } else {
        lastError = cfgAttempt.error
      }
    }

    if (!appliedExplicitMode) {
      this.logger.warn(
        `ACP:${provider.id}`,
        `Failed to set permission mode "${targetMode}" on session ${session.sessionId}: ${lastError || 'unknown error'}`
      )

      const currentMode = session.currentModeId
      if (
        targetMode !== 'bypassPermissions' &&
        (!currentMode || currentMode === 'bypassPermissions')
      ) {
        const currentDesc = currentMode ? `当前模式为 ${currentMode}` : '当前模式未知'
        const detail = lastError ? `：${lastError}` : ''
        this.logger.error(
          `ACP:${provider.id}`,
          `Aborting session ${session.sessionId} (thread=${threadId}): failed to set permission mode "${targetMode}" (${currentDesc})${detail}`
        )
        this.releaseThreadSession(threadId, 'permission mode setup failed')
        throw new Error(
          `无法把 ACP 会话权限模式设为 ${targetMode}，为安全起见已中止（${currentDesc}${detail}）`
        )
      }
    }

    const effectiveMode = session.currentModeId || targetMode
    this.logger.info(
      `ACP:${provider.id}`,
      `Session ${session.sessionId} (thread=${threadId}) permission mode active="${effectiveMode}" (configured="${targetMode}", initial="${modeInfo.currentModeId || 'none'}", explicitSet=${appliedExplicitMode})`
    )
    return { effectiveMode }
  }

  private async getOrCreateThreadSession(
    threadId: string,
    provider: ProviderDto,
    cwd: string,
    mcpServersForAcp: Array<{
      name: string
      command: string
      args: string[]
      env: Array<{ name: string; value: string }>
    }>
  ): Promise<{ session: ActiveAcpSession; sessionStatus: 'reused' | 'loaded' | 'new' }> {
    const mcpSignature = JSON.stringify(mcpServersForAcp)

    const inFlight = this.sessionInits.get(threadId)
    if (inFlight) {
      await inFlight.catch(() => undefined)
    }

    const existing = this.sessions.get(threadId)
    if (existing && !existing.disposed && existing.sessionId) {
      if (
        existing.providerId === provider.id &&
        existing.cwd === cwd &&
        existing.mcpSignature === mcpSignature
      ) {
        return { session: existing, sessionStatus: 'reused' }
      }
      this.releaseThreadSession(threadId, 'provider/cwd/mcp changed')
    }

    let createdResumeMode: 'loaded' | 'new' = 'new'

    const initPromise = (async () => {
      const session = this.createRpcSession(provider, cwd, threadId, mcpSignature)
      try {
        const initRes = await this.sendRpcRequest(
          session,
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: 'cjh', version: '0.1.0' }
          },
          ACP_INIT_TIMEOUT_MS
        )

        const caps = initRes?.agentCapabilities || {}
        const promptCaps = caps.promptCapabilities || {}
        session.agentCapabilities = {
          loadSession: Boolean(caps.loadSession),
          promptCapabilities: {
            image: Boolean(promptCaps.image),
            audio: Boolean(promptCaps.audio),
            embeddedContext: Boolean(promptCaps.embeddedContext)
          }
        }

        const threadRecord = this.db.getThread(threadId)
        const meta = (threadRecord?.metadata || {}) as Record<string, unknown>
        const savedSessionId =
          typeof meta.acpSessionId === 'string' && meta.acpSessionId.trim()
            ? meta.acpSessionId.trim()
            : null
        const savedProviderId = typeof meta.acpProviderId === 'string' ? meta.acpProviderId : null
        const savedCwd = typeof meta.acpCwd === 'string' ? meta.acpCwd : null
        const canAttemptLoad =
          session.agentCapabilities.loadSession &&
          Boolean(savedSessionId) &&
          (!savedProviderId || savedProviderId === provider.id) &&
          (!savedCwd || savedCwd === cwd)

        let sessRes: any = null
        if (canAttemptLoad && savedSessionId) {
          try {
            session.sessionId = savedSessionId
            this.sessionsByAcpId.set(savedSessionId, session)
            sessRes = await this.sendRpcRequest(
              session,
              'session/load',
              {
                sessionId: savedSessionId,
                cwd,
                mcpServers: mcpServersForAcp
              },
              ACP_SESSION_TIMEOUT_MS
            )
            createdResumeMode = 'loaded'
            this.logger.info(
              `ACP:${provider.id}`,
              `Loaded ACP session ${savedSessionId} via session/load for thread ${threadId}`
            )
          } catch (loadErr) {
            if (this.sessionsByAcpId.get(savedSessionId) === session) {
              this.sessionsByAcpId.delete(savedSessionId)
            }
            session.sessionId = ''
            createdResumeMode = 'new'
            this.logger.warn(
              `ACP:${provider.id}`,
              `session/load failed for ${savedSessionId}, falling back to session/new: ${
                loadErr instanceof Error ? loadErr.message : String(loadErr)
              }`
            )
          }
        }

        if (createdResumeMode !== 'loaded') {
          sessRes = await this.sendRpcRequest(
            session,
            'session/new',
            {
              cwd,
              mcpServers: mcpServersForAcp
            },
            ACP_SESSION_TIMEOUT_MS
          )
          session.sessionId = String(sessRes.sessionId)
          this.sessionsByAcpId.set(session.sessionId, session)
        }

        this.sessions.set(threadId, session)

        const desiredModeOverride =
          typeof meta.acpDesiredModeId === 'string' && meta.acpDesiredModeId.trim()
            ? meta.acpDesiredModeId.trim()
            : null

        const { effectiveMode } = await this.enforceSessionPermissionMode(
          session,
          provider,
          threadId,
          sessRes,
          createdResumeMode === 'loaded',
          desiredModeOverride
        )

        const updatedThread = this.db.updateThreadMetadata(threadId, {
          acpSessionId: session.sessionId,
          acpProviderId: provider.id,
          acpCwd: cwd,
          acpLoadSessionSupported: session.agentCapabilities.loadSession,
          acpResumeMode: createdResumeMode === 'loaded' ? 'session_load' : 'new',
          acpMode: {
            currentModeId: effectiveMode,
            availableModes: session.availableModes
          }
        })
        if (updatedThread) {
          this.opts?.onThreadMetadataChanged?.(updatedThread)
        }
        this.opts?.onModeUpdated?.({
          threadId,
          providerId: provider.id,
          currentModeId: effectiveMode,
          availableModes: session.availableModes
        })

        const updatedProv = this.db.updateProviderAcpModeInfo(
          provider.id,
          session.availableModes,
          effectiveMode
        )
        if (updatedProv) {
          this.opts?.onProviderModeDiscovered?.(updatedProv)
        }

        this.scheduleIdleTimer(session)
        return session
      } catch (err) {
        if (this.sessions.get(threadId) === session) {
          this.releaseThreadSession(threadId, 'session init failed')
        } else {
          this.clearIdleTimer(session)
          if (session.sessionId && this.sessionsByAcpId.get(session.sessionId) === session) {
            this.sessionsByAcpId.delete(session.sessionId)
          }
          session.disposed = true
          session.child.kill()
        }
        throw err
      }
    })()

    this.sessionInits.set(threadId, initPromise)
    try {
      const session = await initPromise
      return { session, sessionStatus: createdResumeMode }
    } finally {
      if (this.sessionInits.get(threadId) === initPromise) {
        this.sessionInits.delete(threadId)
      }
    }
  }

  releaseThreadSession(threadId: string, reason = 'released'): boolean {
    for (const [reqId, entry] of [...this.pendingPermissions.entries()]) {
      if (entry.dto.threadId === threadId) {
        this.resolvePermission(reqId, '__cancel__')
      }
    }
    this.threadCommands.delete(threadId)

    const session = this.sessions.get(threadId)
    if (!session) return false

    this.clearIdleTimer(session)
    this.sessions.delete(threadId)
    if (session.sessionId && this.sessionsByAcpId.get(session.sessionId) === session) {
      this.sessionsByAcpId.delete(session.sessionId)
    }

    session.disposed = true
    for (const [, pending] of session.pendingRpc) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`ACP 会话已释放 (${reason})`))
    }
    session.pendingRpc.clear()
    session.child.kill()
    const shouldClearSavedSessionId =
      reason !== 'thread deleted' &&
      reason !== 'idle timeout' &&
      reason !== 'provider config updated'
    if (shouldClearSavedSessionId) {
      try {
        const updatedThread = this.db.updateThreadMetadata(threadId, {
          acpSessionId: undefined,
          acpProviderId: undefined,
          acpCwd: undefined,
          acpResumeMode: undefined,
          acpDesiredModeId: undefined,
          acpMode: undefined
        })
        if (updatedThread) {
          this.opts?.onThreadMetadataChanged?.(updatedThread)
        }
      } catch {
        // Ignore if DB already closed during shutdown
      }
    }
    this.logger.info(
      `ACP:${session.providerId}`,
      `Released ACP session ${session.sessionId || '(init)'} for thread ${threadId} (${reason})`
    )
    return true
  }

  releaseProviderSessions(providerId: string, reason = 'provider updated'): number {
    let count = 0
    for (const [threadId, session] of [...this.sessions.entries()]) {
      if (session.providerId === providerId) {
        if (this.releaseThreadSession(threadId, reason)) count++
      }
    }
    return count
  }

  getActiveThreadSessionInfo(threadId: string): {
    sessionId: string
    providerId: string
    cwd: string
    currentModeId: string | null
    availableModes: AcpModeOption[]
  } | null {
    const sess = this.sessions.get(threadId)
    if (!sess || sess.disposed) return null
    return {
      sessionId: sess.sessionId,
      providerId: sess.providerId,
      cwd: sess.cwd,
      currentModeId: sess.currentModeId,
      availableModes: sess.availableModes
    }
  }

  async setThreadMode(
    threadId: string,
    modeId: string,
    providerHint?: ProviderDto | null
  ): Promise<{
    currentModeId: string
    availableModes: AcpModeOption[]
    appliedLive: boolean
  }> {
    const targetMode = modeId.trim()
    if (!targetMode) {
      throw new Error('模式 ID 不能为空')
    }
    const thread = this.db.getThread(threadId)
    if (!thread) {
      throw new Error(`线程不存在 (${threadId})`)
    }

    const session = this.sessions.get(threadId)
    if (session && !session.disposed && session.sessionId) {
      let applied = false
      let lastError: string | undefined

      try {
        await this.sendRpcRequest(
          session,
          'session/set_mode',
          {
            sessionId: session.sessionId,
            modeId: targetMode
          },
          15_000
        )
        applied = true
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (session.modeConfigOptionId) {
          const cfgAttempt = await this.tryApplyModeViaConfigOption(
            session,
            session.modeConfigOptionId,
            targetMode
          )
          if (cfgAttempt.ok) {
            applied = true
          } else {
            lastError = cfgAttempt.error || lastError
          }
        }
      }

      if (!applied) {
        throw new Error(`切换 ACP 模式失败: ${lastError || 'Agent 拒绝变更'}`)
      }

      this.db.updateThreadMetadata(threadId, { acpDesiredModeId: targetMode })
      this.syncThreadModeState(session, targetMode)
      return {
        currentModeId: targetMode,
        availableModes: session.availableModes,
        appliedLive: true
      }
    }

    // No live ACP process yet: store desired mode onto thread metadata for next session init
    const metaMode = (thread.metadata?.acpMode as { availableModes?: AcpModeOption[] } | undefined)
    const availableModes =
      metaMode?.availableModes && metaMode.availableModes.length
        ? metaMode.availableModes
        : providerHint?.acpAvailableModes || []
    const updatedThread = this.db.updateThreadMetadata(threadId, {
      acpDesiredModeId: targetMode,
      acpMode: {
        currentModeId: targetMode,
        availableModes
      }
    })
    if (updatedThread) {
      this.opts?.onThreadMetadataChanged?.(updatedThread)
    }
    this.opts?.onModeUpdated?.({
      threadId,
      providerId: providerHint?.id || String(thread.metadata?.acpProviderId || ''),
      currentModeId: targetMode,
      availableModes
    })
    return {
      currentModeId: targetMode,
      availableModes,
      appliedLive: false
    }
  }

  private isTextFile(mimeType: string, fileName: string): boolean {
    if (mimeType.startsWith('text/')) return true
    if (mimeType === 'application/json' || mimeType === 'application/xml' || mimeType === 'application/javascript') {
      return true
    }
    return /\.(txt|md|markdown|json|jsonc|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|sql|yaml|yml|toml|ini|conf|env|sh|bash|ps1|bat|cmd|css|scss|html|xml|svg|csv|log)$/i.test(
      fileName
    )
  }

  private buildAcpPromptBlocks(
    session: ActiveAcpSession,
    promptText: string,
    attachments: AcpPromptAttachment[]
  ): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = []
    if (promptText.trim() || attachments.length === 0) {
      blocks.push({ type: 'text', text: promptText })
    }

    const caps = session.agentCapabilities?.promptCapabilities
    const supportsImage = Boolean(caps?.image)
    const supportsEmbedded = Boolean(caps?.embeddedContext)

    for (const att of attachments) {
      const mime = att.mimeType || 'application/octet-stream'

      if (mime.startsWith('image/')) {
        let base64: string | null = null
        let resolvedMime = mime
        if (att.dataUrl && att.dataUrl.startsWith('data:')) {
          const commaIdx = att.dataUrl.indexOf(',')
          if (commaIdx > 0) {
            const header = att.dataUrl.slice(5, commaIdx)
            const mimeMatch = /^([^;]+)/.exec(header)
            if (mimeMatch?.[1]) resolvedMime = mimeMatch[1]
            base64 = att.dataUrl.slice(commaIdx + 1)
          }
        } else if (att.diskPath && existsSync(att.diskPath)) {
          base64 = readFileSync(att.diskPath).toString('base64')
        }

        if (supportsImage && base64) {
          blocks.push({
            type: 'image',
            data: base64,
            mimeType: resolvedMime,
            ...(att.fileUri ? { uri: att.fileUri } : {})
          })
          continue
        }
        if (att.fileUri) {
          blocks.push({
            type: 'resource_link',
            uri: att.fileUri,
            name: att.fileName,
            mimeType: resolvedMime,
            size: att.byteSize,
            ...(att.diskPath ? { description: att.diskPath } : {})
          })
          if (att.diskPath) {
            blocks.push({
              type: 'text',
              text: `[图片附件路径: ${att.diskPath}]`
            })
          }
          continue
        }
      }

      if (this.isTextFile(mime, att.fileName) && att.diskPath && existsSync(att.diskPath)) {
        const rawBuf = readFileSync(att.diskPath)
        const maxInlineBytes = 512 * 1024
        if (rawBuf.byteLength <= maxInlineBytes) {
          const textContent = rawBuf.toString('utf8')
          if (supportsEmbedded && att.fileUri) {
            blocks.push({
              type: 'resource',
              resource: {
                uri: att.fileUri,
                mimeType: mime,
                text: textContent
              }
            })
          } else {
            blocks.push({
              type: 'text',
              text: `\n<file name="${att.fileName}" path="${att.diskPath}">\n${textContent}\n</file>\n`
            })
          }
          continue
        }
      }

      // Non-text binary or large file -> resource_link + local file path note
      if (att.fileUri) {
        blocks.push({
          type: 'resource_link',
          uri: att.fileUri,
          name: att.fileName,
          mimeType: mime,
          size: att.byteSize,
          ...(att.diskPath ? { description: att.diskPath } : {})
        })
      }
      if (att.diskPath) {
        blocks.push({
          type: 'text',
          text: `[附加文件本地路径: ${att.diskPath}]`
        })
      }
    }

    return blocks
  }

  async runPromptTurn(params: {
    threadId: string
    provider: ProviderDto
    modelId: string
    cwd: string
    promptText: string
    attachments?: AcpPromptAttachment[]
    buildFallbackHistoryContext?: () => string | null
    mcpServersForAcp: Array<{
      name: string
      command: string
      args: string[]
      env: Array<{ name: string; value: string }>
    }>
    callbacks: AcpStreamCallbacks
    abortSignal: AbortSignal
  }): Promise<{ stopReason: string; usage: AcpTurnUsage }> {
    const { session, sessionStatus } = await this.getOrCreateThreadSession(
      params.threadId,
      params.provider,
      params.cwd,
      params.mcpServersForAcp
    )

    let effectivePromptText = params.promptText
    if (sessionStatus === 'new' && params.buildFallbackHistoryContext) {
      const historyContext = params.buildFallbackHistoryContext()
      if (historyContext) {
        effectivePromptText = `${historyContext}\n\n${effectivePromptText}`
        const updatedThread = this.db.updateThreadMetadata(params.threadId, {
          acpResumeMode: 'fallback_history'
        })
        if (updatedThread) {
          this.opts?.onThreadMetadataChanged?.(updatedThread)
        }
      }
    }

    // Serialize turns if a previous turn on the same thread is still settling after cancel
    if (session.activeTurnPromise) {
      await session.activeTurnPromise.catch(() => undefined)
    }

    this.clearIdleTimer(session)
    const turnToken = this.turnTokenCounter++
    session.currentTurnToken = turnToken
    session.currentThreadId = params.threadId
    session.currentCallbacks = params.callbacks
    if (session.commands.length) {
      this.threadCommands.set(params.threadId, session.commands)
    }

    // Best-effort switch model via set_config_option -> fallback set_model
    if (params.modelId) {
      await this.sendRpcRequest(
        session,
        'session/set_config_option',
        {
          sessionId: session.sessionId,
          configId: 'model',
          value: params.modelId
        },
        15_000
      ).catch(() =>
        this.sendRpcRequest(
          session,
          'session/set_model',
          {
            sessionId: session.sessionId,
            modelId: params.modelId
          },
          15_000
        ).catch(() => undefined)
      )
    }

    const onAbort = () => {
      if (!session.disposed && session.child.stdin && !session.child.stdin.destroyed) {
        const cancelNotice =
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/cancel',
            params: { sessionId: session.sessionId }
          }) + '\n'
        session.child.stdin.write(cancelNotice)
      }
    }
    params.abortSignal.addEventListener('abort', onAbort, { once: true })

    const promptBlocks = this.buildAcpPromptBlocks(
      session,
      effectivePromptText,
      params.attachments || []
    )

    const turnPromise = (async () => {
      const res = await this.sendRpcRequest(
        session,
        'session/prompt',
        {
          sessionId: session.sessionId,
          prompt: promptBlocks
        },
        30 * 60_000 // Coding agent turns can run up to 30m
      )
      return {
        stopReason: String(res?.stopReason || 'end_turn'),
        usage: extractPromptUsage(res)
      }
    })()

    session.activeTurnPromise = turnPromise

    try {
      return await turnPromise
    } finally {
      params.abortSignal.removeEventListener('abort', onAbort)
      if (session.activeTurnPromise === turnPromise) {
        session.activeTurnPromise = null
      }
      if (session.currentTurnToken === turnToken) {
        session.currentCallbacks = null
        session.currentThreadId = null
      }
      this.scheduleIdleTimer(session)
    }
  }

  disposeAll(): void {
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer)
      entry.resolve({ outcome: 'cancelled' })
    }
    this.pendingPermissions.clear()

    for (const [, sess] of this.sessions) {
      this.clearIdleTimer(sess)
      sess.disposed = true
      sess.child.kill()
    }
    this.sessions.clear()
    this.sessionsByAcpId.clear()
    this.sessionInits.clear()
  }
}
