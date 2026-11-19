import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FeishuSdkFactory } from '../channels/feishu'
import { startLocalDaemon } from '../entry'

const tempDirs: string[] = []

function makeTempDir(prefix = 'cjh-r3-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function createMockFeishuSdk() {
  const sentMessages: Array<{ receive_id: string; msg_type: string; content: string; id: string }> = []
  const patchedMessages: Array<{ message_id: string; content: string }> = []
  let handlers: Record<string, (data: any) => Promise<any> | any> = {}
  let wsConnected = false
  let msgSeq = 1

  const factory: FeishuSdkFactory = {
    createClient: () => ({
      request: async () => ({ bot: { open_id: 'ou_bot_123' } }),
      im: {
        v1: {
          message: {
            create: async (payload: any) => {
              const id = `om_mock_${msgSeq++}`
              sentMessages.push({
                receive_id: payload.data.receive_id,
                msg_type: payload.data.msg_type,
                content: payload.data.content,
                id
              })
              return { data: { message_id: id } }
            },
            patch: async (payload: any) => {
              patchedMessages.push({
                message_id: payload.path.message_id,
                content: payload.data.content
              })
              return { code: 0 }
            }
          }
        }
      }
    }),
    createWsClient: () => ({
      start: async () => {
        wsConnected = true
      },
      close: () => {
        wsConnected = false
      }
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
    patchedMessages,
    isWsConnected: () => wsConnected,
    getHandlers: () => handlers
  }
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

describe('Round 4 R3 — Feishu Bridge, Card Permissions & Cron Delivery', () => {
  it('maps Feishu p2p/group messages to threads, supports commands, approves permissions via card callback, and delivers cron output', async () => {
    const dataDir = makeTempDir('cjh-r3-data-')
    const workspaceDir = makeTempDir('cjh-r3-ws-')
    process.env.CJH_DATA_DIR = dataDir

    const mockSdk = createMockFeishuSdk()
    const daemon = await startLocalDaemon({
      port: 0,
      masterKeyHex: '66'.repeat(32),
      feishuSdkFactory: mockSdk.factory
    })

    // Mock OpenAI-compatible SSE server that calls fs_write on prompt containing "写文件"
    let llmCallCount = 0
    const llmSrv = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body)
      const msgs: any[] = parsed.messages || []
      const hasToolResult = msgs.some(m => m.role === 'tool')
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      const userText = String(
        Array.isArray(lastUser?.content)
          ? lastUser.content.map((p: any) => p.text || '').join('')
          : lastUser?.content || ''
      )
      llmCallCount++

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })

      if (userText.includes('写文件') && !hasToolResult) {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${llmCallCount}`,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_feishu_write_1',
                      type: 'function',
                      function: {
                        name: 'fs_write',
                        arguments: JSON.stringify({ path: 'feishu-out.txt', content: 'from feishu card ok' })
                      }
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
            id: `chatcmpl-${llmCallCount}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          })}\n\n`
        )
      } else {
        const reply = hasToolResult
          ? '飞书审批通过并已写入 feishu-out.txt'
          : userText.includes('日报')
            ? '昨日总结：一切运行正常'
            : `飞书回复: ${userText}`
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${llmCallCount}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }]
          })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${llmCallCount}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
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
        id: 'mock-feishu',
        name: 'Mock Feishu',
        type: 'openai-compatible',
        apiFormat: 'openai-chat',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: 'sk-feishu',
        customHeaders: {},
        models: [
          {
            id: 'gpt-feishu',
            name: 'GPT Feishu',
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

      const authHeaders = {
        Authorization: `Bearer ${daemon.authToken}`,
        'Content-Type': 'application/json'
      }

      // 1. Save Feishu config with encrypted secret & set default model
      const putRes = await fetch(`http://127.0.0.1:${daemon.port}/api/settings`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          chat: { defaultModel: 'mock-feishu:gpt-feishu' },
          channels: {
            feishu: {
              enabled: true,
              appId: 'cli_mock_app',
              appSecret: 'sec_mock_secret_1234',
              domain: 'feishu'
            }
          }
        })
      })
      expect(putRes.status).toBe(200)
      const settingsJson = (await putRes.json()) as any
      expect(settingsJson.channels.feishu.hasAppSecret).toBe(true)
      expect(settingsJson.channels.feishu.appSecretPreview).toContain('••••')
      expect(JSON.stringify(settingsJson)).not.toContain('sec_mock_secret_1234')

      // Connect explicitly & verify status
      const connRes = await fetch(`http://127.0.0.1:${daemon.port}/api/channels/feishu/connect`, {
        method: 'POST',
        headers: authHeaders
      })
      expect(connRes.status).toBe(200)
      const statusJson = (await connRes.json()) as any
      expect(statusJson.status).toBe('connected')
      expect(statusJson.botOpenId).toBe('ou_bot_123')
      expect(mockSdk.isWsConnected()).toBe(true)

      // 2. Group message WITHOUT @bot mention is ignored
      const handlers = mockSdk.getHandlers()
      await handlers['im.message.receive_v1']({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_grp_ignored',
          chat_id: 'oc_grp_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '大家好' }),
          mentions: []
        }
      })
      expect(daemon.ctx.db.listChannelMappings('feishu')).toHaveLength(0)

      // 3. Group message WITH @bot mention creates mapping and responds via generate_response(source=feishu)
      const p2pResult = await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_1' }, sender_type: 'user' },
        message: {
          message_id: 'msg_grp_1',
          chat_id: 'oc_grp_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 你好飞书' }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_123' } }]
        }
      })
      expect(p2pResult.handled).toBe(true)
      expect(p2pResult.threadId).toBeTruthy()
      const grpThreadId = p2pResult.threadId!

      // Wait for generation_completed patch on thinking message
      await viWaitFor(() => mockSdk.patchedMessages.some(p => p.content.includes('飞书回复: 你好飞书')))
      expect(mockSdk.sentMessages[0].content).toContain('思考中…')

      // Check mapping persisted
      const mappings = daemon.ctx.db.listChannelMappings('feishu')
      expect(mappings).toHaveLength(1)
      expect(mappings[0].externalChatId).toBe('oc_grp_1')
      expect(mappings[0].externalUserId).toBe('ou_user_1')
      expect(mappings[0].threadId).toBe(grpThreadId)

      // 4. Feishu commands: /new & /model
      const newCmd = await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_2' }, sender_type: 'user' },
        message: {
          message_id: 'msg_p2p_new',
          chat_id: 'oc_p2p_2',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/new' })
        }
      })
      expect(newCmd.handled).toBe(true)
      expect(newCmd.threadId).toBeTruthy()
      const p2pThreadId = newCmd.threadId!

      // Bind workspace to p2pThreadId so fs_write triggers permission card
      daemon.ctx.db.updateThread(p2pThreadId, { workspacePath: workspaceDir })

      // 5. Permission card flow in Feishu: trigger fs_write -> approve via card.action.trigger
      const prevSentLen = mockSdk.sentMessages.length
      await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_user_2' }, sender_type: 'user' },
        message: {
          message_id: 'msg_p2p_write',
          chat_id: 'oc_p2p_2',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '请帮我写文件' })
        }
      })

      // Wait for permission card to be sent
      await viWaitFor(() =>
        mockSdk.sentMessages.slice(prevSentLen).some(m => m.content.includes('安全审批请求'))
      )
      const permCardMsg = mockSdk.sentMessages
        .slice(prevSentLen)
        .find(m => m.content.includes('安全审批请求'))!
      const permCardObj = JSON.parse(permCardMsg.content)
      const actionElem = permCardObj.elements.find((e: any) => e.tag === 'action')
      const allowOnceBtn = actionElem.actions.find((a: any) => a.value.optionId === 'allow_once')
      expect(allowOnceBtn).toBeDefined()

      // Invoke card callback
      const cardRes = await handlers['card.action.trigger']({
        action: { value: allowOnceBtn.value }
      })
      expect(cardRes.toast.type).toBe('success')

      // Wait for completion & file written
      await viWaitFor(() =>
        mockSdk.patchedMessages.some(p => p.content.includes('飞书审批通过并已写入 feishu-out.txt'))
      )
      expect(readFileSync(join(workspaceDir, 'feishu-out.txt'), 'utf8')).toBe('from feishu card ok')

      // 6. Cron job delivery to Feishu chat
      const cronCreateRes = await fetch(`http://127.0.0.1:${daemon.port}/api/cron`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: '飞书每日日报',
          cronExpr: '30 7 * * *',
          timezone: 'Asia/Shanghai',
          prompt: '请生成今日日报',
          model: 'mock-feishu:gpt-feishu',
          feishuChatId: 'oc_grp_1',
          enabled: true
        })
      })
      expect(cronCreateRes.status).toBe(201)
      const cronJob = (await cronCreateRes.json()) as any
      expect(cronJob.feishuChatId).toBe('oc_grp_1')

      const runRes = await fetch(`http://127.0.0.1:${daemon.port}/api/cron/${cronJob.id}/run`, {
        method: 'POST',
        headers: authHeaders
      })
      expect(runRes.status).toBe(200)
      const runJson = (await runRes.json()) as any
      expect(runJson.status).toBe('success')

      expect(
        mockSdk.sentMessages.some(
          m =>
            m.receive_id === 'oc_grp_1' &&
            m.content.includes('定时任务汇报') &&
            m.content.includes('昨日总结：一切运行正常')
        )
      ).toBe(true)

      // 7. Logs tagged [Bridge:feishu]
      const bridgeLogs = daemon.ctx.logger.getRecent('Bridge:feishu', 50)
      expect(bridgeLogs.length).toBeGreaterThan(0)
    } finally {
      llmSrv.close()
      await daemon.shutdown()
    }
  })

  it('handles card rejection, ACP reject_once / timeout red card (P0-4), /help /model /stop commands (P2-4), steer card queue & fast permission race (P1-4)', async () => {
    const dataDir = makeTempDir('cjh-r3-races-')
    const workspaceDir = makeTempDir('cjh-r3-races-ws-')
    process.env.CJH_DATA_DIR = dataDir

    let createCardDelayMs = 0
    const sentMessages: Array<{ receive_id: string; msg_type: string; content: string; id: string }> = []
    const patchedMessages: Array<{ message_id: string; content: string }> = []
    let handlers: Record<string, (data: any) => Promise<any> | any> = {}
    let msgSeq = 1

    const factory: FeishuSdkFactory = {
      createClient: () => ({
        request: async () => ({ bot: { open_id: 'ou_bot_123' } }),
        im: {
          v1: {
            message: {
              create: async (payload: any) => {
                if (
                  createCardDelayMs > 0 &&
                  String(payload?.data?.content || '').includes('安全审批请求')
                ) {
                  await new Promise(r => setTimeout(r, createCardDelayMs))
                }
                const id = `om_race_${msgSeq++}`
                sentMessages.push({
                  receive_id: payload.data.receive_id,
                  msg_type: payload.data.msg_type,
                  content: payload.data.content,
                  id
                })
                return { data: { message_id: id } }
              },
              patch: async (payload: any) => {
                patchedMessages.push({
                  message_id: payload.path.message_id,
                  content: payload.data.content
                })
                return { code: 0 }
              }
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

    const daemon = await startLocalDaemon({
      port: 0,
      masterKeyHex: '77'.repeat(32),
      feishuSdkFactory: factory
    })

    let llmSeq = 0
    const llmSrv = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const parsed = JSON.parse(body)
      const msgs: any[] = parsed.messages || []
      const hasToolResult = msgs.some(m => m.role === 'tool')
      const lastUser = [...msgs].reverse().find(m => m.role === 'user')
      const userText = String(
        Array.isArray(lastUser?.content)
          ? lastUser.content.map((p: any) => p.text || '').join('')
          : lastUser?.content || ''
      )
      const seq = ++llmSeq

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache'
      })

      if (userText.includes('慢速第一轮')) {
        await new Promise(r => setTimeout(r, 150))
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '第一轮慢速回复完成' }, finish_reason: null }]
          })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`
        )
      } else if (userText.includes('第二轮追问')) {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: '第二轮插队回复完成' }, finish_reason: null }]
          })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`
        )
      } else if (userText.includes('超长挂起用于停止')) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 5000)
          req.on('close', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      } else if (userText.includes('尝试写敏感文件') && !hasToolResult) {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_rej_${seq}`,
                      type: 'function',
                      function: {
                        name: 'fs_write',
                        arguments: JSON.stringify({ path: 'blocked.txt', content: 'nope' })
                      }
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
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
          })}\n\n`
        )
      } else {
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: `回执:${userText}` }, finish_reason: null }]
          })}\n\n`
        )
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${seq}`,
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
        id: 'mock-r3',
        name: 'Mock R3',
        type: 'openai-compatible',
        apiFormat: 'openai-chat',
        isResponseApi: false,
        useMaxCompletionTokens: false,
        baseUrl: `http://127.0.0.1:${llmPort}/v1`,
        apiKey: 'sk-r3',
        customHeaders: {},
        models: [
          {
            id: 'gpt-a',
            name: 'GPT A',
            enabled: true,
            capabilities: { vision: false, reasoning: false, streaming: true, functionCalling: true }
          },
          {
            id: 'gpt-b',
            name: 'GPT B',
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

      daemon.ctx.db.updateSettings({
        chat: { defaultModel: 'mock-r3:gpt-a' },
        acp: { permissionTimeoutSec: 1 },
        channels: {
          feishu: {
            enabled: true,
            appId: 'cli_r3',
            appSecret: 'sec_r3',
            domain: 'feishu'
          }
        }
      })
      await daemon.ctx.feishuBridge!.connect()

      // 1. /help command
      const helpRes = await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_help',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/help' })
        }
      })
      expect(helpRes.reason).toBe('command_help')
      expect(sentMessages[sentMessages.length - 1].content).toContain('飞书命令列表')

      // 2. /model & /model <id> commands
      const modelListRes = await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_model_list',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/model' })
        }
      })
      expect(modelListRes.reason).toBe('command_model_list')
      const threadId = modelListRes.threadId!
      daemon.ctx.db.updateThread(threadId, { workspacePath: workspaceDir })

      const modelSetRes = await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_model_set',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/model mock-r3:gpt-b' })
        }
      })
      expect(modelSetRes.reason).toBe('command_model_set')
      expect(daemon.ctx.db.getThread(threadId)!.model).toBe('mock-r3:gpt-b')

      // 3. /stop command aborts in-flight generation and updates thinking card
      await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_hang',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '超长挂起用于停止' })
        }
      })
      const hangCardId = sentMessages[sentMessages.length - 1].id
      await new Promise(r => setTimeout(r, 40))

      const stopRes = await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_stop',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/stop' })
        }
      })
      expect(stopRes.reason).toBe('command_stop')
      await viWaitFor(() => patchedMessages.some(p => p.message_id === hangCardId))

      // 4. Feishu card click "拒绝" -> red card & file NOT written
      const beforeRejSent = sentMessages.length
      await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_write_rej',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '尝试写敏感文件' })
        }
      })
      await viWaitFor(() =>
        sentMessages.slice(beforeRejSent).some(m => m.content.includes('安全审批请求'))
      )
      const rejPermCard = sentMessages
        .slice(beforeRejSent)
        .find(m => m.content.includes('安全审批请求'))!
      const rejCardObj = JSON.parse(rejPermCard.content)
      const rejAction = rejCardObj.elements
        .find((e: any) => e.tag === 'action')
        .actions.find((a: any) => a.value.optionId === '__reject__')

      const rejToast = await handlers['card.action.trigger']({
        action: { value: rejAction.value }
      })
      expect(rejToast.toast.type).toBe('warning')

      await viWaitFor(() => patchedMessages.some(p => p.message_id === rejPermCard.id))
      const rejPatched = JSON.parse(
        patchedMessages.find(p => p.message_id === rejPermCard.id)!.content
      )
      expect(rejPatched.header.template).toBe('red')
      expect(rejPatched.header.title.content).toContain('审批已拒绝')
      expect(existsSync(join(workspaceDir, 'blocked.txt'))).toBe(false)
      await viWaitFor(() => daemon.ctx.engine.getThreadStatus(threadId) === 'idle')

      // 5. P0-4: ACP-style `reject_once` desktop rejection AND timeout auto-reject BOTH produce RED card (never green!)
      // Start a slow turn so FeishuBridge is subscribed to `threadId`
      await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_acp_perm_host',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '超长挂起用于停止' })
        }
      })

      // 5a. Desktop GUI resolves ACP permission with `reject_once`
      const beforeAcpPerm = sentMessages.length
      const acpPermPromise1 = daemon.ctx.permissionGate.requestPermission({
        threadId,
        providerId: 'claude-acp',
        title: 'ACP Bash rm',
        toolName: 'bash',
        rawInput: { cmd: 'rm -rf temp' },
        cwd: workspaceDir,
        options: [
          { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
          { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
        ]
      })
      await viWaitFor(() =>
        sentMessages.slice(beforeAcpPerm).some(m => m.content.includes('ACP Bash rm'))
      )
      const acpCard1 = sentMessages.slice(beforeAcpPerm).find(m => m.content.includes('ACP Bash rm'))!
      const pendingList1 = daemon.ctx.permissionGate.getPendingPermissionsForThread(threadId)
      daemon.ctx.permissionGate.resolvePermission(pendingList1[0].requestId, 'reject_once')
      const acpOut1 = await acpPermPromise1
      expect(acpOut1).toEqual({ outcome: 'selected', optionId: 'reject_once' })

      await viWaitFor(() => patchedMessages.some(p => p.message_id === acpCard1.id))
      const acpPatched1 = JSON.parse(
        patchedMessages.find(p => p.message_id === acpCard1.id)!.content
      )
      expect(acpPatched1.header.template).toBe('red')
      expect(acpPatched1.header.title.content).toContain('审批已拒绝')

      // 5b. ACP permission times out after 1s -> also patched RED
      const beforeAcpTimeout = sentMessages.length
      const acpPermPromise2 = daemon.ctx.permissionGate.requestPermission({
        threadId,
        providerId: 'claude-acp',
        title: 'ACP Timeout Edit',
        toolName: 'edit',
        rawInput: { path: 'a.ts' },
        cwd: workspaceDir,
        options: [
          { optionId: 'allow_once', name: '允许', kind: 'allow_once' },
          { optionId: 'reject_once', name: '拒绝', kind: 'reject_once' }
        ]
      })
      await viWaitFor(() =>
        sentMessages.slice(beforeAcpTimeout).some(m => m.content.includes('ACP Timeout Edit'))
      )
      const acpCard2 = sentMessages
        .slice(beforeAcpTimeout)
        .find(m => m.content.includes('ACP Timeout Edit'))!
      const acpOut2 = await acpPermPromise2
      expect(acpOut2).toEqual({ outcome: 'selected', optionId: 'reject_once' })

      await viWaitFor(() => patchedMessages.some(p => p.message_id === acpCard2.id))
      const acpPatched2 = JSON.parse(
        patchedMessages.find(p => p.message_id === acpCard2.id)!.content
      )
      expect(acpPatched2.header.template).toBe('red')
      expect(acpPatched2.header.title.content).toContain('审批已拒绝')

      // 5c. P1-4 Race 2: `permission_resolved` arrives BEFORE `sendCardMessage` returns `message_id`
      createCardDelayMs = 100
      const fastPermPromise = daemon.ctx.permissionGate.requestPermission({
        threadId,
        providerId: 'sub2api',
        title: 'Fast Desktop Approve',
        toolName: 'fs_write',
        rawInput: { path: 'fast.txt' },
        cwd: workspaceDir,
        options: [
          { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
          { optionId: 'reject', name: '拒绝', kind: 'reject_once' }
        ]
      })
      const fastReqId = daemon.ctx.permissionGate.getPendingPermissionsForThread(threadId)[0].requestId
      // Resolve immediately (at 10ms) while Feishu card HTTP create is still delayed (100ms)!
      setTimeout(() => daemon.ctx.permissionGate.resolvePermission(fastReqId, 'allow_once'), 10)
      await fastPermPromise

      await viWaitFor(() =>
        sentMessages.some(m => m.content.includes('Fast Desktop Approve'))
      )
      const fastCard = sentMessages.find(m => m.content.includes('Fast Desktop Approve'))!
      await viWaitFor(() => patchedMessages.some(p => p.message_id === fastCard.id))
      const fastPatched = JSON.parse(
        patchedMessages.find(p => p.message_id === fastCard.id)!.content
      )
      expect(fastPatched.header.template).toBe('green')
      expect(fastPatched.header.title.content).toContain('审批已允许')
      createCardDelayMs = 0

      // Stop the host turn before testing Steer queue
      daemon.ctx.engine.stopGeneration(threadId)
      await viWaitFor(() => daemon.ctx.engine.getThreadStatus(threadId) === 'idle')

      // 6. P1-4 Race 1: Consecutive Feishu messages (Steer mode) update each card in order without dangling
      const beforeSteerSent = sentMessages.length
      await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_steer_1',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '慢速第一轮' })
        }
      })
      const steerCard1Id = sentMessages[beforeSteerSent].id

      // Immediately send 2nd message while Turn 1 is still streaming (150ms)
      await daemon.ctx.feishuBridge!.handleIncomingMessageEvent({
        sender: { sender_id: { open_id: 'ou_u1' }, sender_type: 'user' },
        message: {
          message_id: 'm_steer_2',
          chat_id: 'oc_c1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '第二轮追问' })
        }
      })
      const steerCard2Id = sentMessages[beforeSteerSent + 1].id
      expect(steerCard2Id).not.toBe(steerCard1Id)

      await viWaitFor(
        () =>
          patchedMessages.some(p => p.message_id === steerCard1Id) &&
          patchedMessages.some(p => p.message_id === steerCard2Id)
      )
      const card1Final = patchedMessages.find(p => p.message_id === steerCard1Id)!.content
      const card2Final = patchedMessages.find(p => p.message_id === steerCard2Id)!.content
      expect(card1Final).toContain('第一轮慢速回复完成')
      expect(card2Final).toContain('第二轮插队回复完成')
    } finally {
      llmSrv.close()
      await daemon.shutdown()
    }
  }, 20_000)
})

async function viWaitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`)
    }
    await new Promise(r => setTimeout(r, 25))
  }
}
