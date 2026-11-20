import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HERDR_WS_EVENTS,
  HerdrClientLike,
  HerdrTerminal,
  HerdrTerminalTransitionEvent
} from '@shared/herdr-types'
import { PermissionOptionDto, ThreadDto } from '@shared/schemas'
import { parseFlags, runCli } from '../../cli/index'
import { SecretVault } from '../crypto/vault'
import { AppDatabase } from '../db/database'
import { HerdrFollowManager } from '../herdr/follow'
import { TaggedLogger } from '../logger'
import { isAllowPermissionOption, PermissionGate } from '../permissions/gate'
import { SkillsScanner } from '../skills/scanner'
import { buildHerdrToolSet, formatHerdrToolTitle } from '../tools/herdr-tools'
import { WsHub } from '../ws-hub'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r5-r4-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.CJH_DATA_DIR
  delete process.env.CJH_API_URL
  delete process.env.CJH_API_TOKEN
  while (tempDirs.length) {
    const d = tempDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore cleanup lock
    }
  }
})

function makeSampleTerminal(overrides: Partial<HerdrTerminal> = {}): HerdrTerminal {
  return {
    address: 't5',
    name: 'fix-auth',
    state: 'live',
    argv: ['codex', '--no-daemon'],
    cwd: 'D:\\repo\\app',
    cols: 120,
    rows: 40,
    created_ms: 1700000000000,
    screen: '',
    turn: 1,
    status: { state: 'idle', app: 'codex' },
    labels: { cjh: '1' },
    agent: 'codex',
    muted: false,
    ...overrides
  }
}

function createMockHerdrClient(initialTerminals: HerdrTerminal[] = []) {
  const terminals = new Map<string, HerdrTerminal>(initialTerminals.map(t => [t.address, t]))
  const listeners = new Set<(evt: HerdrTerminalTransitionEvent) => void>()

  const calls = {
    list: [] as any[],
    read: [] as any[],
    wait: [] as any[],
    run: [] as any[],
    send: [] as any[],
    answer: [] as any[],
    keys: [] as any[],
    kill: [] as any[],
    rm: [] as any[]
  }

  let screenText = 'line 1\nline 2\nAll tests passed.'

  const client: HerdrClientLike = {
    start: async () => {},
    dispose: async () => {},
    getStatus: () => ({
      available: true,
      connected: true,
      reason: null,
      execPath: 'mock-hc',
      version: '0.1.21',
      core: { id: 'core-1', name: 'default' },
      live: terminals.size,
      finished: 0,
      uptimeMs: 1000,
      reconnecting: false
    }),
    getSnapshot: () => [...terminals.values()],
    getCachedTerminal: (addressOrName: string) => {
      if (terminals.has(addressOrName)) return terminals.get(addressOrName)!
      for (const t of terminals.values()) {
        if (t.name === addressOrName) return t
      }
      return null
    },
    onTransition: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    markSelfInitiated: () => {},
    wasRecentlySelfInitiated: () => false,
    listTerminals: async opts => {
      calls.list.push(opts)
      return {
        available: true,
        terminals: [...terminals.values()],
        hiddenFinished: 0,
        machines: []
      }
    },
    getTerminal: async address => {
      const t = client.getCachedTerminal(address)
      if (!t) throw new Error(`not_found: ${address}`)
      return t
    },
    readTerminal: async (terminal, lines) => {
      calls.read.push({ terminal, lines })
      return {
        text: screenText,
        complete: true,
        how: lines && lines > 0 ? 'history' : 'screen',
        why: null
      }
    },
    runTerminal: async input => {
      calls.run.push(input)
      const created = makeSampleTerminal({
        address: 't9',
        name: input.name || 'worker',
        agent: input.agent || 'codex',
        cwd: input.cwd || 'D:\\repo\\app'
      })
      terminals.set(created.address, created)
      return created
    },
    sendTerminal: async (terminal, input) => {
      calls.send.push({ terminal, input })
      return { turn: 2, started: true, status: 'working' }
    },
    keysTerminal: async (terminal, keys) => {
      calls.keys.push({ terminal, keys })
      return { turn: 2, status: 'working' }
    },
    interruptTerminal: async () => ({ outcome: 'stopped', key: 'ctrl-c' }),
    answerTerminal: async (terminal, input) => {
      calls.answer.push({ terminal, input })
      return { ok: true, mode: 'keys', keys: ['1', 'enter'], result: { turn: 2, status: 'working' } }
    },
    waitTerminal: async (terminal, opts) => {
      calls.wait.push({ terminal, opts })
      return {
        terminal,
        ended: false,
        reason: 'done',
        turn: 2,
        status: 'done',
        children: []
      }
    },
    killTerminal: async terminal => {
      calls.kill.push({ terminal })
      const t = client.getCachedTerminal(terminal) || makeSampleTerminal({ address: terminal })
      const finished = { ...t, state: 'finished' as const, exit_code: 0 }
      terminals.set(finished.address, finished)
      return finished
    },
    rmTerminal: async terminal => {
      calls.rm.push({ terminal })
      terminals.delete(terminal)
      return { removed: terminal }
    },
    labelTerminal: async (terminal, labels) => {
      const t = client.getCachedTerminal(terminal)!
      return { ...t, labels: { ...t.labels, ...labels } }
    },
    setMuted: async (terminal, muted) => {
      const t = client.getCachedTerminal(terminal)!
      return { terminal: { ...t, muted }, muted }
    },
    putFile: async (_terminal, name) => ({ path: `/tmp/${name}`, bytes: 10 }),
    listMachines: async () => [],
    listTemplates: async () => [],
    listWorkspaces: async () => ({ available: true, workspaces: [] })
  }

  return {
    client,
    calls,
    terminals,
    setScreenText: (txt: string) => {
      screenText = txt
    },
    emit: (evt: HerdrTerminalTransitionEvent) => {
      for (const l of [...listeners]) l(evt)
    }
  }
}

function createPermissionRunner(
  db: AppDatabase,
  wsHub: WsHub,
  permissionGate: PermissionGate,
  thread: ThreadDto
) {
  const allowedTools = new Set<string>(
    Array.isArray(thread.metadata?.allowedBuiltinTools)
      ? thread.metadata.allowedBuiltinTools.filter((x): x is string => typeof x === 'string')
      : []
  )
  return async <T>(
    toolName: string,
    requiresConfirmation: boolean,
    rawInput: unknown,
    fn: () => Promise<T> | T
  ): Promise<T> => {
    const settings = db.getSettings()
    const needsConfirm = requiresConfirmation || !settings.tools.autoApproveReadOnly
    if (needsConfirm && !allowedTools.has(toolName)) {
      const options: PermissionOptionDto[] = [
        { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow_always', name: '本线程总是允许该工具', kind: 'allow_always' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' }
      ]
      const outcome = await permissionGate.requestPermission({
        threadId: thread.id,
        providerId: 'mock-provider',
        title: formatHerdrToolTitle(toolName, rawInput) || toolName,
        toolName,
        rawInput,
        cwd: thread.workspacePath || null,
        options
      })
      const selected =
        outcome.outcome === 'selected'
          ? options.find(o => o.optionId === outcome.optionId)
          : undefined
      if (!isAllowPermissionOption(selected)) {
        throw new Error(`权限被拒绝：用户拒绝执行 ${toolName} 或审批已超时`)
      }
      if (selected!.kind === 'allow_always') {
        allowedTools.add(toolName)
        db.addThreadAllowedBuiltinTool(thread.id, toolName)
      }
    }
    return await fn()
  }
}

describe('Round 5 R4 — Builtin Herdr Tools, Follow Manager & Skill', () => {
  it('enforces PermissionGate on mutating tools, auto-approves read-only tools, clamps wait timeout, and wires follow', async () => {
    const dataDir = makeTempDir('cjh-r5-tools-')
    const vault = new SecretVault(undefined, join(dataDir, 'master.key'))
    const db = new AppDatabase(join(dataDir, 'cjh.db'), vault)
    const wsHub = new WsHub()
    const logger = new TaggedLogger(join(dataDir, 'logs'))
    db.updateSettings({ acp: { permissionTimeoutSec: 5 }, tools: { autoApproveReadOnly: true } })

    const requested: any[] = []
    let nextDecision: 'allow_once' | 'allow_always' | '__reject__' = '__reject__'
    const permissionGate = new PermissionGate(
      db,
      logger,
      dto => {
        requested.push(dto)
        setTimeout(() => permissionGate.resolvePermission(dto.requestId, nextDecision), 10)
      },
      () => {}
    )

    const thread = db.createThread({ title: 'herdr tools test', workspacePath: 'D:\\repo\\app' })
    const otherThread = db.createThread({ title: 'other thread' })

    const mock = createMockHerdrClient([
      makeSampleTerminal({ address: 't5', name: 'fix-auth', cwd: 'D:\\repo\\app' }),
      makeSampleTerminal({ address: 't6', name: 'other-proj', cwd: 'D:\\repo\\other' })
    ])
    const triggerFn = vi.fn()
    const followManager = new HerdrFollowManager(mock.client, wsHub, logger, {
      triggerFollowTurn: triggerFn
    })

    const tools = buildHerdrToolSet({
      herdrClient: mock.client,
      followManager,
      thread,
      runWithPermission: createPermissionRunner(db, wsHub, permissionGate, thread)
    })

    try {
      // 1. Read-only tools auto-approve when autoApproveReadOnly = true
      const listRes = await (tools.herdr_list as any).execute(
        { cwd: 'D:/repo/app/' },
        { toolCallId: 'c1', messages: [] }
      )
      expect(listRes.available).toBe(true)
      expect(listRes.terminals).toHaveLength(1)
      expect(listRes.terminals[0].address).toBe('t5')

      const readRes = await (tools.herdr_read as any).execute(
        { terminal: 't5', lines: 9999 },
        { toolCallId: 'c2', messages: [] }
      )
      expect(readRes.text).toContain('All tests passed.')
      expect(mock.calls.read[0].lines).toBe(500)

      const waitRes = await (tools.herdr_wait as any).execute(
        { terminal: 't5', timeout: 999, output: 'Done' },
        { toolCallId: 'c3', messages: [] }
      )
      expect(waitRes.reason).toBe('done')
      expect(mock.calls.wait[0].opts.timeout).toBe(300)

      const waitMin = await (tools.herdr_wait as any).execute(
        { terminal: 't5', timeout: -5 },
        { toolCallId: 'c4', messages: [] }
      )
      expect(waitMin.reason).toBe('done')
      expect(mock.calls.wait[1].opts.timeout).toBe(1)
      expect(requested).toHaveLength(0)

      // 2. When autoApproveReadOnly = false, read-only tool asks PermissionGate and fails closed on reject
      db.updateSettings({ tools: { autoApproveReadOnly: false } })
      nextDecision = '__reject__'
      await expect(
        (tools.herdr_read as any).execute({ terminal: 't5' }, { toolCallId: 'c5', messages: [] })
      ).rejects.toThrow('权限被拒绝')
      expect(requested).toHaveLength(1)

      db.updateSettings({ tools: { autoApproveReadOnly: true } })

      // 3. All 5 mutating tools fail closed when rejected
      for (const [name, args] of [
        ['herdr_run', { agent: 'codex', task: 'fix bug' }],
        ['herdr_send', { terminal: 't5', text: 'hi' }],
        ['herdr_answer', { terminal: 't5', choice: 1 }],
        ['herdr_keys', { terminal: 't5', keys: ['enter'] }],
        ['herdr_kill', { terminal: 't5' }]
      ] as const) {
        nextDecision = '__reject__'
        await expect(
          (tools[name] as any).execute(args, { toolCallId: `rej-${name}`, messages: [] })
        ).rejects.toThrow('权限被拒绝')
      }
      expect(mock.calls.run).toHaveLength(0)
      expect(mock.calls.send).toHaveLength(0)
      expect(mock.calls.answer).toHaveLength(0)
      expect(mock.calls.keys).toHaveLength(0)
      expect(mock.calls.kill).toHaveLength(0)

      // 4. Approve herdr_run with follow: true -> defaults cwd to thread.workspacePath & binds follow
      nextDecision = 'allow_once'
      const runOut = await (tools.herdr_run as any).execute(
        { agent: 'codex', name: 'worker', task: 'run unit tests', follow: true },
        { toolCallId: 'run-1', messages: [] }
      )
      expect(runOut.terminal.address).toBe('t9')
      expect(runOut.following).toBe(true)
      expect(mock.calls.run[0].cwd).toBe('D:\\repo\\app')
      expect(followManager.getFollower('t9')?.threadId).toBe(thread.id)

      // 5. Approve herdr_send with allow_always + follow: true
      nextDecision = 'allow_always'
      const sendOut = await (tools.herdr_send as any).execute(
        { terminal: 't5', text: 'check again', follow: true },
        { toolCallId: 'send-1', messages: [] }
      )
      expect(sendOut.following).toBe(true)
      expect(followManager.getFollower('t5')?.threadId).toBe(thread.id)

      // Second herdr_send does not re-prompt because allow_always was granted
      const reqCountBefore = requested.length
      await (tools.herdr_send as any).execute(
        { terminal: 't5', text: 'second msg' },
        { toolCallId: 'send-2', messages: [] }
      )
      expect(requested.length).toBe(reqCountBefore)

      // 6. Another thread trying herdr_send with follow:true on already-followed terminal is rejected cleanly
      const otherTools = buildHerdrToolSet({
        herdrClient: mock.client,
        followManager,
        thread: otherThread,
        runWithPermission: createPermissionRunner(db, wsHub, permissionGate, otherThread)
      })
      nextDecision = 'allow_once'
      const sendCallsBefore = mock.calls.send.length
      await expect(
        (otherTools.herdr_send as any).execute(
          { terminal: 't5', text: 'hijack', follow: true },
          { toolCallId: 'send-hijack', messages: [] }
        )
      ).rejects.toThrow(`已被线程 ${thread.id} 跟进`)
      expect(mock.calls.send.length).toBe(sendCallsBefore)

      // 7. herdr_unfollow (no confirmation needed) works for owning thread, rejects for non-owning thread
      await expect(
        (otherTools.herdr_unfollow as any).execute(
          { terminal: 't5' },
          { toolCallId: 'unf-other', messages: [] }
        )
      ).rejects.toThrow(thread.id)

      const unfOut = await (tools.herdr_unfollow as any).execute(
        { terminal: 't5' },
        { toolCallId: 'unf-1', messages: [] }
      )
      expect(unfOut.unfollowed).toBe(true)
      expect(followManager.getFollower('t5')).toBeNull()

      // 8. herdr_answer, herdr_keys, herdr_kill(remove=true)
      nextDecision = 'allow_once'
      await (tools.herdr_answer as any).execute(
        { terminal: 't5', choice: 2, useArrows: false },
        { toolCallId: 'ans-1', messages: [] }
      )
      expect(mock.calls.answer[0]).toEqual({
        terminal: 't5',
        input: { choice: 2, text: undefined, useArrows: false }
      })

      await (tools.herdr_keys as any).execute(
        { terminal: 't5', keys: ['down', 'enter'] },
        { toolCallId: 'keys-1', messages: [] }
      )
      expect(mock.calls.keys[0]).toEqual({ terminal: 't5', keys: ['down', 'enter'] })

      const killOut = await (tools.herdr_kill as any).execute(
        { terminal: 't9', remove: true },
        { toolCallId: 'kill-1', messages: [] }
      )
      expect(killOut.killed.state).toBe('finished')
      expect(killOut.removed).toEqual({ removed: 't9' })
      expect(followManager.getFollower('t9')).toBeNull()

      // 9. formatHerdrToolTitle formatting
      expect(formatHerdrToolTitle('herdr_send', { terminal: 't5' })).toBe('herdr_send · t5')
      expect(formatHerdrToolTitle('herdr_run', { agent: 'agy', name: 'fix' })).toBe(
        'herdr_run · agy (fix)'
      )
      expect(formatHerdrToolTitle('fs_read', { path: 'a.ts' })).toBeNull()
    } finally {
      followManager.dispose()
      db.close()
    }
  })

  it('HerdrFollowManager enforces single-thread constraint, injects transitions without duplicates, and cleans up on unfollow/finished/removed', async () => {
    const dataDir = makeTempDir('cjh-r5-follow-')
    const wsHub = new WsHub()
    const logger = new TaggedLogger(join(dataDir, 'logs'))
    const wsEvents: Array<{ type: string; data: any }> = []
    const unsubWs = wsHub.subscribe(evt => wsEvents.push({ type: evt.type, data: evt.data }))

    const term = makeSampleTerminal({
      address: 't5',
      name: 'fix-auth',
      agent: 'codex',
      cwd: 'D:\\repo\\app',
      turn: 3,
      status: { state: 'working', app: 'codex', msg: '正在修改登录模块' }
    })
    const mock = createMockHerdrClient([term])
    mock.setScreenText('\x1b[32mPASS\x1b[0m auth.test.ts\n1. Allow write\n2. Deny')

    const triggered: Array<{ threadId: string; promptText: string }> = []
    const manager = new HerdrFollowManager(mock.client, wsHub, logger, {
      triggerFollowTurn: (threadId, promptText) => {
        triggered.push({ threadId, promptText })
      }
    })

    try {
      // Single-thread constraint + name resolution
      const b1 = manager.follow('fix-auth', 'thread-A')
      expect(b1.terminal).toBe('t5')
      expect(b1.threadId).toBe('thread-A')
      expect(manager.follow('t5', 'thread-A')).toBe(b1) // idempotent for same thread
      expect(() => manager.follow('t5', 'thread-B')).toThrow('已被线程 thread-A 跟进')

      expect(
        wsEvents.some(e => e.type === HERDR_WS_EVENTS.FOLLOW_UPDATED && e.data.follows.length === 1)
      ).toBe(true)

      // 1. working -> done on turn 3 triggers once with ANSI-stripped screen & status
      mock.emit({
        type: 'status',
        address: 't5',
        terminal: { ...term, turn: 3, status: { state: 'done', app: 'codex', msg: '修复完成' } },
        prevStatus: { state: 'working' },
        status: { state: 'done', app: 'codex', msg: '修复完成' },
        turn: 3,
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 30))
      expect(triggered).toHaveLength(1)
      expect(triggered[0].threadId).toBe('thread-A')
      expect(triggered[0].promptText).toContain('fix-auth (t5)')
      expect(triggered[0].promptText).toContain('修复完成')
      expect(triggered[0].promptText).toContain('PASS auth.test.ts')
      expect(triggered[0].promptText).not.toContain('\x1b[32m')

      // 2. done -> idle AND duplicate working -> idle on SAME turn 3 do NOT trigger twice
      mock.emit({
        type: 'status',
        address: 't5',
        prevStatus: { state: 'done' },
        status: { state: 'idle' },
        turn: 3,
        timestamp: Date.now()
      })
      mock.emit({
        type: 'status',
        address: 't5',
        prevStatus: { state: 'working' },
        status: { state: 'idle' },
        turn: 3,
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 30))
      expect(triggered).toHaveLength(1)

      // 3. Turn 4: working -> blocked triggers, then resume working -> blocked triggers again, then error triggers
      mock.emit({
        type: 'status',
        address: 't5',
        prevStatus: { state: 'working' },
        status: { state: 'blocked', kind: 'permission', msg: '需要允许执行 npm test' },
        turn: 4,
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 30))
      expect(triggered).toHaveLength(2)
      expect(triggered[1].promptText).toContain('blocked (permission)')

      mock.emit({
        type: 'status',
        address: 't5',
        prevStatus: { state: 'blocked' },
        status: { state: 'working' },
        turn: 4,
        timestamp: Date.now()
      })
      mock.emit({
        type: 'status',
        address: 't5',
        prevStatus: { state: 'working' },
        status: { state: 'error', msg: '命令执行失败' },
        turn: 4,
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 30))
      expect(triggered).toHaveLength(3)
      expect(triggered[2].promptText).toContain('error')

      // 4. finished triggers & auto-removes follow binding
      mock.emit({
        type: 'finished',
        address: 't5',
        terminal: { ...term, state: 'finished', exit_code: 0, turn: 4 },
        turn: 4,
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 30))
      expect(triggered).toHaveLength(4)
      expect(triggered[3].promptText).toContain('finished (exit_code=0)')
      expect(manager.getFollower('t5')).toBeNull()

      // 5. Re-follow then unfollow stops future triggers
      manager.follow('t5', 'thread-A')
      expect(manager.unfollow('t5')).toBe(true)
      mock.emit({
        type: 'status',
        address: 't5',
        prevStatus: { state: 'working' },
        status: { state: 'done', msg: 'should ignore' },
        turn: 5,
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 30))
      expect(triggered).toHaveLength(4)

      // 6. removed event immediately deletes binding without triggering
      manager.follow('t5', 'thread-A')
      mock.emit({
        type: 'removed',
        address: 't5',
        timestamp: Date.now()
      })
      await new Promise(r => setTimeout(r, 20))
      expect(manager.getFollower('t5')).toBeNull()
      expect(triggered).toHaveLength(4)
    } finally {
      unsubWs()
      manager.dispose()
    }
  })

  it('SkillsScanner discovers builtin:herdr from resources/skills/herdr/SKILL.md', () => {
    const dataDir = makeTempDir('cjh-r5-skills-')
    const vault = new SecretVault(undefined, join(dataDir, 'master.key'))
    const db = new AppDatabase(join(dataDir, 'cjh.db'), vault)
    const builtinDir = resolve(process.cwd(), 'resources', 'skills')
    const scanner = new SkillsScanner(db, join(dataDir, 'skills'), builtinDir)

    try {
      const skills = scanner.scan()
      const herdrSkill = skills.find(s => s.id === 'builtin:herdr')
      expect(herdrSkill).toBeDefined()
      expect(herdrSkill!.name).toBe('herdr')
      expect(herdrSkill!.source).toBe('builtin')
      expect(herdrSkill!.enabled).toBe(true)
      expect(herdrSkill!.description).toContain('herdr')

      const loaded = scanner.getContent('builtin:herdr')
      expect(loaded?.content).toContain('herdr_run')
      expect(loaded?.content).toContain('blocked')
    } finally {
      db.close()
    }
  })
})

describe('Round 5 R5 — CLI cjh term subcommands', () => {
  it('dispatches ls, read, run, send, answer, follow, unfollow to /api/herdr/* and parses flags cleanly', async () => {
    const requests: Array<{ method: string; url: string; auth: string | undefined; body: any }> = []

    const srv = createServer(async (req, res) => {
      let rawBody = ''
      for await (const chunk of req) rawBody += chunk
      const parsedBody = rawBody ? JSON.parse(rawBody) : null
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        auth: req.headers.authorization,
        body: parsedBody
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url?.startsWith('/api/herdr/terminals?') && req.method === 'GET') {
        res.end(
          JSON.stringify({
            available: true,
            terminals: [
              makeSampleTerminal({
                address: 't5',
                name: 'fix-auth',
                agent: 'codex',
                status: { state: 'working', msg: '正在运行单测' },
                turn: 2,
                cwd: 'D:\\repo\\app'
              })
            ],
            hiddenFinished: 0,
            machines: []
          })
        )
        return
      }
      if (req.url?.includes('/screen') && req.method === 'GET') {
        res.end(JSON.stringify({ text: 'SCREEN_OK\nline 2', complete: true, how: 'screen' }))
        return
      }
      if (req.url === '/api/herdr/terminals' && req.method === 'POST') {
        res.end(JSON.stringify({ address: 't9', name: parsedBody.name, agent: parsedBody.agent }))
        return
      }
      if (req.url?.endsWith('/send') && req.method === 'POST') {
        res.end(JSON.stringify({ turn: 3, started: true }))
        return
      }
      if (req.url?.endsWith('/answer') && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true, mode: 'keys' }))
        return
      }
      if (req.url?.endsWith('/follow') && req.method === 'POST') {
        res.end(JSON.stringify({ terminal: 't5', threadId: parsedBody.threadId }))
        return
      }
      if (req.url?.endsWith('/follow') && req.method === 'DELETE') {
        res.end(JSON.stringify({ ok: true, unfollowed: true }))
        return
      }
      res.end(JSON.stringify({ ok: true }))
    })

    await new Promise<void>(resolveListen => srv.listen(0, '127.0.0.1', resolveListen))
    const port = (srv.address() as any).port
    process.env.CJH_API_URL = `http://127.0.0.1:${port}`
    process.env.CJH_API_TOKEN = 'test-herdr-cli-token'

    const capture = () => {
      const logs: string[] = []
      return {
        logs,
        io: {
          log: (m: string) => logs.push(m),
          error: (m: string) => logs.push(m)
        }
      }
    }

    try {
      // Flag parsing sanity checks (boolean flags don't swallow positional args; value flags preserve '-' values)
      const parsedAnswer = parseFlags(['t5', '--arrows', '2'])
      expect(parsedAnswer.flags.arrows).toBe(true)
      expect(parsedAnswer.positional).toEqual(['t5', '2'])

      const parsedText = parseFlags(['t5', '--text', '- confirm option'])
      expect(parsedText.flags.text).toBe('- confirm option')

      // 1. cjh term ls --all
      const c1 = capture()
      await runCli(['term', 'ls', '--all'], c1.io)
      expect(c1.logs[0]).toBe('t5\tfix-auth\tcodex\tworking\t2\tD:\\repo\\app\t正在运行单测')
      expect(requests[0].url).toBe('/api/herdr/terminals?all=1')
      expect(requests[0].auth).toBe('Bearer test-herdr-cli-token')

      // 2. cjh term read t5 --lines 80
      const c2 = capture()
      await runCli(['term', 'read', 't5', '--lines', '80'], c2.io)
      expect(c2.logs[0]).toBe('SCREEN_OK\nline 2')
      expect(requests[1].url).toBe('/api/herdr/terminals/t5/screen?lines=80')

      // 3. cjh term run agy --cwd /repo/app --name worker --follow th-1 修复登录单测
      const c3 = capture()
      await runCli(
        ['term', 'run', 'agy', '--cwd', '/repo/app', '--name', 'worker', '--follow', 'th-1', '修复登录单测'],
        c3.io
      )
      expect(JSON.parse(c3.logs.join('\n')).address).toBe('t9')
      expect(requests[2].body).toEqual({
        agent: 'agy',
        cwd: '/repo/app',
        name: 'worker',
        task: '修复登录单测',
        followThreadId: 'th-1'
      })

      // 4. cjh term send t5 --force --wait --follow th-1 继续执行测试
      const c4 = capture()
      await runCli(
        ['term', 'send', 't5', '--force', '--wait', '--follow', 'th-1', '继续执行测试'],
        c4.io
      )
      expect(requests[3].url).toBe('/api/herdr/terminals/t5/send')
      expect(requests[3].body).toEqual({
        text: '继续执行测试',
        force: true,
        wait: true,
        followThreadId: 'th-1'
      })

      // 5. cjh term answer t5 2 --arrows  &  cjh term answer t5 --text "yes"
      const c5 = capture()
      await runCli(['term', 'answer', 't5', '2', '--arrows'], c5.io)
      expect(requests[4].url).toBe('/api/herdr/terminals/t5/answer')
      expect(requests[4].body).toEqual({ choice: 2, useArrows: true })

      const c6 = capture()
      await runCli(['term', 'answer', 't5', '--text', 'yes'], c6.io)
      expect(requests[5].body).toEqual({ text: 'yes', useArrows: false })

      // 6. cjh term follow t5 --thread th-1
      const c7 = capture()
      await runCli(['term', 'follow', 't5', '--thread', 'th-1'], c7.io)
      expect(requests[6].url).toBe('/api/herdr/terminals/t5/follow')
      expect(requests[6].body).toEqual({ threadId: 'th-1' })

      // 7. cjh term unfollow t5
      const c8 = capture()
      await runCli(['term', 'unfollow', 't5'], c8.io)
      expect(requests[7].method).toBe('DELETE')
      expect(requests[7].url).toBe('/api/herdr/terminals/t5/follow')
    } finally {
      srv.close()
    }
  })
})
