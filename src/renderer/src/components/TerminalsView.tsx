import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Check,
  Copy,
  CornerDownLeft,
  Cpu,
  FolderOpen,
  FolderSearch,
  Link2,
  Loader2,
  PauseCircle,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Terminal,
  Trash2,
  Unlink,
  Upload,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type {
  AppSettings,
  HerdrClientStatusDto,
  HerdrFollowBindingDto,
  HerdrReadResult,
  HerdrTerminal,
  HerdrTerminalListResponseDto
} from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { useHerdrStore } from '../store/herdr-store'
import { CustomSelect, Switch } from './ui/primitives'

// ==================== ANSI & Text Helpers ====================

const ANSI_16_COLORS: string[] = [
  '#3f3f46', // 0 black (readable on dark bg)
  '#ef4444', // 1 red
  '#10b981', // 2 green
  '#f59e0b', // 3 yellow
  '#3b82f6', // 4 blue
  '#a855f7', // 5 magenta
  '#06b6d4', // 6 cyan
  '#e4e4e7', // 7 white
  '#71717a', // 8 bright black
  '#f87171', // 9 bright red
  '#34d399', // 10 bright green
  '#fbbf24', // 11 bright yellow
  '#60a5fa', // 12 bright blue
  '#c084fc', // 13 bright magenta
  '#22d3ee', // 14 bright cyan
  '#fafafa'  // 15 bright white
]

function colorFrom256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined
  if (n < 16) return ANSI_16_COLORS[n]
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  const idx = n - 16
  const r = Math.floor(idx / 36)
  const g = Math.floor((idx % 36) / 6)
  const b = idx % 6
  const map = [0, 95, 135, 175, 215, 255]
  return `rgb(${map[r]}, ${map[g]}, ${map[b]})`
}

interface AnsiStyleState {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function applySgrCodes(codes: number[], prev: AnsiStyleState): AnsiStyleState {
  if (codes.length === 0) return {}
  let next: AnsiStyleState = { ...prev }
  let i = 0
  while (i < codes.length) {
    const c = codes[i]
    if (c === 0) {
      next = {}
    } else if (c === 1) {
      next.bold = true
    } else if (c === 2) {
      next.dim = true
    } else if (c === 3) {
      next.italic = true
    } else if (c === 4) {
      next.underline = true
    } else if (c === 22) {
      next.bold = false
      next.dim = false
    } else if (c === 23) {
      next.italic = false
    } else if (c === 24) {
      next.underline = false
    } else if (c >= 30 && c <= 37) {
      next.fg = ANSI_16_COLORS[c - 30]
    } else if (c === 39) {
      next.fg = undefined
    } else if (c >= 90 && c <= 97) {
      next.fg = ANSI_16_COLORS[c - 90 + 8]
    } else if (c >= 40 && c <= 47) {
      next.bg = ANSI_16_COLORS[c - 40]
    } else if (c === 49) {
      next.bg = undefined
    } else if (c >= 100 && c <= 107) {
      next.bg = ANSI_16_COLORS[c - 100 + 8]
    } else if (c === 38 || c === 48) {
      const isFg = c === 38
      const mode = codes[i + 1]
      if (mode === 5 && codes[i + 2] !== undefined) {
        const col = colorFrom256(codes[i + 2])
        if (isFg) next.fg = col
        else next.bg = col
        i += 2
      } else if (mode === 2 && codes[i + 4] !== undefined) {
        const col = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`
        if (isFg) next.fg = col
        else next.bg = col
        i += 4
      }
    }
    i++
  }
  return next
}

function sanitizeControlChars(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Strip OSC sequences (\x1b]...\x07 or \x1b]...\x1b\\)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Strip DCS / APC / PM / SOS sequences
    .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
    // Strip non-SGR CSI sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-ln-z~@]/g, '')
    // Strip single-char ESC sequences
    .replace(/\x1b[@-Z\\-_]/g, '')
}

function stripAnsi(raw: string): string {
  return sanitizeControlChars(raw).replace(/\x1b\[[0-9;]*m/g, '')
}

function renderAnsiContent(raw: string): React.ReactNode {
  const cleaned = sanitizeControlChars(raw)
  const sgrRe = /\x1b\[([0-9;]*)m/g
  const nodes: React.ReactNode[] = []
  let style: AnsiStyleState = {}
  let lastIndex = 0
  let key = 0

  const pushChunk = (text: string, st: AnsiStyleState) => {
    if (!text) return
    const hasStyle = st.fg || st.bg || st.bold || st.dim || st.italic || st.underline
    if (!hasStyle) {
      nodes.push(text)
    } else {
      nodes.push(
        <span
          key={key++}
          style={{
            color: st.fg,
            backgroundColor: st.bg,
            fontWeight: st.bold ? 600 : undefined,
            opacity: st.dim ? 0.65 : undefined,
            fontStyle: st.italic ? 'italic' : undefined,
            textDecoration: st.underline ? 'underline' : undefined
          }}
        >
          {text}
        </span>
      )
    }
  }

  let match: RegExpExecArray | null
  while ((match = sgrRe.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      pushChunk(cleaned.slice(lastIndex, match.index), style)
    }
    const rawParams = match[1]
    const codes = rawParams
      ? rawParams.split(';').map(s => (s === '' ? 0 : Number.parseInt(s, 10))).filter(n => !Number.isNaN(n))
      : [0]
    style = applySgrCodes(codes, style)
    lastIndex = sgrRe.lastIndex
  }
  if (lastIndex < cleaned.length) {
    pushChunk(cleaned.slice(lastIndex), style)
  }

  return nodes.length > 0 ? nodes : cleaned
}

interface ParsedOption {
  index: number
  label: string
}

function parseBlockedOptions(screenText: string): ParsedOption[] {
  const plain = stripAnsi(screenText)
  const lines = plain.split('\n').slice(-35)
  const found: ParsedOption[] = []
  const seen = new Set<number>()
  const re = /^\s*(?:[❯>▸●•]\s*)?(\d+)[.)、]\s+(.+)$/
  for (const line of lines) {
    const m = re.exec(line)
    if (!m) continue
    const idx = Number.parseInt(m[1], 10)
    const label = m[2].trim()
    if (!Number.isFinite(idx) || idx < 1 || idx > 20 || !label) continue
    if (!seen.has(idx)) {
      seen.add(idx)
      found.push({ index: idx, label })
    }
  }
  return found
}

function getFolderBasename(cwdPath: string): string {
  if (!cwdPath) return ''
  const normalized = cwdPath.replace(/[\\/]+$/, '')
  if (!normalized) return cwdPath
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

function inferAgentKey(term: HerdrTerminal): string {
  if (term.agent) return term.agent
  const app = term.status?.app?.toLowerCase()
  if (app === 'antigravity' || app === 'agy') return 'agy'
  if (app === 'codex' || app === 'claude' || app === 'pi') return app
  const cmd = (term.foreground?.argv?.[0] || term.argv?.[0] || term.template || '').toLowerCase()
  if (cmd.includes('agy') || cmd.includes('antigravity')) return 'agy'
  if (cmd.includes('codex')) return 'codex'
  if (cmd.includes('claude')) return 'claude'
  if (/(^|[\\/])pi(\.exe)?$/.test(cmd)) return 'pi'
  return 'shell'
}

function renderAgentBadge(agent: string) {
  const normalized = agent.toLowerCase()
  let Icon = SquareTerminal
  let cls = 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
  if (normalized === 'agy' || normalized === 'antigravity') {
    Icon = Sparkles
    cls = 'bg-[var(--accent-soft)] text-[var(--accent)]'
  } else if (normalized === 'codex') {
    Icon = Cpu
    cls = 'bg-[var(--success-soft)] text-[var(--success)]'
  } else if (normalized === 'claude') {
    Icon = Bot
    cls = 'bg-[var(--warning-soft)] text-[var(--warning)]'
  } else if (normalized === 'pi') {
    Icon = Terminal
    cls = 'bg-sky-500/12 text-sky-500'
  }
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-mono font-medium shrink-0 ${cls}`}>
      <Icon className="w-3 h-3" />
      <span>{normalized}</span>
    </span>
  )
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const commaIdx = result.indexOf(',')
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

// ==================== Main View ====================

export function TerminalsView() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const storeStatus = useHerdrStore(s => s.status)
  const terminalsByAddress = useHerdrStore(s => s.terminalsByAddress)
  const selectedAddress = useHerdrStore(s => s.selectedAddress)
  const followsByTerminal = useHerdrStore(s => s.followsByTerminal)
  const setStatus = useHerdrStore(s => s.setStatus)
  const setTerminals = useHerdrStore(s => s.setTerminals)
  const upsertTerminal = useHerdrStore(s => s.upsertTerminal)
  const removeTerminal = useHerdrStore(s => s.removeTerminal)
  const setSelectedAddress = useHerdrStore(s => s.setSelectedAddress)
  const setFollows = useHerdrStore(s => s.setFollows)

  const [showFinished, setShowFinished] = useState(false)
  const [historyLines, setHistoryLines] = useState<number>(0)
  const [execPathInput, setExecPathInput] = useState('')
  const [execPathSaved, setExecPathSaved] = useState(false)
  const [actionFeedback, setActionFeedback] = useState<{ ok: boolean; text: string } | null>(null)
  const [copiedScreen, setCopiedScreen] = useState(false)
  const [confirmKillAddr, setConfirmKillAddr] = useState<string | null>(null)
  const [sendText, setSendText] = useState('')
  const [forceSend, setForceSend] = useState(false)
  const [blockedReply, setBlockedReply] = useState('')

  // Create Terminal Modal State
  const [createOpen, setCreateOpen] = useState(false)
  const [newAgent, setNewAgent] = useState<'agy' | 'codex' | 'claude' | 'pi' | 'shell' | 'custom'>('agy')
  const [newCustomCmd, setNewCustomCmd] = useState('')
  const [newCwd, setNewCwd] = useState('')
  const [newName, setNewName] = useState('')
  const [newTask, setNewTask] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const screenBoxRef = useRef<HTMLPreElement>(null)
  const shouldStickBottomRef = useRef(true)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  useEffect(() => {
    if (settings?.herdr?.execPath !== undefined) {
      setExecPathInput(settings.herdr.execPath || '')
    }
  }, [settings?.herdr?.execPath])

  const statusQuery = useQuery<HerdrClientStatusDto>({
    queryKey: ['herdr-status'],
    queryFn: () => apiFetch('/api/herdr/status'),
    refetchInterval: 10000
  })

  useEffect(() => {
    if (statusQuery.data) {
      setStatus(statusQuery.data)
    }
  }, [statusQuery.data, setStatus])

  const terminalsQuery = useQuery<HerdrTerminalListResponseDto>({
    queryKey: ['herdr-terminals', showFinished],
    queryFn: () => apiFetch(`/api/herdr/terminals?all=${showFinished ? 1 : 0}`),
    refetchInterval: 8000
  })

  useEffect(() => {
    if (terminalsQuery.data?.terminals) {
      setTerminals(terminalsQuery.data.terminals)
    }
  }, [terminalsQuery.data, setTerminals])

  const followsQuery = useQuery<HerdrFollowBindingDto[] | { follows: HerdrFollowBindingDto[] }>({
    queryKey: ['herdr-follows'],
    queryFn: () => apiFetch('/api/herdr/follows'),
    refetchInterval: 10000
  })

  useEffect(() => {
    if (!followsQuery.data) return
    const list = Array.isArray(followsQuery.data)
      ? followsQuery.data
      : Array.isArray(followsQuery.data.follows)
        ? followsQuery.data.follows
        : []
    setFollows(list)
  }, [followsQuery.data, setFollows])

  const effectiveStatus = storeStatus ?? statusQuery.data ?? null

  const visibleTerminals = useMemo(() => {
    const all = Object.values(terminalsByAddress)
    const filtered = showFinished ? all : all.filter(term => term.state !== 'finished')
    return filtered.sort((a, b) => {
      const aLive = a.state === 'live' ? 0 : 1
      const bLive = b.state === 'live' ? 0 : 1
      if (aLive !== bLive) return aLive - bLive
      return a.address.localeCompare(b.address, undefined, { numeric: true })
    })
  }, [terminalsByAddress, showFinished])

  useEffect(() => {
    if (visibleTerminals.length === 0) return
    if (!selectedAddress || !terminalsByAddress[selectedAddress]) {
      setSelectedAddress(visibleTerminals[0].address)
    }
  }, [visibleTerminals, selectedAddress, terminalsByAddress, setSelectedAddress])

  const selectedTerminal = selectedAddress ? terminalsByAddress[selectedAddress] || null : null

  const workspaceGroups = useMemo(() => {
    const groups = new Map<string, HerdrTerminal[]>()
    for (const term of visibleTerminals) {
      const key = term.foreground?.cwd || term.cwd || ''
      const arr = groups.get(key) || []
      arr.push(term)
      groups.set(key, arr)
    }
    return [...groups.entries()]
  }, [visibleTerminals])

  const counts = useMemo(() => {
    let live = 0
    let working = 0
    let blocked = 0
    for (const term of Object.values(terminalsByAddress)) {
      if (term.state === 'live') {
        live++
        if (term.status?.state === 'working') working++
        if (term.status?.state === 'blocked') blocked++
      }
    }
    return { live, working, blocked }
  }, [terminalsByAddress])

  const isSelectedWorking =
    Boolean(selectedTerminal) &&
    selectedTerminal!.state === 'live' &&
    selectedTerminal!.status?.state === 'working'

  const screenQuery = useQuery<HerdrReadResult>({
    queryKey: ['herdr-screen', selectedTerminal?.address, historyLines],
    queryFn: () =>
      apiFetch(
        `/api/herdr/terminals/${encodeURIComponent(selectedTerminal!.address)}/screen?lines=${historyLines}`
      ),
    enabled: Boolean(selectedTerminal?.address && effectiveStatus?.available !== false),
    refetchInterval: isSelectedWorking ? 1500 : false
  })

  // Auto-refresh screen whenever terminal status / turn / state changes
  const terminalVersionKey = selectedTerminal
    ? `${selectedTerminal.address}:${selectedTerminal.state}:${selectedTerminal.turn}:${selectedTerminal.status?.state ?? ''}:${selectedTerminal.status_ms ?? ''}`
    : ''
  const prevVersionRef = useRef<{ addr: string; key: string }>({ addr: '', key: '' })
  useEffect(() => {
    if (!selectedTerminal || !terminalVersionKey) return
    if (
      prevVersionRef.current.addr === selectedTerminal.address &&
      prevVersionRef.current.key !== terminalVersionKey
    ) {
      void screenQuery.refetch()
    }
    prevVersionRef.current = { addr: selectedTerminal.address, key: terminalVersionKey }
  }, [selectedTerminal, terminalVersionKey, screenQuery.refetch])

  // Track scroll position & auto-scroll when near bottom
  const handleScreenScroll = () => {
    const el = screenBoxRef.current
    if (!el) return
    shouldStickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
  }

  useEffect(() => {
    shouldStickBottomRef.current = true
  }, [selectedTerminal?.address])

  useEffect(() => {
    const el = screenBoxRef.current
    if (!el || !shouldStickBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }, [screenQuery.data?.text, selectedTerminal?.address])

  // Reset inline states when switching terminal
  useEffect(() => {
    setConfirmKillAddr(null)
    setBlockedReply('')
    setActionFeedback(null)
  }, [selectedTerminal?.address])

  const showFeedback = (ok: boolean, text: string) => {
    setActionFeedback({ ok, text })
    window.setTimeout(() => {
      setActionFeedback(curr => (curr?.text === text ? null : curr))
    }, 3000)
  }

  const refreshAll = () => {
    void statusQuery.refetch()
    void terminalsQuery.refetch()
    void followsQuery.refetch()
    if (selectedTerminal) void screenQuery.refetch()
  }

  // ==================== Mutations ====================

  const saveExecPathMut = useMutation({
    mutationFn: () =>
      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ herdr: { execPath: execPathInput.trim() } })
      }),
    onSuccess: () => {
      setExecPathSaved(true)
      window.setTimeout(() => setExecPathSaved(false), 2000)
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void statusQuery.refetch()
      void terminalsQuery.refetch()
    }
  })

  const muteMut = useMutation({
    mutationFn: ({ address, muted }: { address: string; muted: boolean }) =>
      apiFetch<{ terminal: HerdrTerminal; muted: boolean }>(
        `/api/herdr/terminals/${encodeURIComponent(address)}/mute`,
        {
          method: 'POST',
          body: JSON.stringify({ muted })
        }
      ),
    onSuccess: res => {
      if (res?.terminal) upsertTerminal(res.terminal)
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const unfollowMut = useMutation({
    mutationFn: (address: string) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}/follow`, {
        method: 'DELETE'
      }),
    onSuccess: () => {
      void followsQuery.refetch()
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const sendMut = useMutation({
    mutationFn: ({ address, text, force }: { address: string; text: string; force: boolean }) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}/send`, {
        method: 'POST',
        body: JSON.stringify({ text, force })
      }),
    onSuccess: () => {
      setSendText('')
      showFeedback(true, t('terminals.actionSent'))
      void screenQuery.refetch()
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const keysMut = useMutation({
    mutationFn: ({ address, keys }: { address: string; keys: string[] }) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}/keys`, {
        method: 'POST',
        body: JSON.stringify({ keys })
      }),
    onSuccess: () => {
      void screenQuery.refetch()
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const interruptMut = useMutation({
    mutationFn: (address: string) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}/interrupt`, {
        method: 'POST',
        body: JSON.stringify({})
      }),
    onSuccess: () => {
      void screenQuery.refetch()
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const answerMut = useMutation({
    mutationFn: ({ address, choice, text }: { address: string; choice?: number; text?: string }) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}/answer`, {
        method: 'POST',
        body: JSON.stringify(choice !== undefined ? { choice } : { text })
      }),
    onSuccess: () => {
      setBlockedReply('')
      showFeedback(true, t('terminals.actionSent'))
      void screenQuery.refetch()
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const killMut = useMutation({
    mutationFn: (address: string) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}?confirm=1`, {
        method: 'DELETE'
      }),
    onSuccess: () => {
      setConfirmKillAddr(null)
      void terminalsQuery.refetch()
      void screenQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const removeMut = useMutation({
    mutationFn: (address: string) =>
      apiFetch(`/api/herdr/terminals/${encodeURIComponent(address)}/rm`, {
        method: 'POST'
      }),
    onSuccess: (_res, address) => {
      removeTerminal(address)
      void terminalsQuery.refetch()
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const putFileMut = useMutation({
    mutationFn: async ({ address, file }: { address: string; file: File }) => {
      const data = await fileToBase64(file)
      return apiFetch<{ path: string; bytes: number }>(
        `/api/herdr/terminals/${encodeURIComponent(address)}/put`,
        {
          method: 'POST',
          body: JSON.stringify({ name: file.name, data })
        }
      )
    },
    onSuccess: res => {
      showFeedback(true, `${t('terminals.actionSent')} → ${res.path}`)
    },
    onError: err => {
      showFeedback(false, t('terminals.actionFailed', { msg: err instanceof Error ? err.message : String(err) }))
    }
  })

  const createMut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        agent: newAgent
      }
      if (newAgent === 'custom') {
        body.line = newCustomCmd.trim()
      }
      if (newCwd.trim()) body.cwd = newCwd.trim()
      if (newName.trim()) body.name = newName.trim()
      if (newTask.trim()) body.task = newTask.trim()
      return apiFetch<HerdrTerminal>('/api/herdr/terminals', {
        method: 'POST',
        body: JSON.stringify(body)
      })
    },
    onSuccess: created => {
      upsertTerminal(created)
      setSelectedAddress(created.address)
      setCreateOpen(false)
      setNewCustomCmd('')
      setNewName('')
      setNewTask('')
      setCreateError(null)
      void terminalsQuery.refetch()
    },
    onError: err => {
      setCreateError(err instanceof Error ? err.message : String(err))
    }
  })

  // ==================== Status Badge Renderer ====================

  const renderStatusBadge = (term: HerdrTerminal) => {
    if (term.state === 'finished') {
      const codeStr =
        term.exit_code !== null && term.exit_code !== undefined ? ` (${term.exit_code})` : ''
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-muted)] text-[10px] font-medium shrink-0">
          <span>
            {t('terminals.statusFinished')}
            {codeStr}
          </span>
        </span>
      )
    }

    const st = term.status?.state
    if (st === 'working') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500 text-[10px] font-medium shrink-0">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{t('terminals.statusWorking')}</span>
        </span>
      )
    }
    if (st === 'blocked') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--danger-soft)] text-[var(--danger)] text-[10px] font-medium shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--danger)] animate-pulse" />
          <span>{t('terminals.statusBlocked')}</span>
        </span>
      )
    }
    if (st === 'done') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--success-soft)] text-[var(--success)] text-[10px] font-medium shrink-0">
          <span>{t('terminals.statusDone')}</span>
        </span>
      )
    }
    if (st === 'error') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--warning-soft)] text-[var(--warning)] text-[10px] font-medium shrink-0">
          <span>{t('terminals.statusError')}</span>
        </span>
      )
    }
    if (st === 'idle') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-muted)] text-[10px] font-medium shrink-0">
          <span>{t('terminals.statusIdle')}</span>
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-secondary)] text-[10px] font-medium shrink-0">
        <span>{t('terminals.statusUnknown')}</span>
      </span>
    )
  }

  // ==================== Selected Terminal Derived Values ====================

  const selectedScreenText = screenQuery.data?.text ?? selectedTerminal?.screen ?? ''
  const selectedPlainScreen = useMemo(() => stripAnsi(selectedScreenText), [selectedScreenText])
  const blockedOptions = useMemo(() => {
    if (!selectedTerminal || selectedTerminal.state !== 'live' || selectedTerminal.status?.state !== 'blocked') {
      return []
    }
    return parseBlockedOptions(selectedScreenText)
  }, [selectedTerminal, selectedScreenText])

  // ==================== Unavailable State ====================

  if (effectiveStatus && !effectiveStatus.available) {
    return (
      <div
        className="flex-1 overflow-y-auto p-8 select-text"
        style={{ backgroundImage: 'var(--ambient-glow)' }}
      >
        <div className="max-w-2xl mx-auto mt-8 p-6 rounded-2xl surface-card space-y-5 text-xs animate-enter">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-[var(--warning-soft)] text-[var(--warning)] flex items-center justify-center shrink-0">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="space-y-1 min-w-0">
              <h3 className="text-base font-semibold tracking-tight">
                {t('terminals.unavailableTitle')}
              </h3>
              <p className="text-[var(--text-secondary)] leading-relaxed">
                {t('terminals.unavailableDesc')}
              </p>
            </div>
          </div>

          {effectiveStatus.reason && (
            <div className="px-3.5 py-2.5 rounded-xl bg-[var(--danger-soft)] border border-[var(--danger)]/20 text-[var(--danger)] font-mono break-all">
              <span className="font-semibold">{t('terminals.unavailableReason')}: </span>
              {effectiveStatus.reason}
            </div>
          )}

          <div className="p-4 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] space-y-2">
            <div className="font-semibold text-[var(--text-primary)]">
              {t('terminals.unavailableInstallTitle')}
            </div>
            <div className="space-y-1 text-[var(--text-secondary)] leading-relaxed">
              <p>{t('terminals.unavailableInstallStep1')}</p>
              <p className="font-mono text-[11px]">{t('terminals.unavailableInstallStep2')}</p>
              <p>{t('terminals.unavailableInstallStep3')}</p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="font-medium text-[var(--text-secondary)]">
              {t('terminals.execPathLabel')}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                value={execPathInput}
                onChange={e => setExecPathInput(e.target.value)}
                placeholder={t('terminals.execPathPlaceholder')}
                className="flex-1 min-w-[220px] px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
              {window.cjhShell && (
                <button
                  type="button"
                  onClick={async () => {
                    const picked = await window.cjhShell!.pickFile()
                    if (picked) setExecPathInput(picked)
                  }}
                  className="px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition"
                >
                  <FolderSearch className="w-3.5 h-3.5" />
                  <span>{t('common.browse')}</span>
                </button>
              )}
              <button
                type="button"
                disabled={saveExecPathMut.isPending}
                onClick={() => saveExecPathMut.mutate()}
                className="px-3.5 py-2 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium inline-flex items-center gap-1.5 transition"
              >
                {execPathSaved && <Check className="w-3.5 h-3.5 text-[var(--success)]" />}
                <span>{t('terminals.saveExecPath')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void statusQuery.refetch()
                  void terminalsQuery.refetch()
                }}
                className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
                <span>{t('terminals.retryConnect')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const selectedFollow = selectedTerminal
    ? followsByTerminal[selectedTerminal.address] ||
      (selectedTerminal.followedByThreadId
        ? { terminal: selectedTerminal.address, threadId: selectedTerminal.followedByThreadId }
        : null)
    : null

  const selectedMuted = selectedTerminal
    ? Boolean(selectedTerminal.muted || selectedTerminal.labels?.['cjh.mute'] === '1')
    : false

  const selectedCwd = selectedTerminal ? selectedTerminal.foreground?.cwd || selectedTerminal.cwd : ''

  const handleCopyScreen = () => {
    if (!selectedPlainScreen) return
    void navigator.clipboard.writeText(selectedPlainScreen)
    setCopiedScreen(true)
    window.setTimeout(() => setCopiedScreen(false), 1600)
  }

  const handleSendSubmit = () => {
    const trimmed = sendText.trim()
    if (!selectedTerminal || !trimmed || sendMut.isPending) return
    sendMut.mutate({ address: selectedTerminal.address, text: trimmed, force: forceSend })
  }

  const handleUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !selectedTerminal) return
    putFileMut.mutate({ address: selectedTerminal.address, file })
  }

  const blockedKindLabel = (kind?: string | null) => {
    if (kind === 'permission') return t('terminals.blockedKindPermission')
    if (kind === 'question') return t('terminals.blockedKindQuestion')
    if (kind === 'auth') return t('terminals.blockedKindAuth')
    return kind || t('terminals.statusBlocked')
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Left Pane: Terminal List Grouped by Workspace / cwd */}
      <aside className="w-80 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] flex flex-col shrink-0 min-h-0">
        {/* Header */}
        <div className="p-4 border-b border-[var(--border-subtle)] space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <SquareTerminal className="w-4 h-4 text-[var(--accent)] shrink-0" />
              <h3 className="text-sm font-semibold tracking-tight truncate">
                {t('terminals.title')}
              </h3>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={refreshAll}
                className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition"
                title={t('terminals.refresh')}
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${
                    terminalsQuery.isFetching || statusQuery.isFetching ? 'animate-spin' : ''
                  }`}
                />
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreateError(null)
                  setCreateOpen(true)
                }}
                className="px-2.5 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium inline-flex items-center gap-1 hover:opacity-90 transition shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('terminals.newTerminal')}</span>
              </button>
            </div>
          </div>

          {/* Live / Working / Blocked Counts + Show Finished */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-[var(--border-subtle)] text-[var(--text-secondary)]">
                {t('terminals.liveCount', { count: counts.live })}
              </span>
              {counts.working > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-500 font-medium">
                  {t('terminals.workingCount', { count: counts.working })}
                </span>
              )}
              {counts.blocked > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-[var(--danger-soft)] text-[var(--danger)] font-medium">
                  {t('terminals.blockedCount', { count: counts.blocked })}
                </span>
              )}
            </div>

            <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
              <span>{t('terminals.showFinished')}</span>
              <Switch checked={showFinished} onChange={setShowFinished} />
            </label>
          </div>
        </div>

        {/* Grouped Terminal List */}
        <div className="flex-1 overflow-y-auto p-2.5 space-y-4">
          {visibleTerminals.length === 0 ? (
            <div className="p-6 text-center space-y-2 text-xs">
              <div className="w-9 h-9 mx-auto rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
                <Terminal className="w-4 h-4" />
              </div>
              <div className="font-medium text-[var(--text-primary)]">{t('terminals.emptyTitle')}</div>
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                {t('terminals.emptyDesc')}
              </p>
            </div>
          ) : (
            workspaceGroups.map(([cwdKey, items]) => {
              const folderName = getFolderBasename(cwdKey) || t('terminals.workspaceUnknown')
              return (
                <div key={cwdKey || '__unknown__'} className="space-y-1">
                  <div
                    className="px-2 py-1 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"
                    title={cwdKey || t('terminals.workspaceUnknown')}
                  >
                    <FolderOpen className="w-3 h-3 shrink-0" />
                    <span className="font-semibold text-[var(--text-secondary)] truncate">
                      {folderName}
                    </span>
                    {cwdKey && (
                      <span className="font-mono text-[10px] truncate opacity-70">{cwdKey}</span>
                    )}
                  </div>

                  {items.map(term => {
                    const active = term.address === selectedTerminal?.address
                    const agent = inferAgentKey(term)
                    const isMuted = Boolean(term.muted || term.labels?.['cjh.mute'] === '1')
                    const isFollowed = Boolean(
                      term.followedByThreadId || followsByTerminal[term.address]
                    )
                    const preview = term.status?.msg || term.title || ''
                    const displayName = term.name
                      ? `${term.name} (${term.address})`
                      : term.address

                    return (
                      <div
                        key={term.address}
                        onClick={() => setSelectedAddress(term.address)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            setSelectedAddress(term.address)
                          }
                        }}
                        className={`w-full text-left px-3 py-2.5 rounded-xl cursor-pointer transition space-y-1.5 ${
                          active
                            ? 'bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-2xs'
                            : 'border border-transparent hover:bg-[var(--bg-surface)]/65'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {renderAgentBadge(agent)}
                            <span className="text-xs font-semibold text-[var(--text-primary)] truncate">
                              {displayName}
                            </span>
                          </div>
                          {renderStatusBadge(term)}
                        </div>

                        {preview && (
                          <div className="text-[11px] text-[var(--text-secondary)] truncate">
                            {preview}
                          </div>
                        )}

                        <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--text-muted)]">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] font-mono">
                              {t('terminals.turnLabel', { turn: term.turn })}
                            </span>
                            {isFollowed && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-medium">
                                <Link2 className="w-2.5 h-2.5" />
                                <span>{t('terminals.followedBadge')}</span>
                              </span>
                            )}
                            {isMuted && (
                              <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-muted)]">
                                {t('terminals.mutedBadge')}
                              </span>
                            )}
                          </div>

                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation()
                              muteMut.mutate({ address: term.address, muted: !isMuted })
                            }}
                            className={`p-1 rounded-md hover:bg-[var(--bg-elevated)] transition ${
                              isMuted ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'
                            }`}
                            title={isMuted ? t('terminals.unmute') : t('terminals.mute')}
                          >
                            {isMuted ? (
                              <VolumeX className="w-3.5 h-3.5" />
                            ) : (
                              <Volume2 className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>
      </aside>

      {/* Right Pane: Selected Terminal Detail */}
      <div
        className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden"
        style={{ backgroundImage: 'var(--ambient-glow)' }}
      >
        {!selectedTerminal ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-3 text-xs">
            <div className="w-11 h-11 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
              <SquareTerminal className="w-5 h-5" />
            </div>
            <div className="font-semibold text-sm">{t('terminals.title')}</div>
            <p className="text-[var(--text-muted)] max-w-sm">{t('terminals.selectHint')}</p>
            <button
              type="button"
              onClick={() => {
                setCreateError(null)
                setCreateOpen(true)
              }}
              className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('terminals.newTerminal')}</span>
            </button>
          </div>
        ) : (
          <>
            {/* Detail Header */}
            <header className="px-5 py-3.5 border-b border-[var(--border-subtle)] bg-[var(--bg-surface)]/80 backdrop-blur-sm flex flex-wrap items-center justify-between gap-3 shrink-0">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  {renderAgentBadge(inferAgentKey(selectedTerminal))}
                  <h3 className="text-sm font-semibold tracking-tight truncate">
                    {selectedTerminal.name
                      ? `${selectedTerminal.name} (${selectedTerminal.address})`
                      : selectedTerminal.address}
                  </h3>
                  {renderStatusBadge(selectedTerminal)}
                  <span className="px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] font-mono text-[11px] text-[var(--text-secondary)]">
                    {t('terminals.turnLabel', { turn: selectedTerminal.turn })}
                  </span>
                  {isSelectedWorking && (
                    <span className="text-[11px] text-blue-500 font-medium">
                      · {t('terminals.screenAutoRefresh')}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)] font-mono">
                  <span className="truncate max-w-xl" title={selectedCwd}>
                    {selectedCwd || t('terminals.workspaceUnknown')}
                  </span>
                  {selectedTerminal.title && (
                    <span className="text-[var(--text-secondary)] truncate max-w-md font-sans">
                      {selectedTerminal.title}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs shrink-0">
                {selectedFollow && (
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] text-[11px] font-medium">
                    <Link2 className="w-3.5 h-3.5" />
                    <span>{t('terminals.followedBadge')}</span>
                    <button
                      type="button"
                      disabled={unfollowMut.isPending}
                      onClick={() => unfollowMut.mutate(selectedTerminal.address)}
                      className="ml-1 inline-flex items-center gap-0.5 hover:underline"
                      title={t('terminals.unfollow')}
                    >
                      <Unlink className="w-3 h-3" />
                      <span>{t('terminals.unfollow')}</span>
                    </button>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() =>
                    muteMut.mutate({ address: selectedTerminal.address, muted: !selectedMuted })
                  }
                  className={`px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition ${
                    selectedMuted
                      ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                      : 'bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                  }`}
                  title={selectedMuted ? t('terminals.unmute') : t('terminals.mute')}
                >
                  {selectedMuted ? (
                    <VolumeX className="w-3.5 h-3.5" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                  <span>{selectedMuted ? t('terminals.unmute') : t('terminals.mute')}</span>
                </button>

                <CustomSelect
                  value={String(historyLines)}
                  onChange={val => setHistoryLines(Number(val) || 0)}
                  options={[
                    { value: '0', label: `${t('terminals.historyLines')}: 0` },
                    { value: '100', label: `${t('terminals.historyLines')}: 100` },
                    { value: '300', label: `${t('terminals.historyLines')}: 300` }
                  ]}
                  align="right"
                />

                <button
                  type="button"
                  onClick={handleCopyScreen}
                  className="px-2.5 py-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition"
                  title={t('terminals.copyScreen')}
                >
                  {copiedScreen ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-[var(--success)]" />
                      <span className="text-[var(--success)]">{t('common.copied')}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>{t('terminals.copyScreen')}</span>
                    </>
                  )}
                </button>

                {selectedTerminal.state === 'live' && (
                  <>
                    <input
                      ref={uploadInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleUploadChange}
                    />
                    <button
                      type="button"
                      disabled={putFileMut.isPending}
                      onClick={() => uploadInputRef.current?.click()}
                      className="px-2.5 py-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition"
                      title={t('terminals.uploadFile')}
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>{t('terminals.uploadFile')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setConfirmKillAddr(prev =>
                          prev === selectedTerminal.address ? null : selectedTerminal.address
                        )
                      }
                      className="px-2.5 py-1.5 rounded-lg bg-[var(--danger-soft)] text-[var(--danger)] hover:opacity-85 inline-flex items-center gap-1.5 font-medium transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('terminals.kill')}</span>
                    </button>
                  </>
                )}

                {selectedTerminal.state === 'finished' && (
                  <button
                    type="button"
                    disabled={removeMut.isPending}
                    onClick={() => removeMut.mutate(selectedTerminal.address)}
                    className="px-2.5 py-1.5 rounded-lg bg-[var(--bg-elevated)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] inline-flex items-center gap-1.5 font-medium transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{t('terminals.remove')}</span>
                  </button>
                )}
              </div>
            </header>

            {/* Kill Secondary Confirmation Strip */}
            {confirmKillAddr === selectedTerminal.address && (
              <div className="px-5 py-3 bg-[var(--danger-soft)] border-b border-[var(--danger)]/25 flex flex-wrap items-center justify-between gap-3 text-xs animate-enter shrink-0">
                <div className="space-y-0.5">
                  <div className="font-semibold text-[var(--danger)]">
                    {t('terminals.killConfirmTitle', {
                      target: selectedTerminal.name
                        ? `${selectedTerminal.name} (${selectedTerminal.address})`
                        : selectedTerminal.address
                    })}
                  </div>
                  <div className="text-[11px] text-[var(--text-secondary)]">
                    {t('terminals.killConfirmDesc')}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setConfirmKillAddr(null)}
                    className="px-3 py-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-medium"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={killMut.isPending}
                    onClick={() => killMut.mutate(selectedTerminal.address)}
                    className="px-3 py-1.5 rounded-lg bg-[var(--danger)] text-white font-medium hover:opacity-90"
                  >
                    {t('terminals.killConfirmBtn')}
                  </button>
                </div>
              </div>
            )}

            {/* Blocked Banner */}
            {selectedTerminal.state === 'live' && selectedTerminal.status?.state === 'blocked' && (
              <div className="px-5 py-3.5 bg-[var(--danger-soft)] border-b border-[var(--danger)]/25 space-y-2.5 text-xs animate-enter shrink-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-[var(--danger)] shrink-0" />
                  <span className="px-2 py-0.5 rounded-full bg-[var(--danger)] text-white text-[10px] font-semibold">
                    {blockedKindLabel(selectedTerminal.status.kind)}
                  </span>
                  <span className="font-semibold text-[var(--text-primary)]">
                    {t('terminals.blockedBannerTitle')}
                  </span>
                  {selectedTerminal.status.msg && (
                    <span className="text-[var(--text-secondary)] font-mono">
                      — {selectedTerminal.status.msg}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-[var(--text-muted)] mr-1">
                    {t('terminals.blockedQuickChoices')}:
                  </span>
                  {(blockedOptions.length > 0
                    ? blockedOptions
                    : [
                        { index: 1, label: '1' },
                        { index: 2, label: '2' },
                        { index: 3, label: '3' }
                      ]
                  ).map(opt => (
                    <button
                      key={opt.index}
                      type="button"
                      disabled={answerMut.isPending}
                      onClick={() =>
                        answerMut.mutate({
                          address: selectedTerminal.address,
                          choice: opt.index
                        })
                      }
                      className="px-3 py-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--accent)] hover:text-[var(--accent-fg)] border border-[var(--border-strong)] font-medium transition max-w-xs truncate"
                      title={opt.label}
                    >
                      {blockedOptions.length > 0 ? `${opt.index}. ${opt.label}` : opt.label}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    value={blockedReply}
                    onChange={e => setBlockedReply(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && blockedReply.trim()) {
                        e.preventDefault()
                        answerMut.mutate({
                          address: selectedTerminal.address,
                          text: blockedReply.trim()
                        })
                      }
                    }}
                    placeholder={t('terminals.blockedCustomReplyPlaceholder')}
                    className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--bg-surface)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    type="button"
                    disabled={!blockedReply.trim() || answerMut.isPending}
                    onClick={() =>
                      answerMut.mutate({
                        address: selectedTerminal.address,
                        text: blockedReply.trim()
                      })
                    }
                    className="px-3.5 py-1.5 rounded-lg bg-[var(--danger)] text-white font-medium disabled:opacity-40"
                  >
                    {t('terminals.send')}
                  </button>
                </div>
              </div>
            )}

            {/* Action Feedback / Incomplete Notice */}
            {(actionFeedback || (screenQuery.data && screenQuery.data.complete === false)) && (
              <div className="px-5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-sidebar)] flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0">
                {screenQuery.data && screenQuery.data.complete === false ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                    <AlertCircle className="w-3.5 h-3.5" />
                    <span>{t('terminals.screenIncomplete')}</span>
                  </span>
                ) : (
                  <span />
                )}
                {actionFeedback && (
                  <span
                    className={`font-medium ${
                      actionFeedback.ok ? 'text-[var(--success)]' : 'text-[var(--danger)]'
                    }`}
                  >
                    {actionFeedback.text}
                  </span>
                )}
              </div>
            )}

            {/* Screen Viewer */}
            <div className="flex-1 min-h-0 p-4 overflow-hidden flex flex-col">
              <pre
                ref={screenBoxRef}
                onScroll={handleScreenScroll}
                className="flex-1 min-h-0 overflow-auto p-4 rounded-2xl border border-[var(--border-subtle)] bg-[#0c0d10] text-[#e4e4e7] font-mono text-xs leading-relaxed whitespace-pre-wrap break-words select-text shadow-inner"
              >
                {renderAnsiContent(selectedScreenText)}
              </pre>
            </div>

            {/* Bottom Control Bar */}
            {selectedTerminal.state === 'live' && (
              <div className="px-4 pb-4 pt-1 shrink-0 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {[
                      { label: 'Enter', keys: ['enter'] },
                      { label: 'Esc', keys: ['esc'] },
                      { label: '↑', keys: ['up'] },
                      { label: '↓', keys: ['down'] },
                      { label: 'Ctrl+C', keys: ['ctrl+c'] }
                    ].map(btn => (
                      <button
                        key={btn.label}
                        type="button"
                        disabled={keysMut.isPending}
                        onClick={() =>
                          keysMut.mutate({ address: selectedTerminal.address, keys: btn.keys })
                        }
                        className="px-2.5 py-1 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-mono text-[11px] font-medium transition"
                      >
                        {btn.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={interruptMut.isPending}
                      onClick={() => interruptMut.mutate(selectedTerminal.address)}
                      className="px-2.5 py-1 rounded-lg bg-[var(--warning-soft)] text-[var(--warning)] hover:opacity-90 text-[11px] font-medium inline-flex items-center gap-1 transition"
                    >
                      <PauseCircle className="w-3.5 h-3.5" />
                      <span>{t('terminals.interrupt')}</span>
                    </button>
                  </div>

                  <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={forceSend}
                      onChange={e => setForceSend(e.target.checked)}
                      className="accent-[var(--accent)]"
                    />
                    <span>{t('terminals.forceSend')}</span>
                  </label>
                </div>

                <div className="composer-shell rounded-2xl p-2 flex items-end gap-2">
                  <textarea
                    rows={2}
                    value={sendText}
                    onChange={e => setSendText(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSendSubmit()
                      }
                    }}
                    placeholder={t('terminals.sendPlaceholder')}
                    className="flex-1 bg-transparent px-2.5 py-1.5 text-xs outline-none resize-none max-h-32"
                  />
                  <button
                    type="button"
                    disabled={!sendText.trim() || sendMut.isPending}
                    onClick={handleSendSubmit}
                    className="px-3.5 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-40 hover:opacity-90 transition shrink-0"
                  >
                    {forceSend ? (
                      <CornerDownLeft className="w-3.5 h-3.5" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>{forceSend ? t('terminals.forceSend') : t('terminals.send')}</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* New Terminal Modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl surface-card p-6 space-y-4 text-xs animate-enter">
            <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
              <div className="flex items-center gap-2">
                <SquareTerminal className="w-4 h-4 text-[var(--accent)]" />
                <h4 className="text-sm font-semibold">{t('terminals.createModalTitle')}</h4>
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="p-1 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {createError && (
              <div className="px-3.5 py-2 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] font-mono break-all">
                {createError}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('terminals.createAgentLabel')}
              </label>
              <CustomSelect
                value={newAgent}
                onChange={v =>
                  setNewAgent(v as 'agy' | 'codex' | 'claude' | 'pi' | 'shell' | 'custom')
                }
                options={[
                  { value: 'agy', label: t('terminals.createAgentAgy') },
                  { value: 'codex', label: t('terminals.createAgentCodex') },
                  { value: 'claude', label: t('terminals.createAgentClaude') },
                  { value: 'pi', label: t('terminals.createAgentPi') },
                  { value: 'shell', label: t('terminals.createAgentShell') },
                  { value: 'custom', label: t('terminals.createAgentCustom') }
                ]}
                className="w-full"
              />
            </div>

            {newAgent === 'custom' && (
              <div className="space-y-1.5">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('terminals.createCustomCmdLabel')}
                </label>
                <input
                  value={newCustomCmd}
                  onChange={e => setNewCustomCmd(e.target.value)}
                  placeholder={t('terminals.createCustomCmdPlaceholder')}
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('terminals.createCwdLabel')}
              </label>
              <div className="flex gap-2">
                <input
                  value={newCwd}
                  onChange={e => setNewCwd(e.target.value)}
                  placeholder={t('terminals.createCwdPlaceholder')}
                  className="flex-1 px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                />
                {window.cjhShell && (
                  <button
                    type="button"
                    onClick={async () => {
                      const dir = await window.cjhShell!.pickDirectory()
                      if (dir) setNewCwd(dir)
                    }}
                    className="px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition"
                  >
                    <FolderSearch className="w-3.5 h-3.5" />
                    <span>{t('common.browse')}</span>
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('terminals.createNameLabel')}
              </label>
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder={t('terminals.createNamePlaceholder')}
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('terminals.createTaskLabel')}
              </label>
              <textarea
                rows={3}
                value={newTask}
                onChange={e => setNewTask(e.target.value)}
                placeholder={t('terminals.createTaskPlaceholder')}
                className="w-full p-3 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                className="px-3.5 py-2 rounded-xl bg-[var(--bg-elevated)] font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={
                  createMut.isPending || (newAgent === 'custom' && !newCustomCmd.trim())
                }
                onClick={() => createMut.mutate()}
                className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 disabled:opacity-40 hover:opacity-90 transition shadow-sm"
              >
                {createMut.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>
                  {createMut.isPending ? t('terminals.creating') : t('terminals.createSubmit')}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
