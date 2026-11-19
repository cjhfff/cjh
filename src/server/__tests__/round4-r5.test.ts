import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from '../../cli/index'
import { startLocalDaemon } from '../entry'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r5-'): string {
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

describe('Round 4 R5 — CLI Completion', () => {
  it('supports cron list/add/rm/run, search, usage, config, and thread send (waiting for reply)', async () => {
    const dataDir = makeTempDir('cjh-r5-data-')
    process.env.CJH_DATA_DIR = dataDir
    const daemon = await startLocalDaemon({ port: 0, masterKeyHex: '55'.repeat(32) })

    // Mock OpenAI-compatible SSE server for thread send & cron run
    const llmSrv = createServer(async (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-cli',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'CLI同步回复内容OK' }, finish_reason: null }]
        })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({
          id: 'chatcmpl-cli',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
        })}\n\n`
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
    await new Promise<void>(resolve => llmSrv.listen(0, '127.0.0.1', resolve))
    const llmPort = (llmSrv.address() as any).port

    const capture = () => {
      const logs: string[] = []
      const errors: string[] = []
      return {
        logs,
        errors,
        io: {
          log: (m: string) => logs.push(m),
          error: (m: string) => errors.push(m)
        }
      }
    }

    try {
      daemon.ctx.db.upsertProvider({
        id: 'mock-cli',
        name: 'Mock CLI',
        type: 'openai-compatible',
        apiFormat: 'openai-chat',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: 'sk-cli',
        customHeaders: {},
        models: [
          {
            id: 'gpt-cli',
            name: 'GPT CLI',
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

      // 1. thread new + thread send (waits for generation & prints reply)
      const c1 = capture()
      await runCli(['thread', 'new', 'CLI测试线程'], c1.io)
      const threadId = c1.logs[0].trim()
      expect(threadId.length).toBeGreaterThan(0)

      const c2 = capture()
      await runCli(['thread', 'send', threadId, '请回复OK', '-m', 'mock-cli:gpt-cli'], c2.io)
      expect(c2.logs.join('\n')).toContain('CLI同步回复内容OK')

      // 2. search <q>
      const c3 = capture()
      await runCli(['search', 'CLI同步回复'], c3.io)
      const searchResult = JSON.parse(c3.logs.join('\n'))
      expect(searchResult.messages.length).toBeGreaterThanOrEqual(1)

      // 3. cron add / list / run / rm
      const c4 = capture()
      await runCli(
        [
          'cron',
          'add',
          '--name',
          'CLI定时测试',
          '--expr',
          '30 7 * * *',
          '--prompt',
          '执行日报',
          '--thread',
          threadId,
          '--model',
          'mock-cli:gpt-cli'
        ],
        c4.io
      )
      const createdJob = JSON.parse(c4.logs.join('\n'))
      expect(createdJob.name).toBe('CLI定时测试')

      const c5 = capture()
      await runCli(['cron', 'list'], c5.io)
      expect(c5.logs.join('\n')).toContain(createdJob.id)

      const c6 = capture()
      await runCli(['cron', 'run', createdJob.id], c6.io)
      const runOut = JSON.parse(c6.logs.join('\n'))
      expect(runOut.status).toBe('success')

      const c7 = capture()
      await runCli(['cron', 'rm', createdJob.id], c7.io)
      expect(JSON.parse(c7.logs.join('\n')).ok).toBe(true)

      // 4. usage & config set
      const c8 = capture()
      await runCli(['usage', '--days', '7'], c8.io)
      expect(JSON.parse(c8.logs.join('\n')).byCategory).toBeDefined()

      const c9 = capture()
      await runCli(['config', 'set', 'tools.maxSteps', '18'], c9.io)
      expect(JSON.parse(c9.logs.join('\n')).tools.maxSteps).toBe(18)

      // 5. P1-3: `cjh send -t <id> --wait "<内容>"` does not swallow positional message after boolean --wait
      const c10 = capture()
      await runCli(
        ['send', '-t', threadId, '-m', 'mock-cli:gpt-cli', '--wait', '布尔标志后紧跟位置参数'],
        c10.io
      )
      expect(c10.logs.join('\n')).toContain('CLI同步回复内容OK')

      // 6. P1-3: Values starting with '-' (Markdown list) are preserved instead of becoming "true"
      const c11 = capture()
      await runCli(
        [
          'memory',
          'add',
          '--title',
          '列表规范',
          '--content',
          '- 第一条规范\n- 第二条规范'
        ],
        c11.io
      )
      const createdMem = JSON.parse(c11.logs.join('\n'))
      expect(createdMem.content).toBe('- 第一条规范\n- 第二条规范')

      const c12 = capture()
      await runCli(
        [
          'cron',
          'add',
          '--name',
          '列表提示词任务',
          '--expr',
          '30 7 * * *',
          '--prompt',
          '- 汇总昨日指标\n- 检查异常'
        ],
        c12.io
      )
      const dashCron = JSON.parse(c12.logs.join('\n'))
      expect(dashCron.prompt).toBe('- 汇总昨日指标\n- 检查异常')
    } finally {
      llmSrv.close()
      await daemon.shutdown()
    }
  })
})
