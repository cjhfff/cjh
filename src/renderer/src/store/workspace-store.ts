import { create } from 'zustand'
import type {
  AcpModeOption,
  ContextUsageDto,
  MessagePart,
  PendingPermissionRequestDto,
  StoredMessageDto,
  ThreadRuntimeStatus
} from '@shared/schemas'

export type MainViewTab =
  | 'chat'
  | 'terminals'
  | 'providers'
  | 'mcp'
  | 'memory'
  | 'cron'
  | 'channels'
  | 'system'

interface ThreadModeState {
  currentModeId: string
  availableModes: AcpModeOption[]
}

interface WorkspaceState {
  activeView: MainViewTab
  activeThreadId: string | null
  highlightedMessageId: string | null
  onboardingOpen: boolean | null
  messagesByThread: Record<string, StoredMessageDto[]>
  statusByThread: Record<string, ThreadRuntimeStatus>
  permissionsByThread: Record<string, PendingPermissionRequestDto[]>
  commandsByThread: Record<string, Array<{ name: string; description?: string }>>
  modeByThread: Record<string, ThreadModeState>
  contextUsageByThread: Record<string, ContextUsageDto>

  setActiveView: (view: MainViewTab) => void
  setActiveThreadId: (id: string | null) => void
  setHighlightedMessageId: (id: string | null) => void
  setOnboardingOpen: (open: boolean | null) => void
  setThreadMessages: (
    threadId: string,
    messages: StoredMessageDto[],
    permissions?: PendingPermissionRequestDto[]
  ) => void
  upsertMessage: (msg: StoredMessageDto) => void
  appendDelta: (
    threadId: string,
    messageId: string,
    partType: 'text' | 'reasoning',
    delta: string
  ) => void
  upsertToolCallPart: (payload: {
    threadId: string
    messageId: string
    toolCallId: string
    toolName?: string
    title?: string
    kind?: string
    input?: unknown
    status?: 'running' | 'completed' | 'failed'
    output?: unknown
    isError?: boolean
  }) => void
  setThreadStatus: (threadId: string, status: ThreadRuntimeStatus) => void
  addPermissionRequest: (dto: PendingPermissionRequestDto) => void
  removePermissionRequest: (threadId: string, requestId: string) => void
  setThreadCommands: (
    threadId: string,
    commands: Array<{ name: string; description?: string }>
  ) => void
  setThreadMode: (threadId: string, mode: ThreadModeState) => void
  setThreadContextUsage: (threadId: string, usage: ContextUsageDto) => void
}

export const useWorkspaceStore = create<WorkspaceState>(set => ({
  activeView: 'chat',
  activeThreadId: null,
  highlightedMessageId: null,
  onboardingOpen: null,
  messagesByThread: {},
  statusByThread: {},
  permissionsByThread: {},
  commandsByThread: {},
  modeByThread: {},
  contextUsageByThread: {},

  setActiveView: view => set({ activeView: view }),
  setActiveThreadId: id => set({ activeThreadId: id }),
  setHighlightedMessageId: id => set({ highlightedMessageId: id }),
  setOnboardingOpen: open => set({ onboardingOpen: open }),

  setThreadMessages: (threadId, messages, permissions) =>
    set(state => ({
      messagesByThread: { ...state.messagesByThread, [threadId]: messages },
      ...(permissions !== undefined
        ? { permissionsByThread: { ...state.permissionsByThread, [threadId]: permissions } }
        : {})
    })),

  upsertMessage: msg =>
    set(state => {
      const list = state.messagesByThread[msg.threadId] || []
      const idx = list.findIndex(m => m.id === msg.id)
      const next = idx >= 0 ? list.map((m, i) => (i === idx ? msg : m)) : [...list, msg]
      return {
        messagesByThread: { ...state.messagesByThread, [msg.threadId]: next }
      }
    }),

  appendDelta: (threadId, messageId, partType, delta) =>
    set(state => {
      const list = state.messagesByThread[threadId] || []
      const idx = list.findIndex(m => m.id === messageId)
      if (idx === -1) return state

      const target = list[idx]
      const parts = [...target.message.parts]
      const last = parts[parts.length - 1]
      if (last && last.type === partType) {
        parts[parts.length - 1] = { ...last, text: last.text + delta }
      } else {
        parts.push({ type: partType, text: delta })
      }

      const nextList = [...list]
      nextList[idx] = {
        ...target,
        message: { ...target.message, parts }
      }
      return {
        messagesByThread: { ...state.messagesByThread, [threadId]: nextList }
      }
    }),

  upsertToolCallPart: payload =>
    set(state => {
      const list = state.messagesByThread[payload.threadId] || []
      const idx = list.findIndex(m => m.id === payload.messageId)
      if (idx === -1) return state

      const target = list[idx]
      const parts = [...target.message.parts]
      const pIdx = parts.findIndex(
        (p): p is Extract<MessagePart, { type: 'tool-call' }> =>
          p.type === 'tool-call' && p.toolCallId === payload.toolCallId
      )
      if (pIdx >= 0) {
        const prev = parts[pIdx] as Extract<MessagePart, { type: 'tool-call' }>
        parts[pIdx] = {
          ...prev,
          ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
          ...(payload.title !== undefined ? { title: payload.title } : {}),
          ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
          ...(payload.input !== undefined ? { input: payload.input } : {}),
          ...(payload.status !== undefined ? { status: payload.status } : {}),
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          ...(payload.isError !== undefined ? { isError: payload.isError } : {})
        }
      } else {
        parts.push({
          type: 'tool-call',
          toolCallId: payload.toolCallId,
          toolName: payload.toolName || payload.title || 'Tool',
          title: payload.title || payload.toolName || 'Tool',
          ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
          ...(payload.input !== undefined ? { input: payload.input } : {}),
          ...(payload.output !== undefined ? { output: payload.output } : {}),
          status: payload.status || 'running',
          ...(payload.isError !== undefined ? { isError: payload.isError } : {})
        })
      }

      const nextList = [...list]
      nextList[idx] = {
        ...target,
        message: { ...target.message, parts }
      }
      return {
        messagesByThread: { ...state.messagesByThread, [payload.threadId]: nextList }
      }
    }),

  setThreadStatus: (threadId, status) =>
    set(state => ({
      statusByThread: { ...state.statusByThread, [threadId]: status }
    })),

  addPermissionRequest: dto =>
    set(state => {
      const existing = state.permissionsByThread[dto.threadId] || []
      if (existing.some(p => p.requestId === dto.requestId)) return state
      return {
        permissionsByThread: {
          ...state.permissionsByThread,
          [dto.threadId]: [...existing, dto]
        }
      }
    }),

  removePermissionRequest: (threadId, requestId) =>
    set(state => ({
      permissionsByThread: {
        ...state.permissionsByThread,
        [threadId]: (state.permissionsByThread[threadId] || []).filter(
          p => p.requestId !== requestId
        )
      }
    })),

  setThreadCommands: (threadId, commands) =>
    set(state => ({
      commandsByThread: { ...state.commandsByThread, [threadId]: commands }
    })),

  setThreadMode: (threadId, mode) =>
    set(state => ({
      modeByThread: { ...state.modeByThread, [threadId]: mode }
    })),

  setThreadContextUsage: (threadId, usage) =>
    set(state => ({
      contextUsageByThread: { ...state.contextUsageByThread, [threadId]: usage }
    }))
}))
