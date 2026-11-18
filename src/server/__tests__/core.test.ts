import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretVault } from '../crypto/vault'
import { AppDatabase } from '../db/database'
import {
  buildCleanSubprocessEnv,
  parseWindowsCmdShim,
  prepareSafeSpawnPlan
} from '../proc/spawner'
import { startLocalDaemon } from '../entry'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.CJH_DATA_DIR
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

describe('SecretVault & AppDatabase (Message Tree + Provider Vault)', () => {
  it('encrypts provider API keys at rest and resolves model prefixes', () => {
    const dir = makeTempDir()
    const vault = new SecretVault(undefined, join(dir, 'master.key'))
    const db = new AppDatabase(join(dir, 'cjh.db'), vault)

    const saved = db.upsertProvider({
      id: 'sub2api',
      name: 'sub2api Relay',
      type: 'openai-compatible',
      apiFormat: 'openai-responses',
      isResponseApi: true,
      useMaxCompletionTokens: true,
      baseUrl: 'https://yangyue99.store/v1',
      apiKey: 'sk-super-secret-relay-key-1234',
      customHeaders: {},
      models: [
        {
          id: 'gpt-5.5',
          name: 'GPT-5.5',
          enabled: true,
          capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
        }
      ],
      availableModels: [],
      acpArgs: [],
      acpEnv: {},
      acpMcpServerIds: [],
      enabled: true,
      sortOrder: 0
    })

    expect(saved.hasApiKey).toBe(true)
    expect(saved.apiKeyPreview).toBe('sk-s••••1234')

    // Raw DB column must be encrypted ciphertext, never plaintext
    const rawRow = db.sqlite
      .prepare('SELECT api_key_enc FROM providers WHERE id = ?')
      .get('sub2api') as { api_key_enc: string }
    expect(rawRow.api_key_enc.startsWith('enc:v1:')).toBe(true)
    expect(rawRow.api_key_enc).not.toContain('sk-super-secret')
    expect(db.getProviderSecretKey('sub2api')).toBe('sk-super-secret-relay-key-1234')

    // Model string resolution with and without prefix
    expect(db.resolveModelString('sub2api:gpt-5.5')?.modelId).toBe('gpt-5.5')
    expect(db.resolveModelString('gpt-5.5')?.provider.id).toBe('sub2api')

    db.close()
  })

  it('supports multi-version message slots, version switching, and rollback', () => {
    const dir = makeTempDir()
    const vault = new SecretVault()
    const db = new AppDatabase(join(dir, 'cjh.db'), vault)

    const thread = db.createThread({ title: '测试树形分支' })
    const u1 = db.insertMessage({
      threadId: thread.id,
      parentId: null,
      role: 'user',
      message: { id: 'u1', role: 'user', parts: [{ type: 'text', text: '你好' }] }
    })

    const a1 = db.insertMessage({
      threadId: thread.id,
      parentId: u1.id,
      slotId: 'slot_a',
      role: 'assistant',
      message: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '初版回复' }] }
    })

    const a2 = db.insertMessage({
      threadId: thread.id,
      parentId: u1.id,
      slotId: 'slot_a',
      role: 'assistant',
      message: { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: '重试回复 v2' }] }
    })

    // Active branch should point to v2
    let branch = db.getActiveBranchMessages(thread.id)
    expect(branch.map(m => m.id)).toEqual([u1.id, a2.id])
    expect(branch[1].versionInfo).toEqual({
      index: 2,
      total: 2,
      siblingIds: [a1.id, a2.id]
    })

    // Switch back to v1
    db.switchMessageVersion(a1.id)
    branch = db.getActiveBranchMessages(thread.id)
    expect(branch.map(m => m.id)).toEqual([u1.id, a1.id])
    expect(branch[1].versionInfo.index).toBe(1)

    // Rollback to u1
    db.rollbackToMessage(u1.id)
    branch = db.getActiveBranchMessages(thread.id)
    expect(branch.map(m => m.id)).toEqual([u1.id])

    db.close()
  })
})

describe('Windows ProcessSpawner (ACP Pitfalls #1–#4)', () => {
  it('parses npm .cmd shims in directories with spaces without shell string splitting', () => {
    const base = makeTempDir('Program Files Mock ')
    const subDir = join(base, 'node_modules', 'pkg', 'bin')
    mkdirSync(subDir, { recursive: true })
    const targetJs = join(subDir, 'cli.js')
    writeFileSync(targetJs, 'console.log("ok")', 'utf8')

    const cmdPath = join(base, 'npx.cmd')
    writeFileSync(
      cmdPath,
      '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n',
      'utf8'
    )

    const parsed = parseWindowsCmdShim(cmdPath)
    expect(parsed).not.toBeNull()
    expect(parsed?.scriptPath).toBe(targetJs)

    if (process.platform === 'win32') {
      const plan = prepareSafeSpawnPlan({
        command: cmdPath,
        args: ['-y', '@agentclientprotocol/claude-agent-acp']
      })
      expect(plan.args[0]).toBe(targetJs)
      expect(plan.args.slice(1)).toEqual(['-y', '@agentclientprotocol/claude-agent-acp'])
    }
  })

  it('sanitizes CLAUDECODE / ANTHROPIC_API_KEY and injects borrowed sub2api credentials + acp_env', () => {
    process.env.CLAUDECODE = '1'
    process.env.ANTHROPIC_API_KEY = 'should-be-removed'

    const env = buildCleanSubprocessEnv({
      command: 'claude-agent-acp',
      borrowedAuth: {
        kind: 'anthropic',
        apiKey: 'sk-borrowed-sub2api',
        baseUrl: 'https://yangyue99.store'
      },
      extraEnv: {
        CUSTOM_FLAG: 'enabled'
      }
    })

    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-borrowed-sub2api')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://yangyue99.store')
    expect(env.CUSTOM_FLAG).toBe('enabled')

    delete process.env.CLAUDECODE
    delete process.env.ANTHROPIC_API_KEY
  })
})

describe('Local Daemon Bearer Auth & Portable Runtime Discovery', () => {
  it('rejects unauthenticated requests with 401 and serves /api/health with valid token', async () => {
    const dir = makeTempDir('cjh-daemon-')
    process.env.CJH_DATA_DIR = dir

    const daemon = await startLocalDaemon({ port: 0, authToken: 'test-token-secret' })
    try {
      const unauth = await fetch(`http://127.0.0.1:${daemon.port}/api/health`)
      expect(unauth.status).toBe(401)

      const authed = await fetch(`http://127.0.0.1:${daemon.port}/api/health`, {
        headers: { Authorization: 'Bearer test-token-secret' }
      })
      expect(authed.status).toBe(200)
      const body = await authed.json()
      expect(body.ok).toBe(true)
      expect(body.port).toBe(daemon.port)
    } finally {
      await daemon.shutdown()
    }
  })

  it('runs a real stdio JSON-RPC ACP agent, ignores unknown notifications, and enforces fail-closed permissions', async () => {
    const dir = makeTempDir('cjh-acp-e2e-')
    process.env.CJH_DATA_DIR = dir

    // Write a mock ACP JSON-RPC agent script that sends _auth/status_update, configOptions, and requests permission
    const mockAgentJs = join(dir, 'mock-acp-agent.mjs')
    writeFileSync(
      mockAgentJs,
      `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    // Emit an unknown notification (Pitfall #7)
    send({ jsonrpc: '2.0', method: '_auth/status_update', params: { ok: true } });
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-claude', version: '2.1.325' } } });
  } else if (msg.method === 'session/new') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: 'sess_mock_1',
        configOptions: [{
          id: 'model',
          name: 'Model',
          type: 'select',
          options: [
            { value: 'opus', name: 'Opus', description: 'Claude Opus 5.5 (2.1.325)' }
          ]
        }]
      }
    });
  } else if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const promptReqId = msg.id;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: '准备请求权限...' } } }
    });
    // Ask client for permission
    send({
      jsonrpc: '2.0',
      id: 999,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess_mock_1',
        toolCall: { title: 'Write spawner.ts', rawInput: { path: 'spawner.ts' } },
        options: [
          { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
          { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
        ]
      }
    });
    // Wait for permission response id=999
    const waitPerm = (l2) => {
      const m2 = JSON.parse(l2);
      if (m2.id === 999) {
        rl.off('line', waitPerm);
        const chosen = m2.result?.outcome?.optionId || m2.result?.outcome?.outcome;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: '权限结果:' + chosen } } }
        });
        send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
      }
    };
    rl.on('line', waitPerm);
  }
});
`,
      'utf8'
    )

    const daemon = await startLocalDaemon({ port: 0, authToken: 'acp-token' })
    try {
      // Configure short 1-second permission timeout to test automatic fail-closed rejection!
      daemon.ctx.db.updateSettings({ acp: { permissionTimeoutSec: 1 } as any })

      const acpProv = daemon.ctx.db.upsertProvider({
        id: 'mock-acp',
        name: 'Mock ACP',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [mockAgentJs],
        acpEnv: {},
        acpMcpServerIds: [],
        customHeaders: {},
        models: [],
        availableModels: [],
        enabled: true,
        sortOrder: 0
      })

      // 1. Discover models (verifies Pitfall #7, #8, #9)
      const discovered = await daemon.ctx.acpManager.discoverProviderModels(acpProv)
      expect(discovered.models).toHaveLength(1)
      expect(discovered.models[0].id).toBe('opus')
      expect(discovered.models[0].description).toBe('Claude Opus 5.5 (2.1.325)')

      daemon.ctx.db.updateProviderModels('mock-acp', discovered.models, discovered.models)

      // 2. Run a real turn without approving permission -> must auto-reject after 1s (Fail-Closed!)
      const thread = daemon.ctx.db.createThread({ model: 'mock-acp:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '执行测试' }] },
        source: 'test'
      })

      const msgs = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(msgs).toHaveLength(2)
      const assistantParts = msgs[1].message.parts
      const textPart = assistantParts.find(p => p.type === 'text')
      expect(textPart && textPart.type === 'text' ? textPart.text : '').toContain(
        '权限结果:reject_once'
      )
    } finally {
      await daemon.shutdown()
    }
  }, 15_000)
})
