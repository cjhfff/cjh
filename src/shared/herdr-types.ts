import { z } from 'zod'

// ==================== Herdr Wire Types (aligned with herdr-schema.json v0.1.21) ====================

export type HerdrStatusState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
export type HerdrBlockedKind = 'permission' | 'question' | 'auth' | string

export interface HerdrStatus {
  state: HerdrStatusState | string
  app?: string
  kind?: HerdrBlockedKind | null
  msg?: string
  title?: string
  progress?: number | null
}

export interface HerdrForeground {
  pid: number
  name: string
  argv: string[]
  cwd: string
}

export interface HerdrFirstMessage {
  sent: boolean
  reason?: string | null
  started?: boolean | null
  turn?: number | null
}

export interface HerdrTerminal {
  address: string
  name?: string | null
  state: 'live' | 'finished' | string
  argv: string[]
  cwd: string
  cols: number
  rows: number
  created_ms: number
  finished_ms?: number | null
  exit_code?: number | null
  signal?: number | null
  reason?: string | null
  screen: string
  pid?: number | null
  parent?: string | null
  template?: string | null
  title?: string
  turn: number
  status?: HerdrStatus | null
  status_ms?: number | null
  records?: Record<string, HerdrStatus>
  reported?: boolean
  foreground?: HerdrForeground | null
  labels: Record<string, string>
  keep?: boolean
  rm?: boolean
  notify?: boolean
  die_with_parent?: boolean
  identity?: string
  first_message?: HerdrFirstMessage | null
  // Derived fields enriched by cjh server
  agent?: string | null
  muted?: boolean
  followedByThreadId?: string | null
}

export interface HerdrCoreInfo {
  id: string
  name: string
}

export interface HerdrHolderInfo {
  pid: number
  instance: string
  current: boolean
  terminals: number
}

export interface HerdrMachineView {
  name: string
  target: string
  id: string
  host: string
  version: string
  state: 'connecting' | 'connected' | 'needs_login' | 'unreachable' | string
  session?: string | null
  since_ms?: number | null
  why?: string | null
  via?: boolean
  temporary?: boolean
  keeps_running_after_logout?: boolean | null
  logout_linger_user?: string | null
}

export interface HerdrTemplateInfo {
  name: string
  description: string
  command: string
  error?: string | null
}

export interface HerdrReadResult {
  text: string
  complete: boolean
  how: 'screen' | 'history' | 'stitched' | string
  why?: string | null
}

export interface HerdrWaitResult {
  terminal: string
  ended: boolean
  reason: string
  turn: number
  status?: string | null
  exit_code?: number | null
  signal?: number | null
  from?: string | null
  children: HerdrWaitResult[]
}

export interface HerdrSendResult {
  turn: number
  started?: boolean | null
  status?: string | null
  wait?: HerdrWaitResult | null
}

export interface HerdrKeysResult {
  turn: number
  status?: string | null
}

export interface HerdrInterruptResult {
  outcome: 'stopped' | 'exited' | 'still_working' | 'unknown' | string
  key: string
}

export interface HerdrPutResult {
  path: string
  bytes: number
}

export interface HerdrRemoveResult {
  removed: string
}

export interface HerdrAnswerResult {
  ok: true
  mode: 'keys' | 'send'
  keys?: string[]
  result: HerdrKeysResult | HerdrSendResult
}

export interface HerdrClientStatusDto {
  available: boolean
  connected: boolean
  reason: string | null
  execPath: string | null
  version: string | null
  core: HerdrCoreInfo | null
  live: number
  finished: number
  uptimeMs: number | null
  reconnecting: boolean
}

export interface HerdrTerminalListResponseDto {
  available: boolean
  reason?: string | null
  terminals: HerdrTerminal[]
  hiddenFinished: number
  machines: HerdrMachineView[]
}

export interface HerdrWorkspaceGroupDto {
  cwd: string
  name: string
  terminals: HerdrTerminal[]
  liveCount: number
  workingCount: number
  blockedCount: number
}

export interface HerdrWorkspaceListResponseDto {
  available: boolean
  reason?: string | null
  workspaces: HerdrWorkspaceGroupDto[]
}

export interface HerdrFollowBindingDto {
  terminal: string
  threadId: string
  createdAt: number
  lastTurnNotified: number
}

export interface HerdrNotificationDto {
  id: string
  address: string
  terminalName: string
  agent: string | null
  cwd: string
  kind: 'blocked' | 'done' | 'error' | 'finished'
  title: string
  body: string
  blockedKind?: string | null
  screenTail?: string
  options?: Array<{ index: number; label: string }>
  timestamp: number
}

// ==================== Built-in Agent Command Defaults ====================

export const DEFAULT_HERDR_AGENT_COMMANDS: Record<string, string[]> = {
  agy: ['agy'],
  codex: ['codex', '--no-daemon'],
  claude: ['claude'],
  pi: ['pi'],
  shell: []
}

// ==================== WebSocket Event Names (R1 Contract) ====================

export const HERDR_WS_EVENTS = {
  STATUS_CHANGED: 'herdr_status_changed',
  TERMINALS_SNAPSHOT: 'herdr_terminals_snapshot',
  TERMINAL_CREATED: 'herdr_terminal_created',
  TERMINAL_STATUS: 'herdr_terminal_status',
  TERMINAL_TURN: 'herdr_terminal_turn',
  TERMINAL_TITLE: 'herdr_terminal_title',
  TERMINAL_LABELS: 'herdr_terminal_labels',
  TERMINAL_FOREGROUND: 'herdr_terminal_foreground',
  TERMINAL_FINISHED: 'herdr_terminal_finished',
  TERMINAL_REMOVED: 'herdr_terminal_removed',
  TERMINAL_UPDATED: 'herdr_terminal_updated',
  FOLLOW_UPDATED: 'herdr_follow_updated',
  NOTIFICATION: 'herdr_notification'
} as const

export type HerdrWsEventName = (typeof HERDR_WS_EVENTS)[keyof typeof HERDR_WS_EVENTS]

// ==================== Request Validation Schemas (Zod) ====================

export const HerdrRunRequestSchema = z.object({
  agent: z.string().min(1).default('shell'),
  command: z.array(z.string()).optional(),
  line: z.string().optional(),
  cwd: z.string().optional(),
  name: z
    .string()
    .regex(/^[a-z0-9._-]{1,32}$/, '终端名称仅允许 1-32 位小写字母、数字、-、_ 或 .')
    .optional(),
  task: z.string().optional(),
  labels: z.record(z.string(), z.string()).default({}),
  on: z.string().optional(),
  size: z
    .object({
      cols: z.number().int().min(1).max(65535),
      rows: z.number().int().min(1).max(65535)
    })
    .optional(),
  followThreadId: z.string().min(1).optional()
})
export type HerdrRunRequest = z.infer<typeof HerdrRunRequestSchema>

export const HerdrSendRequestSchema = z.object({
  text: z.string().min(1),
  force: z.boolean().default(false),
  if: z.enum(['idle', 'working']).optional(),
  wait: z.boolean().default(false),
  timeout: z.number().positive().max(600).optional(),
  followThreadId: z.string().min(1).optional()
})
export type HerdrSendRequest = z.infer<typeof HerdrSendRequestSchema>

export const HerdrKeysRequestSchema = z.object({
  keys: z.array(z.string().min(1)).min(1)
})
export type HerdrKeysRequest = z.infer<typeof HerdrKeysRequestSchema>

export const HerdrInterruptRequestSchema = z.object({
  timeout: z.number().positive().max(60).optional()
})
export type HerdrInterruptRequest = z.infer<typeof HerdrInterruptRequestSchema>

export const HerdrAnswerRequestSchema = z
  .object({
    choice: z.union([z.number().int().min(1).max(99), z.string().min(1)]).optional(),
    text: z.string().min(1).optional(),
    useArrows: z.boolean().default(false)
  })
  .refine(v => v.choice !== undefined || v.text !== undefined, {
    message: '必须提供 choice（选项号）或 text（作答文本）之一'
  })
export type HerdrAnswerRequest = z.infer<typeof HerdrAnswerRequestSchema>

export const HerdrLabelRequestSchema = z.object({
  labels: z.record(z.string(), z.string())
})
export type HerdrLabelRequest = z.infer<typeof HerdrLabelRequestSchema>

export const HerdrMuteRequestSchema = z.object({
  muted: z.boolean()
})
export type HerdrMuteRequest = z.infer<typeof HerdrMuteRequestSchema>

export const HerdrPutRequestSchema = z.object({
  name: z.string().min(1),
  data: z.string().min(1)
})
export type HerdrPutRequest = z.infer<typeof HerdrPutRequestSchema>

export const HerdrFollowRequestSchema = z.object({
  threadId: z.string().min(1)
})
export type HerdrFollowRequest = z.infer<typeof HerdrFollowRequestSchema>

// ==================== Internal Server Interfaces (shared across R1 / R3 / R4) ====================

export interface HerdrTerminalTransitionEvent {
  type:
    | 'snapshot'
    | 'created'
    | 'status'
    | 'turn'
    | 'title'
    | 'labels'
    | 'foreground'
    | 'finished'
    | 'removed'
    | 'updated'
  address: string
  terminal?: HerdrTerminal
  prevTerminal?: HerdrTerminal | null
  prevStatus?: HerdrStatus | null
  status?: HerdrStatus | null
  prevTurn?: number
  turn?: number
  initiatedByCjh?: boolean
  timestamp: number
}

export interface HerdrClientLike {
  start(): Promise<void>
  dispose(): Promise<void>
  getStatus(): HerdrClientStatusDto
  getSnapshot(): HerdrTerminal[]
  getCachedTerminal(addressOrName: string): HerdrTerminal | null
  /** Address for an address or name from the raw snapshot, without enrichment (safe to call from getFollower). */
  resolveCachedAddress?(addressOrName: string): string | null
  onTransition(listener: (evt: HerdrTerminalTransitionEvent) => void): () => void
  markSelfInitiated(address: string): void
  wasRecentlySelfInitiated(address: string, windowMs?: number): boolean
  listTerminals(opts?: {
    all?: boolean
    labels?: Record<string, string>
  }): Promise<HerdrTerminalListResponseDto>
  getTerminal(terminal: string): Promise<HerdrTerminal>
  readTerminal(terminal: string, lines?: number): Promise<HerdrReadResult>
  runTerminal(input: Partial<HerdrRunRequest> & { agent?: string }): Promise<HerdrTerminal>
  sendTerminal(
    terminal: string,
    input: Partial<HerdrSendRequest> & { text: string }
  ): Promise<HerdrSendResult>
  keysTerminal(terminal: string, keys: string[]): Promise<HerdrKeysResult>
  interruptTerminal(terminal: string, timeout?: number): Promise<HerdrInterruptResult>
  answerTerminal(
    terminal: string,
    input: { choice?: number | string; text?: string; useArrows?: boolean }
  ): Promise<HerdrAnswerResult>
  waitTerminal(
    terminal: string,
    opts?: { timeout?: number; output?: string }
  ): Promise<HerdrWaitResult>
  killTerminal(terminal: string): Promise<HerdrTerminal>
  rmTerminal(terminal: string): Promise<HerdrRemoveResult>
  labelTerminal(terminal: string, labels: Record<string, string>): Promise<HerdrTerminal>
  setMuted(terminal: string, muted: boolean): Promise<{ terminal: HerdrTerminal; muted: boolean }>
  putFile(terminal: string, name: string, dataBase64: string): Promise<HerdrPutResult>
  listMachines(): Promise<HerdrMachineView[]>
  listTemplates(): Promise<HerdrTemplateInfo[]>
  listWorkspaces(all?: boolean): Promise<HerdrWorkspaceListResponseDto>
}

export interface HerdrFollowManagerLike {
  follow(terminal: string, threadId: string): HerdrFollowBindingDto
  unfollow(terminal: string): boolean
  unfollowThread(threadId: string): number
  getFollower(terminal: string): HerdrFollowBindingDto | null
  listFollows(): HerdrFollowBindingDto[]
  dispose(): void
}
