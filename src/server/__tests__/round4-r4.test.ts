import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../cli/index'
import { startLocalDaemon } from '../entry'
import { buildBuiltinToolSet } from '../tools/builtin'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r4-'): string {
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

describe('Round 4 R4 — Markdown Memory Store, FTS5 Search, Auto-Inject & CLI', () => {
  it('persists Markdown files with frontmatter, supports memory_save/memory_search, CLI add/search, and FTS auto-injection', async () => {
    const dataDir = makeTempDir('cjh-r4-data-')
    process.env.CJH_DATA_DIR = dataDir
    let daemon = await startLocalDaemon({ port: 0, masterKeyHex: '44'.repeat(32) })

    const capturedSystemPrompts: string[] = []
    const llmSrv = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body)
      const sysMsg = (parsed.messages || []).find((m: any) => m.role === 'system')
      if (sysMsg) capturedSystemPrompts.push(String(sysMsg.content || ''))
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mem',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '收到记忆注入' }, finish_reason: null }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-mem',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
    await new Promise<void>(resolve => llmSrv.listen(0, '127.0.0.1', resolve))
    const llmPort = (llmSrv.address() as any).port

    try {
      const thread = daemon.ctx.db.createThread({ title: '记忆测试线程' })
      const tools = buildBuiltinToolSet({
        db: daemon.ctx.db,
        wsHub: daemon.ctx.wsHub,
        permissionGate: daemon.ctx.permissionGate,
        skillsScanner: daemon.ctx.skillsScanner,
        memoryStore: daemon.ctx.memoryStore,
        thread,
        providerId: 'sub2api'
      })

      // 1. memory_save creates markdown file with frontmatter
      const saved = await (tools.memory_save as any).execute(
        {
          title: 'TypeScript 编码偏好',
          content: '项目统一使用 TypeScript 严格模式与 pnpm/npm 测试流程，避免使用 any。',
          tags: ['偏好', 'TypeScript']
        },
        { toolCallId: 'm1', messages: [] }
      )
      expect(saved.id).toMatch(/^mem_/)
      expect(existsSync(saved.filePath)).toBe(true)
      const mdRaw = readFileSync(saved.filePath, 'utf8')
      expect(mdRaw).toContain(`id: ${saved.id}`)
      expect(mdRaw).toContain(`sourceThreadId: "${thread.id}"`)
      expect(mdRaw).toContain('TypeScript 编码偏好')

      // 2. memory_search finds it via FTS5
      const searchHits = await (tools.memory_search as any).execute(
        { query: 'TypeScript', limit: 5 },
        { toolCallId: 'm2', messages: [] }
      )
      expect(searchHits.length).toBeGreaterThanOrEqual(1)
      expect(searchHits[0].id).toBe(saved.id)

      // 3. CLI memory add & memory search
      const cliLogs: string[] = []
      await runCli(
        [
          'memory',
          'add',
          '--title',
          '部署环境约定',
          '--content',
          '生产服务运行在 Windows 便携目录 data/ 下，使用 WAL 模式。',
          '--tags',
          '运维,SQLite'
        ],
        { log: m => cliLogs.push(m), error: () => {} }
      )
      const cliCreated = JSON.parse(cliLogs.join('\n'))
      expect(cliCreated.title).toBe('部署环境约定')

      const cliSearchLogs: string[] = []
      await runCli(['memory', 'search', '便携目录'], {
        log: m => cliSearchLogs.push(m),
        error: () => {}
      })
      const cliHits = JSON.parse(cliSearchLogs.join('\n'))
      expect(cliHits.some((h: any) => h.id === cliCreated.id)).toBe(true)

      // 4. Auto-inject top 5 FTS matches into systemPrompt before turn
      daemon.ctx.db.upsertProvider({
        id: 'mock-mem',
        name: 'Mock Mem',
        type: 'openai-compatible',
        apiFormat: 'openai-chat',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: 'sk-mem',
        customHeaders: {},
        models: [
          {
            id: 'gpt-mem',
            name: 'GPT Mem',
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
        title: '自动召回验证',
        model: 'mock-mem:gpt-mem'
      })
      await daemon.ctx.engine.startTurn({
        threadId: chatThread.id,
        userMessage: {
          role: 'user',
          parts: [{ type: 'text', text: '请按我的 TypeScript 编码偏好写个函数' }]
        },
        source: 'gui'
      })
      expect(capturedSystemPrompts.length).toBe(1)
      expect(capturedSystemPrompts[0]).toContain('<recalled_memories>')
      expect(capturedSystemPrompts[0]).toContain('TypeScript 编码偏好')

      // 5. Disable memoryAutoInject -> no injection
      daemon.ctx.db.updateSettings({ tools: { memoryAutoInject: false } })
      await daemon.ctx.engine.startTurn({
        threadId: chatThread.id,
        userMessage: {
          role: 'user',
          parts: [{ type: 'text', text: '再来一段 TypeScript 代码' }]
        },
        source: 'gui'
      })
      expect(capturedSystemPrompts.length).toBe(2)
      expect(capturedSystemPrompts[1]).not.toContain('<recalled_memories>')

      // 6. Manual markdown file placed on disk is indexed after restart (syncFromDisk)
      const manualPath = join(dataDir, 'memory', 'mem_manual_disk.md')
      writeFileSync(
        manualPath,
        '---\nid: mem_manual_disk\ntitle: "磁盘手写记忆"\ntags: ["手写"]\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\nsourceThreadId: null\n---\n\n这是一条直接写入磁盘的记忆。\n',
        'utf8'
      )
      await daemon.shutdown()
      daemon = await startLocalDaemon({ port: 0, masterKeyHex: '44'.repeat(32) })
      const syncedHits = daemon.ctx.memoryStore.search('直接写入磁盘', 5)
      expect(syncedHits.some(h => h.id === 'mem_manual_disk')).toBe(true)

      // 7. REST update & delete removes markdown file
      const authHeaders = {
        Authorization: `Bearer ${daemon.authToken}`,
        'Content-Type': 'application/json'
      }
      const updRes = await fetch(`http://127.0.0.1:${daemon.port}/api/memories/${saved.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ title: 'TypeScript 新规范', content: '已更新记忆内容' })
      })
      expect(updRes.status).toBe(200)
      expect(readFileSync(saved.filePath, 'utf8')).toContain('已更新记忆内容')

      const delRes = await fetch(`http://127.0.0.1:${daemon.port}/api/memories/${saved.id}`, {
        method: 'DELETE',
        headers: authHeaders
      })
      expect(delRes.status).toBe(200)
      expect(existsSync(saved.filePath)).toBe(false)
    } finally {
      llmSrv.close()
      await daemon.shutdown()
    }
  })
})
