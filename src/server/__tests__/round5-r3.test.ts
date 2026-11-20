import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HERDR_WS_EVENTS,
  HerdrAnswerResult,
  HerdrClientLike,
  HerdrClientStatusDto,
  HerdrNotificationDto,
  HerdrReadResult,
  HerdrSendResult,
  HerdrTerminal,
  HerdrTerminalListResponseDto,
  HerdrTerminalTransitionEvent
} from '@shared/herdr-types'
import { FeishuBridge, FeishuSdkFactory } from '../channels/feishu'
import { SecretVault } from '../crypto/vault'
import { AppDatabase } from '../db/database'
import { extractScreenTail, HerdrNotifier, parseScreenOptions } from '../herdr/notifier'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r5-r3-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore cleanup lock
    }
  }
})

function makeTerminal(overrides: Partial<HerdrTerminal> = {}): HerdrTerminal {
  return {
    address: 't1',
    name: 'fix-auth',
    state: 'live',
    argv: ['codex'],
    cwd: 'D:/workspace/demo',
    cols: 120,
    rows: 40,
    created_ms: 1_000_000,
    screen: '',
    turn: 1,
    status: { state: 'idle', app: 'codex', msg: '' },
    labels: {},
    agent: 'codex',
    ...overrides
  }
}

function createMockHerdrClient(initialTerminals: HerdrTerminal[] = []) {
  const terminals = new Map<string, HerdrTerminal>()
  for (const t of initialTerminals) {
    terminals.set(t.address, t)
  }

  const listeners = new Set<(evt: HerdrTerminalTransitionEvent) => void>()
  const selfInitiatedAt = new Map<string, number>()
  const screens = new Map<string, string>()

  const sendCalls: Array<{ terminal: string; input: { text: string; force?: boolean } }> = []
  const answerCalls: Array<{
    terminal: string
    input: { choice?: number | string; text?: string; useArrows?: boolean }
  }> = []
  let readError: Error | null = null
  let sendError: Error | null = null

  const findTerminal = (addrOrName: string): HerdrTerminal | null => {
    if (terminals.has(addrOrName)) return terminals.get(addrOrName)!
    for (const t of terminals.values()) {
      if (t.name === addrOrName) return t
    }
    return null
  }

  const client: HerdrClientLike = {
    start: async () => {},
    dispose: async () => {},
    getStatus: (): HerdrClientStatusDto => ({
      available: true,
      connected: true,
      reason: null,
      execPath: 'herdr-core.exe',
      version: '0.1.21',
      core: { id: 'core-1', name: 'default' },
      live: [...terminals.values()].filter(t => t.state === 'live').length,
      finished: [...terminals.values()].filter(t => t.state === 'finished').length,
      uptimeMs: 1000,
      reconnecting: false
    }),
    getSnapshot: () => [...terminals.values()],
    getCachedTerminal: addrOrName => findTerminal(addrOrName),
    onTransition: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    markSelfInitiated: addr => {
      selfInitiatedAt.set(addr, Date.now())
    },
    wasRecentlySelfInitiated: (addr, windowMs = 2000) => {
      const ts = selfInitiatedAt.get(addr)
      return ts !== undefined && Date.now() - ts <= windowMs
    },
    listTerminals: async (): Promise<HerdrTerminalListResponseDto> => ({
      available: true,
      terminals: [...terminals.values()],
      hiddenFinished: 0,
      machines: []
    }),
    getTerminal: async addrOrName => {
      const found = findTerminal(addrOrName)
      if (!found) throw new Error(`Terminal not found: ${addrOrName}`)
      return found
    },
    readTerminal: async (addr): Promise<HerdrReadResult> => {
      if (readError) throw readError
      const found = findTerminal(addr)
      const text = screens.get(found?.address || addr) ?? found?.screen ?? ''
      return { text, complete: true, how: 'screen' }
    },
    runTerminal: async () => makeTerminal(),
    sendTerminal: async (terminal, input): Promise<HerdrSendResult> => {
      if (sendError) throw sendError
      const found = findTerminal(terminal)
      const addr = found?.address || terminal
      sendCalls.push({ terminal: addr, input })
      const nextTurn = (found?.turn ?? 0) + 1
      if (found) found.turn = nextTurn
      return { turn: nextTurn, started: true, status: found?.status?.state || 'working' }
    },
    keysTerminal: async () => ({ turn: 1 }),
    interruptTerminal: async () => ({ outcome: 'stopped', key: 'Ctrl+C' }),
    answerTerminal: async (terminal, input): Promise<HerdrAnswerResult> => {
      const found = findTerminal(terminal)
      const addr = found?.address || terminal
      answerCalls.push({ terminal: addr, input })
      return { ok: true, mode: 'keys', keys: ['1'], result: { turn: found?.turn ?? 1 } }
    },
    waitTerminal: async () => ({
      terminal: 't1',
      ended: false,
      reason: 'timeout',
      turn: 1,
      children: []
    }),
    killTerminal: async addr => findTerminal(addr) || makeTerminal({ address: addr, state: 'finished' }),
    rmTerminal: async addr => ({ removed: addr }),
    labelTerminal: async (addr, labels) => {
      const t = findTerminal(addr) || makeTerminal({ address: addr })
      t.labels = { ...t.labels, ...labels }
      return t
    },
    setMuted: async (addr, muted) => {
      const t = findTerminal(addr) || makeTerminal({ address: addr })
      t.muted = muted
      return { terminal: t, muted }
    },
    putFile: async (_addr, name) => ({ path: name, bytes: 0 }),
    listMachines: async () => [],
    listTemplates: async () => [],
    listWorkspaces: async () => ({ available: true, workspaces: [] })
  }

  return {
    client,
    terminals,
    screens,
    sendCalls,
    answerCalls,
    setReadError: (err: Error | null) => {
      readError = err
    },
    setSendError: (err: Error | null) => {
      sendError = err
    },
    emit: (evt: HerdrTerminalTransitionEvent) => {
      if (evt.terminal) {
        terminals.set(evt.terminal.address, evt.terminal)
      }
      for (const l of [...listeners]) {
        l(evt)
      }
    }
  }
}

function createMockFeishuSdk() {
  const sentMessages: Array<{ receive_id: string; msg_type: string; content: string; id: string }> = []
  let handlers: Record<string, (data: any) => Promise<any> | any> = {}
  let msgSeq = 1

  const factory: FeishuSdkFactory = {
    createClient: () => ({
      request: async () => ({ bot: { open_id: 'ou_bot_r5' } }),
      im: {
        v1: {
          message: {
            create: async (payload: any) => {
              const id = `om_r5_${msgSeq++}`
              sentMessages.push({
                receive_id: payload.data.receive_id,
                msg_type: payload.data.msg_type,
                content: payload.data.content,
                id
              })
              return { data: { message_id: id } }
            },
            patch: async () => ({ code: 0 })
          }
        }
      }
    }),
    createWsClient: () => ({
      start: async () => {},
      close: () => {}
    }),
    createEventDispatcher: () => ({
      register: (h: Record<string, (data: any) => Promise<any> | any>) => {
        handlers = h
      }
    })
  }

  return {
    factory,
    sentMessages,
    getHandlers: () => handlers
  }
}

function createHarness() {
  const dir = makeTempDir()
  const logger = new TaggedLogger(join(dir, 'logs'))
  const vault = new SecretVault('44'.repeat(32), join(dir, 'master.key'))
  const db = new AppDatabase(join(dir, 'cjh.db'), vault)
  const wsHub = new WsHub()
  const mockSdk = createMockFeishuSdk()
  const dispatchedWs: any[] = []
  const mockHerdr = createMockHerdrClient()

  const bridge = new FeishuBridge(
    db,
    wsHub,
    logger,
    msg => dispatchedWs.push(msg),
    mockSdk.factory,
    mockHerdr.client
  )

  return { dir, db, wsHub, logger, mockSdk, dispatchedWs, mockHerdr, bridge }
}

describe('Round 5 R3 — HerdrNotifier, Mute, Debounce & Feishu Integration', () => {
  it('strips ANSI sequences cleanly in extractScreenTail and parses numbered options in parseScreenOptions', () => {
    const raw = [
      '\x1b]0;codex\x07',
      '1. Old step from earlier output',
      '2. Another earlier line',
      ...Array.from({ length: 25 }, (_, i) => `\x1b[32mline-${i + 1}\x1b[0m\r`),
      'Allow running \x1b[1mnpm test\x1b[0m?',
      '\x1b[36m❯ 1. Yes, allow once\x1b[0m',
      '  2) Always allow in this repo',
      '  [3] No, cancel'
    ].join('\n')

    const tail = extractScreenTail(raw, 20)
    expect(tail).not.toContain('\x1b')
    expect(tail.split('\n')).toHaveLength(20)
    expect(tail).toContain('line-25')
    expect(tail).not.toContain('Old step')

    const options = parseScreenOptions(raw)
    expect(options).toEqual([
      { index: 1, label: 'Yes, allow once' },
      { index: 2, label: 'Always allow in this repo' },
      { index: 3, label: 'No, cancel' }
    ])
  })

  it('triggers notifications for working->blocked, working->done, working->idle, ->error, and finished, and delivers Feishu cards when configured', async () => {
    const { db, wsHub, logger, mockSdk, mockHerdr, bridge } = createHarness()

    db.updateSettings({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_r5_app',
          appSecret: 'sec_r5_secret',
          domain: 'feishu',
          notifyChatId: 'oc_notify_chat'
        }
      }
    })

    const wsEvents: HerdrNotificationDto[] = []
    wsHub.subscribe(evt => {
      if (evt.type === HERDR_WS_EVENTS.NOTIFICATION) {
        wsEvents.push(evt.data as HerdrNotificationDto)
      }
    })
    const desktopPayloads: HerdrNotificationDto[] = []

    let currentMs = 10_000
    const notifier = new HerdrNotifier(db, wsHub, logger, mockHerdr.client, {
      feishuBridge: bridge,
      now: () => currentMs,
      onDesktopNotify: dto => desktopPayloads.push(dto)
    })
    notifier.start()

    try {
      const t1 = makeTerminal({
        address: 't1',
        name: 'fix-auth',
        agent: 'codex',
        cwd: 'D:/repo/auth',
        status: { state: 'working', app: 'codex' }
      })
      mockHerdr.terminals.set('t1', t1)
      mockHerdr.screens.set(
        't1',
        'Checking files...\nAllow tool write_file?\n❯ 1. Allow once\n  2. Always allow\n  3. Deny'
      )

      // 1) working -> blocked
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, status: { state: 'blocked', kind: 'permission', msg: 'write_file' } },
        prevStatus: { state: 'working' },
        status: { state: 'blocked', kind: 'permission', msg: 'write_file' },
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(mockSdk.sentMessages).toHaveLength(1))

      expect(wsEvents).toHaveLength(1)
      expect(desktopPayloads).toHaveLength(1)
      expect(wsEvents[0].kind).toBe('blocked')
      expect(wsEvents[0].blockedKind).toBe('permission')
      expect(wsEvents[0].options).toEqual([
        { index: 1, label: 'Allow once' },
        { index: 2, label: 'Always allow' },
        { index: 3, label: 'Deny' }
      ])

      const blockedCard = JSON.parse(mockSdk.sentMessages[0].content)
      expect(mockSdk.sentMessages[0].receive_id).toBe('oc_notify_chat')
      expect(blockedCard.header.template).toBe('red')
      expect(blockedCard.header.title.content).toContain('fix-auth (t1)')
      const actionElem = blockedCard.elements.find((e: any) => e.tag === 'action')
      expect(actionElem.actions).toHaveLength(3)
      expect(actionElem.actions[0].value).toMatchObject({
        kind: 'cjh_herdr_answer',
        terminal: 't1',
        choice: 1
      })
      expect(mockSdk.sentMessages[0].content).toContain('/t t1')

      // 2) working -> done
      currentMs += 6_000
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, status: { state: 'done', msg: 'Tests passed' } },
        prevStatus: { state: 'working' },
        status: { state: 'done', msg: 'Tests passed' },
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(mockSdk.sentMessages).toHaveLength(2))
      expect(wsEvents[1].kind).toBe('done')
      expect(JSON.parse(mockSdk.sentMessages[1].content).header.template).toBe('green')

      // 3) working -> idle (after >5s debounce so done category fires again)
      currentMs += 6_000
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, status: { state: 'idle' } },
        prevStatus: { state: 'working' },
        status: { state: 'idle' },
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(mockSdk.sentMessages).toHaveLength(3))
      expect(wsEvents[2].kind).toBe('done')
      expect(JSON.parse(mockSdk.sentMessages[2].content).header.template).toBe('green')

      // 4) -> error
      currentMs += 1_000
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, status: { state: 'error', msg: 'API 500' } },
        prevStatus: { state: 'idle' },
        status: { state: 'error', msg: 'API 500' },
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(mockSdk.sentMessages).toHaveLength(4))
      expect(wsEvents[3].kind).toBe('error')
      expect(JSON.parse(mockSdk.sentMessages[3].content).header.template).toBe('orange')

      // 5) finished
      currentMs += 1_000
      mockHerdr.emit({
        type: 'finished',
        address: 't1',
        terminal: { ...t1, state: 'finished', exit_code: 0 },
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(mockSdk.sentMessages).toHaveLength(5))
      expect(wsEvents[4].kind).toBe('finished')
      expect(JSON.parse(mockSdk.sentMessages[4].content).header.template).toBe('grey')
    } finally {
      notifier.dispose()
      db.close()
    }
  })

  it('ignores idle->working, suppresses self-initiated short working->idle bounce, enforces mute and 5s debounce', async () => {
    const { db, wsHub, logger, mockSdk, mockHerdr, bridge } = createHarness()

    db.updateSettings({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_r5_app',
          appSecret: 'sec_r5_secret',
          domain: 'feishu',
          notifyChatId: 'oc_notify_chat'
        }
      }
    })

    const wsEvents: HerdrNotificationDto[] = []
    wsHub.subscribe(evt => {
      if (evt.type === HERDR_WS_EVENTS.NOTIFICATION) {
        wsEvents.push(evt.data as HerdrNotificationDto)
      }
    })

    let currentMs = 20_000
    const notifier = new HerdrNotifier(db, wsHub, logger, mockHerdr.client, {
      feishuBridge: bridge,
      now: () => currentMs
    })
    notifier.start()

    try {
      const t1 = makeTerminal({ address: 't1', turn: 2 })
      mockHerdr.terminals.set('t1', t1)

      // idle -> working does NOT notify
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, status: { state: 'working' } },
        prevStatus: { state: 'idle' },
        status: { state: 'working' },
        initiatedByCjh: true,
        turn: 2,
        timestamp: currentMs
      })
      await new Promise(r => setTimeout(r, 20))
      expect(wsEvents).toHaveLength(0)

      // Spurious self-initiated working -> idle bounce within <300ms with same turn -> suppressed
      currentMs += 100
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, turn: 2, status: { state: 'idle' } },
        prevStatus: { state: 'working' },
        status: { state: 'idle' },
        turn: 2,
        timestamp: currentMs
      })
      await new Promise(r => setTimeout(r, 20))
      expect(wsEvents).toHaveLength(0)

      // Self-initiated working -> idle when turn increments DOES notify
      currentMs += 500
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, turn: 2, status: { state: 'working' } },
        prevStatus: { state: 'idle' },
        status: { state: 'working' },
        initiatedByCjh: true,
        turn: 2,
        timestamp: currentMs
      })
      currentMs += 100
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, turn: 3, status: { state: 'idle' } },
        prevStatus: { state: 'working' },
        status: { state: 'idle' },
        turn: 3,
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(wsEvents).toHaveLength(1))
      expect(wsEvents[0].kind).toBe('done')

      // 5s debounce: second working -> done within 5000ms is suppressed
      currentMs += 2_000
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, turn: 4, status: { state: 'done' } },
        prevStatus: { state: 'working' },
        status: { state: 'done' },
        turn: 4,
        timestamp: currentMs
      })
      await new Promise(r => setTimeout(r, 20))
      expect(wsEvents).toHaveLength(1)

      // After >5000ms it fires again
      currentMs += 3_500
      mockHerdr.emit({
        type: 'status',
        address: 't1',
        terminal: { ...t1, turn: 5, status: { state: 'done' } },
        prevStatus: { state: 'working' },
        status: { state: 'done' },
        turn: 5,
        timestamp: currentMs
      })
      await vi.waitFor(() => expect(wsEvents).toHaveLength(2))

      // Mute via cjh.mute=1 label suppresses both desktop & Feishu
      const tMutedLabel = makeTerminal({
        address: 't2',
        labels: { 'cjh.mute': '1' }
      })
      mockHerdr.terminals.set('t2', tMutedLabel)
      currentMs += 1_000
      mockHerdr.emit({
        type: 'status',
        address: 't2',
        terminal: { ...tMutedLabel, status: { state: 'blocked', kind: 'question' } },
        prevStatus: { state: 'working' },
        status: { state: 'blocked', kind: 'question' },
        timestamp: currentMs
      })
      await new Promise(r => setTimeout(r, 20))
      expect(wsEvents).toHaveLength(2)
      expect(mockSdk.sentMessages).toHaveLength(2)

      // Mute via settings.herdr.mutedTerminals suppresses both desktop & Feishu
      db.updateSettings({ herdr: { mutedTerminals: ['t3'] } })
      const tMutedSettings = makeTerminal({ address: 't3', labels: {} })
      mockHerdr.terminals.set('t3', tMutedSettings)
      currentMs += 1_000
      mockHerdr.emit({
        type: 'status',
        address: 't3',
        terminal: { ...tMutedSettings, status: { state: 'error', msg: 'boom' } },
        prevStatus: { state: 'idle' },
        status: { state: 'error', msg: 'boom' },
        timestamp: currentMs
      })
      await new Promise(r => setTimeout(r, 20))
      expect(wsEvents).toHaveLength(2)
      expect(mockSdk.sentMessages).toHaveLength(2)
    } finally {
      notifier.dispose()
      db.close()
    }
  })

  it('handles Feishu card action cjh_herdr_answer, reply-to-card routing, and /t commands', async () => {
    const { db, logger, mockSdk, dispatchedWs, mockHerdr, bridge } = createHarness()

    db.updateSettings({
      channels: {
        feishu: {
          enabled: true,
          appId: 'cli_r5_app',
          appSecret: 'sec_r5_secret',
          domain: 'feishu',
          notifyChatId: 'oc_notify_chat'
        }
      }
    })
    await bridge.connect()

    const t5 = makeTerminal({
      address: 't5',
      name: 'fix-auth',
      agent: 'claude',
      cwd: 'D:/repo/auth',
      turn: 3,
      status: { state: 'blocked', kind: 'permission', msg: 'Run tests?' }
    })
    const t6 = makeTerminal({
      address: 't6',
      name: 'refactor-ui',
      agent: 'agy',
      cwd: 'D:/repo/ui',
      turn: 2,
      status: { state: 'idle', msg: 'Ready' }
    })
    mockHerdr.terminals.set('t5', t5)
    mockHerdr.terminals.set('t6', t6)

    try {
      // 1. Send notification cards and verify card action callback calls answerTerminal
      const cardMsgId1 = await bridge.sendHerdrNotificationCard('oc_notify_chat', {
        id: 'notif-1',
        address: 't5',
        terminalName: 'fix-auth',
        agent: 'claude',
        cwd: 'D:/repo/auth',
        kind: 'blocked',
        title: '终端待处理：fix-auth (t5)',
        body: '[permission] Run tests?',
        blockedKind: 'permission',
        screenTail: '1. Allow once\n2. Deny',
        options: [
          { index: 1, label: 'Allow once' },
          { index: 2, label: 'Deny' }
        ],
        timestamp: Date.now()
      })
      expect(cardMsgId1).toBeTruthy()

      const actionRes = await bridge.handleCardActionEvent({
        action: {
          value: {
            kind: 'cjh_herdr_answer',
            terminal: 't5',
            choice: 1,
            label: 'Allow once'
          }
        }
      })
      expect(actionRes.toast.type).toBe('success')
      expect(mockHerdr.answerCalls).toContainEqual({
        terminal: 't5',
        input: { choice: 1 }
      })

      // 2. Reply to a notification card via parent_id routes directly to terminal (not chat thread)
      const cardMsgId2 = await bridge.sendHerdrNotificationCard('oc_notify_chat', {
        id: 'notif-2',
        address: 't6',
        terminalName: 'refactor-ui',
        agent: 'agy',
        cwd: 'D:/repo/ui',
        kind: 'done',
        title: '终端已完成：refactor-ui (t6)',
        body: 'Finished UI update',
        timestamp: Date.now()
      })
      expect(cardMsgId2).toBeTruthy()

      const replyRes = await bridge.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_reply_card_1',
          chat_id: 'oc_notify_chat',
          chat_type: 'p2p',
          parent_id: cardMsgId2,
          message_type: 'text',
          content: JSON.stringify({ text: '请再跑一遍单测' })
        }
      })
      expect(replyRes.handled).toBe(true)
      expect(replyRes.reason).toBe('herdr_card_reply')
      expect(mockHerdr.sendCalls).toContainEqual({
        terminal: 't6',
        input: { text: '请再跑一遍单测', force: false }
      })
      // Must NOT have triggered LLM chat generation
      expect(dispatchedWs).toHaveLength(0)

      // Reply to blocked card with numeric choice -> answerTerminal({ choice })
      const blockedReplyRes = await bridge.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_reply_blocked_1',
          chat_id: 'oc_notify_chat',
          chat_type: 'p2p',
          parent_id: cardMsgId1,
          message_type: 'text',
          content: JSON.stringify({ text: '2' })
        }
      })
      expect(blockedReplyRes.handled).toBe(true)
      expect(mockHerdr.answerCalls).toContainEqual({
        terminal: 't5',
        input: { choice: 2 }
      })

      // 3. /help lists /t commands
      const prevSentCount = mockSdk.sentMessages.length
      await bridge.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_cmd_help',
          chat_id: 'oc_notify_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/help' })
        }
      })
      expect(mockSdk.sentMessages[prevSentCount].content).toContain('/t ls')

      // 4. /t ls lists terminals
      const lsStart = mockSdk.sentMessages.length
      const lsRes = await bridge.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_cmd_t_ls',
          chat_id: 'oc_notify_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/t ls' })
        }
      })
      expect(lsRes.handled).toBe(true)
      expect(lsRes.reason).toBe('command_t_ls')
      const lsCardText = mockSdk.sentMessages[lsStart].content
      expect(lsCardText).toContain('t5')
      expect(lsCardText).toContain('fix-auth')
      expect(lsCardText).toContain('t6')
      expect(lsCardText).toContain('refactor-ui')

      // 5. /t <name> <text> sends text to resolved terminal
      const sendRes = await bridge.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_cmd_t_send',
          chat_id: 'oc_notify_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/t refactor-ui git status' })
        }
      })
      expect(sendRes.handled).toBe(true)
      expect(sendRes.reason).toBe('command_t_send')
      expect(mockHerdr.sendCalls).toContainEqual({
        terminal: 't6',
        input: { text: 'git status', force: false }
      })

      // 6. /t <t> 1 on blocked terminal answers with choice 1
      const ansRes = await bridge.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_cmd_t_answer',
          chat_id: 'oc_notify_chat',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/t t5 1' })
        }
      })
      expect(ansRes.handled).toBe(true)
      expect(ansRes.reason).toBe('command_t_answer')
      expect(mockHerdr.answerCalls).toContainEqual({
        terminal: 't5',
        input: { choice: 1 }
      })
      expect(dispatchedWs).toHaveLength(0)
    } finally {
      await bridge.disconnect()
      db.close()
    }
  })
})
