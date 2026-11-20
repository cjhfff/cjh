import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, Server as NetServer, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HERDR_WS_EVENTS,
  HerdrFollowBindingDto,
  HerdrFollowManagerLike,
  HerdrTerminal,
  HerdrTerminalTransitionEvent,
  ProviderDto,
  WsServerEnvelope
} from '@shared/schemas'
import { AcpAgentManager, PRESET_PACKAGES, resolveAcpLaunchSpec } from '../acp/manager'
import { SecretVault } from '../crypto/vault'
import { AppDatabase } from '../db/database'
import {
  HerdrClient,
  HerdrFollowManager,
  deriveTerminalAgent,
  registerHerdrRoutes,
  resolveAgentArgv
} from '../herdr'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'

const tempDirs: string[] = []
const cleanupCallbacks: Array<() => Promise<void> | void> = []

function makeTempDir(prefix = 'cjh-r5-r0r1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeProvider(overrides: Partial<ProviderDto> = {}): ProviderDto {
  return {
    id: 'prov-1',
    name: 'Test Provider',
    type: 'acp',
    apiFormat: 'anthropic',
    isResponseApi: false,
    useMaxCompletionTokens: false,
    apiVersion: null,
    baseUrl: null,
    hasApiKey: false,
    apiKeyPreview: null,
    customHeaders: {},
    models: [],
    availableModels: [],
    acpPreset: 'antigravity',
    acpCommand: null,
    acpExecutablePath: null,
    acpArgs: [],
    acpEnv: {},
    acpApiProviderId: null,
    acpMcpServerIds: [],
    acpPermissionMode: 'default',
    acpAvailableModes: [],
    acpLastModeId: null,
    enabled: true,
    sortOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

interface FakeHerdrHarness {
  scriptPath: string
  emitEvent: (seq: number, terminal: string, type: string, data: unknown) => void
  emitHeartbeat: () => void
  emitMissed: (seq: number, terminals: HerdrTerminal[]) => void
  crashConnections: () => void
  getRpcCalls: () => Array<{ method: string; params: any }>
  getConnectionCount: () => number
  setNextRpcError: (method: string, error: { code: number; message: string; kind: string }) => void
  close: () => Promise<void>
}

async function createFakeHerdrHarness(
  dir: string,
  initialTerminals: HerdrTerminal[] = []
): Promise<FakeHerdrHarness> {
  const terminals = new Map<string, HerdrTerminal>(
    initialTerminals.map(t => [t.address, structuredClone(t)])
  )
  const rpcCalls: Array<{ method: string; params: any }> = []
  const nextErrors = new Map<string, { code: number; message: string; kind: string }>()
  const sockets = new Set<Socket>()
  let eventSubSocket: Socket | null = null
  let connectionCount = 0
  let nextTermNum = 10

  const sendJson = (sock: Socket, obj: unknown) => {
    if (!sock.destroyed) {
      sock.write(JSON.stringify(obj) + '\n')
    }
  }

  const server: NetServer = createServer(sock => {
    connectionCount++
    sockets.add(sock)
    let isEventsConn = false
    let buf = ''

    sock.on('data', chunk => {
      buf += chunk.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
        if (!line) continue

        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }

        if (isEventsConn) {
          // Plain mode: after events.subscribe, connection carries only notifications
          continue
        }

        const { id, method, params = {} } = msg
        rpcCalls.push({ method, params })

        const injectedErr = nextErrors.get(method)
        if (injectedErr) {
          nextErrors.delete(method)
          sendJson(sock, {
            jsonrpc: '2.0',
            id,
            error: {
              code: injectedErr.code,
              message: injectedErr.message,
              data: { kind: injectedErr.kind }
            }
          })
          continue
        }

        switch (method) {
          case 'hello': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                generation: 1,
                version: '0.1.21-mock',
                core: { id: 'core-mock-1', name: 'mock-host' },
                framed: false,
                methods: ['server.status', 'events.subscribe', 'terminal.list'],
                features: []
              }
            })
            break
          }
          case 'server.status': {
            const list = [...terminals.values()]
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                core: { id: 'core-mock-1', name: 'mock-host' },
                version: '0.1.21-mock',
                pid: 4242,
                uptime_ms: 12345,
                holders: [{ pid: 4242, instance: '1', current: true, terminals: list.length }],
                live: list.filter(t => t.state === 'live').length,
                finished: list.filter(t => t.state === 'finished').length
              }
            })
            break
          }
          case 'events.subscribe': {
            isEventsConn = true
            eventSubSocket = sock
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                seq: 5,
                terminals: [...terminals.values()]
              }
            })
            break
          }
          case 'terminal.list': {
            const all = Boolean(params.all)
            const list = [...terminals.values()].filter(t => (all ? true : t.state === 'live'))
            const hiddenFinished = [...terminals.values()].filter(t => t.state === 'finished').length
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                terminals: list,
                hidden_finished: all ? 0 : hiddenFinished,
                machines: [
                  {
                    name: 'vps',
                    target: 'root@vps',
                    id: 'm1',
                    host: 'vps',
                    version: '0.1.21',
                    state: 'connected'
                  }
                ]
              }
            })
            break
          }
          case 'terminal.get': {
            const target = [...terminals.values()].find(
              t => t.address === params.terminal || t.name === params.terminal
            )
            if (!target) {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } }
              })
            } else {
              sendJson(sock, { jsonrpc: '2.0', id, result: target })
            }
            break
          }
          case 'terminal.read': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                text: `screen for ${params.terminal} (lines=${params.lines ?? 0})`,
                complete: true,
                how: 'screen',
                why: null
              }
            })
            break
          }
          case 'terminal.run': {
            const addr = `t${nextTermNum++}`
            const created: HerdrTerminal = {
              address: addr,
              name: params.name ?? null,
              state: 'live',
              argv: params.argv || [],
              cwd: params.cwd || 'D:\\workspace\\cjh',
              cols: params.size?.cols ?? 200,
              rows: params.size?.rows ?? 120,
              created_ms: Date.now(),
              screen: 'exact',
              turn: 0,
              labels: params.labels || {},
              status: { state: 'idle', app: 'antigravity', msg: 'ready' }
            }
            terminals.set(addr, created)
            sendJson(sock, { jsonrpc: '2.0', id, result: created })
            break
          }
          case 'terminal.send': {
            const target = [...terminals.values()].find(
              t => t.address === params.terminal || t.name === params.terminal
            )
            if (!target) {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } }
              })
              break
            }
            if (target.status?.state === 'blocked' && !params.force) {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'blocked', data: { kind: 'blocked' } }
              })
              break
            }
            target.turn += 1
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                turn: target.turn,
                started: true,
                status: 'working'
              }
            })
            break
          }
          case 'terminal.keys': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: { turn: 2, status: 'working' }
            })
            break
          }
          case 'terminal.interrupt': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: { outcome: 'stopped', key: 'esc' }
            })
            break
          }
          case 'terminal.wait': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                terminal: params.terminal,
                ended: true,
                reason: 'status',
                turn: 3,
                status: 'done',
                children: []
              }
            })
            break
          }
          case 'terminal.kill': {
            const target = [...terminals.values()].find(
              t => t.address === params.terminal || t.name === params.terminal
            )
            if (!target) {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } }
              })
              break
            }
            target.state = 'finished'
            target.reason = 'killed'
            target.finished_ms = Date.now()
            sendJson(sock, { jsonrpc: '2.0', id, result: target })
            break
          }
          case 'terminal.rm': {
            const target = [...terminals.values()].find(
              t => t.address === params.terminal || t.name === params.terminal
            )
            if (!target) {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } }
              })
              break
            }
            if (target.state === 'live') {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'live', data: { kind: 'live' } }
              })
              break
            }
            terminals.delete(target.address)
            sendJson(sock, { jsonrpc: '2.0', id, result: { removed: target.address } })
            break
          }
          case 'terminal.label': {
            const target = [...terminals.values()].find(
              t => t.address === params.terminal || t.name === params.terminal
            )
            if (!target) {
              sendJson(sock, {
                jsonrpc: '2.0',
                id,
                error: { code: -32000, message: 'not_found', data: { kind: 'not_found' } }
              })
              break
            }
            const nextLabels = { ...target.labels }
            for (const [k, v] of Object.entries(params.labels || {})) {
              if (v === '') delete nextLabels[k]
              else nextLabels[k] = String(v)
            }
            target.labels = nextLabels
            sendJson(sock, { jsonrpc: '2.0', id, result: target })
            break
          }
          case 'terminal.put': {
            const rawBytes = Buffer.from(String(params.data || ''), 'base64').byteLength
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                path: `/tmp/herdr/${params.terminal}/${params.name}`,
                bytes: rawBytes
              }
            })
            break
          }
          case 'machine.list': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                machines: [
                  {
                    name: 'vps',
                    target: 'root@vps',
                    id: 'm1',
                    host: 'vps',
                    version: '0.1.21',
                    state: 'connected'
                  }
                ]
              }
            })
            break
          }
          case 'templates.list': {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              result: {
                templates: [
                  {
                    name: 'reviewer',
                    description: 'Code review role',
                    command: 'claude'
                  }
                ]
              }
            })
            break
          }
          default: {
            sendJson(sock, {
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Method not found: ${method}` }
            })
          }
        }
      }
    })

    sock.on('close', () => {
      sockets.delete(sock)
      if (eventSubSocket === sock) eventSubSocket = null
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  const scriptPath = join(dir, 'fake-herdr-core.mjs')
  writeFileSync(
    scriptPath,
    `import { connect } from 'node:net'
const sock = connect(${port}, '127.0.0.1')
process.stdin.pipe(sock)
sock.pipe(process.stdout)
sock.on('close', () => process.exit(0))
sock.on('error', () => process.exit(1))
`,
    'utf8'
  )

  return {
    scriptPath,
    emitEvent(seq, terminal, type, data) {
      if (!eventSubSocket) throw new Error('No active events subscription socket')
      if (type === 'created' && data && typeof data === 'object') {
        const term = ((data as any).terminal ?? data) as HerdrTerminal
        if (term?.address) terminals.set(term.address, structuredClone(term))
      } else if (type === 'status' && data && typeof data === 'object') {
        const existing = terminals.get(terminal)
        if (existing) {
          existing.status = ('status' in data ? (data as any).status : data) as any
        }
      }
      sendJson(eventSubSocket, {
        jsonrpc: '2.0',
        method: 'event',
        params: { seq, terminal, type, data }
      })
    },
    emitHeartbeat() {
      if (!eventSubSocket) throw new Error('No active events subscription socket')
      sendJson(eventSubSocket, {
        jsonrpc: '2.0',
        method: 'heartbeat',
        params: {}
      })
    },
    emitMissed(seq, nextTerminals) {
      if (!eventSubSocket) throw new Error('No active events subscription socket')
      terminals.clear()
      for (const t of nextTerminals) terminals.set(t.address, structuredClone(t))
      sendJson(eventSubSocket, {
        jsonrpc: '2.0',
        method: 'missed',
        params: { seq, terminals: nextTerminals }
      })
    },
    crashConnections() {
      for (const s of [...sockets]) {
        s.destroy()
      }
    },
    getRpcCalls: () => rpcCalls,
    getConnectionCount: () => connectionCount,
    setNextRpcError(method, error) {
      nextErrors.set(method, error)
    },
    async close() {
      for (const s of [...sockets]) {
        s.destroy()
      }
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

function createFollowManagerMock(): HerdrFollowManagerLike {
  const bindings = new Map<string, HerdrFollowBindingDto>()
  return {
    follow(terminal, threadId) {
      const binding: HerdrFollowBindingDto = {
        terminal,
        threadId,
        createdAt: Date.now(),
        lastTurnNotified: 0
      }
      bindings.set(terminal, binding)
      return binding
    },
    unfollow(terminal) {
      return bindings.delete(terminal)
    },
    unfollowThread(threadId) {
      let count = 0
      for (const [k, v] of bindings.entries()) {
        if (v.threadId === threadId) {
          bindings.delete(k)
          count++
        }
      }
      return count
    },
    getFollower(terminal) {
      return bindings.get(terminal) || null
    },
    listFollows() {
      return [...bindings.values()]
    },
    dispose() {
      bindings.clear()
    }
  }
}

afterEach(async () => {
  while (cleanupCallbacks.length) {
    const fn = cleanupCallbacks.pop()!
    await fn()
  }
  while (tempDirs.length) {
    const d = tempDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

describe('Round 5 R0 — Antigravity (agy) ACP Preset', () => {
  it('registers antigravity preset alongside claude, codex, gemini without npmPkg', () => {
    expect(PRESET_PACKAGES.claude.npmPkg).toBe('@agentclientprotocol/claude-agent-acp')
    expect(PRESET_PACKAGES.codex.npmPkg).toBe('@zed-industries/codex-acp')
    expect(PRESET_PACKAGES.gemini.npmPkg).toBe('@google/gemini-cli')
    expect(PRESET_PACKAGES.antigravity).toEqual({
      alias: 'agy',
      extraArgs: ['acp'],
      cliBinary: 'agy'
    })
  })

  it('probes Windows default ~/.gemini/bin/agy.exe before PATH, honors explicit acpExecutablePath, and never falls back to npx', () => {
    const winHome = 'C:\\Users\\tester'
    const expectedWinBin = join(winHome, '.gemini', 'bin', 'agy.exe')

    // 1. Windows default path exists
    const winSpec = resolveAcpLaunchSpec(makeProvider({ acpArgs: ['--verbose'] }), {
      platform: 'win32',
      homeDir: winHome,
      fileExists: p => p === expectedWinBin,
      findInPath: () => 'C:\\other\\agy.exe'
    })
    expect(winSpec.command).toBe(expectedWinBin)
    expect(winSpec.args).toEqual(['acp', '--verbose'])
    expect(winSpec.extraEnv.CLAUDE_CODE_EXECUTABLE).toBeUndefined()

    // 2. Explicit acpExecutablePath overrides command binary directly
    const explicitSpec = resolveAcpLaunchSpec(
      makeProvider({
        acpExecutablePath: 'D:\\custom\\agy-dev.exe',
        acpArgs: ['--debug']
      }),
      {
        platform: 'win32',
        homeDir: winHome,
        fileExists: () => true,
        findInPath: () => 'C:\\other\\agy.exe'
      }
    )
    expect(explicitSpec.command).toBe('D:\\custom\\agy-dev.exe')
    expect(explicitSpec.args).toEqual(['acp', '--debug'])
    expect(explicitSpec.extraEnv.CLAUDE_CODE_EXECUTABLE).toBeUndefined()

    // 3. Fallback to PATH agy when win32 default absent
    const pathSpec = resolveAcpLaunchSpec(makeProvider(), {
      platform: 'win32',
      homeDir: winHome,
      fileExists: () => false,
      findInPath: cmd => (cmd === 'agy' ? 'C:\\bin\\agy.exe' : null)
    })
    expect(pathSpec.command).toBe('C:\\bin\\agy.exe')
    expect(pathSpec.args).toEqual(['acp'])

    // 4. Never falls back to npx when absent
    const missingSpec = resolveAcpLaunchSpec(makeProvider(), {
      platform: 'linux',
      homeDir: '/home/tester',
      fileExists: () => false,
      findInPath: () => null
    })
    expect(missingSpec.command).toBe('agy')
    expect(missingSpec.args).toEqual(['acp'])
    expect(missingSpec.command).not.toBe('npx')

    // 5. Claude preset still sets CLAUDE_CODE_EXECUTABLE and falls back to npx
    const claudeSpec = resolveAcpLaunchSpec(
      makeProvider({
        acpPreset: 'claude',
        acpExecutablePath: 'C:\\tools\\claude.exe'
      }),
      {
        platform: 'win32',
        fileExists: () => false,
        findInPath: () => null
      }
    )
    expect(claudeSpec.command).toBe('npx')
    expect(claudeSpec.args).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
    expect(claudeSpec.extraEnv.CLAUDE_CODE_EXECUTABLE).toBe('C:\\tools\\claude.exe')
  })

  it('aborts fail-closed when antigravity session reports bypassPermissions and session/set_mode fails', async () => {
    const dir = makeTempDir()
    const vault = new SecretVault()
    const db = new AppDatabase(join(dir, 'cjh.db'), vault)
    const logger = new TaggedLogger(join(dir, 'logs'))
    cleanupCallbacks.push(() => db.close())

    const fakeAgyScript = join(dir, 'fake-agy.mjs')
    const wrapperCmd = join(dir, process.platform === 'win32' ? 'fake-agy.cmd' : 'fake-agy.sh')
    writeFileSync(
      fakeAgyScript,
      `import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } }) + '\\n')
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'agy-sess-1',
        modes: {
          currentModeId: 'bypassPermissions',
          availableModes: [{ id: 'default', name: 'Default' }, { id: 'bypassPermissions', name: 'Bypass' }]
        }
      }
    }) + '\\n')
  } else if (msg.method === 'session/set_mode') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: 'session/set_mode unsupported' }
    }) + '\\n')
  }
})
`,
      'utf8'
    )
    if (process.platform === 'win32') {
      writeFileSync(
        wrapperCmd,
        `@ECHO off\r\n"${process.execPath}" "${fakeAgyScript}" %*\r\n`,
        'utf8'
      )
    } else {
      writeFileSync(wrapperCmd, `#!/bin/sh\nexec "${process.execPath}" "${fakeAgyScript}" "$@"\n`, {
        mode: 0o755
      })
    }

    const mgr = new AcpAgentManager(
      db,
      logger,
      () => ({ apiUrl: 'http://127.0.0.1:1', apiToken: 'tok' }),
      () => {},
      () => {}
    )
    cleanupCallbacks.push(() => mgr.disposeAll())

    const prov = db.upsertProvider({
      id: 'agy-test',
      name: 'Antigravity',
      type: 'acp',
      apiFormat: 'anthropic',
      isResponseApi: false,
      useMaxCompletionTokens: false,
      acpPreset: 'antigravity',
      acpExecutablePath: wrapperCmd,
      acpPermissionMode: 'default',
      acpArgs: [],
      acpEnv: {},
      acpMcpServerIds: [],
      customHeaders: {},
      models: [],
      availableModels: [],
      enabled: true,
      sortOrder: 0
    })

    const thread = db.createThread({ model: 'agy-test:default' })

    await expect(
      mgr.runPromptTurn({
        threadId: thread.id,
        provider: prov,
        modelId: 'default',
        cwd: dir,
        promptText: 'hello',
        mcpServersForAcp: [],
        abortSignal: new AbortController().signal,
        callbacks: {
          onTextDelta: () => {},
          onReasoningDelta: () => {},
          onToolCallStart: () => {},
          onToolCallUpdate: () => {}
        }
      })
    ).rejects.toThrow(/无法把 ACP 会话权限模式设为 default/)

    expect(mgr.getActiveThreadSessionInfo(thread.id)).toBeNull()
  }, 15_000)
})

describe('Round 5 R1 — HerdrClient & HTTP Routes', () => {
  it('returns graceful unavailable status and 503/200 responses when herdr-core is missing', async () => {
    const dir = makeTempDir()
    const db = new AppDatabase(join(dir, 'cjh.db'), new SecretVault())
    const logger = new TaggedLogger(join(dir, 'logs'))
    const wsHub = new WsHub()
    cleanupCallbacks.push(() => db.close())

    const client = new HerdrClient(db, logger, wsHub, {
      execPathOverride: join(dir, 'missing-herdr-core.exe')
    })
    cleanupCallbacks.push(() => client.dispose())

    await client.start()
    const status = client.getStatus()
    expect(status.available).toBe(false)
    expect(status.connected).toBe(false)
    expect(status.reason).toBeTruthy()

    const app = new Hono()
    registerHerdrRoutes(app, { herdrClient: client, db, wsHub })

    const statusRes = await app.request('/api/herdr/status')
    expect(statusRes.status).toBe(200)
    expect(await statusRes.json()).toMatchObject({ available: false, connected: false })

    const listRes = await app.request('/api/herdr/terminals')
    expect(listRes.status).toBe(200)
    expect(await listRes.json()).toMatchObject({
      available: false,
      terminals: [],
      hiddenFinished: 0,
      machines: []
    })

    const wsRes = await app.request('/api/herdr/workspaces')
    expect(wsRes.status).toBe(200)
    expect(await wsRes.json()).toMatchObject({ available: false, workspaces: [] })

    const runRes = await app.request('/api/herdr/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'shell' })
    })
    expect(runRes.status).toBe(503)
  })

  it('derives agent names and resolves agent argv consistently', () => {
    expect(
      deriveTerminalAgent({
        argv: ['bash'],
        status: { state: 'working', app: 'antigravity' }
      })
    ).toBe('agy')
    expect(deriveTerminalAgent({ argv: ['C:\\bin\\codex.exe', '--no-daemon'] })).toBe('codex')
    expect(deriveTerminalAgent({ argv: ['claude'] })).toBe('claude')
    expect(deriveTerminalAgent({ argv: ['pi'] })).toBe('pi')
    expect(deriveTerminalAgent({ argv: ['powershell.exe'] })).toBe('shell')
    expect(deriveTerminalAgent({ argv: [], template: 'reviewer' })).toBe('reviewer')

    expect(resolveAgentArgv('agy')).toEqual(['agy'])
    expect(resolveAgentArgv('codex')).toEqual(['codex', '--no-daemon'])
    expect(resolveAgentArgv('agy', undefined, { agy: ['D:\\bin\\agy.exe'] })).toEqual([
      'D:\\bin\\agy.exe'
    ])
    expect(resolveAgentArgv('agy', ['custom-agy', '--flag'])).toEqual(['custom-agy', '--flag'])
  })

  it('does not recurse when a real HerdrFollowManager enriches a non-empty snapshot (regression: stack overflow on real hc)', async () => {
    const dir = makeTempDir()
    const db = new AppDatabase(join(dir, 'cjh.db'), new SecretVault())
    const logger = new TaggedLogger(join(dir, 'logs'))
    const wsHub = new WsHub()
    const term = (address: string, name: string): HerdrTerminal => ({
      address,
      name,
      state: 'live',
      argv: ['codex'],
      cwd: 'D:\\repo\\alpha',
      cols: 200,
      rows: 120,
      created_ms: 1000,
      screen: 'exact',
      turn: 3,
      title: '',
      labels: {},
      status: { state: 'idle', app: 'codex' },
      foreground: { pid: 7, name: 'codex', argv: ['codex'], cwd: 'D:\\repo\\alpha' }
    })
    const harness = await createFakeHerdrHarness(dir, [term('t3', 'user-codex'), term('t4', 'user-agy')])
    cleanupCallbacks.push(() => harness.close())
    cleanupCallbacks.push(() => db.close())

    let followRef: HerdrFollowManager | null = null
    const client = new HerdrClient(db, logger, wsHub, {
      execPathOverride: harness.scriptPath,
      getFollower: addr => followRef?.getFollower(addr)?.threadId ?? null,
      reconnectBaseDelayMs: 60,
      reconnectMaxDelayMs: 240
    })
    followRef = new HerdrFollowManager(client, wsHub, logger, { triggerFollowTurn: () => {} })
    cleanupCallbacks.push(() => client.dispose())

    await client.start()
    expect(client.getStatus()).toMatchObject({ available: true, connected: true, reason: null })
    expect(client.getSnapshot().map(t => t.address).sort()).toEqual(['t3', 't4'])
    expect(client.getCachedTerminal('user-codex')?.address).toBe('t3')

    followRef.follow('user-agy', 'thread-1')
    expect(client.getCachedTerminal('t4')?.followedByThreadId).toBe('thread-1')
    expect(client.getCachedTerminal('t3')?.followedByThreadId).toBeNull()
  })

  it('handles dual-connection RPC, event stream notifications, WS broadcasts, routes, answer, delete confirm, put, and reconnect', async () => {
    const dir = makeTempDir()
    const db = new AppDatabase(join(dir, 'cjh.db'), new SecretVault())
    const logger = new TaggedLogger(join(dir, 'logs'))
    const wsHub = new WsHub()
    const followMgr = createFollowManagerMock()

    const initialTerm: HerdrTerminal = {
      address: 't1',
      name: 'worker',
      state: 'live',
      argv: ['claude'],
      cwd: 'D:\\repo\\alpha',
      cols: 200,
      rows: 120,
      created_ms: 1000,
      screen: 'exact',
      turn: 1,
      title: 'Initial Title',
      labels: { env: 'dev' },
      status: { state: 'idle', app: 'claude', msg: 'waiting' },
      foreground: { pid: 101, name: 'claude', argv: ['claude'], cwd: 'D:\\repo\\alpha' }
    }

    const harness = await createFakeHerdrHarness(dir, [initialTerm])
    cleanupCallbacks.push(() => harness.close())
    cleanupCallbacks.push(() => db.close())

    const wsEvents: WsServerEnvelope[] = []
    const unsubWs = wsHub.subscribe(evt => wsEvents.push(evt))
    cleanupCallbacks.push(unsubWs)

    const transitions: HerdrTerminalTransitionEvent[] = []
    const client = new HerdrClient(db, logger, wsHub, {
      execPathOverride: harness.scriptPath,
      getFollower: addr => followMgr.getFollower(addr)?.threadId || null,
      reconnectBaseDelayMs: 60,
      reconnectMaxDelayMs: 240
    })
    cleanupCallbacks.push(() => client.dispose())
    client.onTransition(evt => transitions.push(evt))

    await client.start()

    // Dual connections established: 1 RPC + 1 Events
    expect(harness.getConnectionCount()).toBe(2)
    expect(client.getStatus()).toMatchObject({
      available: true,
      connected: true,
      version: '0.1.21-mock',
      live: 1,
      finished: 0
    })

    // Initial snapshot broadcast + cached enrichment
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINALS_SNAPSHOT)).toBe(true)
    expect(client.getCachedTerminal('worker')?.agent).toBe('claude')

    const app = new Hono()
    registerHerdrRoutes(app, { herdrClient: client, followManager: followMgr, db, wsHub })

    // 1. Run terminal via POST /api/herdr/terminals (agy + task -> ['agy', '-i', task], labels.cjh='1', follow)
    const runRes = await app.request('/api/herdr/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'agy',
        cwd: 'D:\\repo\\beta',
        name: 'agy-job',
        task: 'fix bug 42',
        followThreadId: 'thread-99'
      })
    })
    expect(runRes.status).toBe(201)
    const createdDto = (await runRes.json()) as HerdrTerminal
    expect(createdDto.address).toBe('t10')
    expect(createdDto.labels.cjh).toBe('1')
    expect(createdDto.followedByThreadId).toBe('thread-99')
    const lastRunCall = harness.getRpcCalls().filter(c => c.method === 'terminal.run').pop()!
    expect(lastRunCall.params.argv).toEqual(['agy', '-i', 'fix bug 42'])
    expect(lastRunCall.params.wait).toBe(false)
    expect(client.wasRecentlySelfInitiated('t10')).toBe(true)

    // 2. Event notifications -> cache + transitions + WS broadcasts
    harness.emitEvent(6, 't11', 'created', {
      address: 't11',
      name: 'codex-box',
      state: 'live',
      argv: ['codex', '--no-daemon'],
      cwd: 'D:\\repo\\alpha',
      cols: 200,
      rows: 120,
      created_ms: 2000,
      screen: 'exact',
      turn: 0,
      labels: {}
    })
    await new Promise(r => setTimeout(r, 30))
    expect(client.getCachedTerminal('t11')?.agent).toBe('codex')
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_CREATED)).toBe(true)

    // Status event shape A: { status, status_ms }
    harness.emitEvent(7, 't10', 'status', {
      status: { state: 'working', app: 'antigravity', msg: 'editing' },
      status_ms: 3000
    })
    // Status event shape B: direct { state, kind, msg }
    harness.emitEvent(8, 't1', 'status', {
      state: 'blocked',
      kind: 'permission',
      msg: 'Allow rm?'
    })
    harness.emitEvent(9, 't1', 'turn', { turn: 2 })
    harness.emitEvent(10, 't1', 'title', { title: 'Updated Title' })
    harness.emitEvent(11, 't1', 'labels', { labels: { env: 'dev', 'cjh.mute': '1' } })
    harness.emitHeartbeat()
    await new Promise(r => setTimeout(r, 40))

    const t10Cached = client.getCachedTerminal('t10')!
    expect(t10Cached.status?.state).toBe('working')
    const t10StatusTransition = transitions.find(
      t => t.type === 'status' && t.address === 't10'
    )
    expect(t10StatusTransition?.initiatedByCjh).toBe(true)

    const t1Cached = client.getCachedTerminal('t1')!
    expect(t1Cached.status?.state).toBe('blocked')
    expect(t1Cached.turn).toBe(2)
    expect(t1Cached.title).toBe('Updated Title')
    expect(t1Cached.muted).toBe(true)

    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_STATUS)).toBe(true)
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_TURN)).toBe(true)
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_TITLE)).toBe(true)
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_LABELS)).toBe(true)

    // 3. Workspaces grouping + read + answer + send + keys + interrupt + put + mute
    const wsListRes = await app.request('/api/herdr/workspaces?all=1')
    expect(wsListRes.status).toBe(200)
    const wsBody = await wsListRes.json()
    expect(wsBody.available).toBe(true)
    expect(wsBody.workspaces.length).toBeGreaterThanOrEqual(2)

    const screenRes = await app.request('/api/herdr/terminals/t1/screen?lines=50')
    expect(screenRes.status).toBe(200)
    expect((await screenRes.json()).text).toContain('lines=50')

    // answer choice numeric -> keys ['2', 'enter']
    const ansNumRes = await app.request('/api/herdr/terminals/t1/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: 2 })
    })
    expect(ansNumRes.status).toBe(200)
    expect(await ansNumRes.json()).toMatchObject({ ok: true, mode: 'keys', keys: ['2', 'enter'] })

    // answer choice with useArrows -> ['down', 'down', 'enter']
    const ansArrowRes = await app.request('/api/herdr/terminals/t1/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: 3, useArrows: true })
    })
    expect(ansArrowRes.status).toBe(200)
    expect(await ansArrowRes.json()).toMatchObject({
      ok: true,
      mode: 'keys',
      keys: ['down', 'down', 'enter']
    })

    // answer text -> send with force: true
    const ansTextRes = await app.request('/api/herdr/terminals/t1/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'yes proceed' })
    })
    expect(ansTextRes.status).toBe(200)
    const lastSend = harness.getRpcCalls().filter(c => c.method === 'terminal.send').pop()!
    expect(lastSend.params).toMatchObject({ terminal: 't1', text: 'yes proceed', force: true })

    // put JSON
    const putJsonRes = await app.request('/api/herdr/terminals/t1/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'note.txt',
        data: Buffer.from('hello herdr').toString('base64')
      })
    })
    expect(putJsonRes.status).toBe(200)
    expect(await putJsonRes.json()).toMatchObject({ bytes: 11 })

    // put multipart FormData
    const form = new FormData()
    form.append('file', new Blob(['binary-img-data'], { type: 'image/png' }), 'shot.png')
    const putFormRes = await app.request('/api/herdr/terminals/t1/put', {
      method: 'POST',
      body: form
    })
    expect(putFormRes.status).toBe(200)
    expect(await putFormRes.json()).toMatchObject({
      path: '/tmp/herdr/t1/shot.png',
      bytes: 15
    })

    // keys, interrupt, label, mute, wait, follow/unfollow
    const keysRes = await app.request('/api/herdr/terminals/t1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['ctrl+c'] })
    })
    expect(keysRes.status).toBe(200)

    const intRes = await app.request('/api/herdr/terminals/t1/interrupt', {
      method: 'POST'
    })
    expect(intRes.status).toBe(200)
    expect(await intRes.json()).toMatchObject({ outcome: 'stopped', key: 'esc' })

    const labelRes = await app.request('/api/herdr/terminals/t1/label', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels: { tag: 'v1' } })
    })
    expect(labelRes.status).toBe(200)
    expect((await labelRes.json()).labels.tag).toBe('v1')

    const muteRes = await app.request('/api/herdr/terminals/t1/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted: false })
    })
    expect(muteRes.status).toBe(200)
    expect((await muteRes.json()).muted).toBe(false)

    const waitRes = await client.waitTerminal('t1', { timeout: 5 })
    expect(waitRes.ended).toBe(true)
    expect(waitRes.status).toBe('done')

    const followRes = await app.request('/api/herdr/terminals/t1/follow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'thread-1' })
    })
    expect(followRes.status).toBe(200)

    const unfollowRes = await app.request('/api/herdr/terminals/t1/follow', {
      method: 'DELETE'
    })
    expect(unfollowRes.status).toBe(200)
    expect(await unfollowRes.json()).toEqual({ ok: true })

    // machines, templates, follows
    expect((await (await app.request('/api/herdr/machines')).json()).machines).toHaveLength(1)
    expect((await (await app.request('/api/herdr/templates')).json()).templates).toHaveLength(1)
    expect((await (await app.request('/api/herdr/follows')).json()).follows).toHaveLength(1)

    // 4. DELETE requires secondary confirmation (query confirm=1 or body { confirm: true })
    const delNoConfirm = await app.request('/api/herdr/terminals/t11', { method: 'DELETE' })
    expect(delNoConfirm.status).toBe(400)

    const delWithBodyConfirm = await app.request('/api/herdr/terminals/t11', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true })
    })
    expect(delWithBodyConfirm.status).toBe(200)
    expect((await delWithBodyConfirm.json()).state).toBe('finished')

    // finished & removed events
    harness.emitEvent(12, 't11', 'finished', {
      exit_code: 0,
      finished_ms: 4000,
      reason: 'killed',
      signal: null
    })
    await new Promise(r => setTimeout(r, 20))
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_FINISHED)).toBe(true)

    const rmRes = await app.request('/api/herdr/terminals/t11/rm', { method: 'POST' })
    expect(rmRes.status).toBe(200)

    harness.emitEvent(13, 't11', 'removed', {})
    await new Promise(r => setTimeout(r, 20))
    expect(client.getCachedTerminal('t11')).toBeNull()
    expect(wsEvents.some(e => e.type === HERDR_WS_EVENTS.TERMINAL_REMOVED)).toBe(true)

    // 5. RPC error code mapping (404 not_found, 409 blocked)
    const notFoundRes = await app.request('/api/herdr/terminals/t999')
    expect(notFoundRes.status).toBe(404)

    const blockedSendRes = await app.request('/api/herdr/terminals/t1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hi', force: false })
    })
    expect(blockedSendRes.status).toBe(409)

    // 6. Missed event replaces snapshot
    harness.emitMissed(20, [initialTerm])
    await new Promise(r => setTimeout(r, 20))
    expect(client.getSnapshot().map(t => t.address)).toEqual(['t1'])

    // 7. Auto-reconnect after fake process crash
    const countBeforeCrash = harness.getConnectionCount()
    harness.crashConnections()
    const disconnDeadline = Date.now() + 3000
    while (Date.now() < disconnDeadline && client.getStatus().connected) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(client.getStatus().connected).toBe(false)

    const reconnDeadline = Date.now() + 5000
    while (Date.now() < reconnDeadline && !client.getStatus().connected) {
      await new Promise(r => setTimeout(r, 30))
    }
    expect(harness.getConnectionCount()).toBeGreaterThan(countBeforeCrash)
    expect(client.getStatus().connected).toBe(true)
    expect(client.getStatus().reconnecting).toBe(false)
  }, 20_000)
})
