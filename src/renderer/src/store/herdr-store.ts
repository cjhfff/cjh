import { create } from 'zustand'
import {
  HERDR_WS_EVENTS,
  type HerdrClientStatusDto,
  type HerdrFollowBindingDto,
  type HerdrForeground,
  type HerdrNotificationDto,
  type HerdrStatus,
  type HerdrTerminal,
  type WsServerEnvelope
} from '@shared/schemas'

const MAX_RECENT_NOTIFICATIONS = 50

interface HerdrState {
  status: HerdrClientStatusDto | null
  terminalsByAddress: Record<string, HerdrTerminal>
  selectedAddress: string | null
  followsByTerminal: Record<string, HerdrFollowBindingDto>
  recentNotifications: HerdrNotificationDto[]

  setStatus: (status: HerdrClientStatusDto) => void
  setTerminals: (terminals: HerdrTerminal[]) => void
  upsertTerminal: (terminal: HerdrTerminal) => void
  removeTerminal: (address: string) => void
  setSelectedAddress: (address: string | null) => void
  setFollows: (follows: HerdrFollowBindingDto[]) => void
  pushNotification: (n: HerdrNotificationDto) => void
  handleWsEvent: (evt: WsServerEnvelope) => boolean
}

function isTerminalObject(val: unknown): val is HerdrTerminal {
  return Boolean(val && typeof val === 'object' && 'address' in val && typeof (val as HerdrTerminal).address === 'string')
}

function resolveAddress(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  if (!payload || typeof payload !== 'object') return null
  const obj = payload as Record<string, unknown>
  if (typeof obj.address === 'string') return obj.address
  if (typeof obj.terminal === 'string') return obj.terminal
  if (isTerminalObject(obj.terminal)) return obj.terminal.address
  return null
}

function extractTerminalPayload(payload: unknown): HerdrTerminal | null {
  if (isTerminalObject(payload)) return payload
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (isTerminalObject(obj.terminal)) return obj.terminal
  }
  return null
}

function buildFollowsMap(follows: HerdrFollowBindingDto[]): Record<string, HerdrFollowBindingDto> {
  const next: Record<string, HerdrFollowBindingDto> = {}
  for (const f of follows) {
    if (f && f.terminal) {
      next[f.terminal] = f
    }
  }
  return next
}

export const useHerdrStore = create<HerdrState>((set, get) => ({
  status: null,
  terminalsByAddress: {},
  selectedAddress: null,
  followsByTerminal: {},
  recentNotifications: [],

  setStatus: status => set({ status }),

  setTerminals: terminals =>
    set(state => {
      const next: Record<string, HerdrTerminal> = {}
      for (const term of terminals) {
        if (!term || !term.address) continue
        const follow = state.followsByTerminal[term.address]
        next[term.address] =
          follow && !term.followedByThreadId
            ? { ...term, followedByThreadId: follow.threadId }
            : term
      }
      return { terminalsByAddress: next }
    }),

  upsertTerminal: terminal =>
    set(state => {
      if (!terminal || !terminal.address) return state
      const follow = state.followsByTerminal[terminal.address]
      const merged: HerdrTerminal =
        follow && !terminal.followedByThreadId
          ? { ...terminal, followedByThreadId: follow.threadId }
          : terminal
      return {
        terminalsByAddress: {
          ...state.terminalsByAddress,
          [terminal.address]: merged
        }
      }
    }),

  removeTerminal: address =>
    set(state => {
      const hasTerm = address in state.terminalsByAddress
      const hasFollow = address in state.followsByTerminal
      if (!hasTerm && !hasFollow && state.selectedAddress !== address) return state
      const nextTerminals = { ...state.terminalsByAddress }
      delete nextTerminals[address]
      const nextFollows = { ...state.followsByTerminal }
      delete nextFollows[address]
      return {
        terminalsByAddress: nextTerminals,
        followsByTerminal: nextFollows,
        selectedAddress: state.selectedAddress === address ? null : state.selectedAddress
      }
    }),

  setSelectedAddress: address => set({ selectedAddress: address }),

  setFollows: follows =>
    set(state => {
      const nextFollows = buildFollowsMap(follows)
      const nextTerminals: Record<string, HerdrTerminal> = {}
      for (const [addr, term] of Object.entries(state.terminalsByAddress)) {
        const follow = nextFollows[addr]
        nextTerminals[addr] = {
          ...term,
          followedByThreadId: follow ? follow.threadId : null
        }
      }
      return {
        followsByTerminal: nextFollows,
        terminalsByAddress: nextTerminals
      }
    }),

  pushNotification: n =>
    set(state => {
      if (!n || !n.id) return state
      const filtered = state.recentNotifications.filter(item => item.id !== n.id)
      return {
        recentNotifications: [n, ...filtered].slice(0, MAX_RECENT_NOTIFICATIONS)
      }
    }),

  handleWsEvent: evt => {
    const state = get()
    const payload = evt.data as Record<string, unknown> | unknown

    switch (evt.type) {
      case HERDR_WS_EVENTS.STATUS_CHANGED: {
        if (payload && typeof payload === 'object') {
          state.setStatus(payload as HerdrClientStatusDto)
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINALS_SNAPSHOT: {
        const list = Array.isArray(payload)
          ? (payload as HerdrTerminal[])
          : payload && typeof payload === 'object' && Array.isArray((payload as { terminals?: unknown }).terminals)
            ? ((payload as { terminals: HerdrTerminal[] }).terminals)
            : null
        if (list) {
          state.setTerminals(list)
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_CREATED:
      case HERDR_WS_EVENTS.TERMINAL_UPDATED: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_STATUS: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
          return true
        }
        const addr = resolveAddress(payload)
        if (addr && payload && typeof payload === 'object') {
          const obj = payload as { status?: HerdrStatus | null; status_ms?: number }
          const prev = state.terminalsByAddress[addr]
          if (prev) {
            state.upsertTerminal({
              ...prev,
              status: obj.status !== undefined ? obj.status : prev.status,
              ...(obj.status_ms !== undefined ? { status_ms: obj.status_ms } : {})
            })
          }
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_TURN: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
          return true
        }
        const addr = resolveAddress(payload)
        if (addr && payload && typeof payload === 'object') {
          const obj = payload as { turn?: number }
          const prev = state.terminalsByAddress[addr]
          if (prev && typeof obj.turn === 'number') {
            state.upsertTerminal({ ...prev, turn: obj.turn })
          }
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_TITLE: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
          return true
        }
        const addr = resolveAddress(payload)
        if (addr && payload && typeof payload === 'object') {
          const obj = payload as { title?: string }
          const prev = state.terminalsByAddress[addr]
          if (prev && typeof obj.title === 'string') {
            state.upsertTerminal({ ...prev, title: obj.title })
          }
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_LABELS: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
          return true
        }
        const addr = resolveAddress(payload)
        if (addr && payload && typeof payload === 'object') {
          const obj = payload as { labels?: Record<string, string>; muted?: boolean }
          const prev = state.terminalsByAddress[addr]
          if (prev && obj.labels && typeof obj.labels === 'object') {
            state.upsertTerminal({
              ...prev,
              labels: obj.labels,
              muted:
                obj.muted !== undefined
                  ? obj.muted
                  : obj.labels['cjh.mute'] === '1'
            })
          }
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_FOREGROUND: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
          return true
        }
        const addr = resolveAddress(payload)
        if (addr && payload && typeof payload === 'object') {
          const obj = payload as { foreground?: HerdrForeground | null; agent?: string | null }
          const prev = state.terminalsByAddress[addr]
          if (prev) {
            state.upsertTerminal({
              ...prev,
              foreground: obj.foreground !== undefined ? obj.foreground : prev.foreground,
              ...(obj.agent !== undefined ? { agent: obj.agent } : {})
            })
          }
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_FINISHED: {
        const terminal = extractTerminalPayload(payload)
        if (terminal) {
          state.upsertTerminal(terminal)
          return true
        }
        const addr = resolveAddress(payload)
        if (addr && payload && typeof payload === 'object') {
          const obj = payload as {
            exit_code?: number | null
            finished_ms?: number | null
            reason?: string | null
            signal?: number | null
          }
          const prev = state.terminalsByAddress[addr]
          if (prev) {
            state.upsertTerminal({
              ...prev,
              state: 'finished',
              ...(obj.exit_code !== undefined ? { exit_code: obj.exit_code } : {}),
              ...(obj.finished_ms !== undefined ? { finished_ms: obj.finished_ms } : {}),
              ...(obj.reason !== undefined ? { reason: obj.reason } : {}),
              ...(obj.signal !== undefined ? { signal: obj.signal } : {})
            })
          }
        }
        return true
      }

      case HERDR_WS_EVENTS.TERMINAL_REMOVED: {
        const addr = resolveAddress(payload)
        if (addr) {
          state.removeTerminal(addr)
        }
        return true
      }

      case HERDR_WS_EVENTS.FOLLOW_UPDATED: {
        const list = Array.isArray(payload)
          ? (payload as HerdrFollowBindingDto[])
          : payload && typeof payload === 'object' && Array.isArray((payload as { follows?: unknown }).follows)
            ? ((payload as { follows: HerdrFollowBindingDto[] }).follows)
            : null
        if (list) {
          state.setFollows(list)
        }
        return true
      }

      case HERDR_WS_EVENTS.NOTIFICATION: {
        if (payload && typeof payload === 'object' && 'id' in payload && 'address' in payload) {
          state.pushNotification(payload as HerdrNotificationDto)
        }
        return true
      }

      default:
        return false
    }
  }
}))
