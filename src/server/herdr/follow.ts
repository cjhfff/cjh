import {
  HERDR_WS_EVENTS,
  HerdrClientLike,
  HerdrFollowBindingDto,
  HerdrFollowManagerLike,
  HerdrStatus,
  HerdrTerminal,
  HerdrTerminalTransitionEvent
} from '@shared/herdr-types'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'

export interface HerdrFollowEngineTrigger {
  triggerFollowTurn: (threadId: string, promptText: string) => void
}

const MAX_FOLLOW_SCREEN_LINES = 40
const MAX_FOLLOW_SCREEN_CHARS = 4000

/** Strip ANSI CSI/OSC/control sequences for clean model prompt injection. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '')
}

function clipScreenTail(rawScreen: string, maxLines = MAX_FOLLOW_SCREEN_LINES): string {
  const cleaned = stripAnsi(rawScreen)
  const lines = cleaned.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop()
  }
  const tail = lines.slice(-maxLines).join('\n').trimEnd()
  if (tail.length > MAX_FOLLOW_SCREEN_CHARS) {
    return tail.slice(-MAX_FOLLOW_SCREEN_CHARS)
  }
  return tail
}

function formatStatusLabel(
  evt: HerdrTerminalTransitionEvent,
  terminal?: HerdrTerminal
): string {
  if (evt.type === 'finished') {
    const code = terminal?.exit_code
    return code !== undefined && code !== null ? `finished (exit_code=${code})` : 'finished'
  }
  const st: HerdrStatus | null | undefined = evt.status ?? terminal?.status
  if (!st) return terminal?.state || 'unknown'
  if (st.state === 'blocked') {
    return st.kind ? `blocked (${st.kind})` : 'blocked'
  }
  return st.state
}

export class HerdrFollowManager implements HerdrFollowManagerLike {
  private bindings = new Map<string, HerdrFollowBindingDto>()
  private lastNotifiedKey = new Map<string, string>()
  private completedTurnByAddress = new Map<string, number>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private herdrClient: HerdrClientLike,
    private wsHub: WsHub,
    private logger: TaggedLogger,
    private trigger: HerdrFollowEngineTrigger
  ) {
    this.unsubscribe = this.herdrClient.onTransition(evt => {
      void this.handleTransition(evt)
    })
  }

  private resolveAddress(terminal: string): string {
    const trimmed = terminal.trim()
    if (this.bindings.has(trimmed)) return trimmed
    if (this.herdrClient.resolveCachedAddress) {
      return this.herdrClient.resolveCachedAddress(trimmed) || trimmed
    }
    const cached = this.herdrClient.getCachedTerminal(trimmed)
    return cached?.address || trimmed
  }

  private broadcastUpdated(): void {
    this.wsHub.broadcast(HERDR_WS_EVENTS.FOLLOW_UPDATED, {
      follows: this.listFollows()
    })
  }

  follow(terminal: string, threadId: string): HerdrFollowBindingDto {
    const address = this.resolveAddress(terminal)
    const existing = this.bindings.get(address)
    if (existing) {
      if (existing.threadId === threadId) {
        return existing
      }
      throw new Error(`终端 ${address} 已被线程 ${existing.threadId} 跟进，请先取消原有跟进`)
    }

    const binding: HerdrFollowBindingDto = {
      terminal: address,
      threadId,
      createdAt: Date.now(),
      lastTurnNotified: -1
    }
    this.bindings.set(address, binding)
    this.logger.info('HerdrFollow', `Thread ${threadId} following terminal ${address}`)
    this.broadcastUpdated()
    return binding
  }

  unfollow(terminal: string): boolean {
    const trimmed = terminal.trim()
    const address = this.resolveAddress(trimmed)
    const targetKey = this.bindings.has(address)
      ? address
      : this.bindings.has(trimmed)
        ? trimmed
        : null
    if (!targetKey) return false

    this.bindings.delete(targetKey)
    this.lastNotifiedKey.delete(targetKey)
    this.completedTurnByAddress.delete(targetKey)
    this.logger.info('HerdrFollow', `Unfollowed terminal ${targetKey}`)
    this.broadcastUpdated()
    return true
  }

  unfollowThread(threadId: string): number {
    let removed = 0
    for (const [addr, binding] of this.bindings.entries()) {
      if (binding.threadId === threadId) {
        this.bindings.delete(addr)
        this.lastNotifiedKey.delete(addr)
        this.completedTurnByAddress.delete(addr)
        removed++
      }
    }
    if (removed > 0) {
      this.logger.info('HerdrFollow', `Unfollowed ${removed} terminal(s) for thread ${threadId}`)
      this.broadcastUpdated()
    }
    return removed
  }

  getFollower(terminal: string): HerdrFollowBindingDto | null {
    const trimmed = terminal.trim()
    const address = this.resolveAddress(trimmed)
    return this.bindings.get(address) ?? this.bindings.get(trimmed) ?? null
  }

  listFollows(): HerdrFollowBindingDto[] {
    return [...this.bindings.values()]
  }

  dispose(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    this.bindings.clear()
    this.lastNotifiedKey.clear()
    this.completedTurnByAddress.clear()
  }

  private async handleTransition(evt: HerdrTerminalTransitionEvent): Promise<void> {
    const address = evt.address || evt.terminal?.address
    if (!address) return

    if (evt.type === 'removed') {
      this.unfollow(address)
      return
    }

    const binding = this.bindings.get(address)
    if (!binding) return

    // Reset transient blocked/error dedup marker when terminal resumes working
    if (evt.type === 'status' && evt.status?.state === 'working') {
      const prevKey = this.lastNotifiedKey.get(address)
      if (prevKey && (prevKey.endsWith(':blocked') || prevKey.endsWith(':error'))) {
        this.lastNotifiedKey.delete(address)
      }
      return
    }

    const isStoppedWorkingStatus =
      evt.type === 'status' &&
      evt.prevStatus?.state === 'working' &&
      typeof evt.status?.state === 'string' &&
      ['done', 'idle', 'blocked', 'error'].includes(evt.status.state)

    const isFinished = evt.type === 'finished'
    if (!isStoppedWorkingStatus && !isFinished) return

    const cached = evt.terminal || this.herdrClient.getCachedTerminal(address) || undefined
    const turn = evt.turn ?? cached?.turn ?? 0
    const nextState = isFinished ? 'finished' : evt.status!.state

    // Prevent duplicate triggers for same (terminal, turn, state) and done->idle on same turn
    const dedupKey = `${turn}:${nextState}`
    if (this.lastNotifiedKey.get(address) === dedupKey) {
      return
    }
    if (nextState === 'done' || nextState === 'idle') {
      if (this.completedTurnByAddress.get(address) === turn) {
        return
      }
      this.completedTurnByAddress.set(address, turn)
    }
    this.lastNotifiedKey.set(address, dedupKey)

    let screenTail = ''
    try {
      const readRes = await this.herdrClient.readTerminal(address, 0)
      screenTail = clipScreenTail(readRes.text || '')
    } catch (err) {
      this.logger.warn('HerdrFollow', `Failed to read screen for ${address}`, err)
      if (cached?.screen) {
        screenTail = clipScreenTail(cached.screen)
      }
    }

    // Re-check binding after async read in case unfollow() happened while reading
    const activeBinding = this.bindings.get(address)
    if (!activeBinding || activeBinding.threadId !== binding.threadId) {
      return
    }

    activeBinding.lastTurnNotified = turn

    const displayName = cached?.name ? `${cached.name} (${address})` : address
    const agent = cached?.agent || evt.status?.app || 'unknown'
    const cwd = cached?.foreground?.cwd || cached?.cwd || '-'
    const statusLabel = formatStatusLabel(evt, cached)
    const msgSummary = evt.status?.msg || cached?.status?.msg || ''

    const lines: string[] = [
      `[herdr 跟进回调] 终端 ${displayName} 状态更新`,
      `- Agent: ${agent}`,
      `- 工作目录: ${cwd}`,
      `- 当前状态: ${statusLabel} (turn=${turn})`
    ]
    if (msgSummary) {
      lines.push(`- 最后回复摘要: ${msgSummary}`)
    }
    if (screenTail) {
      lines.push('', '屏幕尾部输出：', '```text', screenTail, '```')
    }
    lines.push(
      '',
      '请根据上述状态与屏幕输出决定下一步操作：',
      '- 如需继续下达指令：调用 `herdr_send`；',
      '- 如处于 `blocked` 等待选择/确认：先评估风险，涉及敏感权限确认请先向用户说明并征得同意，再调用 `herdr_answer` 作答；',
      '- 如任务已完成：向用户汇总最终结果，并可调用 `herdr_unfollow`（及在确认不再需要时 `herdr_kill`）清理本次跟进。'
    )

    const injectedText = lines.join('\n')
    try {
      this.trigger.triggerFollowTurn(activeBinding.threadId, injectedText)
    } finally {
      if (isFinished) {
        this.unfollow(address)
      }
    }
  }
}
