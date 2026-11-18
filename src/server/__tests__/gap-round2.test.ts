import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretVault } from '../crypto/vault'
import { AppDatabase } from '../db/database'
import { startLocalDaemon } from '../entry'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-gap2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function writeResumeMockAcpAgent(dir: string): {
  scriptPath: string
  stateFilePath: string
  rpcLogPath: string
} {
  const scriptPath = join(dir, 'resume-acp-agent.mjs')
  const stateFilePath = join(dir, 'acp-session-store.json')
  const rpcLogPath = join(dir, 'acp-rpc-log.jsonl')

  writeFileSync(
    scriptPath,
    `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const STATE_FILE = ${JSON.stringify(stateFilePath)};
const RPC_LOG = ${JSON.stringify(rpcLogPath)};

function loadStore() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveStore(store) {
  writeFileSync(STATE_FILE, JSON.stringify(store, null, 2), 'utf8');
}
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}
function logRpc(entry) {
  appendFileSync(RPC_LOG, JSON.stringify(entry) + '\\n', 'utf8');
}

const rl = createInterface({ input: process.stdin });
const supportsLoad = process.env.MOCK_LOAD_SESSION === '1';

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;

  logRpc({ pid: process.pid, method: msg.method, params: msg.params });

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'resume-mock', version: '1.0.0' },
        agentCapabilities: {
          loadSession: supportsLoad,
          promptCapabilities: { image: true, embeddedContext: true }
        }
      }
    });
    return;
  }

  if (msg.method === 'session/new') {
    const store = loadStore();
    const sessionId = 'sess_' + (Object.keys(store).length + 1) + '_' + process.pid;
    store[sessionId] = { modeId: 'bypassPermissions', secret: null, prompts: [] };
    saveStore(store);
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId,
        modes: {
          currentModeId: 'bypassPermissions',
          availableModes: [
            { id: 'default', name: 'Manual' },
            { id: 'bypassPermissions', name: 'Bypass' }
          ]
        }
      }
    });
    return;
  }

  if (msg.method === 'session/load') {
    const sid = msg.params?.sessionId;
    const store = loadStore();
    if (!supportsLoad || !sid || !store[sid]) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32001, message: 'Session not found: ' + sid }
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        modes: {
          currentModeId: store[sid].modeId || 'default',
          availableModes: [
            { id: 'default', name: 'Manual' },
            { id: 'bypassPermissions', name: 'Bypass' }
          ]
        }
      }
    });
    return;
  }

  if (msg.method === 'session/set_mode') {
    const sid = msg.params?.sessionId;
    const store = loadStore();
    if (sid && store[sid]) {
      store[sid].modeId = msg.params.modeId;
      saveStore(store);
    }
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: [] } });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sid = msg.params?.sessionId;
    const store = loadStore();
    const st = store[sid] || { modeId: 'default', secret: null, prompts: [] };
    const text = (msg.params?.prompt || []).map(b => b.text || '').join('\\n');
    st.prompts.push(text);

    if (text.startsWith('REMEMBER:')) {
      st.secret = text.slice('REMEMBER:'.length).trim();
      store[sid] = st;
      saveStore(store);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已记住:' + st.secret } }
        }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    if (text === 'ASK_SECRET') {
      store[sid] = st;
      saveStore(store);
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '回忆:' + (st.secret || 'NONE') + ':MODE=' + st.modeId } }
        }
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }

    store[sid] = st;
    saveStore(store);
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: sid,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ECHO:' + text } }
      }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    'utf8'
  )

  return { scriptPath, stateFilePath, rpcLogPath }
}

afterEach(() => {
  delete process.env.CJH_DATA_DIR
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 50 })
    } catch {
      // Ignore transient Windows handle release
    }
  }
})

describe('Round 2 Gap Closure — B1: ACP Session Resume', () => {
  it('B1a: uses session/load after daemon restart when agent supports loadSession', async () => {
    const dir = makeTempDir('cjh-b1-load-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath, rpcLogPath } = writeResumeMockAcpAgent(dir)

    const daemon1 = await startLocalDaemon({ port: 0, authToken: 'b1-load-token' })
    let threadId = ''
    let savedAcpSessionId = ''
    try {
      daemon1.ctx.db.upsertProvider({
        id: 'acp-loadable',
        name: 'ACP Loadable',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: { MOCK_LOAD_SESSION: '1' },
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

      const thread = daemon1.ctx.db.createThread({ model: 'acp-loadable:opus', workspacePath: dir })
      threadId = thread.id

      await daemon1.ctx.engine.startTurn({
        threadId,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'REMEMBER:极光密码' }] },
        source: 'test'
      })

      const after1 = daemon1.ctx.db.getThread(threadId)!
      savedAcpSessionId = String(after1.metadata.acpSessionId)
      expect(savedAcpSessionId).toMatch(/^sess_/)
    } finally {
      await daemon1.shutdown()
    }

    // Restart daemon on same data directory
    const daemon2 = await startLocalDaemon({ port: 0, authToken: 'b1-load-token' })
    try {
      await daemon2.ctx.engine.startTurn({
        threadId,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ASK_SECRET' }] },
        source: 'test'
      })

      const msgs = daemon2.ctx.db.getActiveBranchMessages(threadId)
      const lastText = msgs[msgs.length - 1].message.parts.find(p => p.type === 'text')
      expect(lastText && lastText.type === 'text' ? lastText.text : '').toBe('回忆:极光密码:MODE=default')

      const after2 = daemon2.ctx.db.getThread(threadId)!
      expect(after2.metadata.acpSessionId).toBe(savedAcpSessionId)
      expect(after2.metadata.acpResumeMode).toBe('session_load')

      const calls = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      const loadCalls = calls.filter(c => c.method === 'session/load')
      const newCalls = calls.filter(c => c.method === 'session/new')
      const promptCalls = calls.filter(c => c.method === 'session/prompt')
      expect(loadCalls).toHaveLength(1)
      expect(loadCalls[0].params.sessionId).toBe(savedAcpSessionId)
      expect(newCalls).toHaveLength(1) // Only the initial session/new from daemon1
      expect(promptCalls[1].params.prompt[0].text).toBe('ASK_SECRET')
    } finally {
      await daemon2.shutdown()
    }
  }, 20_000)

  it('B1b: injects compressed thread history into first turn when agent does NOT support loadSession', async () => {
    const dir = makeTempDir('cjh-b1-fallback-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath, rpcLogPath } = writeResumeMockAcpAgent(dir)

    const daemon = await startLocalDaemon({ port: 0, authToken: 'b1-fallback-token' })
    try {
      daemon.ctx.db.upsertProvider({
        id: 'acp-noload',
        name: 'ACP NoLoad',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: { MOCK_LOAD_SESSION: '0' },
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-noload:opus', workspacePath: dir })

      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'REMEMBER:星辰大海' }] },
        source: 'test'
      })

      // Simulate idle timeout releasing the in-memory session
      daemon.ctx.acpManager.releaseThreadSession(thread.id, 'idle timeout')
      expect(daemon.ctx.acpManager.getActiveThreadSessionInfo(thread.id)).toBeNull()

      // Turn 2 on released session -> new session/new + compressed history context prepended
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '继续刚才的任务' }] },
        source: 'test'
      })

      const after2 = daemon.ctx.db.getThread(thread.id)!
      expect(after2.metadata.acpResumeMode).toBe('fallback_history')

      // Turn 3 on same live session -> NO duplicate history context prepended
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '第三轮消息' }] },
        source: 'test'
      })

      const calls = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      expect(calls.some(c => c.method === 'session/load')).toBe(false)
      const promptCalls = calls.filter(c => c.method === 'session/prompt')
      expect(promptCalls).toHaveLength(3)
      expect(promptCalls[1].params.prompt[0].text).toContain('<conversation_history_context>')
      expect(promptCalls[1].params.prompt[0].text).toContain('REMEMBER:星辰大海')
      expect(promptCalls[1].params.prompt[0].text).toContain('已记住:星辰大海')
      expect(promptCalls[1].params.prompt[0].text).toContain('继续刚才的任务')
      expect(promptCalls[2].params.prompt[0].text).toBe('第三轮消息')
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)
})

describe('Round 2 Gap Closure — A1–A6', () => {
  it('A1 & A2: supports thread rename (titleSource=manual), archive/unarchive, and batch delete', async () => {
    const dir = makeTempDir('cjh-a1-a2-')
    process.env.CJH_DATA_DIR = dir
    const daemon = await startLocalDaemon({ port: 0, authToken: 'a1-a2-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer a1-a2-token'
      }

      const t1 = daemon.ctx.db.createThread({})
      const t2 = daemon.ctx.db.createThread({})
      const t3 = daemon.ctx.db.createThread({})

      // Rename t1 -> titleSource becomes 'manual'
      const renameRes = await app.request(`/api/threads/${t1.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ title: '手动改名后的标题' })
      })
      expect(renameRes.status).toBe(200)
      const renamed = await renameRes.json()
      expect(renamed.title).toBe('手动改名后的标题')
      expect(renamed.titleSource).toBe('manual')

      // Archive t1
      const archRes = await app.request(`/api/threads/${t1.id}/archive`, {
        method: 'POST',
        headers
      })
      expect(archRes.status).toBe(200)
      const archived = await archRes.json()
      expect(typeof archived.archivedAt).toBe('number')

      // Default list excludes archived; ?archived=1 includes archived
      const activeList = await (await app.request('/api/threads', { headers })).json()
      expect(activeList.map((x: any) => x.id)).not.toContain(t1.id)
      const allList = await (await app.request('/api/threads?archived=1', { headers })).json()
      expect(allList.map((x: any) => x.id)).toContain(t1.id)

      // Unarchive t1
      const unarchRes = await app.request(`/api/threads/${t1.id}/unarchive`, {
        method: 'POST',
        headers
      })
      expect(unarchRes.status).toBe(200)
      expect((await unarchRes.json()).archivedAt).toBeNull()

      // Batch delete t2 and t3
      const batchRes = await app.request('/api/threads/batch-delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: [t2.id, t3.id] })
      })
      expect(batchRes.status).toBe(200)
      expect((await batchRes.json()).deleted).toBe(2)
      expect(daemon.ctx.db.getThread(t2.id)).toBeNull()
      expect(daemon.ctx.db.getThread(t3.id)).toBeNull()
      expect(daemon.ctx.db.getThread(t1.id)).not.toBeNull()
    } finally {
      await daemon.shutdown()
    }
  })

  it('A3: editing a user message with replaceMessageId creates a new branch with versionInfo < m / n >', async () => {
    const dir = makeTempDir('cjh-a3-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath } = writeResumeMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'a3-token' })
    try {
      const broadcasts: Array<{ type: string; data: any }> = []
      const origBroadcast = daemon.ctx.wsHub.broadcast.bind(daemon.ctx.wsHub)
      daemon.ctx.wsHub.broadcast = (type: string, data: any) => {
        broadcasts.push({ type, data })
        origBroadcast(type, data)
      }

      daemon.ctx.db.upsertProvider({
        id: 'acp-a3',
        name: 'ACP A3',
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-a3:opus', workspacePath: dir })
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '第一版问题' }] },
        source: 'test'
      })

      const branch1 = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(branch1).toHaveLength(2)
      const u1 = branch1[0]
      expect(u1.versionInfo.total).toBe(1)

      // Edit u1 and resend
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        replaceMessageId: u1.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: '修改后的第二版问题' }] },
        source: 'test'
      })

      const branch2 = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(branch2).toHaveLength(2)
      const u2 = branch2[0]
      const a2 = branch2[1]
      expect(u2.id).not.toBe(u1.id)
      expect(u2.slotId).toBe(u1.slotId)
      expect(u2.versionInfo).toEqual({
        index: 2,
        total: 2,
        siblingIds: [u1.id, u2.id]
      })
      expect(a2.message.parts[0]).toEqual({ type: 'text', text: 'ECHO:修改后的第二版问题' })

      // Must emit thread_messages_replaced so UI replaces stale branch cleanly
      expect(
        broadcasts.some(b => b.type === 'thread_messages_replaced' && b.data?.threadId === thread.id)
      ).toBe(true)

      // Switching back to u1 restores the first branch
      daemon.ctx.db.switchMessageVersion(u1.id)
      const restoredBranch = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(restoredBranch.map(m => m.id)[0]).toBe(u1.id)
      expect(restoredBranch[1].message.parts[0]).toEqual({ type: 'text', text: 'ECHO:第一版问题' })
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('A4 & A5: forwards ACP slash commands and adapts attachments to ACP promptCapabilities', async () => {
    const dir = makeTempDir('cjh-a4-a5-')
    process.env.CJH_DATA_DIR = dir
    const scriptPath = join(dir, 'att-cmd-acp.mjs')
    const rpcLogPath = join(dir, 'att-rpc.jsonl')

    writeFileSync(
      scriptPath,
      `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const RPC_LOG = ${JSON.stringify(rpcLogPath)};
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function logRpc(entry) { appendFileSync(RPC_LOG, JSON.stringify(entry) + '\\n', 'utf8'); }

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  logRpc({ method: msg.method, params: msg.params });

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: {
            image: process.env.MOCK_CAP_IMAGE === '1',
            embeddedContext: process.env.MOCK_CAP_EMBED === '1'
          }
        }
      }
    });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_att_1' } });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_att_1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Code review' },
            { name: 'plan', description: 'Planning mode' }
          ]
        }
      }
    });
  } else if (msg.method === 'session/set_config_option' || msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'sess_att_1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'blocks:' + msg.params.prompt.length } } }
    });
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
`,
      'utf8'
    )

    const daemon = await startLocalDaemon({ port: 0, authToken: 'a4-a5-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)

      daemon.ctx.db.upsertProvider({
        id: 'acp-caps',
        name: 'ACP Caps',
        type: 'acp',
        apiFormat: 'anthropic',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        acpPreset: 'custom',
        acpCommand: process.execPath,
        acpArgs: [scriptPath],
        acpEnv: { MOCK_CAP_IMAGE: '1', MOCK_CAP_EMBED: '1' },
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-caps:opus', workspacePath: dir })

      // Upload image, text, and binary files
      const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      writeFileSync(join(daemon.ctx.paths.attachmentsDir, 'img1.png'), pngBytes)
      const attImg = daemon.ctx.db.insertAttachment({
        id: 'att_img',
        threadId: thread.id,
        fileName: 'shot.png',
        mimeType: 'image/png',
        byteSize: pngBytes.byteLength,
        relPath: 'img1.png'
      })

      const txtBytes = Buffer.from('console.log("hello")\n', 'utf8')
      writeFileSync(join(daemon.ctx.paths.attachmentsDir, 'code1.ts'), txtBytes)
      const attTxt = daemon.ctx.db.insertAttachment({
        id: 'att_txt',
        threadId: thread.id,
        fileName: 'code.ts',
        mimeType: 'text/plain',
        byteSize: txtBytes.byteLength,
        relPath: 'code1.ts'
      })

      const binBytes = Buffer.from([1, 2, 3, 4])
      writeFileSync(join(daemon.ctx.paths.attachmentsDir, 'archive1.zip'), binBytes)
      const attBin = daemon.ctx.db.insertAttachment({
        id: 'att_bin',
        threadId: thread.id,
        fileName: 'bundle.zip',
        mimeType: 'application/zip',
        byteSize: binBytes.byteLength,
        relPath: 'archive1.zip'
      })

      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: {
          role: 'user',
          parts: [
            { type: 'file', attachmentId: attImg.id, fileName: 'shot.png', mediaType: 'image/png', byteSize: pngBytes.byteLength },
            { type: 'file', attachmentId: attTxt.id, fileName: 'code.ts', mediaType: 'text/plain', byteSize: txtBytes.byteLength },
            { type: 'file', attachmentId: attBin.id, fileName: 'bundle.zip', mediaType: 'application/zip', byteSize: binBytes.byteLength },
            { type: 'text', text: '请分析这三个附件' }
          ]
        },
        source: 'test'
      })

      // Verify A4 commands endpoint
      const cmdRes = await app.request(`/api/threads/${thread.id}/acp-commands`, {
        headers: { Authorization: 'Bearer a4-a5-token' }
      })
      const cmdJson = await cmdRes.json()
      expect(cmdJson.commands).toEqual([
        { name: 'review', description: 'Code review' },
        { name: 'plan', description: 'Planning mode' }
      ])

      // Verify A5 prompt blocks
      const calls = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      const promptCall = calls.find(c => c.method === 'session/prompt')
      const blocks = promptCall.params.prompt
      expect(blocks.some((b: any) => b.type === 'text' && b.text === '请分析这三个附件')).toBe(true)
      expect(blocks.some((b: any) => b.type === 'image' && b.mimeType === 'image/png' && b.data === pngBytes.toString('base64'))).toBe(true)
      expect(blocks.some((b: any) => b.type === 'resource' && b.resource?.text === 'console.log("hello")\n')).toBe(true)
      expect(blocks.some((b: any) => b.type === 'resource_link' && b.name === 'bundle.zip')).toBe(true)
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)

  it('A6: falls back to first 20 characters of first user message when toolModel is unavailable, and never overrides manual title', async () => {
    const dir = makeTempDir('cjh-a6-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath } = writeResumeMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'a6-token' })
    try {
      // Only ACP provider enabled (no non-ACP tool model available!)
      daemon.ctx.db.upsertProvider({
        id: 'acp-only',
        name: 'ACP Only',
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

      const longUserPrompt = '一二三四五六七八九十一二三四五六七八九十超过二十字的内容'
      const thread = daemon.ctx.db.createThread({ model: 'acp-only:opus', workspacePath: dir })
      expect(thread.title).toBe('新对话')
      expect(thread.titleSource).toBe('default')

      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: longUserPrompt }] },
        source: 'test'
      })

      const updated = daemon.ctx.db.getThread(thread.id)!
      expect(updated.title).toBe('一二三四五六七八九十一二三四五六七八九十')
      expect(Array.from(updated.title)).toHaveLength(20)
      expect(updated.titleSource).toBe('auto')

      // Manual rename must NOT be overwritten
      daemon.ctx.db.updateThread(thread.id, { title: '人工标题' })
      await daemon.ctx.engine.maybeGenerateThreadTitle(thread.id)
      expect(daemon.ctx.db.getThread(thread.id)!.title).toBe('人工标题')
      expect(daemon.ctx.db.getThread(thread.id)!.titleSource).toBe('manual')
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)
})

describe('Round 2 Gap Closure — B2: Cron Scheduler', () => {
  it('B2: parses cron + timezone, triggers due cron_job, sends generate_response(source=cron) to target thread, and records cron_runs history', async () => {
    const dir = makeTempDir('cjh-b2-cron-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath } = writeResumeMockAcpAgent(dir)

    // Test migration from v2 DB (no cron_jobs / cron_runs tables)
    const { DatabaseSync } = await import('node:sqlite')
    const legacyDbPath = join(dir, 'cjh.db')
    const v2 = new DatabaseSync(legacyDbPath)
    v2.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, api_format TEXT NOT NULL DEFAULT 'openai-chat', is_response_api INTEGER NOT NULL DEFAULT 0, use_max_completion_tokens INTEGER NOT NULL DEFAULT 0, api_version TEXT, base_url TEXT, api_key_enc TEXT, custom_headers TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', available_models TEXT NOT NULL DEFAULT '[]', acp_preset TEXT, acp_command TEXT, acp_executable_path TEXT, acp_args TEXT NOT NULL DEFAULT '[]', acp_env TEXT NOT NULL DEFAULT '{}', acp_api_provider_id TEXT, acp_mcp_server_ids TEXT NOT NULL DEFAULT '[]', acp_permission_mode TEXT NOT NULL DEFAULT 'default', acp_available_modes TEXT NOT NULL DEFAULT '[]', acp_last_mode_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'default', model TEXT, reasoning_effort TEXT, fast_mode INTEGER NOT NULL DEFAULT 0, active_leaf_id TEXT, workspace_path TEXT, enabled_mcp_ids TEXT, skill_ids TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, parent_id TEXT, slot_id TEXT NOT NULL, role TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, thread_id TEXT, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, rel_path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE skills_state (id TEXT PRIMARY KEY, path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE usage_records (id TEXT PRIMARY KEY, thread_id TEXT, message_id TEXT, category TEXT NOT NULL DEFAULT 'chat', purpose TEXT NOT NULL DEFAULT 'reply', provider_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO schema_migrations (id, applied_at) VALUES ('001_initial_schema', 1000), ('002_acp_permission_mode', 1000);
    `)
    v2.close()

    const daemon = await startLocalDaemon({ port: 0, authToken: 'b2-token' })
    try {
      const { createHttpApp } = await import('../app')
      const { computeNextRunAt } = await import('../cron/scheduler')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer b2-token'
      }

      // Check 003_cron_jobs migration ran
      const migRow = daemon.ctx.db.sqlite
        .prepare("SELECT id FROM schema_migrations WHERE id = '003_cron_jobs'")
        .get() as { id: string } | undefined
      expect(migRow?.id).toBe('003_cron_jobs')

      // Verify timezone calculation for 07:30 Asia/Shanghai (UTC+8 => 23:30 UTC previous day)
      const before730 = Date.parse('2026-11-18T23:25:00.000Z') // 2026-11-19 07:25 Asia/Shanghai
      const next730 = computeNextRunAt('30 7 * * *', 'Asia/Shanghai', before730)
      expect(next730).toBe(Date.parse('2026-11-18T23:30:00.000Z'))

      daemon.ctx.db.upsertProvider({
        id: 'acp-cron',
        name: 'ACP Cron',
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

      const targetThread = daemon.ctx.db.createThread({
        title: '日报接收线程',
        model: 'acp-cron:opus',
        workspacePath: dir
      })

      // Invalid cron expr returns 400
      const badRes = await app.request('/api/cron', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: '坏表达式',
          cronExpr: 'invalid-cron',
          timezone: 'Asia/Shanghai',
          prompt: 'hi'
        })
      })
      expect(badRes.status).toBe(400)

      // Create valid cron job via HTTP API
      const createRes = await app.request('/api/cron', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: '每日 7:30 sub2api 日报',
          cronExpr: '30 7 * * *',
          timezone: 'Asia/Shanghai',
          threadId: targetThread.id,
          prompt: '生成今日sub2api日报',
          model: 'acp-cron:opus',
          enabled: true
        })
      })
      expect(createRes.status).toBe(201)
      const createdJob = await createRes.json()
      expect(createdJob.nextRunAt).toBeTypeOf('number')

      // Spy on engine.startTurn to verify source === 'cron'
      const seenSources: string[] = []
      const origStartTurn = daemon.ctx.engine.startTurn.bind(daemon.ctx.engine)
      daemon.ctx.engine.startTurn = async req => {
        seenSources.push(req.source)
        return origStartTurn(req)
      }

      // Simulate clock reaching nextRunAt and run scheduler.tick()
      const scheduledTime = createdJob.nextRunAt as number
      const runs = await daemon.ctx.cronScheduler.tick(scheduledTime)
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('success')
      expect(runs[0].triggerType).toBe('schedule')
      expect(runs[0].threadId).toBe(targetThread.id)
      expect(seenSources).toEqual(['cron'])

      // Verify target thread received the prompt and agent reply
      const msgs = daemon.ctx.db.getActiveBranchMessages(targetThread.id)
      expect(msgs).toHaveLength(2)
      expect(msgs[0].message.parts[0]).toEqual({ type: 'text', text: '生成今日sub2api日报' })
      expect(msgs[1].message.parts[0]).toEqual({ type: 'text', text: 'ECHO:生成今日sub2api日报' })

      // Verify nextRunAt advanced by 24h and won't double-fire at same timestamp
      const secondTick = await daemon.ctx.cronScheduler.tick(scheduledTime + 10_000)
      expect(secondTick).toHaveLength(0)
      const updatedJob = daemon.ctx.db.getCronJob(createdJob.id)!
      expect(updatedJob.nextRunAt).toBe(scheduledTime + 24 * 60 * 60_000)
      expect(updatedJob.lastStatus).toBe('success')

      // Verify manual run + runs history API
      const manualRes = await app.request(`/api/cron/${createdJob.id}/run`, {
        method: 'POST',
        headers
      })
      expect(manualRes.status).toBe(200)
      const manualRun = await manualRes.json()
      expect(manualRun.triggerType).toBe('manual')
      expect(manualRun.status).toBe('success')

      const runsRes = await app.request(`/api/cron/${createdJob.id}/runs`, { headers })
      expect(runsRes.status).toBe(200)
      const history = await runsRes.json()
      expect(history).toHaveLength(2)
      const triggers = history.map((r: any) => r.triggerType)
      expect(triggers).toContain('manual')
      expect(triggers).toContain('schedule')
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)
})

describe('Round 2 Gap Closure — B3: FTS5 Full-Text Search', () => {
  it('B3: migrates existing messages into messages_fts, syncs inserts/updates/deletes, and serves GET /api/search?q=', async () => {
    const dir = makeTempDir('cjh-b3-fts-')
    process.env.CJH_DATA_DIR = dir
    const { DatabaseSync } = await import('node:sqlite')
    const legacyDbPath = join(dir, 'cjh.db')

    // Pre-populate a v3 DB WITHOUT messages_fts
    const v3 = new DatabaseSync(legacyDbPath)
    v3.exec(`
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, api_format TEXT NOT NULL DEFAULT 'openai-chat', is_response_api INTEGER NOT NULL DEFAULT 0, use_max_completion_tokens INTEGER NOT NULL DEFAULT 0, api_version TEXT, base_url TEXT, api_key_enc TEXT, custom_headers TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]', available_models TEXT NOT NULL DEFAULT '[]', acp_preset TEXT, acp_command TEXT, acp_executable_path TEXT, acp_args TEXT NOT NULL DEFAULT '[]', acp_env TEXT NOT NULL DEFAULT '{}', acp_api_provider_id TEXT, acp_mcp_server_ids TEXT NOT NULL DEFAULT '[]', acp_permission_mode TEXT NOT NULL DEFAULT 'default', acp_available_modes TEXT NOT NULL DEFAULT '[]', acp_last_mode_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'default', model TEXT, reasoning_effort TEXT, fast_mode INTEGER NOT NULL DEFAULT 0, active_leaf_id TEXT, workspace_path TEXT, enabled_mcp_ids TEXT, skill_ids TEXT, is_pinned INTEGER NOT NULL DEFAULT 0, archived_at INTEGER, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, parent_id TEXT, slot_id TEXT NOT NULL, role TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, thread_id TEXT, file_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL, rel_path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, transport TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE skills_state (id TEXT PRIMARY KEY, path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
      CREATE TABLE usage_records (id TEXT PRIMARY KEY, thread_id TEXT, message_id TEXT, category TEXT NOT NULL DEFAULT 'chat', purpose TEXT NOT NULL DEFAULT 'reply', provider_id TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cached_input_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cron_jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, cron_expr TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', thread_id TEXT, prompt TEXT NOT NULL, model TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, next_run_at INTEGER, last_status TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE cron_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE, thread_id TEXT, message_id TEXT, trigger_type TEXT NOT NULL DEFAULT 'schedule', status TEXT NOT NULL, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);
      INSERT INTO schema_migrations (id, applied_at) VALUES ('001_initial_schema', 1000), ('002_acp_permission_mode', 1000), ('003_cron_jobs', 1000);
      INSERT INTO threads (id, title, title_source, created_at, updated_at) VALUES ('th_legacy', '历史排障会话', 'manual', 1000, 1000);
      INSERT INTO messages (id, thread_id, parent_id, slot_id, role, message, created_at)
      VALUES ('msg_legacy_1', 'th_legacy', NULL, 'slot_1', 'assistant', '{"id":"msg_legacy_1","role":"assistant","parts":[{"type":"text","text":"修复了港股网关超时问题"}]}', 1001);
    `)
    v3.close()

    const daemon = await startLocalDaemon({ port: 0, authToken: 'b3-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = { Authorization: 'Bearer b3-token' }

      // Migration 004 should have backfilled legacy message into messages_fts
      const resLegacy = await app.request('/api/search?q=' + encodeURIComponent('网关超时'), {
        headers
      })
      expect(resLegacy.status).toBe(200)
      const legacyJson = await resLegacy.json()
      expect(legacyJson.messages).toHaveLength(1)
      expect(legacyJson.messages[0].messageId).toBe('msg_legacy_1')
      expect(legacyJson.messages[0].threadId).toBe('th_legacy')

      // Insert + update new messages -> searchable by title and content (both >=3 chars FTS and <3 chars LIKE fallback)
      const th2 = daemon.ctx.db.createThread({ title: '部署架构讨论' })
      const mNew = daemon.ctx.db.insertMessage({
        threadId: th2.id,
        parentId: null,
        role: 'user',
        message: { id: 'm_new', role: 'user', parts: [{ type: 'text', text: '初步草稿' }] }
      })
      daemon.ctx.db.updateMessageContent(mNew.id, {
        id: mNew.id,
        role: 'user',
        parts: [{ type: 'text', text: '请帮我配置 sub2api 中转与蓝莓密钥轮换' }]
      })

      const resFts = await app.request('/api/search?q=' + encodeURIComponent('密钥轮换'), {
        headers
      })
      const ftsJson = await resFts.json()
      expect(ftsJson.messages.some((m: any) => m.messageId === mNew.id)).toBe(true)

      const resShort = await app.request('/api/search?q=' + encodeURIComponent('部署'), {
        headers
      })
      const shortJson = await resShort.json()
      expect(shortJson.threads.some((t: any) => t.id === th2.id)).toBe(true)

      const resShortMsg = await app.request('/api/search?q=' + encodeURIComponent('蓝莓'), {
        headers
      })
      const shortMsgJson = await resShortMsg.json()
      expect(shortMsgJson.messages.some((m: any) => m.messageId === mNew.id)).toBe(true)

      // Deleting thread cleans up messages_fts too
      daemon.ctx.db.deleteThread(th2.id)
      const resAfterDel = await app.request('/api/search?q=' + encodeURIComponent('密钥轮换'), {
        headers
      })
      const afterDelJson = await resAfterDel.json()
      expect(afterDelJson.messages.some((m: any) => m.messageId === mNew.id)).toBe(false)
    } finally {
      await daemon.shutdown()
    }
  })
})

describe('Round 2 Gap Closure — B8: ACP Mode Switching', () => {
  it('B8: switches active ACP thread mode via POST /api/threads/:id/acp-mode (session/set_mode) and syncs metadata', async () => {
    const dir = makeTempDir('cjh-b8-mode-')
    process.env.CJH_DATA_DIR = dir
    const { scriptPath, rpcLogPath } = writeResumeMockAcpAgent(dir)
    const daemon = await startLocalDaemon({ port: 0, authToken: 'b8-token' })

    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer b8-token'
      }

      daemon.ctx.db.upsertProvider({
        id: 'acp-b8',
        name: 'ACP B8',
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-b8:opus', workspacePath: dir })

      // 1. Pre-switch before session spawn (stores desired mode and applies on first turn)
      const preRes = await app.request(`/api/threads/${thread.id}/acp-mode`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ modeId: 'default' })
      })
      expect(preRes.status).toBe(200)

      // 2. Run Turn 1 -> initializes in default mode
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ASK_SECRET' }] },
        source: 'test'
      })
      let msgs = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(msgs[1].message.parts[0]).toEqual({ type: 'text', text: '回忆:NONE:MODE=default' })

      // 3. Switch live session mode to bypassPermissions via /api/threads/:id/acp-mode
      const liveRes = await app.request(`/api/threads/${thread.id}/acp-mode`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ modeId: 'bypassPermissions' })
      })
      expect(liveRes.status).toBe(200)
      const liveJson = await liveRes.json()
      expect(liveJson.appliedLive).toBe(true)
      expect(liveJson.currentModeId).toBe('bypassPermissions')

      // Turn 2 uses the switched live mode
      await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'ASK_SECRET' }] },
        source: 'test'
      })
      msgs = daemon.ctx.db.getActiveBranchMessages(thread.id)
      expect(msgs[3].message.parts[0]).toEqual({
        type: 'text',
        text: '回忆:NONE:MODE=bypassPermissions'
      })

      const calls = readFileSync(rpcLogPath, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l))
      expect(
        calls.some(c => c.method === 'session/set_mode' && c.params?.modeId === 'bypassPermissions')
      ).toBe(true)
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)
})

describe('Round 2 Gap Closure — A7, A8, A10', () => {
  it('A7: imports exported JSON data in merge and replace modes via POST /api/data/import', async () => {
    const dir = makeTempDir('cjh-a7-import-')
    process.env.CJH_DATA_DIR = dir
    const daemon = await startLocalDaemon({ port: 0, authToken: 'a7-token' })

    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer a7-token'
      }

      const existing = daemon.ctx.db.createThread({ title: '现有线程' })
      daemon.ctx.db.insertMessage({
        threadId: existing.id,
        parentId: null,
        role: 'user',
        message: { id: 'm_exist', role: 'user', parts: [{ type: 'text', text: '旧消息' }] }
      })

      const backupPayload = {
        app: 'cjh',
        settings: {
          general: {
            theme: 'light',
            language: 'zh-CN',
            autoLaunch: true,
            globalShortcutEnabled: true,
            globalShortcut: 'Alt+Space'
          },
          chat: { defaultModel: '', sendWithEnter: true },
          toolModel: { model: '', autoTitle: true },
          acp: { permissionTimeoutSec: 60 },
          update: { feedUrl: '', autoCheck: false }
        },
        providers: [
          {
            id: 'imported-prov',
            name: 'Imported Relay',
            type: 'openai-compatible',
            apiFormat: 'openai-responses',
            models: [{ id: 'gpt-5', name: 'GPT-5', enabled: true, capabilities: {} }],
            enabled: true
          }
        ],
        threads: [
          {
            id: 'imp_thread_1',
            title: '导入的会话',
            titleSource: 'manual',
            model: 'imported-prov:gpt-5',
            isPinned: false,
            metadata: {},
            createdAt: 2000,
            updatedAt: 2000
          }
        ],
        messages: [
          {
            id: 'imp_msg_1',
            thread_id: 'imp_thread_1',
            parent_id: null,
            slot_id: 's1',
            role: 'user',
            message: JSON.stringify({
              id: 'imp_msg_1',
              role: 'user',
              parts: [{ type: 'text', text: '导入消息可全文搜索' }]
            }),
            metadata: '{}',
            created_at: 2001
          }
        ],
        mcpServers: [],
        cronJobs: []
      }

      // 1. Merge mode keeps existing thread and adds imported thread + FTS entry
      const mergeRes = await app.request('/api/data/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'merge', data: backupPayload })
      })
      expect(mergeRes.status).toBe(200)
      const mergeJson = await mergeRes.json()
      expect(mergeJson.imported.threads).toBe(1)
      expect(mergeJson.imported.messages).toBe(1)
      expect(daemon.ctx.db.getThread(existing.id)).not.toBeNull()
      expect(daemon.ctx.db.getThread('imp_thread_1')).not.toBeNull()
      expect(daemon.ctx.db.search('全文搜索').messages).toHaveLength(1)

      // 2. Replace mode wipes existing and keeps only backup
      const replaceRes = await app.request('/api/data/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'replace', data: backupPayload })
      })
      expect(replaceRes.status).toBe(200)
      expect(daemon.ctx.db.getThread(existing.id)).toBeNull()
      expect(daemon.ctx.db.getThread('imp_thread_1')).not.toBeNull()
      expect(daemon.ctx.db.getSettings().general.autoLaunch).toBe(true)
    } finally {
      await daemon.shutdown()
    }
  })

  it('A8 & A10: executes full check -> download -> sha256 verify -> /api/update/install flow and preserves partial desktop settings', async () => {
    const dir = makeTempDir('cjh-a8-a10-')
    process.env.CJH_DATA_DIR = dir

    // Spin up a local HTTP update server serving latest.json + dummy zip + sha256
    const { createServer } = await import('node:http')
    const { createHash } = await import('node:crypto')
    const { execFileSync } = await import('node:child_process')

    const srcPkgDir = join(dir, 'pkg-src')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(srcPkgDir, { recursive: true })
    writeFileSync(join(srcPkgDir, 'cjh.exe'), 'dummy-exe-v0.2.0', 'utf8')
    const zipPath = join(dir, 'cjh-0.2.0.zip')
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Compress-Archive -Path '${join(srcPkgDir, '*').replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`
      ])
    } else {
      writeFileSync(zipPath, 'dummy-zip', 'utf8')
    }
    const zipBytes = readFileSync(zipPath)
    const expectedSha = createHash('sha256').update(zipBytes).digest('hex')

    let updatePort = 0
    const srv = createServer((req, res) => {
      if (req.url === '/latest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            version: '0.2.0',
            url: `http://127.0.0.1:${updatePort}/cjh-0.2.0.zip`,
            sha256: expectedSha,
            notes: 'v0.2.0 release'
          })
        )
        return
      }
      if (req.url === '/cjh-0.2.0.zip') {
        res.writeHead(200, { 'Content-Type': 'application/zip' })
        res.end(zipBytes)
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', () => resolve()))
    updatePort = (srv.address() as any).port

    let installTriggered = false
    const daemon = await startLocalDaemon({
      port: 0,
      authToken: 'a8-token',
      onRequestUpdateInstall: () => {
        installTriggered = true
        return true
      }
    })

    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer a8-token'
      }

      // 1. A10: Setting autoLaunch & globalShortcut via PUT /api/settings, then toggling theme must NOT clobber them!
      const s1 = await app.request('/api/settings', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          general: { autoLaunch: true, globalShortcutEnabled: true, globalShortcut: 'Alt+Space' }
        })
      })
      expect(s1.status).toBe(200)
      const s2 = await app.request('/api/settings', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ general: { theme: 'light' } })
      })
      expect(s2.status).toBe(200)
      const s2Json = await s2.json()
      expect(s2Json.general.theme).toBe('light')
      expect(s2Json.general.autoLaunch).toBe(true)
      expect(s2Json.general.globalShortcut).toBe('Alt+Space')

      // 2. A8: Install before ready returns 400
      const earlyInstall = await app.request('/api/update/install', {
        method: 'POST',
        headers,
        body: '{}'
      })
      expect(earlyInstall.status).toBe(400)

      // Check -> Download + SHA-256 verify -> Install
      const chkRes = await app.request('/api/update/check', {
        method: 'POST',
        headers,
        body: JSON.stringify({ feedUrl: `http://127.0.0.1:${updatePort}` })
      })
      expect(chkRes.status).toBe(200)
      expect((await chkRes.json()).state).toBe('available')

      const dlRes = await app.request('/api/update/download', { method: 'POST', headers })
      expect(dlRes.status).toBe(200)
      const dlJson = await dlRes.json()
      expect(dlJson.state).toBe('ready')
      expect(dlJson.sha256Verified).toBe(true)
      expect(dlJson.actualSha256).toBe(expectedSha)

      const instRes = await app.request('/api/update/install', {
        method: 'POST',
        headers,
        body: '{}'
      })
      expect(instRes.status).toBe(200)
      const instJson = await instRes.json()
      expect(instJson.ok).toBe(true)
      expect(instJson.triggered).toBe(true)
      expect(instJson.status.state).toBe('installing')
      expect(installTriggered).toBe(true)
    } finally {
      await daemon.shutdown()
      srv.close()
    }
  }, 20_000)
})

describe('Round 2 Gap Closure — B4–B7', () => {
  it('B4: compacts older messages into a system summary message via POST /api/threads/:id/compact', async () => {
    const dir = makeTempDir('cjh-b4-compact-')
    process.env.CJH_DATA_DIR = dir
    const daemon = await startLocalDaemon({ port: 0, authToken: 'b4-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer b4-token'
      }

      const th = daemon.ctx.db.createThread({ title: '长对话' })
      const u1 = daemon.ctx.db.insertMessage({
        threadId: th.id,
        parentId: null,
        role: 'user',
        message: { id: 'u1', role: 'user', parts: [{ type: 'text', text: '设计一个网关服务' }] }
      })
      const a1 = daemon.ctx.db.insertMessage({
        threadId: th.id,
        parentId: u1.id,
        role: 'assistant',
        message: { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '建议采用三层限流架构' }] }
      })
      daemon.ctx.db.insertMessage({
        threadId: th.id,
        parentId: a1.id,
        role: 'user',
        message: { id: 'u2', role: 'user', parts: [{ type: 'text', text: '补充 Redis 方案' }] }
      })

      daemon.ctx.db.updateThreadMetadata(th.id, {
        contextUsage: { used: 180_000, size: 200_000 }
      })

      const res = await app.request(`/api/threads/${th.id}/compact`, {
        method: 'POST',
        headers
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.compacted).toBe(true)
      expect(json.summaryMessage.role).toBe('system')
      expect(json.summaryMessage.metadata.isCompactionSummary).toBe(true)
      expect(json.summaryMessage.metadata.compactedCount).toBe(3)
      expect(json.messages[json.messages.length - 1].role).toBe('system')

      // Context usage lowered below 80%
      const refreshed = daemon.ctx.db.getThread(th.id)!
      const ctxUsage = refreshed.metadata.contextUsage as { used: number; size: number }
      expect(ctxUsage.used).toBeLessThan(160_000)
    } finally {
      await daemon.shutdown()
    }
  })

  it('B5 & B6: supports prompts CRUD and thread branching with parent_thread_id', async () => {
    const dir = makeTempDir('cjh-b5-b6-')
    process.env.CJH_DATA_DIR = dir
    const daemon = await startLocalDaemon({ port: 0, authToken: 'b5-b6-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer b5-b6-token'
      }

      // B5 Prompts CRUD
      const pCreate = await app.request('/api/prompts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: '代码审查模板',
          shortcut: '/cr',
          category: '研发',
          content: '请检查安全漏洞、边界条件与性能瓶颈。'
        })
      })
      expect(pCreate.status).toBe(201)
      const prompt = await pCreate.json()
      expect(prompt.shortcut).toBe('cr')

      const pList = await (await app.request('/api/prompts', { headers })).json()
      expect(pList).toHaveLength(1)

      const pUpd = await app.request(`/api/prompts/${prompt.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ title: '安全审查模板', shortcut: 'sec', content: '检查鉴权。' })
      })
      expect(pUpd.status).toBe(200)
      expect((await pUpd.json()).title).toBe('安全审查模板')

      // B6 Branch thread from specific message
      const parent = daemon.ctx.db.createThread({ title: '主线思路' })
      const m1 = daemon.ctx.db.insertMessage({
        threadId: parent.id,
        parentId: null,
        role: 'user',
        message: { id: 'bm1', role: 'user', parts: [{ type: 'text', text: '第一步' }] }
      })
      const m2 = daemon.ctx.db.insertMessage({
        threadId: parent.id,
        parentId: m1.id,
        role: 'assistant',
        message: { id: 'bm2', role: 'assistant', parts: [{ type: 'text', text: '方案A' }] }
      })
      daemon.ctx.db.insertMessage({
        threadId: parent.id,
        parentId: m2.id,
        role: 'user',
        message: { id: 'bm3', role: 'user', parts: [{ type: 'text', text: '继续方案A' }] }
      })

      const brRes = await app.request(`/api/threads/${parent.id}/branch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messageId: m2.id })
      })
      expect(brRes.status).toBe(201)
      const brJson = await brRes.json()
      expect(brJson.thread.parentThreadId).toBe(parent.id)
      expect(brJson.thread.branchFromMessageId).toBe(m2.id)
      expect(brJson.thread.title).toContain('分支')
      expect(brJson.messages).toHaveLength(2)
      expect(brJson.messages.map((m: any) => m.message.parts[0].text)).toEqual(['第一步', '方案A'])

      const pDel = await app.request(`/api/prompts/${prompt.id}`, { method: 'DELETE', headers })
      expect(pDel.status).toBe(200)
      expect((await (await app.request('/api/prompts', { headers })).json())).toHaveLength(0)
    } finally {
      await daemon.shutdown()
    }
  })

  it('B7: serves readonly workspace file tree, file preview (with traversal protection), and git status/diff', async () => {
    const dir = makeTempDir('cjh-b7-ws-')
    process.env.CJH_DATA_DIR = dir
    const wsDir = makeTempDir('cjh-b7-repo-')
    const { execFileSync } = await import('node:child_process')

    writeFileSync(join(wsDir, 'README.md'), '# Demo\ninitial\n', 'utf8')
    execFileSync('git', ['init'], { cwd: wsDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: wsDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wsDir })
    execFileSync('git', ['add', '.'], { cwd: wsDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: wsDir })
    // Modify README and add untracked file
    writeFileSync(join(wsDir, 'README.md'), '# Demo\nmodified line\n', 'utf8')
    writeFileSync(join(wsDir, 'notes.txt'), 'untracked note', 'utf8')

    const daemon = await startLocalDaemon({ port: 0, authToken: 'b7-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = { Authorization: 'Bearer b7-token' }

      const thread = daemon.ctx.db.createThread({ workspacePath: wsDir })

      const treeRes = await app.request(`/api/threads/${thread.id}/workspace/tree`, { headers })
      expect(treeRes.status).toBe(200)
      const treeJson = await treeRes.json()
      expect(treeJson.entries.some((e: any) => e.name === 'README.md')).toBe(true)
      expect(treeJson.entries.some((e: any) => e.name === 'notes.txt')).toBe(true)

      const fileRes = await app.request(
        `/api/threads/${thread.id}/workspace/file?path=README.md`,
        { headers }
      )
      expect(fileRes.status).toBe(200)
      expect((await fileRes.json()).content).toContain('modified line')

      // Traversal attempt must be rejected with 403
      const travRes = await app.request(
        `/api/threads/${thread.id}/workspace/file?path=../../secret.txt`,
        { headers }
      )
      expect(travRes.status).toBe(403)

      const gitRes = await app.request(`/api/threads/${thread.id}/workspace/git`, { headers })
      expect(gitRes.status).toBe(200)
      const gitJson = await gitRes.json()
      expect(gitJson.isGitRepo).toBe(true)
      expect(gitJson.files.some((f: any) => f.path === 'README.md' && f.status === 'M')).toBe(true)
      expect(gitJson.files.some((f: any) => f.path === 'notes.txt' && f.status === '??')).toBe(true)
      expect(gitJson.diff).toContain('+modified line')
    } finally {
      await daemon.shutdown()
    }
  })
})

describe('Round 2 Gap Closure — B9: Execution Traces', () => {
  it('B9: persists per-turn traces (model, duration, tokens, toolCallCount, error) and serves GET /api/messages/:id/trace', async () => {
    const dir = makeTempDir('cjh-b9-trace-')
    process.env.CJH_DATA_DIR = dir
    const scriptPath = join(dir, 'trace-acp.mjs')
    writeFileSync(
      scriptPath,
      `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id === undefined || !msg.method) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
  } else if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess_trace_1' } });
  } else if (msg.method === 'session/set_config_option' || msg.method === 'session/set_model') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_trace_1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'tc_tr_1', title: 'Read package.json', kind: 'read', status: 'in_progress' }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_trace_1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_tr_1', status: 'completed', rawOutput: 'ok' }
      }
    });
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess_trace_1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'trace-ok' } }
      }
    });
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } }
    });
  }
});
`,
      'utf8'
    )

    const daemon = await startLocalDaemon({ port: 0, authToken: 'b9-token' })
    try {
      const { createHttpApp } = await import('../app')
      const app = createHttpApp(daemon.ctx)
      const headers = { Authorization: 'Bearer b9-token' }

      daemon.ctx.db.upsertProvider({
        id: 'acp-b9',
        name: 'ACP B9',
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

      const thread = daemon.ctx.db.createThread({ model: 'acp-b9:opus', workspacePath: dir })
      const turnRes = await daemon.ctx.engine.startTurn({
        threadId: thread.id,
        userMessage: { role: 'user', parts: [{ type: 'text', text: 'run trace test' }] },
        source: 'cron'
      })
      expect(turnRes.ok).toBe(true)
      expect(turnRes.messageId).toBeTruthy()

      const traceRes = await app.request(`/api/messages/${turnRes.messageId}/trace`, { headers })
      expect(traceRes.status).toBe(200)
      const trace = await traceRes.json()
      expect(trace.model).toBe('acp-b9:opus')
      expect(trace.source).toBe('cron')
      expect(trace.status).toBe('success')
      expect(trace.inputTokens).toBe(80)
      expect(trace.outputTokens).toBe(20)
      expect(trace.totalTokens).toBe(100)
      expect(trace.toolCallCount).toBe(1)
      expect(trace.toolCalls[0].title).toBe('Read package.json')
      expect(trace.durationMs).toBeGreaterThanOrEqual(0)
      expect(trace.error).toBeNull()

      const listRes = await app.request(`/api/threads/${thread.id}/traces`, { headers })
      expect(listRes.status).toBe(200)
      expect(await listRes.json()).toHaveLength(1)
    } finally {
      await daemon.shutdown()
    }
  }, 20_000)
})
