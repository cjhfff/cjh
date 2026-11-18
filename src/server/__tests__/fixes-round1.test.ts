import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCliTarget } from '../../cli/runtime'
import { AcpAgentManager } from '../acp/manager'
import { SecretVault } from '../crypto/vault'
import { AppDatabase } from '../db/database'
import { startLocalDaemon } from '../entry'
import { TaggedLogger } from '../logger'
import { buildCleanSubprocessEnv } from '../proc/spawner'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-fix-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeSmartMockAcpAgent(dir: string): { scriptPath: string; envDumpPath: string; rpcLogPath: string } {
  const scriptPath = join(dir, 'smart-acp-agent.mjs')
  const envDumpPath = join(dir, 'acp-child-env.json')
  const rpcLogPath = join(dir, 'acp-rpc-log.jsonl')

  writeFileSync(
    scriptPath,
    `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const ENV_DUMP_PATH = ${JSON.stringify(envDumpPath)};
const RPC_LOG_PATH = ${JSON.stringify(rpcLogPath)};

writeFileSync(ENV_DUMP_PATH, JSON.stringify(process.env, null, 2), 'utf8');

const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function logRpc(entry) { appendFileSync(RPC_LOG_PATH, JSON.stringify(entry) + '\\n', 'utf8'); }

let sessCounter = 0;
const sessions = new Map(); // sessionId -> { modeId, secret, modeStyle }
const pendingPermResolvers = new Map();

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.id !== undefined && msg.method === undefined) {
    const resolver = pendingPermResolvers.get(msg.id);
    if (resolver) {
      pendingPermResolvers.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  logRpc({ pid: process.pid, method: msg.method, params: msg.params });

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: 'smart-mock-acp', version: '1.0.0' } }
    });
    return;
  }

  if (msg.method === 'session/new') {
    const sessionId = 'sess_' + (++sessCounter) + '_' + process.pid;
    const modeStyle = process.env.MOCK_MODE_STYLE || 'modes';
    // Simulate ~/.claude/settings.json defaulting to bypassPermissions!
    const rawInitialMode = process.env.MOCK_INITIAL_MODE;
    const initialMode = rawInitialMode === '__OMIT__' ? undefined : (rawInitialMode || 'bypassPermissions');
    sessions.set(sessionId, { modeId: initialMode ?? 'default', secret: null, modeStyle });

    const modeOptionList = [
      { value: 'default', name: 'Manual', description: 'Ask every time' },
      { value: 'acceptEdits', name: 'Accept Edits', description: 'Auto edits' },
      { value: 'bypassPermissions', name: 'Bypass', description: 'Skip all' }
    ];
    const modelOption = {
      id: 'model',
      name: 'Model',
      type: 'select',
      options: [{ value: 'opus', name: 'Opus', description: 'Mock Opus' }]
    };

    if (modeStyle === 'noModes') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId,
          configOptions: [modelOption]
        }
      });
    } else if (modeStyle === 'configOptionOnly') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId,
          configOptions: [
            {
              id: 'mode',
              category: 'mode',
              name: 'Mode',
              type: 'select',
              ...(initialMode !== undefined ? { currentValue: initialMode } : {}),
              options: modeOptionList
            },
            modelOption
          ]
        }
      });
    } else if (modeStyle === 'modesAndConfigOption') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId,
          modes: {
            ...(initialMode !== undefined ? { currentModeId: initialMode } : {}),
            availableModes: [
              { id: 'default', name: 'Manual', description: 'Always ask' },
              { id: 'acceptEdits', name: 'Accept edits', description: 'Auto edit' },
              { id: 'plan', name: 'Plan', description: 'Read-only' },
              { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Skip all' }
            ]
          },
          configOptions: [
            {
              id: 'mode',
              category: 'mode',
              name: 'Mode',
              type: 'select',
              ...(initialMode !== undefined ? { currentValue: initialMode } : {}),
              options: modeOptionList
            },
            modelOption
          ]
        }
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId,
          modes: {
            ...(initialMode !== undefined ? { currentModeId: initialMode } : {}),
            availableModes: [
              { id: 'default', name: 'Manual', description: 'Always ask' },
              { id: 'acceptEdits', name: 'Accept edits', description: 'Auto edit' },
              { id: 'plan', name: 'Plan', description: 'Read-only' },
              { id: 'bypassPermissions', name: 'Bypass permissions', description: 'Skip all' }
            ]
          },
          configOptions: [modelOption]
        }
      });
    }
    return;
  }

  if (msg.method === 'session/set_mode') {
    if (process.env.MOCK_FAIL_SET_MODE === '1') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Mock set_mode rejected' }
      });
      return;
    }
    const st = sessions.get(msg.params?.sessionId);
    if (st) st.modeId = msg.params.modeId;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    if (process.env.MOCK_FAIL_SET_CONFIG_OPTION === '1') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Mock set_config_option rejected' }
      });
      return;
    }
    const st = sessions.get(msg.params?.sessionId);
    if (st && msg.params?.configId === 'mode') {
      st.modeId = msg.params.value;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        configOptions: st ? [{ id: 'mode', category: 'mode', type: 'select', currentValue: st.modeId }] : []
      }
    });
    return;
  }

  if (msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId;
    const promptReqId = msg.id;
    const text = String(msg.params?.prompt?.[0]?.text || '');
    const st = sessions.get(sessionId) || { modeId: 'default', secret: null };

    if (text.startsWith('REMEMBER:')) {
      st.secret = text.slice('REMEMBER:'.length).trim();
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已记住:' + st.secret } }
        }
      });
      send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'ASK_SECRET') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回忆:' + (st.secret || 'NONE') } }
        }
      });
      send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text.startsWith('STREAM_SLOW:')) {
      const tag = text.slice('STREAM_SLOW:'.length);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tag + '-1;' } }
        }
      });
      setTimeout(() => {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: tag + '-2' } }
          }
        });
        send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
      }, 120);
      return;
    }

    if (text === 'CHECK_MODE_AND_PERM') {
      if (st.modeId === 'bypassPermissions') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'BYPASSED:' + st.modeId } }
          }
        });
        send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
      } else {
        const permRpcId = 5000 + Math.floor(Math.random() * 1000);
        pendingPermResolvers.set(permRpcId, (res) => {
          const chosen = res?.outcome?.optionId || res?.outcome?.outcome;
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'MODE=' + st.modeId + ',PERM=' + chosen } }
            }
          });
          send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
        });
        send({
          jsonrpc: '2.0',
          id: permRpcId,
          method: 'session/request_permission',
          params: {
            sessionId,
            toolCall: { title: 'Write secret.txt', rawInput: { path: 'secret.txt' } },
            options: [
              { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
              { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
            ]
          }
        });
      }
      return;
    }

    if (text === 'TOOL_AND_USAGE_WITH_TURN') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc_1',
            title: 'Preparing file…',
            kind: 'edit',
            status: 'pending',
            rawInput: {}
          }
        }
      });
      setTimeout(() => {
        // Update title & rawInput WITHOUT status! Should stay running!
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc_1',
              title: 'Edit src/demo.ts',
              kind: 'edit',
              rawInput: { file_path: 'src/demo.ts', content: 'abc' }
            }
          }
        });
      }, 40);
      setTimeout(() => {
        // Complete the tool call
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tc_1',
              status: 'completed',
              rawOutput: 'File updated'
            }
          }
        });
        // Emit ACP usage_update (context window size/used, NOT turn consumption!)
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: 27850,
              size: 1000000
            }
          }
        });
        // Emit current_mode_update
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'current_mode_update',
              currentModeId: 'acceptEdits'
            }
          }
        });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }
          }
        });
        send({
          jsonrpc: '2.0',
          id: promptReqId,
          result: {
            stopReason: 'end_turn',
            usage: { inputTokens: 120, outputTokens: 45, cachedReadTokens: 10, totalTokens: 175 }
          }
        });
      }, 90);
      return;
    }

    if (text === 'USAGE_CONTEXT_ONLY_NO_TURN_USAGE') {
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'usage_update', used: 27850, size: 1000000 }
        }
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok-no-usage' } }
        }
      });
      send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
      return;
    }

    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo:' + text } }
      }
    });
    send({ jsonrpc: '2.0', id: promptReqId, result: { stopReason: 'end_turn' } });
  }
});
`,
    'utf8'
  )

  return { scriptPath, envDumpPath, rpcLogPath }
}

afterEach(() => {
  delete process.env.CJH_DATA_DIR
  delete process.env.CJH_MASTER_KEY_HEX
  delete process.env.CJH_LOCAL_TOKEN
  delete process.env.CJH_DAEMON_AUTOSTART
  delete process.env.CJH_APP_EXE
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

describe('Round 1 Fixes — P0 & P1 Verification', () => {
  it('P0 #1: isolates ACP sessions per threadId, prevents concurrent cross-talk, stores acpSessionId, and releases on delete/cwd/provider/idle', async () => {
    const dir = makeTempDir('cjh-p0-1-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath } = writeSmartMockAcpAgent(dir)

    const daemon = await startLocalDaemon({ port: 0, authToken: 'p0-1-token' })
    try {
      daemon.ctx.db.upsertProvider({
        id: 'acp-iso',
        name: 'ACP Isolation',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
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

      // Second ACP provider to test release on provider change
      daemon.ctx.db.upsertProvider({
        id: 'acp-iso-2',
        name: 'ACP Isolation 2',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: {},
        acpMcpServerIds: [],
        acpPermissionMode: 'default',
        acpAvailableModes: [],
        customHeaders: {},
        models: [
          {
            id: 'sonnet',
            name: 'Sonnet',
            enabled: true,
            capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
          }
        ],
        availableModels: [],
        enabled: true,
        sortOrder: 1
      })

      const cwd = dir
      const threadA = daemon.ctx.db.createThread({ model: 'acp-iso:opus', workspacePath: cwd })
      const threadB = daemon.ctx.db.createThread({ model: 'acp-iso:opus', workspacePath: cwd })

      // 1. Thread A remembers a secret
      await daemon.ctx.engine.startTurn({
        threadId: threadA.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'REMEMBER:蓝莓狮子' }] },
        source: 'test'
      })
      // Thread B asks for the secret -> MUST NOT see Thread A's secret!
      await daemon.ctx.engine.startTurn({
        threadId: threadB.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ASK_SECRET' }] },
        source: 'test'
      })

      const msgsA = daemon.ctx.db.getActiveBranchMessages(threadA.id)
      const msgsB = daemon.ctx.db.getActiveBranchMessages(threadB.id)
      const txtA = msgsA[1].message.parts.find(p => p.type === 'text')
      const txtB = msgsB[1].message.parts.find(p => p.type === 'text')
      expect(txtA && txtA.type === 'text' ? txtA.text : '').toContain('已记住:蓝莓狮子')
      expect(txtB && txtB.type === 'text' ? txtB.text : '').toBe('回忆:NONE')

      // Distinct acpSessionIds persisted in threads.metadata
      const freshA = daemon.ctx.db.getThread(threadA.id)!
      const freshB = daemon.ctx.db.getThread(threadB.id)!
      expect(typeof freshA.metadata.acpSessionId).toBe('string')
      expect(typeof freshB.metadata.acpSessionId).toBe('string')
      expect(freshA.metadata.acpSessionId).not.toBe(freshB.metadata.acpSessionId)

      // 2. Concurrent turns on Thread A and Thread B must NOT mix streaming chunks
      await Promise.all([
        daemon.ctx.engine.startTurn({
          threadId: threadA.id,
          userMessage: { role: 'user', parts: [{ type: 'text', text: 'STREAM_SLOW:AAA' }] },
          source: 'test'
        }),
        daemon.ctx.engine.startTurn({
          threadId: threadB.id,
          userMessage: { role: 'user', parts: [{ type: 'text', text: 'STREAM_SLOW:BBB' }] },
          source: 'test'
        })
      ])

      const msgsA2 = daemon.ctx.db.getActiveBranchMessages(threadA.id)
      const msgsB2 = daemon.ctx.db.getActiveBranchMessages(threadB.id)
      const lastA = msgsA2[msgsA2.length - 1].message.parts.find(p => p.type === 'text')
      const lastB = msgsB2[msgsB2.length - 1].message.parts.find(p => p.type === 'text')
      expect(lastA && lastA.type === 'text' ? lastA.text : '').toBe('AAA-1;AAA-2')
      expect(lastB && lastB.type === 'text' ? lastB.text : '').toBe('BBB-1;BBB-2')

      // 3. Changing cwd via HTTP PUT releases session
      const app = daemon.ctx.db ? (await import('../app')).createHttpApp(daemon.ctx) : null
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(threadA.id)).not.toBeNull()
      const newCwd = makeTempDir('cjh-new-cwd-')
      const putCwdRes = await app!.request(`/api/threads/${threadA.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer p0-1-token'
        },
        body: JSON.stringify({ workspacePath: newCwd })
      })
      expect(putCwdRes.status).toBe(200)
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(threadA.id)).toBeNull()

      // 4. Changing provider via HTTP PUT releases session
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(threadB.id)).not.toBeNull()
      const putProvRes = await app!.request(`/api/threads/${threadB.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer p0-1-token'
        },
        body: JSON.stringify({ model: 'acp-iso-2:sonnet' })
      })
      expect(putProvRes.status).toBe(200)
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(threadB.id)).toBeNull()

      // Re-activate threadA then delete via HTTP DELETE -> releases session
      await daemon.ctx.engine.startTurn({
        threadId: threadA.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ping' }] },
        source: 'test'
      })
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(threadA.id)).not.toBeNull()
      const delRes = await app!.request(`/api/threads/${threadA.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer p0-1-token' }
      })
      expect(delRes.status).toBe(200)
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(threadA.id)).toBeNull()
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('P0 #1b: releases idle ACP session after idleTimeoutMs', async () => {
    const dir = makeTempDir('cjh-p0-idle-')
    const { scriptPath } = writeSmartMockAcpAgent(dir)
    const vault = new SecretVault()
    const db = new AppDatabase(join(dir, 'cjh.db'), vault)
    const logger = new TaggedLogger(join(dir, 'logs'))
    const mgr = new AcpAgentManager(
      db,
      logger,
      () => ({ apiUrl: 'http://127.0.0.1:1', apiToken: 't' }),
      () => {},
      () => {},
      { idleTimeoutMs: 120 }
    )

    try {
      const prov = db.upsertProvider({
        id: 'acp-idle',
        name: 'Idle ACP',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: {},
        acpMcpServerIds: [],
        customHeaders: {},
        models: [],
        availableModels: [],
        enabled: true,
        sortOrder: 0
      })
      const thread = db.createThread({ model: 'acp-idle:opus' })
      await mgr.runPromptTurn({
        threadId: thread.id,
        provider: prov,
        modelId: 'opus',
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
      expect(mgr.getActiveThreadSessionInfo(thread.id)).not.toBeNull()
      await new Promise(r => setTimeout(r, 250))
      expect(mgr.getActiveThreadSessionInfo(thread.id)).toBeNull()
    } finally {
      mgr.disposeAll()
      db.close()
    }
  }, 15_000)

  it('P0 #2: deletes CJH_MASTER_KEY_HEX / CJH_LOCAL_TOKEN after startup and excludes them from all child process envs', async () => {
    const dir = makeTempDir('cjh-p0-2-')
    process.env.CJH_DATA_DIR = dir
    process.env.CJH_MASTER_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    process.env.CJH_LOCAL_TOKEN = 'super-secret-local-token'
    process.env.CJH_DAEMON_AUTOSTART = '1'
    process.env.CJH_APP_EXE = 'C:\\cjh\\cjh.exe'

    const { scriptPath, envDumpPath } = writeSmartMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0 })

    try {
      // Server must delete sensitive bootstrap env vars from its own process.env immediately
      expect(process.env.CJH_MASTER_KEY_HEX).toBeUndefined()
      expect(process.env.CJH_LOCAL_TOKEN).toBeUndefined()
      expect(daemon.authToken).toBe('super-secret-local-token')

      // Even if someone re-injects them later, buildCleanSubprocessEnv must blacklist them
      process.env.CJH_MASTER_KEY_HEX = 'leaked-again'
      process.env.CJH_LOCAL_TOKEN = 'leaked-token-again'
      const mcpEnv = buildCleanSubprocessEnv({ command: 'node' })
      expect(mcpEnv.CJH_MASTER_KEY_HEX).toBeUndefined()
      expect(mcpEnv.CJH_LOCAL_TOKEN).toBeUndefined()
      expect(mcpEnv.CJH_DAEMON_AUTOSTART).toBeUndefined()
      expect(mcpEnv.CJH_APP_EXE).toBeUndefined()
      expect(mcpEnv.CJH_API_URL).toBeUndefined()
      expect(mcpEnv.CJH_API_TOKEN).toBeUndefined()

      // Real child process (stdio ACP agent) must NOT receive CJH_MASTER_KEY_HEX / CJH_LOCAL_TOKEN
      const prov = daemon.ctx.db.upsertProvider({
        id: 'acp-env-check',
        name: 'Env Check ACP',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: {},
        acpMcpServerIds: [],
        customHeaders: {},
        models: [],
        availableModels: [],
        enabled: true,
        sortOrder: 0
      })

      await daemon.ctx.acpManager.discoverProviderModels(prov)
      const dumped = JSON.parse(readFileSync(envDumpPath, 'utf8'))
      expect(dumped.CJH_MASTER_KEY_HEX).toBeUndefined()
      expect(dumped.CJH_LOCAL_TOKEN).toBeUndefined()
      expect(dumped.CJH_DAEMON_AUTOSTART).toBeUndefined()
      expect(dumped.CJH_APP_EXE).toBeUndefined()
      // Only intentionally injected daemonEnv is present
      expect(dumped.CJH_API_URL).toBe(`http://127.0.0.1:${daemon.port}`)
      expect(dumped.CJH_API_TOKEN).toBe('super-secret-local-token')
    } finally {
      await daemon.shutdown()
    }
  }, 15_000)

  it('P0 #3: migrates old DB to add acp_permission_mode, explicitly enforces mode after session/new, and syncs current_mode_update', async () => {
    const dir = makeTempDir('cjh-p0-3-')
    const dbPath = join(dir, 'legacy.db')

    // 1. Create a legacy v1 database WITHOUT acp_permission_mode column
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        api_format TEXT NOT NULL DEFAULT 'openai-chat',
        is_response_api INTEGER NOT NULL DEFAULT 0,
        use_max_completion_tokens INTEGER NOT NULL DEFAULT 0,
        api_version TEXT,
        base_url TEXT,
        api_key_enc TEXT,
        custom_headers TEXT NOT NULL DEFAULT '{}',
        models TEXT NOT NULL DEFAULT '[]',
        available_models TEXT NOT NULL DEFAULT '[]',
        acp_preset TEXT,
        acp_command TEXT,
        acp_executable_path TEXT,
        acp_args TEXT NOT NULL DEFAULT '[]',
        acp_env TEXT NOT NULL DEFAULT '{}',
        acp_api_provider_id TEXT,
        acp_mcp_server_ids TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (id, applied_at) VALUES ('001_initial_schema', 1000);
      INSERT INTO providers (id, name, type, acp_preset, acp_command, created_at, updated_at)
      VALUES ('old-acp', 'Legacy Claude', 'acp', 'claude', 'claude-agent-acp', 1000, 1000);
    `)
    legacy.close()

    // Opening AppDatabase must run migration 002 and upgrade existing row to 'default'
    const vault = new SecretVault()
    const migratedDb = new AppDatabase(dbPath, vault)
    const migRow = migratedDb.sqlite
      .prepare("SELECT id FROM schema_migrations WHERE id = '002_acp_permission_mode'")
      .get() as { id: string } | undefined
    expect(migRow?.id).toBe('002_acp_permission_mode')

    const legacyProv = migratedDb.getProvider('old-acp')
    expect(legacyProv?.acpPermissionMode).toBe('default')
    expect(legacyProv?.acpAvailableModes).toEqual([])
    migratedDb.close()

    // 2. Test explicit session/set_mode overriding agent's bypassPermissions default
    process.env.CJH_DATA_DIR = dir
    const { scriptPath, rpcLogPath } = writeSmartMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'p0-3-token' })
    try {
      daemon.ctx.db.updateSettings({ acp: { permissionTimeoutSec: 1 } as any })
      daemon.ctx.db.upsertProvider({
        id: 'claude-mock',
        name: 'Claude Mock',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: { MOCK_INITIAL_MODE: 'bypassPermissions', MOCK_MODE_STYLE: 'modes' },
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

      const thread = daemon.ctx.db.createThread({ model: 'claude-mock:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'CHECK_MODE_AND_PERM' }] },
        source: 'test'
      })

      // Agent initially defaulted to bypassPermissions, but cjh explicitly called session/set_mode -> default,
      // so agent switched to 'default', sent session/request_permission, and cjh fail-closed rejected it!
      const msgs = daemon.ctx.db.getActiveBranchMessages(thread.id)
      const txt = msgs[1].message.parts.find(p => p.type === 'text')
      expect(txt && txt.type === 'text' ? txt.text : '').toBe('MODE=default,PERM=reject_once')

      const rpcCalls = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      const setModeCall = rpcCalls.find(c => c.method === 'session/set_mode')
      expect(setModeCall?.params?.modeId).toBe('default')

      // Check thread metadata captured availableModes & currentModeId
      const updatedThread = daemon.ctx.db.getThread(thread.id)!
      expect((updatedThread.metadata.acpMode as any)?.currentModeId).toBe('default')
      expect((updatedThread.metadata.acpMode as any)?.availableModes?.length).toBeGreaterThanOrEqual(4)

      // Check configOptionOnly mode style falls back to session/set_config_option(id='mode')
      daemon.ctx.db.upsertProvider({
        id: 'claude-mock-cfg',
        name: 'Claude Mock ConfigOption',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: { MOCK_INITIAL_MODE: 'bypassPermissions', MOCK_MODE_STYLE: 'configOptionOnly' },
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
        sortOrder: 1
      })
      const threadCfg = daemon.ctx.db.createThread({ model: 'claude-mock-cfg:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: threadCfg.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'CHECK_MODE_AND_PERM' }] },
        source: 'test'
      })
      const msgsCfg = daemon.ctx.db.getActiveBranchMessages(threadCfg.id)
      const txtCfg = msgsCfg[1].message.parts.find(p => p.type === 'text')
      expect(txtCfg && txtCfg.type === 'text' ? txtCfg.text : '').toBe('MODE=default,PERM=reject_once')
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('P1 #4, #5, #6: returns 400 on Zod/JSON errors, updates tool card title/input without clobbering status, and separates context usage from turn tokens', async () => {
    const dir = makeTempDir('cjh-p1-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath } = writeSmartMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'p1-token' })

    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)

      // P1 #4: Zod validation error -> 400 with { error, issues }
      const badZodRes = await app.request('/api/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer p1-token'
        },
        body: JSON.stringify({ name: 123 })
      })
      expect(badZodRes.status).toBe(400)
      const badZodBody = await badZodRes.json()
      expect(badZodBody.error).toBeTruthy()
      expect(Array.isArray(badZodBody.issues)).toBe(true)

      // P1 #4: Malformed JSON -> 400
      const badJsonRes = await app.request('/api/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer p1-token'
        },
        body: '{invalid-json'
      })
      expect(badJsonRes.status).toBe(400)

      // Capture WS broadcasts to verify tool_call_update and context_usage_update
      const broadcasts: Array<{ type: string; data: any }> = []
      const origBroadcast = daemon.ctx.wsHub.broadcast.bind(daemon.ctx.wsHub)
      daemon.ctx.wsHub.broadcast = (type: string, data: any) => {
        broadcasts.push({ type, data })
        origBroadcast(type, data)
      }

      daemon.ctx.db.upsertProvider({
        id: 'acp-p1',
        name: 'ACP P1',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-p1:opus' })

      // P1 #5 + P1 #6 (with PromptResponse.usage)
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'TOOL_AND_USAGE_WITH_TURN' }] },
        source: 'test'
      })

      const toolUpdates = broadcasts.filter(b => b.type === 'tool_call_update')
      expect(toolUpdates).toHaveLength(2)
      // First update had title + input, NO status -> must NOT be coerced to 'completed'!
      expect(toolUpdates[0].data.status).toBeUndefined()
      expect(toolUpdates[0].data.title).toBe('Edit src/demo.ts')
      expect(toolUpdates[0].data.input).toEqual({ file_path: 'src/demo.ts', content: 'abc' })
      // Second update completed it
      expect(toolUpdates[1].data.status).toBe('completed')

      const msgs = daemon.ctx.db.getActiveBranchMessages(thread.id)
      const assistantMsg = msgs[1]
      const toolPart = assistantMsg.message.parts.find(p => p.type === 'tool-call')
      expect(toolPart && toolPart.type === 'tool-call' ? toolPart.title : '').toBe('Edit src/demo.ts')
      expect(toolPart && toolPart.type === 'tool-call' ? toolPart.input : null).toEqual({
        file_path: 'src/demo.ts',
        content: 'abc'
      })
      expect(toolPart && toolPart.type === 'tool-call' ? toolPart.status : '').toBe('completed')

      // P1 #6: usage_update (27850) must be in context_usage_update & metadata.contextUsage, NOT turn tokens (120/45/175)!
      const ctxEvents = broadcasts.filter(b => b.type === 'context_usage_update')
      expect(ctxEvents.length).toBeGreaterThanOrEqual(1)
      expect(ctxEvents[0].data.used).toBe(27850)
      expect(ctxEvents[0].data.size).toBe(1000000)

      expect(assistantMsg.metadata.usage?.inputTokens).toBe(120)
      expect(assistantMsg.metadata.usage?.outputTokens).toBe(45)
      expect(assistantMsg.metadata.usage?.totalTokens).toBe(175)

      // Also verify current_mode_update synced into thread metadata
      const refreshedThread = daemon.ctx.db.getThread(thread.id)!
      expect((refreshedThread.metadata.acpMode as any)?.currentModeId).toBe('acceptEdits')
      expect((refreshedThread.metadata.contextUsage as any)?.used).toBe(27850)

      // P1 #6b: When PromptResponse omits usage, usage_records must record 0 instead of context size 27850!
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'USAGE_CONTEXT_ONLY_NO_TURN_USAGE' }] },
        source: 'test'
      })
      const msgs2 = daemon.ctx.db.getActiveBranchMessages(thread.id)
      const assistantMsg2 = msgs2[msgs2.length - 1]
      expect(assistantMsg2.metadata.usage?.inputTokens).toBe(0)
      expect(assistantMsg2.metadata.usage?.outputTokens).toBe(0)
      expect(assistantMsg2.metadata.usage?.totalTokens).toBe(0)
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('P1 #7: CLI resolveCliTarget detects stale runtime.json after hard kill and reports "cjh 未运行"', async () => {
    const dir = makeTempDir('cjh-p1-7-')
    process.env.CJH_DATA_DIR = dir
    const runtimePath = join(dir, 'runtime.json')
    writeFileSync(
      runtimePath,
      JSON.stringify({
        port: 59999,
        token: 'dead-token',
        pid: 999999,
        mode: 'custom',
        startedAt: new Date().toISOString()
      }),
      'utf8'
    )

    await expect(resolveCliTarget()).rejects.toThrow(/cjh 未运行/)
    // Stale runtime.json is cleaned up
    expect(existsSync(runtimePath)).toBe(false)
  })

  it('Round 2 fix: fails closed with generation_error and skips session/prompt when set_mode and set_config_option fail while currentModeId is bypassPermissions', async () => {
    const dir = makeTempDir('cjh-r2-failclosed-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath, rpcLogPath } = writeSmartMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'r2-token' })

    try {
      const broadcasts: Array<{ type: string; data: any }> = []
      const origBroadcast = daemon.ctx.wsHub.broadcast.bind(daemon.ctx.wsHub)
      daemon.ctx.wsHub.broadcast = (type: string, data: any) => {
        broadcasts.push({ type, data })
        origBroadcast(type, data)
      }

      daemon.ctx.db.upsertProvider({
        id: 'acp-failclosed',
        name: 'ACP Fail Closed',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: {
          MOCK_MODE_STYLE: 'modesAndConfigOption',
          MOCK_INITIAL_MODE: 'bypassPermissions',
          MOCK_FAIL_SET_MODE: '1',
          MOCK_FAIL_SET_CONFIG_OPTION: '1'
        },
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-failclosed:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'SHOULD_NOT_RUN' }] },
        source: 'test'
      })

      const genError = broadcasts.find(
        b => b.type === 'generation_error' && b.data?.threadId === thread.id
      )
      expect(genError).toBeDefined()
      expect(String(genError?.data?.error || '')).toContain(
        '无法把 ACP 会话权限模式设为 default，为安全起见已中止'
      )
      expect(
        broadcasts.some(b => b.type === 'generation_completed' && b.data?.threadId === thread.id)
      ).toBe(false)

      const msgs = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(msgs[1].metadata.finishReason).toBe('error')
      expect(msgs[1].metadata.error).toContain(
        '无法把 ACP 会话权限模式设为 default，为安全起见已中止'
      )

      const rpcCalls = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      expect(rpcCalls.some(c => c.method === 'session/set_mode')).toBe(true)
      expect(
        rpcCalls.some(c => c.method === 'session/set_config_option' && c.params?.configId === 'mode')
      ).toBe(true)
      expect(rpcCalls.some(c => c.method === 'session/prompt')).toBe(false)

      // Session must be released after abort
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(thread.id)).toBeNull()
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('Round 2 fix (edge cases): aborts when currentModeId is unknown, continues when currentModeId already matches target, and warns & continues when agent does not support modes', async () => {
    const dir = makeTempDir('cjh-r2-edges-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath, rpcLogPath } = writeSmartMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'r2-edges-token' })

    try {
      const broadcasts: Array<{ type: string; data: any }> = []
      const origBroadcast = daemon.ctx.wsHub.broadcast.bind(daemon.ctx.wsHub)
      daemon.ctx.wsHub.broadcast = (type: string, data: any) => {
        broadcasts.push({ type, data })
        origBroadcast(type, data)
      }

      const upsertMock = (id: string, acpEnv: Record<string, string>) =>
        daemon.ctx.db.upsertProvider({
          id,
          name: id,
          type: 'acp',
          apiFormat: 'anthropic',
          isResponseApi: false,
          useMaxCompletionTokens: false,
          acpPreset: 'custom',
          acpCommand: process.execPath,
          acpArgs: [scriptPath],
          acpEnv,
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

      // 1. Unknown currentModeId + mode set fails -> generation_error, no session/prompt, session released
      upsertMock('acp-unknown-mode', {
        MOCK_MODE_STYLE: 'modesAndConfigOption',
        MOCK_INITIAL_MODE: '__OMIT__',
        MOCK_FAIL_SET_MODE: '1',
        MOCK_FAIL_SET_CONFIG_OPTION: '1'
      })
      const tUnknown = daemon.ctx.db.createThread({ model: 'acp-unknown-mode:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: tUnknown.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ABORT_UNKNOWN' }] },
        source: 'test'
      })
      const unknownErr = broadcasts.find(
        b => b.type === 'generation_error' && b.data?.threadId === tUnknown.id
      )
      expect(String(unknownErr?.data?.error || '')).toContain(
        '无法把 ACP 会话权限模式设为 default，为安全起见已中止'
      )
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(tUnknown.id)).toBeNull()
      const rpcBeforePrompt = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      expect(rpcBeforePrompt.some(c => c.method === 'session/prompt')).toBe(false)

      // 2. currentModeId already equals targetMode ('default') -> continues even if RPC fails
      upsertMock('acp-same-mode', {
        MOCK_MODE_STYLE: 'modesAndConfigOption',
        MOCK_INITIAL_MODE: 'default',
        MOCK_FAIL_SET_MODE: '1',
        MOCK_FAIL_SET_CONFIG_OPTION: '1'
      })
      const tSame = daemon.ctx.db.createThread({ model: 'acp-same-mode:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: tSame.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ok-same-mode' }] },
        source: 'test'
      })
      const sameMsgs = daemon.ctx.db.getActiveBranchMessages(tSame.id)
      const samePart = sameMsgs[1].message.parts.find(p => p.type === 'text')
      expect(samePart && samePart.type === 'text' ? samePart.text : '').toBe('echo:ok-same-mode')

      // 3. Agent does not support modes at all -> logs warn and continues
      upsertMock('acp-no-modes', {
        MOCK_MODE_STYLE: 'noModes'
      })
      const tNoModes = daemon.ctx.db.createThread({ model: 'acp-no-modes:opus' })
      await daemon.ctx.engine.startTurn({
        threadId: tNoModes.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ok-no-modes' }] },
        source: 'test'
      })
      const noModesMsgs = daemon.ctx.db.getActiveBranchMessages(tNoModes.id)
      const noModesPart = noModesMsgs[1].message.parts.find(p => p.type === 'text')
      expect(noModesPart && noModesPart.type === 'text' ? noModesPart.text : '').toBe(
        'echo:ok-no-modes'
      )
      const warnLogs = daemon.ctx.logger.getRecent('ACP:acp-no-modes')
      expect(
        warnLogs.some(
          e =>
            e.level === 'WARN' &&
            e.message.includes('does not advertise modes or mode config option')
        )
      ).toBe(true)
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)
})
