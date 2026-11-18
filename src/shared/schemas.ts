import { z } from 'zod'

// ==================== Model & Provider Schemas ====================

export const ModelCapabilitiesSchema = z.object({
  vision: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  streaming: z.boolean().default(true),
  functionCalling: z.boolean().default(true),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
})
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>

export const ModelDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  capabilities: ModelCapabilitiesSchema.default({}),
  autoCapabilities: ModelCapabilitiesSchema.optional()
})
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>

export const ProviderTypeSchema = z.enum([
  'openai-compatible',
  'openai',
  'anthropic',
  'acp'
])
export type ProviderType = z.infer<typeof ProviderTypeSchema>

export const ApiFormatSchema = z.enum([
  'openai-chat',
  'openai-responses',
  'anthropic'
])
export type ApiFormat = z.infer<typeof ApiFormatSchema>

export const AcpPresetSchema = z.enum(['claude', 'codex', 'gemini', 'custom'])
export type AcpPreset = z.infer<typeof AcpPresetSchema>

export const AcpModeOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional()
})
export type AcpModeOption = z.infer<typeof AcpModeOptionSchema>

export const ProviderUpsertSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'Provider ID 仅允许字母、数字、下划线和连字符').optional(),
  name: z.string().min(1),
  type: ProviderTypeSchema,
  apiFormat: ApiFormatSchema.default('openai-chat'),
  isResponseApi: z.boolean().default(false),
  useMaxCompletionTokens: z.boolean().default(false),
  apiVersion: z.string().optional().nullable(),
  baseUrl: z.string().optional().nullable(),
  apiKey: z.string().optional().nullable(), // null = clear, undefined = keep existing on update
  customHeaders: z.record(z.string(), z.string()).default({}),
  models: z.array(ModelDefinitionSchema).default([]),
  availableModels: z.array(ModelDefinitionSchema).default([]),
  acpPreset: AcpPresetSchema.optional().nullable(),
  acpCommand: z.string().optional().nullable(),
  acpExecutablePath: z.string().optional().nullable(),
  acpArgs: z.array(z.string()).default([]),
  acpEnv: z.record(z.string(), z.string()).default({}),
  acpApiProviderId: z.string().optional().nullable(),
  acpMcpServerIds: z.array(z.string()).default([]),
  acpPermissionMode: z.string().min(1).default('default'),
  acpAvailableModes: z.array(AcpModeOptionSchema).default([]),
  acpLastModeId: z.string().optional().nullable(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0)
})
export type ProviderUpsertInput = z.infer<typeof ProviderUpsertSchema>

export interface AcpCliInspectResult {
  activeSource: 'explicit' | 'local' | 'bundled' | 'npx' | 'unknown'
  resolvedPath: string | null
  localVersion: string | null
  bundledVersion: string | null
  checkedAt: number
}

export interface ProviderDto {
  id: string
  name: string
  type: ProviderType
  apiFormat: ApiFormat
  isResponseApi: boolean
  useMaxCompletionTokens: boolean
  apiVersion: string | null
  baseUrl: string | null
  hasApiKey: boolean
  apiKeyPreview: string | null
  customHeaders: Record<string, string>
  models: ModelDefinition[]
  availableModels: ModelDefinition[]
  acpPreset: AcpPreset | null
  acpCommand: string | null
  acpExecutablePath: string | null
  acpArgs: string[]
  acpEnv: Record<string, string>
  acpApiProviderId: string | null
  acpMcpServerIds: string[]
  acpPermissionMode: string
  acpAvailableModes: AcpModeOption[]
  acpLastModeId: string | null
  enabled: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface CompositeModelOption {
  compositeId: string // "providerId:modelId"
  providerId: string
  providerName: string
  providerType: ProviderType
  modelId: string
  modelName: string
  description?: string
  capabilities: ModelCapabilities
}

// ==================== UIMessage & Thread Schemas ====================

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string()
  }),
  z.object({
    type: z.literal('reasoning'),
    text: z.string(),
    durationMs: z.number().optional()
  }),
  z.object({
    type: z.literal('tool-call'),
    toolCallId: z.string(),
    toolName: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    status: z.enum(['running', 'completed', 'failed']).default('running'),
    isError: z.boolean().optional()
  }),
  z.object({
    type: z.literal('file'),
    attachmentId: z.string().optional(),
    url: z.string().optional(),
    fileName: z.string(),
    mediaType: z.string(),
    byteSize: z.number().optional()
  })
])
export type MessagePart = z.infer<typeof MessagePartSchema>

export const UIMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  parts: z.array(MessagePartSchema)
})
export type UIMessage = z.infer<typeof UIMessageSchema>

export interface MessageMetadata {
  providerId?: string
  model?: string
  latencyMs?: number
  finishReason?: string
  error?: string
  isCompactionSummary?: boolean
  compactedCount?: number
  usage?: {
    inputTokens: number
    outputTokens: number
    cachedInputTokens: number
    reasoningTokens: number
    totalTokens: number
  }
}

export interface StoredMessageDto {
  id: string
  threadId: string
  parentId: string | null
  slotId: string
  role: 'user' | 'assistant' | 'system'
  message: UIMessage
  metadata: MessageMetadata
  createdAt: number
  versionInfo: {
    index: number // 1-based
    total: number
    siblingIds: string[]
  }
}

export type ThreadRuntimeStatus = 'idle' | 'generating' | 'waiting_permission'

export interface ThreadDto {
  id: string
  title: string
  titleSource: 'default' | 'auto' | 'manual'
  model: string | null
  reasoningEffort: 'low' | 'medium' | 'high' | null
  fastMode: boolean
  activeLeafId: string | null
  parentThreadId: string | null
  branchFromMessageId: string | null
  workspacePath: string | null
  enabledMcpIds: string[] | null
  skillIds: string[] | null
  isPinned: boolean
  archivedAt: number | null
  runtimeStatus: ThreadRuntimeStatus
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export const ThreadCreateSchema = z.object({
  title: z.string().optional(),
  model: z.string().optional().nullable(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional().nullable(),
  workspacePath: z.string().optional().nullable(),
  enabledMcpIds: z.array(z.string()).optional().nullable()
})

export const ThreadUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  model: z.string().nullable().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).nullable().optional(),
  fastMode: z.boolean().optional(),
  workspacePath: z.string().nullable().optional(),
  enabledMcpIds: z.array(z.string()).nullable().optional(),
  skillIds: z.array(z.string()).nullable().optional(),
  isPinned: z.boolean().optional(),
  archived: z.boolean().optional()
})

// ==================== MCP & Skills Schemas ====================

export const McpServerUpsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  transport: z.enum(['stdio', 'streamable-http']),
  command: z.string().optional().nullable(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().optional().nullable(),
  headers: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true)
})
export type McpServerUpsertInput = z.infer<typeof McpServerUpsertSchema>

export interface McpServerRuntimeDto {
  id: string
  name: string
  transport: 'stdio' | 'streamable-http'
  command: string | null
  args: string[]
  env: Record<string, string>
  url: string | null
  headers: Record<string, string>
  enabled: boolean
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  lastError: string | null
  toolCount: number
  tools: Array<{ name: string; description?: string }>
}

export interface SkillDto {
  id: string
  name: string
  description: string
  path: string
  source: 'local' | 'claude'
  enabled: boolean
}

// ==================== Settings Schema ====================

export const SettingsSchema = z.object({
  general: z.object({
    theme: z.enum(['dark', 'light', 'system']).default('dark'),
    language: z.enum(['zh-CN']).default('zh-CN'),
    autoLaunch: z.boolean().default(false),
    globalShortcutEnabled: z.boolean().default(true),
    globalShortcut: z.string().default('Alt+Space')
  }).default({}),
  chat: z.object({
    defaultModel: z.string().default(''),
    sendWithEnter: z.boolean().default(true)
  }).default({}),
  toolModel: z.object({
    model: z.string().default(''),
    autoTitle: z.boolean().default(true)
  }).default({}),
  acp: z.object({
    permissionTimeoutSec: z.number().int().min(1).max(300).default(60)
  }).default({}),
  update: z.object({
    feedUrl: z.string().default(''),
    autoCheck: z.boolean().default(false)
  }).default({})
})
export type AppSettings = z.infer<typeof SettingsSchema>

export const SettingsPatchSchema = z.object({
  general: SettingsSchema.shape.general.removeDefault().partial().optional(),
  chat: SettingsSchema.shape.chat.removeDefault().partial().optional(),
  toolModel: SettingsSchema.shape.toolModel.removeDefault().partial().optional(),
  acp: SettingsSchema.shape.acp.removeDefault().partial().optional(),
  update: SettingsSchema.shape.update.removeDefault().partial().optional()
})
export type AppSettingsPatch = z.infer<typeof SettingsPatchSchema>

export const DataImportRequestSchema = z.object({
  mode: z.enum(['merge', 'replace']).default('merge'),
  data: z.record(z.string(), z.unknown())
})

// ==================== ACP Permission Gate ====================

export interface PermissionOptionDto {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export interface PendingPermissionRequestDto {
  requestId: string
  threadId: string
  providerId: string
  title: string
  toolName: string
  rawInput: unknown
  cwd: string | null
  options: PermissionOptionDto[]
  expiresAt: number
}

// ==================== WebSocket Protocol ====================

export const GenerateRequestDataSchema = z.object({
  threadId: z.string().min(1),
  userMessage: z.object({
    role: z.literal('user').default('user'),
    parts: z.array(MessagePartSchema).min(1)
  }).optional().nullable(),
  model: z.string().optional().nullable(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional().nullable(),
  fastMode: z.boolean().optional(),
  enabledMCPServerIds: z.array(z.string()).optional().nullable(),
  noTools: z.boolean().optional(),
  retryOfMessageId: z.string().optional().nullable(),
  replaceMessageId: z.string().optional().nullable(),
  ephemeralContext: z.string().optional().nullable(),
  ephemeralModel: z.string().optional().nullable(),
  source: z.string().default('gui')
})
export type GenerateRequestData = z.infer<typeof GenerateRequestDataSchema>

export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('generate_response'),
    data: GenerateRequestDataSchema
  }),
  z.object({
    type: z.literal('steer_generation'),
    data: GenerateRequestDataSchema
  }),
  z.object({
    type: z.literal('stop_generation'),
    data: z.object({ threadId: z.string().min(1) })
  }),
  z.object({
    type: z.literal('permission_response'),
    data: z.object({
      requestId: z.string().min(1),
      optionId: z.string().min(1)
    })
  })
])
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>

export interface ContextUsageDto {
  used: number
  size: number
  cost?: {
    amount: number
    currency: string
  } | null
  updatedAt?: number
}

// ==================== Cron Jobs Schemas ====================

export const CronJobUpsertSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  cronExpr: z.string().min(1),
  timezone: z.string().min(1).default('Asia/Shanghai'),
  threadId: z.string().optional().nullable(),
  prompt: z.string().min(1),
  model: z.string().optional().nullable(),
  enabled: z.boolean().default(true)
})
export type CronJobUpsertInput = z.infer<typeof CronJobUpsertSchema>

export interface CronJobDto {
  id: string
  name: string
  cronExpr: string
  timezone: string
  threadId: string | null
  prompt: string
  model: string | null
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  lastStatus: string | null
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface CronRunDto {
  id: string
  jobId: string
  threadId: string | null
  messageId: string | null
  triggerType: 'schedule' | 'manual'
  status: 'running' | 'success' | 'error'
  error: string | null
  startedAt: number
  finishedAt: number | null
}

// ==================== Full-Text Search Schemas ====================

export interface SearchMessageHitDto {
  messageId: string
  threadId: string
  threadTitle: string
  archivedAt: number | null
  role: 'user' | 'assistant' | 'system'
  snippet: string
  createdAt: number
}

export interface SearchResponseDto {
  query: string
  threads: ThreadDto[]
  messages: SearchMessageHitDto[]
}

// ==================== Prompts Library Schemas (B5) ====================

export const PromptTemplateUpsertSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  shortcut: z.string().optional().nullable(),
  content: z.string().min(1),
  category: z.string().optional().nullable()
})
export type PromptTemplateUpsertInput = z.infer<typeof PromptTemplateUpsertSchema>

export interface PromptTemplateDto {
  id: string
  title: string
  shortcut: string | null
  content: string
  category: string | null
  createdAt: number
  updatedAt: number
}

// ==================== Workspace Readonly Schemas (B7) ====================

export interface WorkspaceTreeEntryDto {
  name: string
  relPath: string
  isDir: boolean
  size: number
}

export interface WorkspaceGitStatusDto {
  isGitRepo: boolean
  branch: string | null
  files: Array<{ status: string; path: string }>
  diff: string
}

// ==================== Execution Traces (B9) ====================

export interface ExecutionTraceToolCallItem {
  toolCallId: string
  toolName: string
  title?: string
  status: string
  isError?: boolean
}

export interface ExecutionTraceDto {
  id: string
  threadId: string
  messageId: string
  providerId: string
  model: string
  source: string
  status: 'success' | 'error' | 'aborted'
  durationMs: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  totalTokens: number
  toolCallCount: number
  toolCalls: ExecutionTraceToolCallItem[]
  error: string | null
  startedAt: number
  finishedAt: number
}

export interface WsServerEnvelope<T = unknown> {
  type: string
  data: T
  timestamp: number
}
