import { nanoid } from 'nanoid'
import {
  HERDR_WS_EVENTS,
  HerdrClientLike,
  HerdrNotificationDto,
  HerdrTerminal,
  HerdrTerminalTransitionEvent
} from '@shared/herdr-types'
import { FeishuBridge } from '../channels/feishu'
import { AppDatabase } from '../db/database'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'

const DEBOUNCE_WINDOW_MS = 5000
const SELF_BOUNCE_WINDOW_MS = 300

// Strip OSC, DCS/PM/APC, CSI, and single-character ESC sequences plus stray C0 controls.
const ANSI_OSC_REGEX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_DCS_REGEX = /\x1b[PX^_][\s\S]*?\x1b\\/g
const ANSI_CSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const ANSI_ESC_CHAR_REGEX = /\x1b(?:[()#][A-Za-z0-9]|[@-Z\\-_])/g
const CTRL_CHARS_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function stripAnsi(input: string): string {
  if (!input) return ''
  return input
    .replace(ANSI_OSC_REGEX, '')
    .replace(ANSI_DCS_REGEX, '')
    .replace(ANSI_CSI_REGEX, '')
    .replace(ANSI_ESC_CHAR_REGEX, '')
    .replace(CTRL_CHARS_REGEX, '')
}

export function extractScreenTail(screenText: string, maxLines = 20): string {
  if (!screenText || maxLines <= 0) return ''
  const cleaned = stripAnsi(screenText).replace(/\r\n/g, '\n')
  const nonEmptyLines = cleaned
    .split('\n')
    .map(line => {
      const noTrailingCr = line.replace(/\r+$/, '')
      const overwritten = noTrailingCr.includes('\r')
        ? noTrailingCr.split('\r').filter(Boolean).pop() ?? ''
        : noTrailingCr
      return overwritten.replace(/\s+$/, '')
    })
    .filter(line => line.trim().length > 0)

  if (nonEmptyLines.length === 0) return ''
  return nonEmptyLines.slice(-maxLines).join('\n')
}

export function parseScreenOptions(screenText: string): Array<{ index: number; label: string }> {
  const tail = extractScreenTail(screenText, 30)
  if (!tail) return []

  const optionLineRe =
    /^\s*(?:[❯›>*•●→-]\s*)?(?:\[(\d{1,2})\]|\((\d{1,2})\)|(\d{1,2})[.)、:])\s+(.+?)\s*$/

  let currentGroup: Array<{ index: number; label: string }> = []
  const seenInGroup = new Set<number>()

  for (const line of tail.split('\n')) {
    const match = line.match(optionLineRe)
    if (!match) continue

    const rawIndex = match[1] || match[2] || match[3]
    const index = Number(rawIndex)
    const rawLabel = (match[4] || '').trim()
    if (!Number.isInteger(index) || index < 1 || index > 20 || !rawLabel) {
      continue
    }

    const label = rawLabel.length > 80 ? `${rawLabel.slice(0, 77)}...` : rawLabel

    // A fresh item "1" starts a new option block (e.g. ignoring earlier numbered prose).
    if (index === 1 && currentGroup.length > 0) {
      currentGroup = []
      seenInGroup.clear()
    }

    if (!seenInGroup.has(index)) {
      seenInGroup.add(index)
      currentGroup.push({ index, label })
    }
  }

  return currentGroup
}

interface SelfInitiatedWorkingEntry {
  at: number
  turn: number
}

export class HerdrNotifier {
  private readonly TAG = 'HerdrNotifier'
  private unsubscribe: (() => void) | null = null
  private lastNotifiedAt = new Map<string, number>()
  private selfInitiatedWorking = new Map<string, SelfInitiatedWorkingEntry>()
  private now: () => number

  constructor(
    private db: AppDatabase,
    private wsHub: WsHub,
    private logger: TaggedLogger,
    private herdrClient: HerdrClientLike,
    private opts?: {
      feishuBridge?: FeishuBridge
      now?: () => number
      onDesktopNotify?: (dto: HerdrNotificationDto) => void
    }
  ) {
    this.now = opts?.now || (() => Date.now())
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.herdrClient.onTransition(evt => {
      void this.handleTransition(evt).catch(err => {
        this.logger.warn(
          this.TAG,
          `Error handling terminal transition for ${evt.address}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      })
    })
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.lastNotifiedAt.clear()
    this.selfInitiatedWorking.clear()
  }

  private resolveNotificationKind(
    evt: HerdrTerminalTransitionEvent,
    nowMs: number
  ): HerdrNotificationDto['kind'] | null {
    if (evt.type === 'finished') {
      this.selfInitiatedWorking.delete(evt.address)
      return 'finished'
    }

    if (evt.type === 'snapshot' || evt.type === 'removed') {
      return null
    }

    const prevState = evt.prevStatus?.state ?? evt.prevTerminal?.status?.state ?? null
    const nextState = evt.status?.state ?? evt.terminal?.status?.state ?? null

    if (nextState === 'working') {
      if (prevState !== 'working') {
        const isSelfInitiated =
          Boolean(evt.initiatedByCjh) || this.herdrClient.wasRecentlySelfInitiated(evt.address)
        if (isSelfInitiated) {
          const turn = evt.turn ?? evt.terminal?.turn ?? evt.prevTurn ?? evt.prevTerminal?.turn ?? 0
          this.selfInitiatedWorking.set(evt.address, { at: nowMs, turn })
        } else {
          this.selfInitiatedWorking.delete(evt.address)
        }
      }
      return null
    }

    if (nextState === 'blocked' && prevState !== 'blocked') {
      this.selfInitiatedWorking.delete(evt.address)
      return 'blocked'
    }

    if (nextState === 'error' && prevState !== 'error') {
      this.selfInitiatedWorking.delete(evt.address)
      return 'error'
    }

    if (prevState === 'working' && (nextState === 'done' || nextState === 'idle')) {
      const selfEntry = this.selfInitiatedWorking.get(evt.address)
      this.selfInitiatedWorking.delete(evt.address)

      if (nextState === 'idle' && selfEntry) {
        const elapsed = nowMs - selfEntry.at
        const curTurn = evt.turn ?? evt.terminal?.turn ?? selfEntry.turn
        if (elapsed < SELF_BOUNCE_WINDOW_MS && curTurn <= selfEntry.turn) {
          return null
        }
      }
      return 'done'
    }

    return null
  }

  private isTerminalMuted(address: string, terminal: HerdrTerminal | null | undefined): boolean {
    if (terminal?.labels?.['cjh.mute'] === '1') return true
    if (terminal?.muted === true) return true

    const mutedList = this.db.getSettings().herdr.mutedTerminals
    if (mutedList.includes(address)) return true
    if (terminal?.address && mutedList.includes(terminal.address)) return true
    if (terminal?.name && mutedList.includes(terminal.name)) return true
    return false
  }

  private async handleTransition(evt: HerdrTerminalTransitionEvent): Promise<void> {
    const nowMs = this.now()
    const kind = this.resolveNotificationKind(evt, nowMs)
    if (!kind) return

    const terminal = evt.terminal ?? this.herdrClient.getCachedTerminal(evt.address)
    if (this.isTerminalMuted(evt.address, terminal)) {
      this.logger.debug(this.TAG, `Skipped notification (${kind}) for muted terminal ${evt.address}`)
      return
    }

    const debounceKey = `${evt.address}:${kind}`
    const lastSent = this.lastNotifiedAt.get(debounceKey)
    if (lastSent !== undefined && nowMs - lastSent < DEBOUNCE_WINDOW_MS) {
      this.logger.debug(
        this.TAG,
        `Debounced notification (${debounceKey}), elapsed=${nowMs - lastSent}ms`
      )
      return
    }
    this.lastNotifiedAt.set(debounceKey, nowMs)

    let rawScreen = terminal?.screen || ''
    try {
      const readRes = await this.herdrClient.readTerminal(evt.address, 0)
      if (readRes?.text) {
        rawScreen = readRes.text
      }
    } catch (err) {
      this.logger.debug(
        this.TAG,
        `Best-effort readTerminal(${evt.address}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    const screenTail = extractScreenTail(rawScreen, 20)
    const options = kind === 'blocked' ? parseScreenOptions(rawScreen) : []
    const blockedKind =
      kind === 'blocked' ? (evt.status?.kind ?? terminal?.status?.kind ?? null) : null

    const terminalName = terminal?.name || evt.address
    const displayName =
      terminal?.name && terminal.name !== evt.address
        ? `${terminal.name} (${evt.address})`
        : evt.address
    const statusMsg =
      evt.status?.msg || terminal?.status?.msg || evt.status?.title || terminal?.title || ''

    let title: string
    let body: string
    if (kind === 'blocked') {
      title = `终端待处理：${displayName}`
      body = `[${blockedKind || 'blocked'}] ${statusMsg || '等待你的确认或输入'}`
    } else if (kind === 'done') {
      title = `终端已完成：${displayName}`
      body = statusMsg || '当前任务已结束，等待下一步指令'
    } else if (kind === 'error') {
      title = `终端出错：${displayName}`
      body = statusMsg || '终端执行遇到错误'
    } else {
      title = `终端已退出：${displayName}`
      const exitStr = terminal?.exit_code !== undefined && terminal?.exit_code !== null
        ? `exit_code=${terminal.exit_code}`
        : '程序已结束'
      body = statusMsg ? `${exitStr} · ${statusMsg}` : exitStr
    }

    const dto: HerdrNotificationDto = {
      id: nanoid(10),
      address: evt.address,
      terminalName,
      agent: terminal?.agent ?? terminal?.status?.app ?? null,
      cwd: terminal?.cwd || '',
      kind,
      title,
      body,
      blockedKind,
      ...(screenTail ? { screenTail } : {}),
      ...(options.length > 0 ? { options } : {}),
      timestamp: nowMs
    }

    const settings = this.db.getSettings()

    if (settings.herdr.desktopNotifications !== false) {
      this.wsHub.broadcast(HERDR_WS_EVENTS.NOTIFICATION, dto)
      this.opts?.onDesktopNotify?.(dto)
    }

    const feishuCfg = settings.channels.feishu
    const feishuSecret = this.db.getSecret('channels.feishu.app_secret')
    const notifyChatId = feishuCfg.notifyChatId.trim()

    if (this.opts?.feishuBridge && feishuCfg.appId.trim() && feishuSecret && notifyChatId) {
      try {
        await this.opts.feishuBridge.sendHerdrNotificationCard(notifyChatId, dto)
      } catch (err) {
        this.logger.warn(
          this.TAG,
          `Failed sending Feishu herdr notification card: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }
}
