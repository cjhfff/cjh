import React, { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Activity, Brain, Clock, Cpu, MessageSquare, Moon, PanelLeft, Plug, Radio, Sparkles, Sun, Terminal } from 'lucide-react'
import {
  HERDR_WS_EVENTS,
  type AppSettings,
  type HerdrNotificationDto,
  type PendingPermissionRequestDto,
  type ProviderDto,
  type StoredMessageDto,
  type WsClientMessage
} from '@shared/schemas'
import { apiFetch, DaemonWsClient, getDaemonConnection } from './lib/api'
import { MainViewTab, useWorkspaceStore } from './store/workspace-store'
import { useHerdrStore } from './store/herdr-store'
import { ChatWorkspace } from './components/ChatWorkspace'
import { TerminalsView } from './components/TerminalsView'
import { ProvidersView } from './components/ProvidersView'
import { ExtensionsView } from './components/ExtensionsView'
import { ChannelsView } from './components/ChannelsView'
import { CronView } from './components/CronView'
import { DiagnosticsView } from './components/DiagnosticsView'
import { MemoryView } from './components/MemoryView'
import { OnboardingModal } from './components/OnboardingModal'

export function App() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const wsRef = useRef<DaemonWsClient | null>(null)

  const activeView = useWorkspaceStore(s => s.activeView)
  const setActiveView = useWorkspaceStore(s => s.setActiveView)
  const onboardingOpen = useWorkspaceStore(s => s.onboardingOpen)
  const setOnboardingOpen = useWorkspaceStore(s => s.setOnboardingOpen)
  const setThreadMessages = useWorkspaceStore(s => s.setThreadMessages)
  const upsertMessage = useWorkspaceStore(s => s.upsertMessage)
  const appendDelta = useWorkspaceStore(s => s.appendDelta)
  const upsertToolCallPart = useWorkspaceStore(s => s.upsertToolCallPart)
  const setThreadStatus = useWorkspaceStore(s => s.setThreadStatus)
  const addPermissionRequest = useWorkspaceStore(s => s.addPermissionRequest)
  const removePermissionRequest = useWorkspaceStore(s => s.removePermissionRequest)
  const setThreadCommands = useWorkspaceStore(s => s.setThreadCommands)
  const setThreadMode = useWorkspaceStore(s => s.setThreadMode)
  const setThreadContextUsage = useWorkspaceStore(s => s.setThreadContextUsage)
  const blockedTerminalCount = useHerdrStore(
    s =>
      Object.values(s.terminalsByAddress).filter(
        term => term.state === 'live' && term.status?.state === 'blocked'
      ).length
  )

  const [isDark, setIsDark] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [storageBadge, setStorageBadge] = useState('')

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  const { data: providers } = useQuery<ProviderDto[]>({
    queryKey: ['providers'],
    queryFn: () => apiFetch('/api/providers')
  })

  const checkedAutoOnboardingRef = useRef(false)
  useEffect(() => {
    if (checkedAutoOnboardingRef.current) return
    if (!settings || !providers) return
    checkedAutoOnboardingRef.current = true
    if (settings.general.onboardingCompleted === false) {
      if (providers.length === 0) {
        setOnboardingOpen(true)
      } else {
        void apiFetch('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({ general: { onboardingCompleted: true } })
        }).then(() => qc.invalidateQueries({ queryKey: ['settings'] }))
      }
    }
  }, [settings, providers, setOnboardingOpen, qc])

  useEffect(() => {
    void getDaemonConnection().then(info => {
      setStorageBadge(info.mode === 'portable' ? 'Portable · ./data' : 'Local · WAL')
    })
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault()
        setActiveView('providers')
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarOpen(v => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [setActiveView])

  useEffect(() => {
    if (!settings) return
    const nextDark =
      settings.general.theme === 'dark' ||
      (settings.general.theme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    setIsDark(nextDark)
  }, [settings])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    void window.cjhShell?.setTitleBarTheme(isDark)
  }, [isDark])

  useEffect(() => {
    const offFocus = window.cjhShell?.onFocusTerminal?.((address: string) => {
      useHerdrStore.getState().setSelectedAddress(address)
      setActiveView('terminals')
    })
    return () => {
      offFocus?.()
    }
  }, [setActiveView])

  useEffect(() => {
    const client = new DaemonWsClient(evt => {
      if (useHerdrStore.getState().handleWsEvent(evt)) {
        if (evt.type === HERDR_WS_EVENTS.NOTIFICATION) {
          const dto = evt.data as HerdrNotificationDto
          if (dto?.title) {
            if (window.cjhShell?.showNotification) {
              void window.cjhShell.showNotification({
                title: dto.title,
                body: dto.body || '',
                terminalAddress: dto.address
              })
            } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              const n = new Notification(dto.title, { body: dto.body || '' })
              n.onclick = () => {
                useHerdrStore.getState().setSelectedAddress(dto.address)
                setActiveView('terminals')
              }
            }
          }
        }
        return
      }
      switch (evt.type) {
        case 'message_added':
        case 'message_updated':
          upsertMessage(evt.data as StoredMessageDto)
          break
        case 'thread_messages_replaced': {
          const d = evt.data as { threadId: string; messages: StoredMessageDto[] }
          if (d.threadId && Array.isArray(d.messages)) {
            setThreadMessages(d.threadId, d.messages)
          }
          break
        }
        case 'message_delta': {
          const d = evt.data as {
            threadId: string
            messageId: string
            partType: 'text' | 'reasoning'
            delta: string
          }
          appendDelta(d.threadId, d.messageId, d.partType, d.delta)
          break
        }
        case 'tool_call_start':
        case 'tool_call_update':
          upsertToolCallPart(evt.data as any)
          break
        case 'thread_status_changed': {
          const d = evt.data as { threadId: string; status: any }
          setThreadStatus(d.threadId, d.status)
          break
        }
        case 'permission_requested':
          addPermissionRequest(evt.data as PendingPermissionRequestDto)
          break
        case 'permission_resolved': {
          const d = evt.data as { requestId: string; threadId: string }
          removePermissionRequest(d.threadId, d.requestId)
          break
        }
        case 'acp_commands_updated': {
          const d = evt.data as {
            threadId: string
            commands: Array<{ name: string; description?: string }>
          }
          setThreadCommands(d.threadId, d.commands)
          break
        }
        case 'acp_mode_updated': {
          const d = evt.data as {
            threadId: string
            currentModeId: string
            availableModes?: Array<{ id: string; name: string; description?: string }>
          }
          if (d.threadId && d.currentModeId) {
            setThreadMode(d.threadId, {
              currentModeId: d.currentModeId,
              availableModes: d.availableModes || []
            })
          }
          break
        }
        case 'context_usage_update': {
          const d = evt.data as {
            threadId: string
            used: number
            size: number
          }
          if (d.threadId) {
            setThreadContextUsage(d.threadId, { used: d.used, size: d.size })
          }
          break
        }
        case 'thread_created':
        case 'thread_updated':
        case 'thread_deleted':
        case 'title_generated':
          void qc.invalidateQueries({ queryKey: ['threads'] })
          break
        case 'provider_updated':
        case 'provider_deleted':
          void qc.invalidateQueries({ queryKey: ['providers'] })
          void qc.invalidateQueries({ queryKey: ['models'] })
          break
        case 'mcp_status_changed':
          void qc.invalidateQueries({ queryKey: ['mcp-servers'] })
          break
        case 'cron_job_updated':
          void qc.invalidateQueries({ queryKey: ['cron-jobs'] })
          break
        case 'cron_run_updated':
          void qc.invalidateQueries({ queryKey: ['cron-runs'] })
          break
        case 'prompts_updated':
          void qc.invalidateQueries({ queryKey: ['prompts'] })
          break
        case 'memories_updated':
          void qc.invalidateQueries({ queryKey: ['memories'] })
          break
        case 'channel_status_updated':
          void qc.invalidateQueries({ queryKey: ['feishu-status'] })
          void qc.invalidateQueries({ queryKey: ['feishu-mappings'] })
          void qc.invalidateQueries({ queryKey: ['feishu-chats'] })
          break
        case 'generation_completed':
          void qc.invalidateQueries({ queryKey: ['usage'] })
          break
        default:
          break
      }
    })

    wsRef.current = client
    void client.connect()
    return () => client.dispose()
  }, [
    qc,
    setThreadMessages,
    upsertMessage,
    appendDelta,
    upsertToolCallPart,
    setThreadStatus,
    addPermissionRequest,
    removePermissionRequest,
    setThreadCommands,
    setThreadMode,
    setThreadContextUsage
  ])

  const sendWs = (msg: WsClientMessage) => {
    wsRef.current?.send(msg)
  }

  const toggleTheme = async () => {
    const next = !isDark
    setIsDark(next)
    await apiFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ general: { theme: next ? 'dark' : 'light', language: 'zh-CN' } })
    })
    void qc.invalidateQueries({ queryKey: ['settings'] })
  }

  const tabs: Array<{ id: MainViewTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'chat', label: t('nav.workspace'), icon: <MessageSquare className="w-3.5 h-3.5" /> },
    {
      id: 'terminals',
      label: t('nav.terminals'),
      icon: <Terminal className="w-3.5 h-3.5" />,
      badge: blockedTerminalCount > 0 ? blockedTerminalCount : undefined
    },
    { id: 'providers', label: t('nav.providers'), icon: <Cpu className="w-3.5 h-3.5" /> },
    { id: 'mcp', label: t('nav.extensions'), icon: <Plug className="w-3.5 h-3.5" /> },
    { id: 'memory', label: t('nav.memory'), icon: <Brain className="w-3.5 h-3.5" /> },
    { id: 'cron', label: t('nav.cron'), icon: <Clock className="w-3.5 h-3.5" /> },
    { id: 'channels', label: t('nav.channels'), icon: <Radio className="w-3.5 h-3.5" /> },
    { id: 'system', label: t('nav.diagnostics'), icon: <Activity className="w-3.5 h-3.5" /> }
  ]

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--bg-canvas)] text-[var(--text-primary)] overflow-hidden">
      {/* Seamless Velvet Titlebar */}
      <header className="h-10 pl-3 pr-36 bg-[var(--bg-sidebar)] border-b border-[var(--border-subtle)] flex items-center justify-between text-xs shrink-0 app-drag-region">
        <div className="flex items-center gap-2 app-no-drag">
          {activeView === 'chat' && (
              <button
                onClick={() => setSidebarOpen(v => !v)}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition"
                title={t('app.toggleSidebarTitle')}
              >
              <PanelLeft className="w-4 h-4" />
            </button>
          )}
          <div className="flex items-center gap-2 pl-0.5">
            <div className="w-5 h-5 rounded-md bg-gradient-to-br from-[#8b5cf6] to-[#4f46e5] text-white flex items-center justify-center shadow-xs">
              <Sparkles className="w-3 h-3" />
            </div>
            <span className="font-semibold tracking-tight text-[13px]">{t('app.name')}</span>
          </div>
        </div>

        {/* Segmented Glass Navigation Pill */}
        <nav className="flex items-center p-0.5 rounded-xl bg-[var(--bg-canvas)]/75 border border-[var(--border-subtle)] app-no-drag">
          {tabs.map(tab => {
            const active = activeView === tab.id
            return (
              <button
                key={tab.id}
                onClick={() => setActiveView(tab.id)}
                className={`px-3 py-1 rounded-lg inline-flex items-center gap-1.5 text-xs font-medium transition-all duration-150 ${
                  active
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-xs border border-[var(--border-subtle)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent'
                }`}
              >
                <span className={active ? 'text-[var(--accent)]' : ''}>{tab.icon}</span>
                <span>{tab.label}</span>
                {tab.badge ? (
                  <span className="px-1.5 py-0.2 rounded-full bg-[var(--danger)] text-white text-[10px] leading-4 font-semibold">
                    {tab.badge}
                  </span>
                ) : null}
              </button>
            )
          })}
        </nav>

        {/* Subtle Status & Theme Toggle */}
        <div className="flex items-center gap-2 app-no-drag">
          {storageBadge && (
            <span className="hidden md:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--bg-canvas)]/60 border border-[var(--border-subtle)] text-[11px] text-[var(--text-muted)] font-mono">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)]" />
              {storageBadge}
            </span>
          )}
          <button
            onClick={() => void toggleTheme()}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
            title={t('app.toggleThemeTitle')}
          >
            {isDark ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
          </button>
        </div>
      </header>

      {activeView === 'chat' && <ChatWorkspace sendWs={sendWs} sidebarOpen={sidebarOpen} />}
      {activeView === 'terminals' && <TerminalsView />}
      {activeView === 'providers' && <ProvidersView />}
      {activeView === 'mcp' && <ExtensionsView />}
      {activeView === 'memory' && <MemoryView />}
      {activeView === 'cron' && <CronView />}
      {activeView === 'channels' && <ChannelsView />}
      {activeView === 'system' && <DiagnosticsView />}

      <OnboardingModal
        open={Boolean(onboardingOpen)}
        onClose={() => setOnboardingOpen(false)}
      />
    </div>
  )
}
