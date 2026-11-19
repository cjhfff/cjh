import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startLocalDaemon } from '../entry'
import { executeShellCommand } from '../tools/shell'
import { buildBuiltinToolSet } from '../tools/builtin'
import { webFetch, webSearch } from '../tools/web'
import {
  resolveSafeWorkspacePath,
  workspaceFsEdit,
  workspaceFsGlob,
  workspaceFsGrep,
  workspaceFsList,
  workspaceFsRead,
  workspaceFsWrite
} from '../tools/workspace-fs'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r1-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.CJH_DATA_DIR
  while (tempDirs.length) {
    const d = tempDirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // ignore cleanup lock
    }
  }
})

describe('Round 4 R1 — Built-in Tools, Permission Gate, Sandbox & Web', () => {
  it('blocks workspace traversal, requires workspace binding, and enforces permission timeout fail-closed', async () => {
    const dataDir = makeTempDir('cjh-r1-data-')
    const workspaceDir = makeTempDir('cjh-r1-ws-')
    const outsideFile = join(dataDir, 'secret.txt')
    writeFileSync(outsideFile, 'TOP_SECRET', 'utf8')
    writeFileSync(join(workspaceDir, 'hello.ts'), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')

    process.env.CJH_DATA_DIR = dataDir
    const daemon = await startLocalDaemon({ port: 0, masterKeyHex: '11'.repeat(32) })

    try {
      // Set 1s permission timeout to test fail-closed timeout
      daemon.ctx.db.updateSettings({ acp: { permissionTimeoutSec: 1 } })

      // 1. Thread without workspacePath returns clear error
      const unboundThread = daemon.ctx.db.createThread({ title: 'unbound' })
      const unboundTools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        thread: unboundThread,
        providerId: 'sub2api'
      })

      await expect(
        (unboundTools.fs_read as any).execute({ path: 'hello.ts' }, { toolCallId: 't1', messages: [] })
      ).rejects.toThrow('请先为该线程绑定工作目录')

      await expect(
        (unboundTools.shell_exec as any).execute({ command: 'echo hi' }, { toolCallId: 't2', messages: [] })
      ).rejects.toThrow('请先为该线程绑定工作目录')

      // 2. Bound thread: read-only tools work inside workspace, block traversal outside
      const boundThread = daemon.ctx.db.createThread({
        title: 'bound',
        workspacePath: workspaceDir
      })

      const requestedEvents: any[] = []
      const resolvedEvents: any[] = []
      const origBroadcast = daemon.ctx.wsHub.broadcast.bind(daemon.ctx.wsHub)
      daemon.ctx.wsHub.broadcast = (type: string, data: unknown) => {
        if (type === 'permission_requested') requestedEvents.push(data)
        if (type === 'permission_resolved') resolvedEvents.push(data)
        origBroadcast(type, data)
      }

      const tools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        thread: boundThread,
        providerId: 'sub2api'
      })

      const readRes = await (tools.fs_read as any).execute(
        { path: 'hello.ts', startLine: 2, endLine: 3 },
        { toolCallId: 't3', messages: [] }
      )
      expect(readRes.content).toBe('const b = 2\nconst c = 3')

      await expect(
        (tools.fs_read as any).execute({ path: '../secret.txt' }, { toolCallId: 't4', messages: [] })
      ).rejects.toThrow('路径越界')

      await expect(
        (tools.fs_read as any).execute({ path: outsideFile }, { toolCallId: 't5', messages: [] })
      ).rejects.toThrow('路径越界')

      // 3. Confirmable tool (fs_write) times out fail-closed after 1s
      await expect(
        (tools.fs_write as any).execute(
          { path: 'created.txt', content: 'should not exist' },
          { toolCallId: 't6', messages: [] }
        )
      ).rejects.toThrow('权限被拒绝')

      expect(requestedEvents.length).toBeGreaterThanOrEqual(1)
      expect(requestedEvents[0].options.map((o: any) => o.optionId)).toEqual([
        'allow_once',
        'allow_always',
        'reject'
      ])
      expect(resolvedEvents.some(e => e.outcome === 'reject' || e.outcome === 'rejected')).toBe(true)

      // 4. Approve with allow_always -> subsequent fs_write succeeds without prompting again
      let writePermCount = 0
      daemon.ctx.wsHub.broadcast = (type: string, data: unknown) => {
        if (type === 'permission_requested') {
          writePermCount++
          const dto = data as { requestId: string }
          setTimeout(() => daemon.ctx.permissionGate.resolvePermission(dto.requestId, 'allow_always'), 20)
        }
        origBroadcast(type, data)
      }

      await (tools.fs_write as any).execute(
        { path: 'sub/note.txt', content: 'hello world' },
        { toolCallId: 't7', messages: [] }
      )
      expect(readFileSync(join(workspaceDir, 'sub/note.txt'), 'utf8')).toBe('hello world')
      expect(writePermCount).toBe(1)

      // Second fs_write in same thread should NOT prompt again
      await (tools.fs_write as any).execute(
        { path: 'sub/note2.txt', content: 'second' },
        { toolCallId: 't8', messages: [] }
      )
      expect(writePermCount).toBe(1)

      // 5. fs_edit requires confirmation and edits exact text
      const editTools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        thread: boundThread,
        providerId: 'sub2api'
      })
      await (editTools.fs_edit as any).execute(
        { path: 'sub/note.txt', oldText: 'hello world', newText: 'hello cjh' },
        { toolCallId: 't9', messages: [] }
      )
      expect(readFileSync(join(workspaceDir, 'sub/note.txt'), 'utf8')).toBe('hello cjh')

      // 6. When autoApproveReadOnly is false, fs_read also asks for permission (and fails closed if rejected)
      daemon.ctx.db.updateSettings({ tools: { autoApproveReadOnly: false } })
      daemon.ctx.wsHub.broadcast = (type: string, data: unknown) => {
        if (type === 'permission_requested') {
          const dto = data as { requestId: string }
          setTimeout(() => daemon.ctx.permissionGate.resolvePermission(dto.requestId, '__reject__'), 20)
        }
        origBroadcast(type, data)
      }
      await expect(
        (editTools.fs_read as any).execute({ path: 'hello.ts' }, { toolCallId: 't10', messages: [] })
      ).rejects.toThrow('权限被拒绝')
    } finally {
      await daemon.shutdown()
    }
  })

  it('enforces shell_exec timeout, 30KB output truncation, and sanitized child environment', async () => {
    const workspaceDir = makeTempDir('cjh-r1-shell-')
    process.env.CJH_MASTER_KEY_HEX = 'secret-master-key-must-not-leak'
    process.env.CJH_LOCAL_TOKEN = 'secret-local-token-must-not-leak'

    try {
      // 1. Env blacklist & exact args execution
      const envRes = await executeShellCommand({
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({ mk: process.env.CJH_MASTER_KEY_HEX || null, tk: process.env.CJH_LOCAL_TOKEN || null }))'
        ],
        workspacePath: workspaceDir,
        timeoutSec: 10
      })
      expect(envRes.exitCode).toBe(0)
      const parsedEnv = JSON.parse(envRes.stdout.trim())
      expect(parsedEnv.mk).toBeNull()
      expect(parsedEnv.tk).toBeNull()

      // 2. Output truncation at 30KB
      const bigRes = await executeShellCommand({
        command: process.execPath,
        args: ['-e', 'process.stdout.write("A".repeat(45000))'],
        workspacePath: workspaceDir,
        timeoutSec: 10
      })
      expect(bigRes.truncated).toBe(true)
      expect(Buffer.byteLength(bigRes.stdout, 'utf8')).toBeLessThan(31 * 1024)
      expect(bigRes.stdout).toContain('已截断')

      // 3. Timeout enforcement
      const timeoutRes = await executeShellCommand({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => console.log("done"), 10000)'],
        workspacePath: workspaceDir,
        timeoutSec: 1
      })
      expect(timeoutRes.timedOut).toBe(true)
    } finally {
      delete process.env.CJH_MASTER_KEY_HEX
      delete process.env.CJH_LOCAL_TOKEN
    }
  })

  it('supports skill_read, web_fetch HTML->Markdown, encrypted web_search keys, and DuckDuckGo fallback', async () => {
    const dataDir = makeTempDir('cjh-r1-skill-data-')
    const skillDir = join(dataDir, 'skills', 'demo-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo skill description\n---\n\n# Demo Skill\nStep 1: Do work.\n',
      'utf8'
    )

    process.env.CJH_DATA_DIR = dataDir
    const daemon = await startLocalDaemon({ port: 0, masterKeyHex: '22'.repeat(32) })

    // Local test HTTP server for web_fetch
    const srv = createServer((req, res) => {
      if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Hello</h1><p>Visit <a href="https://example.com">Site</a></p><script>alert(1)</script></body></html>')
      } else {
        res.writeHead(404)
        res.end('not found')
      }
    })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve))
    const srvPort = (srv.address() as any).port

    try {
      // Encrypted web_search key storage & masking
      const updatedRes = await fetch(`http://127.0.0.1:${daemon.port}/api/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${daemon.authToken}`
        },
        body: JSON.stringify({
          tools: {
            maxSteps: 25,
            webSearch: {
              backend: 'auto',
              tavilyApiKey: 'tvly-secret-1234567890'
            }
          }
        })
      })
      expect(updatedRes.status).toBe(200)
      const settingsJson = (await updatedRes.json()) as any
      expect(settingsJson.tools.maxSteps).toBe(25)
      expect(settingsJson.tools.webSearch.hasTavilyApiKey).toBe(true)
      expect(settingsJson.tools.webSearch.tavilyApiKeyPreview).toContain('••••')
      expect(JSON.stringify(settingsJson)).not.toContain('tvly-secret-1234567890')
      expect(daemon.ctx.db.getSecret('web_search.tavily_api_key')).toBe('tvly-secret-1234567890')

      // skill_read
      const thread = daemon.ctx.db.createThread({ title: 'skill test' })
      const tools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        thread,
        providerId: 'sub2api'
      })

      const skillOut = await (tools.skill_read as any).execute(
        { idOrName: 'demo-skill' },
        { toolCallId: 's1', messages: [] }
      )
      expect(skillOut.content).toContain('# Demo Skill')
      expect(skillOut.content).toContain('Step 1: Do work.')

      // web_fetch
      const fetched = await webFetch(`http://127.0.0.1:${srvPort}/html`)
      expect(fetched.content).toContain('# Hello')
      expect(fetched.content).toContain('[Site](https://example.com)')
      expect(fetched.content).not.toContain('alert(1)')

      await expect(webFetch('file:///C:/Windows/win.ini')).rejects.toThrow('仅支持 http 和 https')

      // DuckDuckGo fallback via mocked fetch
      const mockDdgFetch: typeof fetch = async () =>
        new Response(
          `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fdocs">Example Docs</a><a class="result__snippet">Official documentation page</a></div>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } }
        )
      const searchOut = await webSearch('example docs', {
        maxResults: 3,
        config: { backend: 'auto' },
        fetchFn: mockDdgFetch
      })
      expect(searchOut.backend).toBe('duckduckgo')
      expect(searchOut.results).toEqual([
        {
          title: 'Example Docs',
          url: 'https://example.org/docs',
          snippet: 'Official documentation page'
        }
      ])

      // Builtin tools trace recording via GenerationEngine with mock OpenAI-compatible SSE server
      const llmSrv = createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        const parsed = JSON.parse(body)
        const hasToolMsg = Array.isArray(parsed.messages) && parsed.messages.some((m: any) => m.role === 'tool')
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache'
        })
        if (!hasToolMsg) {
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_skill_1',
                        type: 'function',
                        function: { name: 'skill_read', arguments: '{"idOrName":"demo-skill"}' }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-1',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
            })}\n\n`
          )
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-2',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant', content: '已完成技能读取' }, finish_reason: null }]
            })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({
              id: 'chatcmpl-2',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 }
            })}\n\n`
          )
          res.write('data: [DONE]\n\n')
          res.end()
        }
      })
      await new Promise<void>(resolve => llmSrv.listen(0, '127.0.0.1', resolve))
      const llmPort = (llmSrv.address() as any).port

      try {
        daemon.ctx.db.upsertProvider({
          id: 'mock-api',
          name: 'Mock API',
          type: 'openai-compatible',
          apiFormat: 'openai-chat',
          isResponseApi: false,
          useMaxCompletionTokens: false,
          baseUrl: `http://127.0.0.1:${llmPort}/v1`,
          apiKey: 'sk-test',
          customHeaders: {},
          models: [
            {
              id: 'gpt-mock',
              name: 'GPT Mock',
              enabled: true,
              capabilities: { vision: false, reasoning: false, streaming: true, functionCalling: true }
            }
          ],
          availableModels: [],
          acpArgs: [],
          acpEnv: {},
          acpMcpServerIds: [],
          acpPermissionMode: 'default',
          acpAvailableModes: [],
          enabled: true,
          sortOrder: 0
        })

        const chatThread = daemon.ctx.db.createThread({
          title: 'trace test',
          model: 'mock-api:gpt-mock'
        })
        const turnRes = await daemon.ctx.engine.startTurn({
          threadId: chatThread.id,
          userMessage: { role: 'user', parts: [{ type: 'text', text: 'read demo-skill' }] },
          source: 'gui'
        })
        expect(turnRes.ok).toBe(true)
        const trace = daemon.ctx.db.getTraceByMessageId(turnRes.messageId!)
        expect(trace).not.toBeNull()
        expect(trace!.toolCallCount).toBe(1)
        expect(trace!.toolCalls[0].toolName).toBe('skill_read')
        expect(trace!.toolCalls[0].status).toBe('completed')
      } finally {
        llmSrv.close()
      }
    } finally {
      srv.close()
      await daemon.shutdown()
    }
  })

  it('P0-1 & P2-4 & P2-2: enforces strict allow_* whitelist for both builtin tools (shell_exec/cron_create/cron_delete/fs_write) and ACP, auto-approves concurrent allow_always, and clears ACP permissions on crash', async () => {
    const dataDir = makeTempDir('cjh-p0-1-data-')
    const workspaceDir = makeTempDir('cjh-p0-1-ws-')
    process.env.CJH_DATA_DIR = dataDir

    // Mock ACP agent that requests permission and exits on CRASH_DURING_PERM
    const acpScriptPath = join(dataDir, 'p01-acp-agent.mjs')
    writeFileSync(
      acpScriptPath,
      `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
const pending = new Map();
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const fn = pending.get(msg.id);
    if (fn) { pending.delete(msg.id); fn(msg.result); }
    return;
  }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_p01' } });
  } else if (msg.method === 'session/set_mode' || msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const promptText = String(msg.params?.prompt?.[0]?.text || '');
    const rpcId = 700 + Math.floor(Math.random() * 1000);
    pending.set(rpcId, (res) => {
      const chosen = res?.outcome?.optionId || res?.outcome?.outcome;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: 'sess_p01', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP_OUTCOME=' + chosen } } }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    });
    send({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_p01',
        toolCall: { title: 'Run dangerous cmd', kind: 'bash', rawInput: { cmd: 'rm -rf' } },
        options: [
          { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
          { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' },
          { optionId: 'deny', name: '禁止', kind: 'deny' }
        ]
      }
    });
    if (promptText === 'CRASH_DURING_PERM') {
      setTimeout(() => process.exit(1), 60);
    }
  }
});
`,
      'utf8'
    )

    const daemon = await startLocalDaemon({ port: 0, masterKeyHex: '88'.repeat(32) })

    try {
      daemon.ctx.db.updateSettings({ acp: { permissionTimeoutSec: 1 } })
      const thread = daemon.ctx.db.createThread({
        title: 'p0-1-whitelist',
        workspacePath: workspaceDir
      })

      let nextSelectedOptionId: string | null = null
      const origBroadcast = daemon.ctx.wsHub.broadcast.bind(daemon.ctx.wsHub)
      const resolvedOutcomes: string[] = []
      daemon.ctx.wsHub.broadcast = (type: string, data: unknown) => {
        if (type === 'permission_requested' && nextSelectedOptionId !== null) {
          const chosen = nextSelectedOptionId
          const dto = data as { requestId: string }
          setTimeout(() => {
            daemon.ctx.permissionGate.resolvePermission(dto.requestId, chosen)
          }, 15)
        }
        if (type === 'permission_resolved') {
          resolvedOutcomes.push((data as { outcome: string }).outcome)
        }
        origBroadcast(type, data)
      }

      const tools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        thread,
        providerId: 'sub2api'
      })

      // 1. P0-1 Builtin tools: reject_once, deny, and arbitrary unknown strings MUST ALL reject & never execute
      const markerPath = join(workspaceDir, 'must-never-exist.txt')
      for (const badOptionId of [
        'reject_once',
        'deny',
        'arbitrary_unknown_option_id',
        'allow_unregistered_id'
      ]) {
        nextSelectedOptionId = badOptionId
        await expect(
          (tools.fs_write as any).execute(
            { path: 'must-never-exist.txt', content: `pwned-${badOptionId}` },
            { toolCallId: `tc_${badOptionId}`, messages: [] }
          )
        ).rejects.toThrow('权限被拒绝')
        expect(existsSync(markerPath)).toBe(false)

        await expect(
          (tools.shell_exec as any).execute(
            {
              command: process.execPath,
              args: ['-e', `require('fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`]
            },
            { toolCallId: `sh_${badOptionId}`, messages: [] }
          )
        ).rejects.toThrow('权限被拒绝')
        expect(existsSync(markerPath)).toBe(false)
      }
      expect(resolvedOutcomes.every(o => o === 'rejected')).toBe(true)

      // 2. P2-4: shell_exec, cron_create, cron_delete timeout fail-closed (1s) and allow_once execution
      nextSelectedOptionId = null // Let 1s timeout trigger!
      await expect(
        (tools.shell_exec as any).execute(
          { command: process.execPath, args: ['-e', 'console.log("hi")'] },
          { toolCallId: 'sh_timeout', messages: [] }
        )
      ).rejects.toThrow('权限被拒绝')

      await expect(
        (tools.cron_create as any).execute(
          { name: '未授权任务', cronExpr: '30 7 * * *', prompt: 'hi' },
          { toolCallId: 'cron_c_timeout', messages: [] }
        )
      ).rejects.toThrow('权限被拒绝')
      expect(daemon.ctx.db.listCronJobs()).toHaveLength(0)

      // Approve cron_create with allow_once -> creates job
      nextSelectedOptionId = 'allow_once'
      const createdCron = await (tools.cron_create as any).execute(
        { name: '已授权任务', cronExpr: '30 7 * * *', prompt: '日报' },
        { toolCallId: 'cron_c_ok', messages: [] }
      )
      expect(createdCron.id).toBeTruthy()
      expect(daemon.ctx.db.listCronJobs()).toHaveLength(1)

      // Reject cron_delete with unknown string -> job NOT deleted
      nextSelectedOptionId = 'unknown_delete_bypass'
      await expect(
        (tools.cron_delete as any).execute(
          { id: createdCron.id },
          { toolCallId: 'cron_d_bad', messages: [] }
        )
      ).rejects.toThrow('权限被拒绝')
      expect(daemon.ctx.db.listCronJobs()).toHaveLength(1)

      // Approve cron_delete with allow_once -> job deleted
      nextSelectedOptionId = 'allow_once'
      const delRes = await (tools.cron_delete as any).execute(
        { id: createdCron.id },
        { toolCallId: 'cron_d_ok', messages: [] }
      )
      expect(delRes.ok).toBe(true)
      expect(daemon.ctx.db.listCronJobs()).toHaveLength(0)

      // 3. P2-2: Concurrent calls to same confirmable tool: clicking allow_always on first auto-approves second
      nextSelectedOptionId = null
      let concurrentPermCount = 0
      daemon.ctx.wsHub.broadcast = (type: string, data: unknown) => {
        if (type === 'permission_requested') {
          concurrentPermCount++
          // Only click allow_always once BOTH requests are pending in PermissionGate
          if (concurrentPermCount === 2) {
            const pending = daemon.ctx.permissionGate.getPendingPermissionsForThread(thread.id)
            expect(pending).toHaveLength(2)
            setTimeout(() => {
              daemon.ctx.permissionGate.resolvePermission(pending[0].requestId, 'allow_always')
            }, 15)
          }
        }
        origBroadcast(type, data)
      }

      await Promise.all([
        (tools.fs_write as any).execute(
          { path: 'batch-1.txt', content: 'one' },
          { toolCallId: 'b1', messages: [] }
        ),
        (tools.fs_write as any).execute(
          { path: 'batch-2.txt', content: 'two' },
          { toolCallId: 'b2', messages: [] }
        )
      ])
      expect(readFileSync(join(workspaceDir, 'batch-1.txt'), 'utf8')).toBe('one')
      expect(readFileSync(join(workspaceDir, 'batch-2.txt'), 'utf8')).toBe('two')
      expect(daemon.ctx.permissionGate.getPendingPermissionsForThread(thread.id)).toHaveLength(0)

      // 4. P0-1 ACP whitelist: reject_once, deny, and arbitrary unknown string all reject in ACP too
      daemon.ctx.db.upsertProvider({
        id: 'acp-p01',
        name: 'ACP P0-1',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [acpScriptPath],
        acpEnv: {},
        acpMcpServerIds: [],
        acpPermissionMode: 'default',
        acpAvailableModes: [],
        customHeaders: {},
        models: [
          {
            id: 'opus',
            name: 'Opus',
            enabled: true,
            capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
          }
        ],
        availableModels: [],
        enabled: true,
        sortOrder: 0
      })

      const acpThread = daemon.ctx.db.createThread({
        title: 'acp-p01-thread',
        model: 'acp-p01:opus',
        workspacePath: workspaceDir
      })

      for (const testOption of ['reject_once', 'deny', 'unknown_acp_bypass']) {
        daemon.ctx.wsHub.broadcast = (type: string, data: unknown) => {
          if (type === 'permission_requested') {
            const dto = data as { requestId: string }
            setTimeout(() => {
              daemon.ctx.permissionGate.resolvePermission(dto.requestId, testOption)
            }, 15)
          }
          origBroadcast(type, data)
        }
        await daemon.ctx.engine.startTurn({
          threadId: acpThread.id,
          userMessage: { role: 'user', parts: [{ type: 'text', text: `TEST_${testOption}` }] },
          source: 'gui'
        })
        const branch = daemon.ctx.db.getActiveBranchMessages(acpThread.id)
        const lastAssistant = branch[branch.length - 1]
        const text = (lastAssistant.message.parts.find(p => p.type === 'text') as any)?.text || ''
        // Must NEVER be allow_once or unknown_acp_bypass!
        expect(text).toMatch(/^ACP_OUTCOME=(reject_once|deny)$/)
      }

      // 5. P2-2: ACP subprocess unexpected exit clears pending permissions immediately (no 60s wait)
      daemon.ctx.db.updateSettings({ acp: { permissionTimeoutSec: 60 } })
      daemon.ctx.wsHub.broadcast = origBroadcast
      const crashThread = daemon.ctx.db.createThread({
        title: 'acp-crash-thread',
        model: 'acp-p01:opus',
        workspacePath: workspaceDir
      })
      const crashRes = await daemon.ctx.engine.startTurn({
        threadId: crashThread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'CRASH_DURING_PERM' }] },
        source: 'gui'
      })
      expect(crashRes.ok).toBe(false)
      expect(daemon.ctx.permissionGate.getPendingPermissionsForThread(crashThread.id)).toHaveLength(
        0
      )
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('P0-2 & P1-1: blocks dangling symlink/junction writes and fs_grep/list/glob symlink escapes, and preserves $&/$$ in fs_edit', () => {
    const workspaceDir = makeTempDir('cjh-p02-ws-')
    const outsideDir = makeTempDir('cjh-p02-outside-')
    const outsideSecretFile = join(outsideDir, 'secret.txt')
    writeFileSync(outsideSecretFile, 'TOP_SECRET_SYMLINK_PAYLOAD=9999\n', 'utf8')
    writeFileSync(join(workspaceDir, 'safe.txt'), 'SAFE_CONTENT=1\n', 'utf8')

    // 1. P0-2a: Dangling symlink write escape (on unprivileged Windows where file symlink throws EPERM,
    // use a dangling NTFS junction pointing to a non-existent outside directory, which has existsSync===false & isSymbolicLink===true)
    const missingOutsideFile = join(outsideDir, 'pwned-by-dangling.txt')
    const missingOutsideSubdir = join(outsideDir, 'nonexistent-outside-subdir')
    let danglingRelWritePath = ''

    try {
      const danglingFileLink = join(workspaceDir, 'dangling-out.txt')
      symlinkSync(missingOutsideFile, danglingFileLink, 'file')
      danglingRelWritePath = 'dangling-out.txt'
    } catch {
      // Unprivileged Windows fallback: dangling NTFS junction to non-existent outside directory
      const danglingJunc = join(workspaceDir, 'dangling-junc')
      symlinkSync(missingOutsideSubdir, danglingJunc, 'junction')
      expect(existsSync(danglingJunc)).toBe(false)
      danglingRelWritePath = 'dangling-junc/pwned.txt'
    }

    expect(resolveSafeWorkspacePath(workspaceDir, danglingRelWritePath)).toBeNull()
    expect(() =>
      workspaceFsWrite(workspaceDir, { path: danglingRelWritePath, content: 'escaped!' })
    ).toThrow('路径越界')
    expect(existsSync(missingOutsideFile)).toBe(false)
    expect(existsSync(missingOutsideSubdir)).toBe(false)

    // 2. P0-2b: fs_grep / fs_list / fs_glob following symlink or junction to outside secret file
    let readEscapeRelPath = ''
    try {
      const fileLink = join(workspaceDir, 'leak-secret.txt')
      symlinkSync(outsideSecretFile, fileLink, 'file')
      readEscapeRelPath = 'leak-secret.txt'
    } catch {
      // Unprivileged Windows fallback: NTFS junction pointing to outsideDir containing secret.txt
      const dirJunc = join(workspaceDir, 'leak-dir')
      symlinkSync(outsideDir, dirJunc, 'junction')
      readEscapeRelPath = 'leak-dir/secret.txt'
    }

    expect(() => workspaceFsRead(workspaceDir, { path: readEscapeRelPath })).toThrow('路径越界')

    const grepRes = workspaceFsGrep(workspaceDir, { query: 'TOP_SECRET_SYMLINK_PAYLOAD' })
    expect(grepRes.matches).toHaveLength(0)

    const safeGrep = workspaceFsGrep(workspaceDir, { query: 'SAFE_CONTENT' })
    expect(safeGrep.matches).toHaveLength(1)
    expect(safeGrep.matches[0].path).toBe('safe.txt')

    const listRes = workspaceFsList(workspaceDir, { recursive: true })
    expect(listRes.entries.map(e => e.path)).toEqual(['safe.txt'])

    const globRes = workspaceFsGlob(workspaceDir, { pattern: '**/*.txt' })
    expect(globRes.files).toEqual(['safe.txt'])

    // 3. P1-1: fs_edit single replacement must NOT corrupt `$&`, `$$`, `$'`, `` $` ``
    writeFileSync(join(workspaceDir, 'code.ts'), 'const pattern = "old";\n', 'utf8')
    workspaceFsEdit(workspaceDir, {
      path: 'code.ts',
      oldText: 'const pattern = "old";',
      newText: "const pattern = '$&' + '$$' + `$'` + '$`';"
    })
    expect(readFileSync(join(workspaceDir, 'code.ts'), 'utf8')).toBe(
      "const pattern = '$&' + '$$' + `$'` + '$`';\n"
    )
  })

  it('P0-3, P1-2 & P1-6: preserves multi-turn tool-call history for non-ACP models, runs PowerShell cmdlets + cjh CLI in shell_exec, and enforces skillIds & builtinToolsEnabled', async () => {
    const dataDir = makeTempDir('cjh-p03-data-')
    const workspaceDir = makeTempDir('cjh-p03-ws-')
    writeFileSync(join(workspaceDir, 'port.conf'), 'BACKEND_PORT=19088\n', 'utf8')
    process.env.CJH_DATA_DIR = dataDir

    const daemon = await startLocalDaemon({ port: 0, masterKeyHex: '99'.repeat(32) })

    const capturedRequests: any[] = []
    const llmSrv = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body)
      capturedRequests.push(parsed)
      const msgs: any[] = parsed.messages || []
      const lastMsg = msgs[msgs.length - 1]
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      const userText = String(
        Array.isArray(lastUser?.content)
          ? lastUser.content.map((p: any) => p.text || '').join('')
          : lastUser?.content || ''
      )

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })

      if (userText.includes('读取配置端口') && lastMsg?.role !== 'tool') {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-t1-a',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read_port_1',
                      type: 'function',
                      function: { name: 'fs_read', arguments: '{"path":"port.conf"}' }
                    }
                  ]
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-t1-a',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          })}\n\n`
        )
      } else {
        const serializedHistory = JSON.stringify(msgs)
        const reply = serializedHistory.includes('19088')
          ? '历史工具上下文存在:19088'
          : '未找到工具上下文'
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-reply',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }]
          })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-reply',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
    await new Promise<void>(resolve => llmSrv.listen(0, '127.0.0.1', resolve))
    const llmPort = (llmSrv.address() as any).port

    try {
      daemon.ctx.db.upsertProvider({
        id: 'mock-p03',
        name: 'Mock P03',
        type: 'openai-compatible',
        apiFormat: 'openai-chat',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: 'sk-p03',
        customHeaders: {},
        models: [
          {
            id: 'gpt-p03',
            name: 'GPT P03',
            enabled: true,
            capabilities: { vision: false, reasoning: false, streaming: true, functionCalling: true }
          }
        ],
        availableModels: [],
        acpArgs: [],
        acpEnv: {},
        acpMcpServerIds: [],
        acpPermissionMode: 'default',
        acpAvailableModes: [],
        enabled: true,
        sortOrder: 0
      })

      // 1. P0-3: Turn 1 calls fs_read -> Turn 2 asks follow-up -> Turn 2 request MUST include Turn 1 tool-call & tool-result!
      const thread = daemon.ctx.db.createThread({
        title: 'p0-3-multiturn',
        model: 'mock-p03:gpt-p03',
        workspacePath: workspaceDir
      })

      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '请读取配置端口' }] },
        source: 'gui'
      })

      capturedRequests.length = 0
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '刚才读取到的端口号是多少？' }] },
        source: 'gui'
      })

      expect(capturedRequests.length).toBe(1)
      const turn2Messages = capturedRequests[0].messages as any[]
      expect(turn2Messages.some(m => m.role === 'assistant' && Array.isArray(m.tool_calls))).toBe(
        true
      )
      expect(
        turn2Messages.some(
          m => m.role === 'tool' && JSON.stringify(m.content).includes('BACKEND_PORT=19088')
        )
      ).toBe(true)

      const branchAfterTurn2 = daemon.ctx.db.getActiveBranchMessages(thread.id)
      const turn2AssistantText = (
        branchAfterTurn2[branchAfterTurn2.length - 1].message.parts.find(p => p.type === 'text') as any
      )?.text
      expect(turn2AssistantText).toBe('历史工具上下文存在:19088')

      // Direct unit check on convertHistoryToModelMessages when assistant message has ONLY tool-call and NO text part
      const toolOnlyConverted = daemon.ctx.engine.convertHistoryToModelMessages([
        {
          id: 'm_u',
          threadId: thread.id,
          parentId: null,
          slotId: 's1',
          role: 'user',
          message: { id: 'm_u', role: 'user', parts: [{ type: 'text', text: 'run' }] },
          metadata: {},
          createdAt: 1,
          versionInfo: { index: 1, total: 1, siblingIds: ['m_u'] }
        },
        {
          id: 'm_a_tool_only',
          threadId: thread.id,
          parentId: 'm_u',
          slotId: 's2',
          role: 'assistant',
          message: {
            id: 'm_a_tool_only',
            role: 'assistant',
            parts: [
              {
                type: 'tool-call',
                toolCallId: 'tc_only_1',
                toolName: 'fs_list',
                input: { dir: '.' },
                output: { entries: ['port.conf'] },
                status: 'completed'
              }
            ]
          },
          metadata: {},
          createdAt: 2,
          versionInfo: { index: 1, total: 1, siblingIds: ['m_a_tool_only'] }
        }
      ])
      expect(toolOnlyConverted.map(m => m.role)).toEqual(['user', 'assistant', 'tool'])

      // 2. P1-6: builtinToolsEnabled === false omits <available_skills> / skill_read from system prompt,
      // and skill_read filters by thread.skillIds when set
      const noToolsThread = daemon.ctx.db.createThread({
        title: 'no-builtin-tools',
        model: 'mock-p03:gpt-p03',
        builtinToolsEnabled: false
      })
      capturedRequests.length = 0
      await daemon.ctx.engine.startTurn({
        threadId: noToolsThread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '你好' }] },
        source: 'gui'
      })
      const sysMsg = capturedRequests[0].messages.find((m: any) => m.role === 'system')
      expect(String(sysMsg?.content || '')).not.toContain('<available_skills>')
      expect(String(sysMsg?.content || '')).not.toContain('skill_read')

      const subsetThread = daemon.ctx.db.createThread({ title: 'subset-skills' })
      const updatedSubset = daemon.ctx.db.updateThread(subsetThread.id, {
        skillIds: ['builtin:cjh-self']
      })!
      const subsetTools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        thread: updatedSubset,
        providerId: 'mock-p03'
      })
      const allowedSkill = await (subsetTools.skill_read as any).execute(
        { idOrName: 'cjh-self' },
        { toolCallId: 'sk_ok', messages: [] }
      )
      expect(allowedSkill.id).toBe('builtin:cjh-self')
      await expect(
        (subsetTools.skill_read as any).execute(
          { idOrName: 'web-research' },
          { toolCallId: 'sk_blocked', messages: [] }
        )
      ).rejects.toThrow('未找到已启用的技能')

      // 3. P1-2: shell_exec supports PowerShell cmdlet with args array, cjh CLI in PATH + daemonEnv, and pre-aborted AbortSignal
      if (process.platform === 'win32') {
        const psArgsRes = await executeShellCommand({
          command: 'Get-ChildItem',
          args: ['-Name'],
          workspacePath: workspaceDir,
          timeoutSec: 15
        })
        expect(psArgsRes.exitCode).toBe(0)
        expect(psArgsRes.stdout).toContain('port.conf')
      }

      const cjhRes = await executeShellCommand({
        command: 'cjh status',
        workspacePath: workspaceDir,
        timeoutSec: 15,
        daemonEnv: {
          apiUrl: `http://127.0.0.1:${daemon.port}`,
          apiToken: daemon.authToken
        }
      })
      expect(cjhRes.exitCode).toBe(0)
      expect(JSON.parse(cjhRes.stdout).ok).toBe(true)

      const preAborted = new AbortController()
      preAborted.abort()
      await expect(
        executeShellCommand({
          command: process.execPath,
          args: ['-e', 'console.log(1)'],
          workspacePath: workspaceDir,
          abortSignal: preAborted.signal
        })
      ).rejects.toThrow()
    } finally {
      llmSrv.close()
      await daemon.shutdown()
    }
  }, 20_000)
})
