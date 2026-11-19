import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowUp,
  Bot,
  BrainCircuit,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Compass,
  FolderOpen,
  FolderTree,
  GitBranch,
  Layers,
  Paperclip,
  Pencil,
  Pin,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
  Zap
} from 'lucide-react'
import type {
  AcpModeOption,
  CompositeModelOption,
  ExecutionTraceDto,
  McpServerRuntimeDto,
  MessagePart,
  PendingPermissionRequestDto,
  PromptTemplateDto,
  ProviderDto,
  SearchResponseDto,
  StoredMessageDto,
  ThreadDto,
  WsClientMessage
} from '@shared/schemas'
import { apiFetch, getDaemonConnection, uploadAttachmentFile } from '../lib/api'
import { useWorkspaceStore } from '../store/workspace-store'
import {
  CodeBlockWithCopy,
  CustomSelect,
  ModelPickerPopover,
  Switch
} from './ui/primitives'
import { WorkspacePanel } from './WorkspacePanel'

interface Props {
  sendWs: (msg: WsClientMessage) => void
  sidebarOpen: boolean
}

function PermissionCard({
  perm,
  onRespond
}: {
  perm: PendingPermissionRequestDto
  onRespond: (requestId: string, optionId: string) => void
}) {
  const { t } = useTranslation()
  const [remainingSec, setRemainingSec] = useState(() =>
    Math.max(0, Math.ceil((perm.expiresAt - Date.now()) / 1000))
  )

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemainingSec(Math.max(0, Math.ceil((perm.expiresAt - Date.now()) / 1000)))
    }, 500)
    return () => clearInterval(id)
  }, [perm.expiresAt])

  return (
    <div className="rounded-2xl border border-[var(--warning)]/60 bg-[var(--bg-surface)] p-4 space-y-3 shadow-lg animate-enter">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--warning-soft)] text-[var(--warning)]">
              <ShieldAlert className="w-3.5 h-3.5" />
              {t('permission.badge')}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {t('permission.failClosedHint')}
            </span>
          </div>
          <div className="text-sm font-semibold pt-0.5">{perm.title}</div>
        </div>
        <span className="px-2.5 py-1 rounded-full bg-[var(--warning-soft)] text-[var(--warning)] font-mono text-xs shrink-0">
          {t('permission.countdown', { sec: remainingSec })}
        </span>
      </div>

      <pre className="p-3 rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] font-mono text-xs overflow-x-auto text-[var(--text-secondary)]">
        {typeof perm.rawInput === 'string'
          ? perm.rawInput
          : JSON.stringify(perm.rawInput, null, 2)}
      </pre>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <span className="text-xs text-[var(--text-muted)] font-mono truncate">
          {perm.cwd ? `cwd: ${perm.cwd}` : perm.toolName}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onRespond(perm.requestId, '__reject__')}
            className="px-3.5 py-1.5 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-xs font-medium hover:opacity-90 transition"
          >
            {t('permission.reject')}
          </button>
          {perm.options
            .filter(o => !/reject|deny|cancel/i.test(o.kind))
            .map(opt => (
              <button
                key={opt.optionId}
                onClick={() => onRespond(perm.requestId, opt.optionId)}
                className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium hover:opacity-90 transition shadow-sm"
              >
                {opt.name}
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}

function MessagePartsView({
  parts,
  daemonConn
}: {
  parts: MessagePart[]
  daemonConn?: { port: number; token: string } | null
}) {
  const { t } = useTranslation()
  const [openBlocks, setOpenBlocks] = useState<Record<number, boolean>>({})

  const toggle = (idx: number) =>
    setOpenBlocks(prev => ({ ...prev, [idx]: !prev[idx] }))

  return (
    <div className="space-y-3">
      {parts.map((part, idx) => {
        if (part.type === 'reasoning') {
          const isOpen = openBlocks[idx] ?? false
          return (
            <div key={idx} className="pl-3 border-l-2 border-[var(--accent)]/40 space-y-1.5">
              <button
                type="button"
                onClick={() => toggle(idx)}
                className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
              >
                <BrainCircuit className="w-3.5 h-3.5 text-[var(--accent)]" />
                <span className="font-medium">{t('chat.reasoningLabel')}</span>
                <span className="text-[11px] opacity-70">
                  {isOpen ? t('common.collapse') : t('common.expand')}
                </span>
              </button>
              {isOpen && (
                <div className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed bg-[var(--bg-surface)]/70 rounded-xl p-3 border border-[var(--border-subtle)] animate-enter">
                  {part.text}
                </div>
              )}
            </div>
          )
        }

        if (part.type === 'tool-call') {
          const isOpen = openBlocks[idx] ?? false
          return (
            <div
              key={part.toolCallId || idx}
              className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggle(idx)}
                className="w-full px-3.5 py-2 flex items-center justify-between text-xs hover:bg-[var(--bg-elevated)]/50 transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      part.status === 'failed'
                        ? 'bg-[var(--danger)]'
                        : part.status === 'running'
                          ? 'bg-[var(--warning)] animate-pulse'
                          : 'bg-[var(--success)]'
                    }`}
                  />
                  <Wrench className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                  <span className="font-mono font-medium truncate">
                    {part.title || part.toolName}
                  </span>
                </div>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[var(--bg-canvas)] text-[var(--text-muted)] shrink-0 ml-2">
                  {part.status === 'running'
                    ? t('chat.toolRunning')
                    : part.status === 'failed'
                      ? t('chat.toolFailed')
                      : t('chat.toolCompleted')}
                </span>
              </button>
              {isOpen && (
                <div className="p-3 border-t border-[var(--border-subtle)] bg-[var(--bg-code)] space-y-2 font-mono text-xs overflow-x-auto animate-enter">
                  {part.input !== undefined && (
                    <div>
                      <div className="text-[var(--text-muted)] text-[11px] mb-1">
                        {t('chat.toolArgs')}
                      </div>
                      <pre className="whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                        {typeof part.input === 'string'
                          ? part.input
                          : JSON.stringify(part.input, null, 2)}
                      </pre>
                    </div>
                  )}
                  {part.output !== undefined && (
                    <div>
                      <div className="text-[var(--text-muted)] text-[11px] mb-1">
                        {t('chat.toolOutput')}
                      </div>
                      <pre className="whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                        {typeof part.output === 'string'
                          ? part.output
                          : JSON.stringify(part.output, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        }

        if (part.type === 'file') {
          const isImg = part.mediaType?.startsWith('image/')
          const imgSrc =
            isImg && part.attachmentId && daemonConn
              ? `http://127.0.0.1:${daemonConn.port}/api/attachments/${part.attachmentId}?token=${encodeURIComponent(daemonConn.token)}`
              : isImg && part.url
                ? part.url
                : null
          return (
            <div key={idx} className="space-y-1.5">
              {imgSrc && (
                <img
                  src={imgSrc}
                  alt={part.fileName}
                  className="max-w-xs max-h-56 rounded-xl border border-[var(--border-subtle)] object-contain bg-[var(--bg-canvas)]"
                />
              )}
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-xs font-mono">
                <Paperclip className="w-3.5 h-3.5 text-[var(--accent)]" />
                <span>{part.fileName}</span>
                {part.byteSize !== undefined && (
                  <span className="text-[10px] text-[var(--text-muted)]">
                    ({Math.max(1, Math.round(part.byteSize / 1024))}KB)
                  </span>
                )}
              </div>
            </div>
          )
        }

        return (
          <div
            key={idx}
            className="text-[14px] leading-7 text-[var(--text-primary)] break-words space-y-2 [&_p]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-[var(--accent)] [&_a]:underline [&_table]:w-full [&_th]:text-left [&_th]:py-1.5 [&_th]:px-2.5 [&_th]:border-b [&_th]:border-[var(--border-strong)] [&_td]:py-1.5 [&_td]:px-2.5 [&_td]:border-b [&_td]:border-[var(--border-subtle)]"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code({ className, children }) {
                  return <CodeBlockWithCopy className={className}>{children}</CodeBlockWithCopy>
                }
              }}
            >
              {part.text}
            </ReactMarkdown>
          </div>
        )
      })}
    </div>
  )
}

const STARTER_CARDS = [
  {
    icon: Code2,
    titleKey: 'chat.starter1Title',
    descKey: 'chat.starter1Desc',
    promptKey: 'chat.starter1Prompt'
  },
  {
    icon: Compass,
    titleKey: 'chat.starter2Title',
    descKey: 'chat.starter2Desc',
    promptKey: 'chat.starter2Prompt'
  },
  {
    icon: Terminal,
    titleKey: 'chat.starter3Title',
    descKey: 'chat.starter3Desc',
    promptKey: 'chat.starter3Prompt'
  },
  {
    icon: Zap,
    titleKey: 'chat.starter4Title',
    descKey: 'chat.starter4Desc',
    promptKey: 'chat.starter4Prompt'
  }
] as const

export function ChatWorkspace({ sendWs, sidebarOpen }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollBottomRef = useRef<HTMLDivElement>(null)

  const activeThreadId = useWorkspaceStore(s => s.activeThreadId)
  const setActiveThreadId = useWorkspaceStore(s => s.setActiveThreadId)
  const highlightedMessageId = useWorkspaceStore(s => s.highlightedMessageId)
  const setHighlightedMessageId = useWorkspaceStore(s => s.setHighlightedMessageId)
  const setActiveView = useWorkspaceStore(s => s.setActiveView)
  const messagesByThread = useWorkspaceStore(s => s.messagesByThread)
  const statusByThread = useWorkspaceStore(s => s.statusByThread)
  const permissionsByThread = useWorkspaceStore(s => s.permissionsByThread)
  const commandsByThread = useWorkspaceStore(s => s.commandsByThread)
  const modeByThread = useWorkspaceStore(s => s.modeByThread)
  const contextUsageByThread = useWorkspaceStore(s => s.contextUsageByThread)
  const setThreadMessages = useWorkspaceStore(s => s.setThreadMessages)
  const setThreadCommands = useWorkspaceStore(s => s.setThreadCommands)
  const removePermissionRequest = useWorkspaceStore(s => s.removePermissionRequest)

  const [daemonConn, setDaemonConn] = useState<{ port: number; token: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [draft, setDraft] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [effort, setEffort] = useState<'' | 'low' | 'medium' | 'high'>('')
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{ id: string; fileName: string; mimeType: string; byteSize: number }>
  >([])
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [mcpMenuOpen, setMcpMenuOpen] = useState(false)

  // A1/A2 Sidebar rename, context menu, multi-select & archive state
  const [sidebarRenamingId, setSidebarRenamingId] = useState<string | null>(null)
  const [sidebarRenameInput, setSidebarRenameInput] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    thread: ThreadDto
    x: number
    y: number
  } | null>(null)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [selectedThreadIds, setSelectedThreadIds] = useState<string[]>([])
  const [showArchived, setShowArchived] = useState(false)

  // A3 Edit user message state
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null)
  const [editingMsgText, setEditingMsgText] = useState('')

  // A4 Slash command & model picker popup state
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0)

  // A5 Drag state
  const [isDragOver, setIsDragOver] = useState(false)

  // B8 ACP Mode switcher state
  const [acpModeMenuOpen, setAcpModeMenuOpen] = useState(false)
  const [acpModeError, setAcpModeError] = useState<string | null>(null)

  // B7 Workspace readonly panel state
  const [workspacePanelOpen, setWorkspacePanelOpen] = useState(false)

  // B9 Execution trace modal state
  const [traceModalMsgId, setTraceModalMsgId] = useState<string | null>(null)
  const [traceData, setTraceData] = useState<ExecutionTraceDto | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)

  const openTraceModal = async (messageId: string) => {
    setTraceModalMsgId(messageId)
    setTraceData(null)
    setTraceError(null)
    try {
      const res = await apiFetch<ExecutionTraceDto>(`/api/messages/${messageId}/trace`)
      setTraceData(res)
    } catch (err) {
      setTraceError(err instanceof Error ? err.message : t('chat.traceNotFound'))
    }
  }

  useEffect(() => {
    void getDaemonConnection().then(c => setDaemonConn({ port: c.port, token: c.token }))
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchQuery.trim()), 180)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const { data: searchResults } = useQuery<SearchResponseDto>({
    queryKey: ['search', debouncedSearch],
    queryFn: () => apiFetch(`/api/search?q=${encodeURIComponent(debouncedSearch)}`),
    enabled: debouncedSearch.length > 0
  })

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [contextMenu])

  const { data: threads = [] } = useQuery<ThreadDto[]>({
    queryKey: ['threads'],
    queryFn: () => apiFetch('/api/threads?archived=1')
  })

  const { data: models = [] } = useQuery<CompositeModelOption[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models')
  })

  const { data: providers = [] } = useQuery<ProviderDto[]>({
    queryKey: ['providers'],
    queryFn: () => apiFetch('/api/providers')
  })

  const { data: mcpServers = [] } = useQuery<McpServerRuntimeDto[]>({
    queryKey: ['mcp-servers'],
    queryFn: () => apiFetch('/api/mcp-servers')
  })

  const { data: promptTemplates = [] } = useQuery<PromptTemplateDto[]>({
    queryKey: ['prompts'],
    queryFn: () => apiFetch('/api/prompts')
  })

  const activeThread = useMemo(
    () => threads.find(th => th.id === activeThreadId) || null,
    [threads, activeThreadId]
  )

  useEffect(() => {
    if (!activeThreadId && threads.length > 0) {
      const firstActive = threads.find(th => !th.archivedAt) || threads[0]
      setActiveThreadId(firstActive.id)
    }
  }, [activeThreadId, threads, setActiveThreadId])

  useEffect(() => {
    if (activeThread?.model) {
      setSelectedModel(activeThread.model)
    } else if (!selectedModel && models.length > 0) {
      setSelectedModel(models[0].compositeId)
    }
    if (activeThread) {
      setEffort(activeThread.reasoningEffort || '')
    }
  }, [activeThread, models])

  useEffect(() => {
    if (!activeThreadId) return
    void apiFetch<{
      messages: StoredMessageDto[]
      pendingPermissions: PendingPermissionRequestDto[]
    }>(`/api/threads/${activeThreadId}/messages`).then(async res => {
      if (
        highlightedMessageId &&
        !res.messages.some(m => m.id === highlightedMessageId)
      ) {
        try {
          const switched = await apiFetch<{ messages: StoredMessageDto[] }>(
            `/api/messages/${highlightedMessageId}/switch-version`,
            { method: 'POST' }
          )
          setThreadMessages(activeThreadId, switched.messages, res.pendingPermissions)
          return
        } catch {
          // Ignore if message belongs to another thread
        }
      }
      setThreadMessages(activeThreadId, res.messages, res.pendingPermissions)
    })
    void apiFetch<{ commands: Array<{ name: string; description?: string }> }>(
      `/api/threads/${activeThreadId}/acp-commands`
    )
      .then(res => setThreadCommands(activeThreadId, res.commands || []))
      .catch(() => undefined)
  }, [activeThreadId, highlightedMessageId, setThreadMessages, setThreadCommands])

  const activeMessages = activeThreadId ? messagesByThread[activeThreadId] || [] : []
  const activePermissions = activeThreadId ? permissionsByThread[activeThreadId] || [] : []
  const activeCommands = activeThreadId ? commandsByThread[activeThreadId] || [] : []
  const liveStatus = activeThreadId
    ? statusByThread[activeThreadId] || activeThread?.runtimeStatus || 'idle'
    : 'idle'

  useEffect(() => {
    if (highlightedMessageId) {
      const el = document.querySelector(`[data-message-id="${CSS.escape(highlightedMessageId)}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        const timer = window.setTimeout(() => setHighlightedMessageId(null), 2600)
        return () => clearTimeout(timer)
      }
    }
    scrollBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    return undefined
  }, [activeMessages.length, activePermissions.length, highlightedMessageId, setHighlightedMessageId])

  const createThreadMut = useMutation({
    mutationFn: () =>
      apiFetch<ThreadDto>('/api/threads', {
        method: 'POST',
        body: JSON.stringify({
          model: selectedModel || null,
          reasoningEffort: effort || null
        })
      }),
    onSuccess: created => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
      setActiveThreadId(created.id)
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        createThreadMut.mutate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const updateThreadMut = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiFetch<ThreadDto>(`/api/threads/${activeThreadId}`, {
        method: 'PUT',
        body: JSON.stringify(patch)
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
    }
  })

  const renameThreadMut = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiFetch<ThreadDto>(`/api/threads/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title })
      }),
    onSuccess: () => {
      setSidebarRenamingId(null)
      void qc.invalidateQueries({ queryKey: ['threads'] })
    }
  })

  const archiveThreadMut = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      apiFetch<ThreadDto>(`/api/threads/${id}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST'
      }),
    onSuccess: (_res, vars) => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
      if (vars.archived && activeThreadId === vars.id) {
        const next = threads.find(th => th.id !== vars.id && !th.archivedAt)
        setActiveThreadId(next ? next.id : null)
      }
    }
  })

  const deleteThreadMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/threads/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, deletedId) => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
      setSelectedThreadIds(prev => prev.filter(x => x !== deletedId))
      if (activeThreadId === deletedId) {
        const next = threads.find(th => th.id !== deletedId && !th.archivedAt)
        setActiveThreadId(next ? next.id : null)
      }
    }
  })

  const batchDeleteMut = useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch('/api/threads/batch-delete', {
        method: 'POST',
        body: JSON.stringify({ ids })
      }),
    onSuccess: (_res, deletedIds) => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
      setSelectedThreadIds([])
      setMultiSelectMode(false)
      if (activeThreadId && deletedIds.includes(activeThreadId)) {
        const next = threads.find(th => !deletedIds.includes(th.id) && !th.archivedAt)
        setActiveThreadId(next ? next.id : null)
      }
    }
  })

  const filteredThreads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return q ? threads.filter(th => th.title.toLowerCase().includes(q)) : threads
  }, [threads, searchQuery])

  const activeThreadsList = filteredThreads.filter(th => !th.archivedAt)
  const archivedThreads = filteredThreads.filter(th => Boolean(th.archivedAt))

  const attentionThreads = activeThreadsList.filter(th => {
    const st = statusByThread[th.id] || th.runtimeStatus
    return st === 'waiting_permission' || st === 'generating'
  })
  const pinnedThreads = activeThreadsList.filter(
    th => th.isPinned && !attentionThreads.some(a => a.id === th.id)
  )
  const regularThreads = activeThreadsList.filter(
    th => !th.isPinned && !attentionThreads.some(a => a.id === th.id)
  )

  const handleSend = async () => {
    const text = draft.trim()
    if (!text && pendingAttachments.length === 0) return

    let targetThreadId = activeThreadId
    if (!targetThreadId) {
      const created = await createThreadMut.mutateAsync()
      targetThreadId = created.id
    }

    const parts: MessagePart[] = []
    for (const att of pendingAttachments) {
      parts.push({
        type: 'file',
        attachmentId: att.id,
        fileName: att.fileName,
        mediaType: att.mimeType,
        byteSize: att.byteSize
      })
    }
    if (text) {
      parts.push({ type: 'text', text })
    }

    setDraft('')
    setPendingAttachments([])

    sendWs({
      type: liveStatus === 'generating' ? 'steer_generation' : 'generate_response',
      data: {
        threadId: targetThreadId,
        userMessage: { role: 'user', parts },
        model: selectedModel || undefined,
        reasoningEffort: effort || null,
        source: 'gui'
      }
    })
  }

  const handleSwitchVersion = async (siblingId: string) => {
    if (!activeThreadId) return
    const res = await apiFetch<{ messages: StoredMessageDto[] }>(
      `/api/messages/${siblingId}/switch-version`,
      { method: 'POST' }
    )
    setThreadMessages(activeThreadId, res.messages)
  }

  const handleRollback = async (messageId: string) => {
    if (!activeThreadId) return
    const res = await apiFetch<{ messages: StoredMessageDto[] }>(
      `/api/messages/${messageId}/rollback`,
      { method: 'POST' }
    )
    setThreadMessages(activeThreadId, res.messages)
  }

  const handleRegenerate = (assistantMessageId: string) => {
    if (!activeThreadId) return
    sendWs({
      type: 'generate_response',
      data: {
        threadId: activeThreadId,
        retryOfMessageId: assistantMessageId,
        model: selectedModel || undefined,
        reasoningEffort: effort || null,
        source: 'gui'
      }
    })
  }

  const handleSaveEditedUserMsg = (msg: StoredMessageDto) => {
    if (!activeThreadId) return
    const existingFiles = msg.message.parts.filter(p => p.type === 'file')
    const trimmed = editingMsgText.trim()
    if (!trimmed && existingFiles.length === 0) return

    const nextParts: MessagePart[] = [
      ...existingFiles,
      ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : [])
    ]
    setEditingMsgId(null)
    setEditingMsgText('')
    sendWs({
      type: 'generate_response',
      data: {
        threadId: activeThreadId,
        replaceMessageId: msg.id,
        userMessage: { role: 'user', parts: nextParts },
        model: selectedModel || undefined,
        reasoningEffort: effort || null,
        source: 'gui'
      }
    })
  }

  const uploadFiles = async (files: File[]) => {
    for (const f of files) {
      const uploaded = await uploadAttachmentFile(f, activeThreadId)
      setPendingAttachments(prev => [...prev, uploaded])
    }
  }

  const handlePermissionRespond = (requestId: string, optionId: string) => {
    if (activeThreadId) {
      removePermissionRequest(activeThreadId, requestId)
    }
    sendWs({
      type: 'permission_response',
      data: { requestId, optionId }
    })
  }

  const handlePickFolder = async () => {
    if (!window.cjhShell) return
    let targetId = activeThreadId
    if (!targetId) {
      const created = await createThreadMut.mutateAsync()
      targetId = created.id
    }
    const dir = await window.cjhShell.pickDirectory()
    if (dir && targetId) {
      await apiFetch(`/api/threads/${targetId}`, {
        method: 'PUT',
        body: JSON.stringify({ workspacePath: dir })
      })
      void qc.invalidateQueries({ queryKey: ['threads'] })
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    await uploadFiles(files)
    e.target.value = ''
  }

  const toggleSelectThread = (id: string) => {
    setSelectedThreadIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const renderThreadItem = (th: ThreadDto) => {
    const st = statusByThread[th.id] || th.runtimeStatus
    const isSelected = th.id === activeThreadId
    const isChecked = selectedThreadIds.includes(th.id)
    const isRenaming = sidebarRenamingId === th.id

    return (
      <div
        key={th.id}
        onClick={() => {
          if (multiSelectMode) {
            toggleSelectThread(th.id)
          } else if (!isRenaming) {
            setActiveThreadId(th.id)
          }
        }}
        onContextMenu={ev => {
          ev.preventDefault()
          ev.stopPropagation()
          setContextMenu({
            thread: th,
            x: Math.min(ev.clientX, window.innerWidth - 180),
            y: Math.min(ev.clientY, window.innerHeight - 190)
          })
        }}
        className={`group px-3 py-2 rounded-xl cursor-pointer transition-all duration-150 flex items-center justify-between gap-2 ${
          st === 'waiting_permission'
            ? 'bg-[var(--warning-soft)] border border-[var(--warning)]/40'
            : isSelected
              ? 'bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-2xs'
              : 'text-[var(--text-secondary)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)]'
        }`}
      >
        <div className="min-w-0 flex-1 flex items-center gap-2">
          {multiSelectMode && (
            <input
              type="checkbox"
              checked={isChecked}
              onChange={() => toggleSelectThread(th.id)}
              onClick={ev => ev.stopPropagation()}
              className="w-3.5 h-3.5 accent-[var(--accent)] shrink-0 cursor-pointer"
            />
          )}
          <div className="min-w-0 flex-1">
            {isRenaming ? (
              <input
                autoFocus
                value={sidebarRenameInput}
                onChange={e => setSidebarRenameInput(e.target.value)}
                onClick={e => e.stopPropagation()}
                onBlur={() => {
                  const next = sidebarRenameInput.trim()
                  if (next && next !== th.title) {
                    renameThreadMut.mutate({ id: th.id, title: next })
                  } else {
                    setSidebarRenamingId(null)
                  }
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.currentTarget.blur()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setSidebarRenamingId(null)
                  }
                }}
                className="w-full px-2 py-0.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--accent)] text-xs outline-none text-[var(--text-primary)]"
              />
            ) : (
              <div
                onDoubleClick={ev => {
                  ev.stopPropagation()
                  setSidebarRenamingId(th.id)
                  setSidebarRenameInput(th.title)
                }}
                className="flex items-center gap-2"
                title={th.title}
              >
                {st === 'generating' && (
                  <span className="w-2 h-2 rounded-full bg-[var(--success)] animate-pulse shrink-0" />
                )}
                <span className={`text-[13px] truncate ${isSelected ? 'font-medium' : ''}`}>
                  {th.title}
                </span>
              </div>
            )}
            {st === 'waiting_permission' && (
              <span className="inline-block mt-0.5 text-[11px] font-medium text-[var(--warning)]">
                ● {t('sidebar.statusWaitingPerm')}
              </span>
            )}
          </div>
        </div>

        {!multiSelectMode && !isRenaming && (
          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            {th.archivedAt ? (
              <button
                onClick={ev => {
                  ev.stopPropagation()
                  archiveThreadMut.mutate({ id: th.id, archived: false })
                }}
                className="p-1 rounded-md hover:bg-[var(--bg-canvas)]/60 text-[var(--text-muted)] hover:text-[var(--accent)]"
                title={t('sidebar.unarchiveThread')}
              >
                <ArchiveRestore className="w-3 h-3" />
              </button>
            ) : (
              <button
                onClick={ev => {
                  ev.stopPropagation()
                  void apiFetch(`/api/threads/${th.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ isPinned: !th.isPinned })
                  }).then(() => qc.invalidateQueries({ queryKey: ['threads'] }))
                }}
                className={`p-1 rounded-md hover:bg-[var(--bg-canvas)]/60 ${
                  th.isPinned ? 'opacity-100 text-[var(--accent)]' : 'text-[var(--text-muted)]'
                }`}
                title={th.isPinned ? t('sidebar.unpinThread') : t('sidebar.pinThread')}
              >
                <Pin className="w-3 h-3" />
              </button>
            )}
            <button
              onClick={ev => {
                ev.stopPropagation()
                deleteThreadMut.mutate(th.id)
              }}
              className="p-1 rounded-md hover:bg-[var(--bg-canvas)]/60 text-[var(--text-muted)] hover:text-[var(--danger)]"
              title={t('sidebar.deleteThread')}
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    )
  }

  const currentModelObj = useMemo(
    () => models.find(m => m.compositeId === selectedModel) || models[0] || null,
    [models, selectedModel]
  )
  const isAcpModel = currentModelObj?.providerType === 'acp'

  const currentProviderObj = useMemo(
    () =>
      currentModelObj ? providers.find(p => p.id === currentModelObj.providerId) || null : null,
    [providers, currentModelObj]
  )

  const activeModeInfo = useMemo(() => {
    if (!activeThreadId || !isAcpModel) return null
    const live = modeByThread[activeThreadId]
    const metaMode = activeThread?.metadata?.acpMode as
      | { currentModeId?: string; availableModes?: AcpModeOption[] }
      | undefined
    const currentModeId =
      live?.currentModeId ||
      metaMode?.currentModeId ||
      currentProviderObj?.acpLastModeId ||
      currentProviderObj?.acpPermissionMode ||
      'default'
    const fallbackModes: AcpModeOption[] = [
      { id: 'default', name: 'default' },
      { id: 'acceptEdits', name: 'acceptEdits' },
      { id: 'plan', name: 'plan' },
      { id: 'bypassPermissions', name: 'bypassPermissions' }
    ]
    const availableModes =
      live?.availableModes?.length
        ? live.availableModes
        : metaMode?.availableModes?.length
          ? metaMode.availableModes
          : currentProviderObj?.acpAvailableModes?.length
            ? currentProviderObj.acpAvailableModes
            : fallbackModes
    return { currentModeId, availableModes }
  }, [activeThreadId, isAcpModel, modeByThread, activeThread, currentProviderObj])

  const switchAcpModeMut = useMutation({
    mutationFn: (modeId: string) =>
      apiFetch(`/api/threads/${activeThreadId}/acp-mode`, {
        method: 'POST',
        body: JSON.stringify({ modeId })
      }),
    onSuccess: () => {
      setAcpModeError(null)
      setAcpModeMenuOpen(false)
      void qc.invalidateQueries({ queryKey: ['threads'] })
      void qc.invalidateQueries({ queryKey: ['providers'] })
    },
    onError: err => {
      setAcpModeError(err instanceof Error ? err.message : String(err))
    }
  })

  const compactMut = useMutation({
    mutationFn: (tid: string) =>
      apiFetch<{ compacted: boolean; messages?: StoredMessageDto[] }>(
        `/api/threads/${tid}/compact`,
        { method: 'POST' }
      ),
    onSuccess: (res, tid) => {
      if (Array.isArray(res?.messages)) {
        setThreadMessages(tid, res.messages)
      }
      void qc.invalidateQueries({ queryKey: ['threads'] })
    }
  })

  const branchThreadMut = useMutation({
    mutationFn: ({ tid, messageId }: { tid: string; messageId: string }) =>
      apiFetch<{ thread: ThreadDto; messages: StoredMessageDto[] }>(
        `/api/threads/${tid}/branch`,
        {
          method: 'POST',
          body: JSON.stringify({ messageId })
        }
      ),
    onSuccess: res => {
      void qc.invalidateQueries({ queryKey: ['threads'] })
      setThreadMessages(res.thread.id, res.messages)
      setActiveThreadId(res.thread.id)
    }
  })

  const slashCandidates = useMemo(() => {
    const builtIns: Array<{
      name: string
      description?: string
      kind: 'builtin' | 'acp' | 'prompt'
      content?: string
    }> = [
      { name: 'new', description: t('chat.slashCmdNewDesc'), kind: 'builtin' },
      { name: 'model', description: t('chat.slashCmdModelDesc'), kind: 'builtin' },
      { name: 'compact', description: t('chat.slashCmdCompactDesc'), kind: 'builtin' }
    ]
    const cmdPool: Array<{
      name: string
      description?: string
      kind: 'builtin' | 'acp' | 'prompt'
      content?: string
    }> = isAcpModel ? activeCommands.map(c => ({ ...c, kind: 'acp' as const })) : builtIns

    const promptPool: Array<{
      name: string
      description?: string
      kind: 'builtin' | 'acp' | 'prompt'
      content?: string
    }> = promptTemplates.map(p => ({
      name: p.shortcut || p.title,
      description: p.shortcut ? `${p.title}` : p.category || p.content.slice(0, 40),
      kind: 'prompt' as const,
      content: p.content
    }))

    if (!draft.startsWith('/')) return []
    const tokenMatch = /^\/([^\s]*)$/.exec(draft)
    if (!tokenMatch) return []
    const q = tokenMatch[1].toLowerCase()
    return [
      ...cmdPool.filter(cmd => cmd.name.toLowerCase().includes(q)),
      ...promptPool.filter(
        pr =>
          pr.name.toLowerCase().includes(q) ||
          (pr.description || '').toLowerCase().includes(q)
      )
    ]
  }, [draft, isAcpModel, activeCommands, promptTemplates, t])

  const slashMenuOpen = !slashDismissed && /^\/[^\s]*$/.test(draft) && slashCandidates.length > 0

  useEffect(() => {
    setSlashSelectedIdx(0)
  }, [draft, slashCandidates.length])

  const applySlashCommand = (cmd: {
    name: string
    kind: 'builtin' | 'acp' | 'prompt'
    content?: string
  }) => {
    if (cmd.kind === 'prompt') {
      setDraft(cmd.content || '')
      setSlashDismissed(true)
      textareaRef.current?.focus()
      return
    }
    if (cmd.kind === 'acp') {
      setDraft(`/${cmd.name} `)
      setSlashDismissed(true)
      textareaRef.current?.focus()
      return
    }
    setDraft('')
    setSlashDismissed(false)
    if (cmd.name === 'new') {
      createThreadMut.mutate()
    } else if (cmd.name === 'model') {
      setModelPickerOpen(true)
    } else if (cmd.name === 'compact' && activeThreadId) {
      compactMut.mutate(activeThreadId)
    }
  }

  const connectedMcpCount = mcpServers.filter(s => s.status === 'connected').length
  const canSend = draft.trim().length > 0 || pendingAttachments.length > 0

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Velvet Collapsible Sidebar */}
      {sidebarOpen && (
        <aside className="w-68 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] flex flex-col justify-between shrink-0">
          <div className="p-3 space-y-3 overflow-y-auto flex-1">
            <button
              onClick={() => createThreadMut.mutate()}
              className="w-full py-2 px-3 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] text-xs font-medium flex items-center justify-between transition shadow-2xs"
            >
              <span className="flex items-center gap-2 text-[var(--text-primary)]">
                <Plus className="w-3.5 h-3.5 text-[var(--accent)]" />
                {t('sidebar.newThread')}
              </span>
              <kbd className="px-1.5 py-0.5 rounded-md bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)] font-mono">
                Ctrl+N
              </kbd>
            </button>

            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[var(--text-muted)]" />
                <input
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('sidebar.searchPlaceholder')}
                  className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-[var(--bg-canvas)]/60 border border-[var(--border-subtle)] text-xs outline-none focus:border-[var(--accent)] transition"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setMultiSelectMode(v => !v)
                  setSelectedThreadIds([])
                }}
                className={`p-1.5 rounded-xl border transition shrink-0 ${
                  multiSelectMode
                    ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)]'
                    : 'bg-[var(--bg-canvas)]/60 border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
                title={multiSelectMode ? t('sidebar.exitMultiSelect') : t('sidebar.multiSelect')}
              >
                <CheckSquare className="w-3.5 h-3.5" />
              </button>
            </div>

            {multiSelectMode && (
              <div className="p-2 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] flex items-center justify-between gap-2 text-[11px] animate-enter">
                <span className="text-[var(--text-secondary)]">
                  {t('sidebar.selectedCount', { count: selectedThreadIds.length })}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedThreadIds(activeThreadsList.map(x => x.id))}
                    className="px-2 py-0.5 rounded-md bg-[var(--bg-elevated)] hover:opacity-90"
                  >
                    {t('sidebar.selectAll')}
                  </button>
                  <button
                    type="button"
                    disabled={selectedThreadIds.length === 0 || batchDeleteMut.isPending}
                    onClick={() => batchDeleteMut.mutate(selectedThreadIds)}
                    className="px-2 py-0.5 rounded-md bg-[var(--danger-soft)] text-[var(--danger)] font-medium disabled:opacity-40"
                  >
                    {t('sidebar.batchDelete')}
                  </button>
                </div>
              </div>
            )}

            {attentionThreads.length > 0 && (
              <div className="space-y-1">
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--warning)]">
                  {t('sidebar.attentionGroup')} · {attentionThreads.length}
                </div>
                {attentionThreads.map(renderThreadItem)}
              </div>
            )}

            {pinnedThreads.length > 0 && (
              <div className="space-y-1">
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {t('sidebar.pinnedGroup')}
                </div>
                {pinnedThreads.map(renderThreadItem)}
              </div>
            )}

            <div className="space-y-0.5">
              {(pinnedThreads.length > 0 || attentionThreads.length > 0) && (
                <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {t('sidebar.recentGroup')}
                </div>
              )}
              {regularThreads.length === 0 &&
              attentionThreads.length === 0 &&
              pinnedThreads.length === 0 ? (
                <div className="px-3 py-8 text-center space-y-3">
                  <div className="text-xs text-[var(--text-muted)] leading-relaxed">
                    {t('sidebar.emptyThreads')}
                  </div>
                  <button
                    type="button"
                    onClick={() => createThreadMut.mutate()}
                    className="px-3.5 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t('sidebar.emptyNewThreadCta')}</span>
                  </button>
                </div>
              ) : (
                regularThreads.map(renderThreadItem)
              )}
            </div>

            {archivedThreads.length > 0 && (
              <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1">
                <button
                  type="button"
                  onClick={() => setShowArchived(v => !v)}
                  className="w-full px-2 py-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Archive className="w-3 h-3" />
                    <span>
                      {t('sidebar.archivedGroup')} ({archivedThreads.length})
                    </span>
                  </span>
                  <ChevronDown
                    className={`w-3 h-3 transition-transform ${showArchived ? 'rotate-180' : ''}`}
                  />
                </button>
                {showArchived && archivedThreads.map(renderThreadItem)}
              </div>
            )}

            {debouncedSearch.length > 0 && (
              <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5">
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                  {t('sidebar.searchMessageHits')}
                  {searchResults ? ` (${searchResults.messages.length})` : ''}
                </div>
                {searchResults && searchResults.messages.length === 0 ? (
                  <div className="px-2 py-2 text-[11px] text-[var(--text-muted)]">
                    {t('sidebar.searchNoHits')}
                  </div>
                ) : (
                  (searchResults?.messages || []).map(hit => (
                    <button
                      key={hit.messageId}
                      type="button"
                      onClick={() => {
                        setHighlightedMessageId(hit.messageId)
                        setActiveThreadId(hit.threadId)
                      }}
                      className="w-full text-left px-2.5 py-2 rounded-xl bg-[var(--bg-surface)]/70 hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] space-y-0.5 transition"
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-medium text-[var(--text-primary)] truncate">
                          {hit.threadTitle}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">
                          {hit.role}
                        </span>
                      </div>
                      <div className="text-[11px] text-[var(--text-secondary)] line-clamp-2 break-all">
                        {hit.snippet}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Minimalist Sidebar Footer */}
          <div className="p-2.5 border-t border-[var(--border-subtle)] flex items-center justify-between text-xs">
            <button
              onClick={() => setActiveView('mcp')}
              className="px-2 py-1.5 rounded-lg hover:bg-[var(--bg-elevated)] flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  connectedMcpCount > 0 ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]'
                }`}
              />
              <span>{t('sidebar.mcpReady', { count: connectedMcpCount })}</span>
            </button>
            <button
              onClick={() => setActiveView('providers')}
              className="px-2 py-1.5 rounded-lg hover:bg-[var(--bg-elevated)] flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
              title={t('sidebar.settingsBtnTitle')}
            >
              <Settings2 className="w-3.5 h-3.5" />
              <span>{t('sidebar.providerSettingsShort')}</span>
            </button>
          </div>
        </aside>
      )}

      {/* Main Editorial Canvas */}
      <main
        className="flex-1 flex flex-col min-w-0 relative"
        style={{ backgroundImage: 'var(--ambient-glow)' }}
      >
        {/* Minimal Context Topbar */}
        <header className="h-11 px-6 flex items-center justify-between gap-4 shrink-0 border-b border-[var(--border-subtle)]/60">
          <div className="flex items-center gap-2 min-w-0">
            {editingTitle && activeThread ? (
              <input
                autoFocus
                value={titleInput}
                onChange={e => setTitleInput(e.target.value)}
                onBlur={() => {
                  setEditingTitle(false)
                  if (titleInput.trim() && titleInput.trim() !== activeThread.title) {
                    updateThreadMut.mutate({ title: titleInput.trim() })
                  }
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') e.currentTarget.blur()
                }}
                className="px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] border border-[var(--accent)] text-xs font-medium outline-none"
              />
            ) : (
              <h2
                onClick={() => {
                  if (activeThread) {
                    setTitleInput(activeThread.title)
                    setEditingTitle(true)
                  }
                }}
                className="text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] truncate cursor-pointer transition"
                title={t('chat.clickToRenameTitle')}
              >
                {activeThread?.title || t('chat.untitled')}
              </h2>
            )}
            {activeThread?.titleSource === 'auto' && (
              <span
                className="text-[11px] px-1.5 py-0.5 rounded-md bg-[var(--accent-soft)] text-[var(--accent)]"
                title={t('chat.autoTitleBadge')}
              >
                {t('chat.autoTitleTag')}
              </span>
            )}
            {activeThread?.parentThreadId && (
              <button
                type="button"
                onClick={() => setActiveThreadId(activeThread.parentThreadId)}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--accent)] transition"
                title={activeThread.parentThreadId}
              >
                <GitBranch className="w-3 h-3" />
                <span>{t('chat.branchedFromBadge')}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0 text-xs">
            {activeModeInfo && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setAcpModeError(null)
                    setAcpModeMenuOpen(v => !v)
                  }}
                  title={
                    activeModeInfo.currentModeId === 'bypassPermissions'
                      ? t('chat.acpModeBypassWarning')
                      : t('chat.acpModeLabel')
                  }
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono transition ${
                    activeModeInfo.currentModeId === 'bypassPermissions'
                      ? 'bg-[var(--danger-soft)] border-[var(--danger)]/60 text-[var(--danger)] font-semibold'
                      : 'bg-[var(--accent-soft)] border-[var(--accent)]/30 text-[var(--accent)] hover:opacity-90'
                  }`}
                >
                  {activeModeInfo.currentModeId === 'bypassPermissions' && (
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span>mode:{activeModeInfo.currentModeId}</span>
                  <ChevronDown className="w-3 h-3 opacity-75" />
                </button>
                {acpModeMenuOpen && (
                  <div className="absolute right-0 top-full mt-1.5 w-64 p-1.5 rounded-xl popover-glass z-40 space-y-1 animate-enter">
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                      {t('chat.acpModeLabel')}
                    </div>
                    {acpModeError && (
                      <div className="px-2 py-1 rounded-lg bg-[var(--danger-soft)] text-[var(--danger)] text-[11px] font-mono break-all">
                        {acpModeError}
                      </div>
                    )}
                    {activeModeInfo.availableModes.map(m => {
                      const active = m.id === activeModeInfo.currentModeId
                      const isBypass = m.id === 'bypassPermissions'
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={switchAcpModeMut.isPending}
                          onClick={() => switchAcpModeMut.mutate(m.id)}
                          className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 transition ${
                            isBypass
                              ? active
                                ? 'bg-[var(--danger-soft)] text-[var(--danger)] font-medium'
                                : 'text-[var(--danger)] hover:bg-[var(--danger-soft)]/70'
                              : active
                                ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                                : 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="font-mono truncate">{m.id}</div>
                            {m.description && (
                              <div className="text-[10px] text-[var(--text-muted)] truncate">
                                {m.description}
                              </div>
                            )}
                          </div>
                          {active && <Check className="w-3.5 h-3.5 shrink-0" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            {activeThread && typeof activeThread.metadata?.acpSessionId === 'string' && (
              <button
                type="button"
                onClick={() => {
                  void apiFetch(`/api/threads/${activeThread.id}/acp-reset`, {
                    method: 'POST'
                  }).then(() => qc.invalidateQueries({ queryKey: ['threads'] }))
                }}
                className="hidden md:inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[var(--bg-surface)]/80 hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition"
                title={
                  activeThread.metadata.acpResumeMode === 'session_load'
                    ? `${t('chat.acpSessionLoaded')} · ${t('chat.acpSessionReset')}`
                    : activeThread.metadata.acpResumeMode === 'fallback_history'
                      ? `${t('chat.acpSessionFallback')} · ${t('chat.acpSessionReset')}`
                      : `${t('chat.acpSessionActive')} · ${t('chat.acpSessionReset')}`
                }
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
                <span>
                  {activeThread.metadata.acpResumeMode === 'session_load'
                    ? t('chat.acpSessionLoaded')
                    : activeThread.metadata.acpResumeMode === 'fallback_history'
                      ? t('chat.acpSessionFallback')
                      : t('chat.acpSessionActive')}
                </span>
              </button>
            )}
            {(() => {
              const liveCtx =
                (activeThreadId && contextUsageByThread[activeThreadId]) ||
                (activeThread?.metadata?.contextUsage as { used?: number; size?: number } | undefined)
              if (!liveCtx || !liveCtx.size) return null
              const pct = Math.min(100, Math.round(((liveCtx.used || 0) / liveCtx.size) * 100))
              const high = pct >= 80
              return (
                <button
                  type="button"
                  onClick={() => {
                    if (activeThreadId) compactMut.mutate(activeThreadId)
                  }}
                  className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono transition ${
                    high
                      ? 'bg-[var(--warning-soft)] border-[var(--warning)]/50 text-[var(--warning)]'
                      : 'bg-[var(--bg-surface)]/80 border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                  title={
                    high
                      ? t('chat.compactWarning', { pct })
                      : t('chat.contextUsageTitle', {
                          used: (liveCtx.used || 0).toLocaleString(),
                          size: liveCtx.size.toLocaleString(),
                          pct
                        })
                  }
                >
                  <span>{Math.round((liveCtx.used || 0) / 1000)}k / {Math.round(liveCtx.size / 1000)}k</span>
                  <span className={high ? 'font-semibold' : 'text-[var(--accent)]'}>{pct}%</span>
                </button>
              )
            })()}
            <button
              onClick={() => void handlePickFolder()}
              className="px-2.5 py-1 rounded-lg bg-[var(--bg-surface)]/80 hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] max-w-[260px] transition"
              title={t('chat.bindFolderTitle')}
            >
              <FolderOpen className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
              <span className="truncate font-mono text-[11px]">
                {activeThread?.workspacePath || t('chat.bindFolder')}
              </span>
            </button>
            {activeThread?.workspacePath && (
              <>
                <button
                  type="button"
                  onClick={() => setWorkspacePanelOpen(v => !v)}
                  className={`p-1.5 rounded-lg border transition ${
                    workspacePanelOpen
                      ? 'bg-[var(--accent-soft)] border-[var(--accent)]/40 text-[var(--accent)]'
                      : 'bg-[var(--bg-surface)]/80 border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title={t('chat.workspacePanelTitle')}
                >
                  <FolderTree className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => updateThreadMut.mutate({ workspacePath: null })}
                  className="p-1 rounded-md hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  title={t('chat.clearFolder')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </header>

        {/* Scrollable Conversation / Empty Hero */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {activeMessages.length === 0 && activePermissions.length === 0 ? (
            /* Crafted Studio Empty State */
            <div className="h-full max-w-2xl mx-auto flex flex-col items-center justify-center py-8 space-y-7 animate-enter">
              <div className="text-center space-y-2.5">
                <div className="w-12 h-12 mx-auto rounded-2xl bg-gradient-to-br from-[#8b5cf6] to-[#4f46e5] text-white flex items-center justify-center shadow-lg shadow-[#7c5cff]/20">
                  <Sparkles className="w-6 h-6" />
                </div>
                <h1 className="text-xl font-semibold tracking-tight pt-1">
                  {t('chat.heroTitle')}
                </h1>
                <p className="text-xs text-[var(--text-muted)] max-w-md mx-auto leading-relaxed">
                  {t('chat.heroSubtitlePrefix')}{' '}
                  <span className="font-mono text-[var(--text-secondary)]">sub2api</span>{' '}
                  {t('chat.heroSubtitleMid')}{' '}
                  <span className="font-mono text-[var(--text-secondary)]">Claude / Codex ACP</span>{' '}
                  {t('chat.heroSubtitleSuffix')}
                </p>
              </div>

              {models.length === 0 && (
                <div className="w-full p-4 rounded-2xl surface-card flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <div className="text-xs font-semibold">{t('chat.onboardTitle')}</div>
                    <p className="text-xs text-[var(--text-muted)]">{t('chat.onboardDesc')}</p>
                  </div>
                  <button
                    onClick={() => setActiveView('providers')}
                    className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium shrink-0 hover:opacity-90 transition shadow-sm"
                  >
                    {t('chat.onboardCta')}
                  </button>
                </div>
              )}

              <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-3">
                {STARTER_CARDS.map((card, idx) => {
                  const Icon = card.icon
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setDraft(t(card.promptKey))
                        textareaRef.current?.focus()
                      }}
                      className="text-left p-4 rounded-2xl bg-[var(--bg-surface)]/75 hover:bg-[var(--bg-elevated)]/80 border border-[var(--border-subtle)] hover:border-[var(--border-strong)] transition-all duration-150 space-y-1.5 group"
                    >
                      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)]">
                        <Icon className="w-4 h-4 text-[var(--accent)] group-hover:scale-105 transition-transform" />
                        <span>{t(card.titleKey)}</span>
                      </div>
                      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
                        {t(card.descKey)}
                      </p>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : (
            /* Editorial Message Stream */
            <div className="max-w-3xl mx-auto space-y-7 pb-4">
              {activeMessages.map(msg => {
                const isUser = msg.role === 'user'
                const isSystem = msg.role === 'system'
                const isHighlighted = highlightedMessageId === msg.id
                return (
                  <div
                    key={msg.id}
                    data-message-id={msg.id}
                    className={`group animate-enter rounded-2xl transition-all ${
                      isHighlighted ? 'ring-2 ring-[var(--accent)] bg-[var(--accent-soft)]/30 p-2 -m-2' : ''
                    }`}
                  >
                    {isSystem ? (
                      <div className="rounded-2xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]/35 p-4 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2 text-[var(--accent)] font-semibold">
                          <span className="inline-flex items-center gap-1.5">
                            <Layers className="w-3.5 h-3.5" />
                            {t('chat.compactTitle', {
                              count: msg.metadata.compactedCount || 0
                            })}
                          </span>
                        </div>
                        <div className="text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap select-text">
                          <MessagePartsView parts={msg.message.parts} daemonConn={daemonConn} />
                        </div>
                      </div>
                    ) : isUser ? (
                      <div className="flex flex-col items-end gap-1.5">
                        {editingMsgId === msg.id ? (
                          <div className="w-full max-w-[85%] rounded-2xl p-3 bg-[var(--bg-surface)] border border-[var(--accent)] space-y-2.5 shadow-sm">
                            {msg.message.parts.some(p => p.type === 'file') && (
                              <div className="flex flex-wrap gap-1.5">
                                {msg.message.parts
                                  .filter((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file')
                                  .map((fp, i) => (
                                    <span
                                      key={i}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--bg-elevated)] text-[11px] font-mono"
                                    >
                                      <Paperclip className="w-3 h-3 text-[var(--accent)]" />
                                      {fp.fileName}
                                    </span>
                                  ))}
                              </div>
                            )}
                            <textarea
                              autoFocus
                              rows={3}
                              value={editingMsgText}
                              onChange={e => setEditingMsgText(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Escape') {
                                  e.preventDefault()
                                  setEditingMsgId(null)
                                } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
                                  e.preventDefault()
                                  handleSaveEditedUserMsg(msg)
                                }
                              }}
                              className="w-full bg-[var(--bg-canvas)] rounded-xl p-2.5 border border-[var(--border-subtle)] text-[13px] leading-relaxed outline-none focus:border-[var(--accent)] resize-y"
                            />
                            <div className="flex items-center justify-end gap-2 text-xs">
                              <button
                                type="button"
                                onClick={() => setEditingMsgId(null)}
                                className="px-3 py-1 rounded-lg bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                              >
                                {t('chat.cancelEdit')}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleSaveEditedUserMsg(msg)}
                                className="px-3 py-1 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1"
                              >
                                <Check className="w-3 h-3" />
                                {t('chat.saveResend')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="max-w-[82%] rounded-2xl rounded-br-md px-4 py-3 bg-[var(--bg-elevated)] border border-[var(--border-subtle)] select-text">
                              <MessagePartsView parts={msg.message.parts} daemonConn={daemonConn} />
                            </div>
                            <div className="flex items-center gap-2.5 text-[11px] text-[var(--text-muted)] pr-1">
                              {msg.versionInfo.total > 1 && (
                                <div className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono text-[var(--text-secondary)]">
                                  <button
                                    disabled={msg.versionInfo.index <= 1}
                                    onClick={() =>
                                      handleSwitchVersion(
                                        msg.versionInfo.siblingIds[msg.versionInfo.index - 2]
                                      )
                                    }
                                    className="disabled:opacity-30 hover:text-[var(--text-primary)]"
                                  >
                                    <ChevronLeft className="w-3 h-3" />
                                  </button>
                                  <span>
                                    {msg.versionInfo.index} / {msg.versionInfo.total}
                                  </span>
                                  <button
                                    disabled={msg.versionInfo.index >= msg.versionInfo.total}
                                    onClick={() =>
                                      handleSwitchVersion(
                                        msg.versionInfo.siblingIds[msg.versionInfo.index]
                                      )
                                    }
                                    className="disabled:opacity-30 hover:text-[var(--text-primary)]"
                                  >
                                    <ChevronRight className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                              <div className="flex items-center gap-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                  type="button"
                                  onClick={() => {
                                    const text = msg.message.parts
                                      .filter(
                                        (p): p is Extract<MessagePart, { type: 'text' }> =>
                                          p.type === 'text'
                                      )
                                      .map(p => p.text)
                                      .join('\n')
                                    setEditingMsgId(msg.id)
                                    setEditingMsgText(text)
                                  }}
                                  className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
                                >
                                  <Pencil className="w-3 h-3" />
                                  {t('chat.editResend')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (activeThreadId) {
                                      branchThreadMut.mutate({ tid: activeThreadId, messageId: msg.id })
                                    }
                                  }}
                                  className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
                                >
                                  <GitBranch className="w-3 h-3" />
                                  {t('chat.branchFromHere')}
                                </button>
                                <button
                                  onClick={() => handleRollback(msg.id)}
                                  className="hover:text-[var(--text-primary)]"
                                >
                                  {t('chat.rollbackHere')}
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-start gap-3.5 select-text">
                        <div className="w-7 h-7 rounded-xl bg-[var(--accent-soft)] border border-[var(--accent)]/25 text-[var(--accent)] flex items-center justify-center shrink-0 mt-0.5">
                          <Bot className="w-4 h-4" />
                        </div>

                        <div className="flex-1 min-w-0 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[var(--text-secondary)] font-mono">
                              {msg.metadata.model || 'assistant'}
                            </span>

                            {msg.versionInfo.total > 1 && (
                              <div className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[11px] font-mono text-[var(--text-secondary)]">
                                <button
                                  disabled={msg.versionInfo.index <= 1}
                                  onClick={() =>
                                    handleSwitchVersion(
                                      msg.versionInfo.siblingIds[msg.versionInfo.index - 2]
                                    )
                                  }
                                  className="disabled:opacity-30 hover:text-[var(--text-primary)]"
                                >
                                  <ChevronLeft className="w-3 h-3" />
                                </button>
                                <span>
                                  {msg.versionInfo.index} / {msg.versionInfo.total}
                                </span>
                                <button
                                  disabled={msg.versionInfo.index >= msg.versionInfo.total}
                                  onClick={() =>
                                    handleSwitchVersion(
                                      msg.versionInfo.siblingIds[msg.versionInfo.index]
                                    )
                                  }
                                  className="disabled:opacity-30 hover:text-[var(--text-primary)]"
                                >
                                  <ChevronRight className="w-3 h-3" />
                                </button>
                              </div>
                            )}
                          </div>

                          <MessagePartsView parts={msg.message.parts} daemonConn={daemonConn} />

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-[var(--text-muted)] opacity-75 group-hover:opacity-100 transition-opacity">
                            <div className="flex items-center gap-3 font-mono">
                              {msg.metadata.usage && msg.metadata.usage.totalTokens > 0 && (
                                <span>
                                  {msg.metadata.usage.totalTokens.toLocaleString()} tok
                                </span>
                              )}
                              {msg.metadata.latencyMs !== undefined && (
                                <span>{(msg.metadata.latencyMs / 1000).toFixed(1)}s</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => void openTraceModal(msg.id)}
                                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] transition"
                              >
                                <Activity className="w-3 h-3" />
                                {t('chat.viewTrace')}
                              </button>
                              <button
                                onClick={() => handleRegenerate(msg.id)}
                                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] transition"
                              >
                                <RefreshCw className="w-3 h-3" />
                                {t('chat.regenerate')}
                              </button>
                              <button
                                onClick={() => {
                                  if (activeThreadId) {
                                    branchThreadMut.mutate({ tid: activeThreadId, messageId: msg.id })
                                  }
                                }}
                                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] transition"
                              >
                                <GitBranch className="w-3 h-3" />
                                {t('chat.branchFromHere')}
                              </button>
                              <button
                                onClick={() => handleRollback(msg.id)}
                                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] transition"
                              >
                                <RotateCcw className="w-3 h-3" />
                                {t('chat.rollbackHere')}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}

              {activePermissions.map(perm => (
                <PermissionCard
                  key={perm.requestId}
                  perm={perm}
                  onRespond={handlePermissionRespond}
                />
              ))}

              <div ref={scrollBottomRef} />
            </div>
          )}
        </div>

        {/* Floating Glass Composer Capsule */}
        <div
          className="px-6 pb-5 pt-1 shrink-0 relative"
          onDragOver={e => {
            e.preventDefault()
            setIsDragOver(true)
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={e => {
            e.preventDefault()
            setIsDragOver(false)
            const files = Array.from(e.dataTransfer.files || [])
            if (files.length) void uploadFiles(files)
          }}
        >
          <div
            className={`max-w-3xl mx-auto rounded-2xl composer-shell p-3 space-y-2.5 relative ${
              isDragOver ? 'ring-2 ring-[var(--accent)]' : ''
            }`}
          >
            {(() => {
              const liveCtx =
                (activeThreadId && contextUsageByThread[activeThreadId]) ||
                (activeThread?.metadata?.contextUsage as { used?: number; size?: number } | undefined)
              if (!liveCtx || !liveCtx.size || !activeThreadId) return null
              const pct = Math.min(100, Math.round(((liveCtx.used || 0) / liveCtx.size) * 100))
              if (pct < 80) return null
              return (
                <div className="px-3 py-1.5 rounded-xl bg-[var(--warning-soft)] border border-[var(--warning)]/40 text-[var(--warning)] text-xs flex items-center justify-between gap-2">
                  <span>{t('chat.compactWarning', { pct })}</span>
                  <button
                    type="button"
                    disabled={compactMut.isPending}
                    onClick={() => compactMut.mutate(activeThreadId)}
                    className="px-2.5 py-0.5 rounded-lg bg-[var(--warning)] text-white font-medium shrink-0 hover:opacity-90"
                  >
                    {compactMut.isPending ? t('chat.compacting') : t('chat.compactBtn')}
                  </button>
                </div>
              )
            })()}

            {slashMenuOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-2 rounded-2xl popover-glass p-1.5 z-40 max-h-64 overflow-y-auto animate-enter">
                <div className="px-2.5 py-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  <span>{t('chat.slashCommandsTitle')}</span>
                  <button
                    type="button"
                    onMouseDown={e => {
                      e.preventDefault()
                      setActiveView('mcp')
                    }}
                    className="text-[var(--accent)] hover:underline normal-case font-normal"
                  >
                    {t('chat.managePromptsLink')}
                  </button>
                </div>
                {slashCandidates.map((cmd, idx) => (
                  <button
                    key={`${cmd.kind}:${cmd.name}:${idx}`}
                    type="button"
                    onMouseDown={e => {
                      e.preventDefault()
                      applySlashCommand(cmd)
                    }}
                    className={`w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between gap-3 transition ${
                      idx === slashSelectedIdx
                        ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                        : 'hover:bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono font-medium">/{cmd.name}</span>
                      {cmd.kind === 'prompt' && (
                        <span className="px-1.5 py-0.2 rounded bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)]">
                          {t('chat.slashPromptsTitle')}
                        </span>
                      )}
                    </div>
                    {cmd.description && (
                      <span className="text-[11px] text-[var(--text-muted)] truncate">
                        {cmd.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}

            {pendingAttachments.length > 0 && (
              <div className="flex flex-wrap gap-2 pb-1">
                {pendingAttachments.map(att => (
                  <span
                    key={att.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-xs font-mono"
                  >
                    {att.mimeType.startsWith('image/') && daemonConn && (
                      <img
                        src={`http://127.0.0.1:${daemonConn.port}/api/attachments/${att.id}?token=${encodeURIComponent(daemonConn.token)}`}
                        alt={att.fileName}
                        className="w-5 h-5 rounded object-cover"
                      />
                    )}
                    <Paperclip className="w-3 h-3 text-[var(--accent)]" />
                    <span className="max-w-[180px] truncate">{att.fileName}</span>
                    <button
                      onClick={() =>
                        setPendingAttachments(prev => prev.filter(x => x.id !== att.id))
                      }
                      className="text-[var(--text-muted)] hover:text-[var(--danger)]"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              rows={2}
              value={draft}
              onChange={e => {
                setDraft(e.target.value)
                setSlashDismissed(false)
              }}
              onPaste={e => {
                const items = Array.from(e.clipboardData?.files || [])
                if (items.length > 0) {
                  void uploadFiles(items)
                }
              }}
              onKeyDown={e => {
                if (slashMenuOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashSelectedIdx(i => (i + 1) % slashCandidates.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashSelectedIdx(i => (i - 1 + slashCandidates.length) % slashCandidates.length)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSlashDismissed(true)
                    return
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault()
                    const chosen = slashCandidates[slashSelectedIdx] || slashCandidates[0]
                    if (chosen) applySlashCommand(chosen)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={t('chat.inputPlaceholder')}
              className="w-full px-1 bg-transparent resize-none outline-none text-[14px] leading-relaxed placeholder:text-[var(--text-muted)] select-text max-h-44"
            />

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <ModelPickerPopover
                  models={models}
                  value={selectedModel}
                  open={modelPickerOpen}
                  onOpenChange={setModelPickerOpen}
                  onChange={nextModel => {
                    setSelectedModel(nextModel)
                    if (activeThreadId) {
                      updateThreadMut.mutate({ model: nextModel })
                    }
                  }}
                  onOpenProviders={() => setActiveView('providers')}
                />

                <CustomSelect
                  direction="up"
                  value={effort}
                  onChange={val => {
                    const cast = val as '' | 'low' | 'medium' | 'high'
                    setEffort(cast)
                    if (activeThreadId) {
                      updateThreadMut.mutate({ reasoningEffort: cast || null })
                    }
                  }}
                  options={[
                    { value: '', label: t('chat.effortAuto') },
                    { value: 'low', label: t('chat.effortLow') },
                    { value: 'medium', label: t('chat.effortMedium') },
                    { value: 'high', label: t('chat.effortHigh') }
                  ]}
                  className="w-28"
                />

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMcpMenuOpen(v => !v)}
                    className="h-8 px-2.5 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] text-xs inline-flex items-center gap-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                  >
                    <Plug className="w-3.5 h-3.5 text-[var(--accent)]" />
                    <span>MCP</span>
                    {connectedMcpCount > 0 && (
                      <span className="px-1.5 py-0.2 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-mono text-[11px]">
                        {connectedMcpCount}
                      </span>
                    )}
                  </button>
                  {mcpMenuOpen && (
                    <div className="absolute bottom-full mb-2 left-0 w-64 p-2.5 rounded-2xl popover-glass space-y-2 z-30 animate-enter">
                      <div className="font-semibold text-xs px-1 pb-1.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
                        <span>{t('chat.mcpThreadTitle')}</span>
                        <button
                          onClick={() => {
                            setMcpMenuOpen(false)
                            setActiveView('mcp')
                          }}
                          className="text-[11px] text-[var(--accent)] hover:underline font-normal"
                        >
                          {t('common.manage')}
                        </button>
                      </div>
                      {mcpServers.length === 0 ? (
                        <div className="text-xs text-[var(--text-muted)] px-1 py-2">
                          {t('chat.mcpEmpty')}
                        </div>
                      ) : (
                        mcpServers.map(srv => {
                          const currentIds = activeThread?.enabledMcpIds
                          const checked = currentIds ? currentIds.includes(srv.id) : srv.enabled
                          return (
                            <div
                              key={srv.id}
                              className="flex items-center justify-between px-1.5 py-1 rounded-lg hover:bg-[var(--bg-elevated)] text-xs"
                            >
                              <span className="truncate">{srv.name}</span>
                              <Switch
                                checked={checked}
                                onChange={nextChecked => {
                                  if (!activeThread) return
                                  const base =
                                    activeThread.enabledMcpIds ??
                                    mcpServers.filter(s => s.enabled).map(s => s.id)
                                  const next = nextChecked
                                    ? [...new Set([...base, srv.id])]
                                    : base.filter(id => id !== srv.id)
                                  updateThreadMut.mutate({ enabledMcpIds: next })
                                }}
                              />
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>

                {activeThread && !isAcpModel && (
                  <button
                    type="button"
                    onClick={() =>
                      updateThreadMut.mutate({
                        builtinToolsEnabled: activeThread.builtinToolsEnabled === false
                      })
                    }
                    className={`h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1.5 transition ${
                      activeThread.builtinToolsEnabled !== false
                        ? 'bg-[var(--accent-soft)] border-[var(--accent)]/35 text-[var(--accent)]'
                        : 'bg-[var(--bg-surface)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                    title={
                      activeThread.builtinToolsEnabled !== false
                        ? t('chat.builtinToolsOnTitle')
                        : t('chat.builtinToolsOffTitle')
                    }
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    <span>{t('chat.builtinToolsLabel')}</span>
                  </button>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileChange}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 w-8 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                  title={t('chat.attach')}
                >
                  <Paperclip className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-2">
                {liveStatus === 'generating' && activeThreadId && (
                  <button
                    type="button"
                    onClick={() =>
                      sendWs({ type: 'stop_generation', data: { threadId: activeThreadId } })
                    }
                    className="h-8 px-3 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] text-xs font-medium inline-flex items-center gap-1.5 hover:opacity-85 transition"
                  >
                    <Square className="w-3 h-3 fill-current" />
                    <span>{t('chat.stopGeneration')}</span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={!canSend}
                  onClick={() => void handleSend()}
                  className="h-8 w-8 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] disabled:opacity-35 inline-flex items-center justify-center hover:opacity-90 transition shadow-sm"
                  title={t('chat.send')}
                >
                  <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {workspacePanelOpen && activeThreadId && (
        <WorkspacePanel
          threadId={activeThreadId}
          workspacePath={activeThread?.workspacePath || null}
          onClose={() => setWorkspacePanelOpen(false)}
        />
      )}

      {/* Sidebar Thread Right-Click Context Menu */}
      {contextMenu && (
        <div
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
          className="fixed z-50 w-44 p-1.5 rounded-xl popover-glass text-xs space-y-0.5 animate-enter"
        >
          <button
            type="button"
            onClick={() => {
              const th = contextMenu.thread
              setContextMenu(null)
              setSidebarRenamingId(th.id)
              setSidebarRenameInput(th.title)
            }}
            className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-elevated)] flex items-center gap-2"
          >
            <Pencil className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            <span>{t('sidebar.renameThread')}</span>
          </button>
          {!contextMenu.thread.archivedAt && (
            <button
              type="button"
              onClick={() => {
                const th = contextMenu.thread
                setContextMenu(null)
                void apiFetch(`/api/threads/${th.id}`, {
                  method: 'PUT',
                  body: JSON.stringify({ isPinned: !th.isPinned })
                }).then(() => qc.invalidateQueries({ queryKey: ['threads'] }))
              }}
              className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-elevated)] flex items-center gap-2"
            >
              <Pin className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              <span>
                {contextMenu.thread.isPinned ? t('sidebar.unpinThread') : t('sidebar.pinThread')}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              const th = contextMenu.thread
              setContextMenu(null)
              archiveThreadMut.mutate({ id: th.id, archived: !th.archivedAt })
            }}
            className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--bg-elevated)] flex items-center gap-2"
          >
            {contextMenu.thread.archivedAt ? (
              <ArchiveRestore className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            ) : (
              <Archive className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            )}
            <span>
              {contextMenu.thread.archivedAt
                ? t('sidebar.unarchiveThread')
                : t('sidebar.archiveThread')}
            </span>
          </button>
          <div className="my-1 border-t border-[var(--border-subtle)]" />
          <button
            type="button"
            onClick={() => {
              const th = contextMenu.thread
              setContextMenu(null)
              deleteThreadMut.mutate(th.id)
            }}
            className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-[var(--danger-soft)] text-[var(--danger)] flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t('sidebar.deleteThread')}</span>
          </button>
        </div>
      )}

      {/* B9 Execution Trace Modal */}
      {traceModalMsgId && (
        <div
          onClick={() => setTraceModalMsgId(null)}
          className="fixed inset-0 z-50 bg-black/45 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl surface-card p-5 space-y-4 text-xs animate-enter"
          >
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <div className="flex items-center gap-2 font-semibold text-sm">
                <Activity className="w-4 h-4 text-[var(--accent)]" />
                <span>{t('chat.traceTitle')}</span>
              </div>
              <button
                type="button"
                onClick={() => setTraceModalMsgId(null)}
                className="p-1 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {traceError ? (
              <div className="p-3 rounded-xl bg-[var(--bg-code)] text-[var(--text-muted)] font-mono">
                {traceError}
              </div>
            ) : !traceData ? (
              <div className="p-6 text-center text-[var(--text-muted)]">{t('common.loading')}</div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2.5 font-mono">
                  <div className="p-2.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {t('chat.traceModel')}
                    </div>
                    <div className="truncate font-medium mt-0.5">{traceData.model}</div>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {t('chat.traceDuration')} / {t('chat.traceSource')}
                    </div>
                    <div className="font-medium mt-0.5">
                      {traceData.durationMs}ms · {traceData.source}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {t('chat.traceStatus')}
                    </div>
                    <div
                      className={`font-semibold mt-0.5 ${
                        traceData.status === 'success'
                          ? 'text-[var(--success)]'
                          : 'text-[var(--danger)]'
                      }`}
                    >
                      {traceData.status}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)]">
                    <div className="text-[10px] text-[var(--text-muted)]">
                      {t('chat.traceTokens')}
                    </div>
                    <div className="mt-0.5">
                      in {traceData.inputTokens} / out {traceData.outputTokens} / total{' '}
                      {traceData.totalTokens}
                    </div>
                  </div>
                </div>

                {traceData.error && (
                  <div className="p-3 rounded-xl bg-[var(--danger-soft)] border border-[var(--danger)]/30 text-[var(--danger)] font-mono break-all">
                    <div className="text-[10px] font-semibold mb-0.5">{t('chat.traceError')}</div>
                    {traceData.error}
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="font-semibold text-[11px] text-[var(--text-muted)]">
                    {t('chat.traceToolCount', { count: traceData.toolCallCount })}
                  </div>
                  {traceData.toolCalls.length === 0 ? (
                    <div className="text-[var(--text-muted)]">{t('chat.traceNoTools')}</div>
                  ) : (
                    <div className="rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] max-h-44 overflow-y-auto">
                      {traceData.toolCalls.map((tc, idx) => (
                        <div
                          key={tc.toolCallId || idx}
                          className="px-3 py-2 flex items-center justify-between gap-2 font-mono text-[11px]"
                        >
                          <span className="truncate">{tc.title || tc.toolName}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] shrink-0 ${
                              tc.status === 'failed'
                                ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                                : 'bg-[var(--success-soft)] text-[var(--success)]'
                            }`}
                          >
                            {tc.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setTraceModalMsgId(null)}
                className="px-4 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
              >
                {t('chat.traceClose')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
