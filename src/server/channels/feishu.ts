import * as lark from '@larksuiteoapi/node-sdk'
import { nanoid } from 'nanoid'
import {
  FeishuBridgeEventDto,
  FeishuBridgeStatusDto,
  ThreadDto,
  WsClientMessage
} from '@shared/schemas'
import { AppDatabase } from '../db/database'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'

export interface FeishuRestClientLike {
  im: {
    v1: {
      message: {
        create: (payload: any) => Promise<any>
        patch?: (payload: any) => Promise<any>
        reply?: (payload: any) => Promise<any>
      }
    }
  }
  request?: (payload: any) => Promise<any>
}

export interface FeishuWsClientLike {
  start: (params: { eventDispatcher: any }) => Promise<void>
  close: (params?: { force?: boolean }) => void
}

export interface FeishuSdkFactory {
  createClient: (opts: {
    appId: string
    appSecret: string
    domain: 'feishu' | 'lark'
  }) => FeishuRestClientLike
  createWsClient: (opts: {
    appId: string
    appSecret: string
    domain: 'feishu' | 'lark'
    onReady?: () => void
    onError?: (err: unknown) => void
    onReconnecting?: () => void
    onReconnected?: () => void
  }) => FeishuWsClientLike
  createEventDispatcher: () => {
    register: (handles: Record<string, (data: any) => Promise<any> | any>) => any
  }
}

const defaultSdkFactory: FeishuSdkFactory = {
  createClient: ({ appId, appSecret, domain }) =>
    new lark.Client({
      appId,
      appSecret,
      domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn
    }) as unknown as FeishuRestClientLike,
  createWsClient: ({ appId, appSecret, domain, onReady, onError, onReconnecting, onReconnected }) =>
    new lark.WSClient({
      appId,
      appSecret,
      domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.warn,
      onReady,
      onError,
      onReconnecting,
      onReconnected
    }) as unknown as FeishuWsClientLike,
  createEventDispatcher: () => new lark.EventDispatcher({})
}

function buildTextCard(title: string, markdownContent: string, template = 'blue'): string {
  const safeContent = markdownContent.slice(0, 28_000) || '（无内容）'
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title }
    },
    elements: [
      {
        tag: 'markdown',
        content: safeContent
      }
    ]
  })
}

function buildPermissionCard(params: {
  requestId: string
  title: string
  toolName: string
  rawInput: unknown
  options: Array<{ optionId: string; name: string; kind: string }>
}): string {
  const inputPreview =
    typeof params.rawInput === 'string'
      ? params.rawInput
      : JSON.stringify(params.rawInput ?? {}, null, 2)
  const clippedInput =
    inputPreview.length > 800 ? inputPreview.slice(0, 800) + '\n…(已截断)' : inputPreview

  const buttons = [
    ...params.options
      .filter(o => /^allow_/i.test(o.kind))
      .map(opt => ({
        tag: 'button',
        text: { tag: 'plain_text', content: opt.name },
        type: opt.kind === 'allow_always' ? 'default' : 'primary',
        value: {
          kind: 'cjh_permission',
          requestId: params.requestId,
          optionId: opt.optionId,
          label: opt.name
        }
      })),
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '拒绝' },
      type: 'danger',
      value: {
        kind: 'cjh_permission',
        requestId: params.requestId,
        optionId: '__reject__',
        label: '拒绝'
      }
    }
  ]

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `安全审批请求：${params.title}` }
    },
    elements: [
      {
        tag: 'markdown',
        content: `**工具**: \`${params.toolName}\`\n\`\`\`json\n${clippedInput}\n\`\`\`\n超时未确认将自动拒绝 (Fail-Closed)。`
      },
      {
        tag: 'action',
        actions: buttons
      }
    ]
  })
}

function formatPermissionOutcomeLabel(outcome: string): string {
  if (/reject|deny|cancel|拒绝|超时/i.test(outcome) || !/^allow/i.test(outcome)) {
    return '已拒绝 / 超时自动拒绝'
  }
  if (outcome === 'allow_always') {
    return '已允许（本线程总是允许）'
  }
  return '已允许'
}

function buildPermissionResolvedCard(title: string, outcomeLabel: string): string {
  const approved = !/reject|deny|cancel|拒绝|超时/i.test(outcomeLabel)
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: approved ? 'green' : 'red',
      title: { tag: 'plain_text', content: `审批${approved ? '已允许' : '已拒绝'}：${title}` }
    },
    elements: [
      {
        tag: 'markdown',
        content: `处理结果：**${outcomeLabel}**`
      }
    ]
  })
}

interface PendingFeishuTurnCard {
  chatId: string
  thinkingMsgId: string | null
}

interface ThreadTurnSession {
  queue: PendingFeishuTurnCard[]
  lastChatId: string
  lastFinalCard: string | null
  cleanup: () => void
}

interface PermissionCardState {
  title: string
  messageId: string | null
  resolvedOutcome: string | null
}

export class FeishuBridge {
  private readonly TAG = 'Bridge:feishu'
  private client: FeishuRestClientLike | null = null
  private wsClient: FeishuWsClientLike | null = null
  private status: FeishuBridgeStatusDto['status'] = 'disconnected'
  private lastError: string | null = null
  private lastConnectedAt: number | null = null
  private botOpenId: string | null = null
  private recentEvents: FeishuBridgeEventDto[] = []
  private seenMessageIds = new Set<string>()
  private threadTurnSessions = new Map<string, ThreadTurnSession>()
  private permissionCards = new Map<string, PermissionCardState>()
  private sdkFactory: FeishuSdkFactory

  constructor(
    private db: AppDatabase,
    private wsHub: WsHub,
    private logger: TaggedLogger,
    private dispatchWsClientMessage: (msg: WsClientMessage) => void,
    sdkFactory?: FeishuSdkFactory
  ) {
    this.sdkFactory = sdkFactory || defaultSdkFactory
  }

  private pushEvent(type: string, summary: string): void {
    const evt: FeishuBridgeEventDto = {
      id: nanoid(8),
      timestamp: Date.now(),
      type,
      summary
    }
    this.recentEvents.unshift(evt)
    if (this.recentEvents.length > 50) {
      this.recentEvents.length = 50
    }
    this.wsHub.broadcast('channel_status_updated', this.getStatus())
  }

  getStatus(): FeishuBridgeStatusDto {
    const cfg = this.db.getSettings().channels.feishu
    const secret = this.db.getSecret('channels.feishu.app_secret')
    return {
      enabled: cfg.enabled,
      configured: Boolean(cfg.appId.trim() && secret),
      appId: cfg.appId,
      domain: cfg.domain,
      status: this.status,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      botOpenId: this.botOpenId,
      recentEvents: [...this.recentEvents]
    }
  }

  async startIfEnabled(): Promise<void> {
    const cfg = this.db.getSettings().channels.feishu
    const secret = this.db.getSecret('channels.feishu.app_secret')
    if (cfg.enabled && cfg.appId.trim() && secret) {
      await this.connect()
    }
  }

  async connect(): Promise<FeishuBridgeStatusDto> {
    await this.disconnect()

    const cfg = this.db.getSettings().channels.feishu
    const appId = cfg.appId.trim()
    const appSecret = this.db.getSecret('channels.feishu.app_secret')

    if (!appId || !appSecret) {
      this.status = 'error'
      this.lastError = '请先配置飞书 App ID 与 App Secret'
      this.logger.warn(this.TAG, this.lastError)
      this.wsHub.broadcast('channel_status_updated', this.getStatus())
      return this.getStatus()
    }

    this.status = 'connecting'
    this.lastError = null
    this.wsHub.broadcast('channel_status_updated', this.getStatus())
    this.logger.info(this.TAG, `Connecting Feishu WSClient (appId=${appId}, domain=${cfg.domain})`)

    try {
      const client = this.sdkFactory.createClient({
        appId,
        appSecret,
        domain: cfg.domain
      })
      this.client = client

      // Try fetching bot open_id for accurate group @mention matching
      if (typeof client.request === 'function') {
        try {
          const botRes = await client.request({
            method: 'GET',
            url: '/open-apis/bot/v3/info'
          })
          const openId = botRes?.bot?.open_id || botRes?.data?.bot?.open_id
          if (typeof openId === 'string' && openId) {
            this.botOpenId = openId
          }
        } catch (err) {
          this.logger.warn(
            this.TAG,
            `Failed to fetch bot info (will fallback to mentions array): ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }

      const dispatcher = this.sdkFactory.createEventDispatcher()
      dispatcher.register({
        'im.message.receive_v1': async (data: any) => {
          void this.handleIncomingMessageEvent(data).catch(err => {
            this.logger.error(this.TAG, 'Failed handling im.message.receive_v1', err)
          })
        },
        'card.action.trigger': async (data: any) => {
          return this.handleCardActionEvent(data)
        }
      })

      let readyFired = false
      const wsClient = this.sdkFactory.createWsClient({
        appId,
        appSecret,
        domain: cfg.domain,
        onReady: () => {
          readyFired = true
          this.status = 'connected'
          this.lastConnectedAt = Date.now()
          this.lastError = null
          this.pushEvent('connected', '飞书长连接已就绪')
        },
        onError: err => {
          this.status = 'error'
          this.lastError = err instanceof Error ? err.message : String(err)
          this.pushEvent('error', this.lastError)
        },
        onReconnecting: () => {
          this.status = 'connecting'
          this.pushEvent('reconnecting', '飞书长连接重连中…')
        },
        onReconnected: () => {
          this.status = 'connected'
          this.lastConnectedAt = Date.now()
          this.lastError = null
          this.pushEvent('reconnected', '飞书长连接重连成功')
        }
      })
      this.wsClient = wsClient

      await wsClient.start({ eventDispatcher: dispatcher })
      if (!readyFired) {
        this.status = 'connected'
        this.lastConnectedAt = Date.now()
        this.lastError = null
        this.pushEvent('connected', `飞书长连接已建立 (${cfg.domain})`)
      }
      this.logger.info(this.TAG, 'Feishu WSClient connected successfully')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.status = 'error'
      this.lastError = msg
      this.logger.error(this.TAG, `Feishu connection failed: ${msg}`)
      this.pushEvent('error', `连接失败: ${msg}`)
    }

    return this.getStatus()
  }

  async disconnect(): Promise<FeishuBridgeStatusDto> {
    for (const sess of this.threadTurnSessions.values()) {
      sess.cleanup()
    }
    this.threadTurnSessions.clear()
    this.permissionCards.clear()

    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true })
      } catch {
        // Ignore close error
      }
      this.wsClient = null
    }
    this.client = null
    if (this.status !== 'disconnected') {
      this.status = 'disconnected'
      this.pushEvent('disconnected', '飞书长连接已断开')
      this.logger.info(this.TAG, 'Feishu WSClient disconnected')
    }
    return this.getStatus()
  }

  async reconnect(): Promise<FeishuBridgeStatusDto> {
    await this.disconnect()
    return this.connect()
  }

  private async sendCardMessage(
    chatId: string,
    cardJson: string,
    clientOverride?: FeishuRestClientLike
  ): Promise<string | null> {
    const c = clientOverride || this.client
    if (!c) return null
    try {
      const res = await c.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: cardJson
        }
      })
      return res?.data?.message_id || res?.message_id || null
    } catch (err) {
      this.logger.error(this.TAG, `Failed to send card to ${chatId}`, err)
      return null
    }
  }

  private async patchCardMessage(messageId: string, cardJson: string): Promise<boolean> {
    if (!this.client?.im?.v1?.message?.patch) return false
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardJson }
      })
      return true
    } catch (err) {
      this.logger.warn(
        this.TAG,
        `Patch card ${messageId} failed: ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }

  private async sendPlainReply(chatId: string, text: string): Promise<string | null> {
    return this.sendCardMessage(chatId, buildTextCard('cjh 助手', text, 'blue'))
  }

  private resolveOrCreateMapping(
    chatId: string,
    userId: string,
    chatType: 'p2p' | 'group' | string
  ): { thread: ThreadDto; isNew: boolean } {
    const existing = this.db.getChannelMapping('feishu', chatId, userId)
    if (existing) {
      const thread = this.db.getThread(existing.threadId)
      if (thread) return { thread, isNew: false }
    }

    const defaultModel = this.db.getSettings().chat.defaultModel || null
    const thread = this.db.createThread({
      title: chatType === 'group' ? `飞书群聊 (${chatId.slice(-6)})` : `飞书私聊 (${userId.slice(-6)})`,
      model: defaultModel
    })
    this.db.upsertChannelMapping({
      platform: 'feishu',
      externalChatId: chatId,
      externalUserId: userId,
      chatType,
      threadId: thread.id
    })
    this.wsHub.broadcast('thread_created', thread)
    return { thread, isNew: true }
  }

  async handleIncomingMessageEvent(rawEvent: any): Promise<{
    handled: boolean
    reason?: string
    threadId?: string
  }> {
    const message = rawEvent?.message || rawEvent?.event?.message
    const sender = rawEvent?.sender || rawEvent?.event?.sender
    if (!message || !message.chat_id) {
      return { handled: false, reason: 'missing_message' }
    }

    if (sender?.sender_type === 'app') {
      return { handled: false, reason: 'self_message' }
    }

    const messageId = String(message.message_id || '')
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) {
        return { handled: false, reason: 'duplicate_message' }
      }
      this.seenMessageIds.add(messageId)
      if (this.seenMessageIds.size > 500) {
        const first = this.seenMessageIds.values().next().value
        if (first) this.seenMessageIds.delete(first)
      }
    }

    const chatId = String(message.chat_id)
    const chatType = (message.chat_type === 'group' ? 'group' : 'p2p') as 'p2p' | 'group'
    const userId = String(
      sender?.sender_id?.open_id ||
        sender?.sender_id?.user_id ||
        sender?.sender_id?.union_id ||
        'unknown'
    )

    const mentions: Array<{ key?: string; id?: { open_id?: string } }> = Array.isArray(
      message.mentions
    )
      ? message.mentions
      : []

    if (chatType === 'group') {
      const botMentioned = this.botOpenId
        ? mentions.some(m => m.id?.open_id === this.botOpenId)
        : mentions.length > 0
      if (!botMentioned) {
        this.logger.debug(this.TAG, `Ignored group message ${messageId} without @bot mention`)
        return { handled: false, reason: 'group_not_mentioned' }
      }
    }

    let text = ''
    if (message.message_type === 'text') {
      try {
        const contentObj = JSON.parse(String(message.content || '{}'))
        text = String(contentObj.text || '')
      } catch {
        text = String(message.content || '')
      }
    } else {
      await this.sendPlainReply(chatId, '暂仅支持文本消息，请发送文字指令或问题。')
      return { handled: false, reason: 'unsupported_message_type' }
    }

    // Strip @_user_N placeholders in group @mentions
    for (const m of mentions) {
      if (m.key) {
        text = text.split(m.key).join('')
      }
    }
    text = text.replace(/@_user_\d+/g, '').trim()

    if (!text) {
      return { handled: false, reason: 'empty_text' }
    }

    this.pushEvent('message', `${chatType}:${chatId.slice(-6)} · ${text.slice(0, 40)}`)
    this.logger.info(this.TAG, `Inbound ${chatType} message from ${userId} in ${chatId}: ${text.slice(0, 80)}`)

    // Slash commands on Feishu side
    if (text === '/help') {
      await this.sendPlainReply(
        chatId,
        [
          '**cjh 飞书命令列表**：',
          '- `/new` — 创建新的对话线程并切换过去',
          '- `/stop` — 停止当前线程正在进行的生成',
          '- `/model <id>` — 切换当前线程模型（如 `/model sub2api:gpt-5.5`）',
          '- `/help` — 查看本帮助'
        ].join('\n')
      )
      return { handled: true, reason: 'command_help' }
    }

    if (text === '/new') {
      const defaultModel = this.db.getSettings().chat.defaultModel || null
      const newThread = this.db.createThread({
        title: chatType === 'group' ? `飞书群聊 (${chatId.slice(-6)})` : `飞书私聊 (${userId.slice(-6)})`,
        model: defaultModel
      })
      this.db.upsertChannelMapping({
        platform: 'feishu',
        externalChatId: chatId,
        externalUserId: userId,
        chatType,
        threadId: newThread.id
      })
      this.wsHub.broadcast('thread_created', newThread)
      await this.sendPlainReply(chatId, `已创建并切换到新线程：\`${newThread.id}\``)
      return { handled: true, reason: 'command_new', threadId: newThread.id }
    }

    const { thread } = this.resolveOrCreateMapping(chatId, userId, chatType)

    if (text === '/stop') {
      this.dispatchWsClientMessage({
        type: 'stop_generation',
        data: { threadId: thread.id }
      })
      await this.sendPlainReply(chatId, `已发送停止生成请求（线程 \`${thread.id}\`）。`)
      return { handled: true, reason: 'command_stop', threadId: thread.id }
    }

    if (text === '/model' || text.startsWith('/model ')) {
      const targetId = text.slice('/model'.length).trim()
      if (!targetId) {
        const models = this.db.listCompositeModels()
        const list = models.slice(0, 15).map(m => `- \`${m.compositeId}\``).join('\n')
        await this.sendPlainReply(
          chatId,
          `当前线程模型：\`${thread.model || '未指定（跟随全局默认）'}\`\n\n可用模型：\n${list || '暂无已启用模型'}`
        )
        return { handled: true, reason: 'command_model_list', threadId: thread.id }
      }
      const resolved = this.db.resolveModelString(targetId)
      if (!resolved) {
        await this.sendPlainReply(chatId, `未找到模型 \`${targetId}\`，请发送 \`/model\` 查看可用列表。`)
        return { handled: true, reason: 'command_model_not_found', threadId: thread.id }
      }
      const compositeId = `${resolved.provider.id}:${resolved.modelId}`
      const updated = this.db.updateThread(thread.id, { model: compositeId })
      if (updated) this.wsHub.broadcast('thread_updated', updated)
      await this.sendPlainReply(chatId, `已将当前线程模型切换为：\`${compositeId}\``)
      return { handled: true, reason: 'command_model_set', threadId: thread.id }
    }

    // Normal generation flow via WS generate_response (source=feishu)
    const thinkingMsgId = await this.sendCardMessage(
      chatId,
      buildTextCard('cjh 助手', '思考中…', 'wathet')
    )

    const session = this.ensureThreadTurnSession(thread.id, chatId)
    session.queue.push({ chatId, thinkingMsgId })

    this.dispatchWsClientMessage({
      type: 'generate_response',
      data: {
        threadId: thread.id,
        userMessage: {
          role: 'user',
          parts: [{ type: 'text', text }]
        },
        source: 'feishu'
      }
    })

    return { handled: true, threadId: thread.id }
  }

  private ensureThreadTurnSession(threadId: string, chatId: string): ThreadTurnSession {
    const existing = this.threadTurnSessions.get(threadId)
    if (existing) {
      existing.lastChatId = chatId
      return existing
    }

    const session: ThreadTurnSession = {
      queue: [],
      lastChatId: chatId,
      lastFinalCard: null,
      cleanup: () => {}
    }

    const unsubscribe = this.wsHub.subscribe(evt => {
      if (evt.type === 'permission_requested') {
        const dto = evt.data as {
          requestId: string
          threadId: string
          title: string
          toolName: string
          rawInput: unknown
          options: Array<{ optionId: string; name: string; kind: string }>
        }
        if (dto.threadId !== threadId) return
        // Immediately reserve slot in memory so fast desktop/timeout resolutions before HTTP create returns are never lost
        this.permissionCards.set(dto.requestId, {
          title: dto.title,
          messageId: null,
          resolvedOutcome: null
        })
        const targetChatId = session.queue[0]?.chatId || session.lastChatId
        void this.sendCardMessage(targetChatId, buildPermissionCard(dto)).then(cardMsgId => {
          const cur = this.permissionCards.get(dto.requestId)
          if (!cur) return
          if (!cardMsgId) {
            this.permissionCards.delete(dto.requestId)
            return
          }
          if (cur.resolvedOutcome !== null) {
            this.permissionCards.delete(dto.requestId)
            const label = formatPermissionOutcomeLabel(cur.resolvedOutcome)
            void this.patchCardMessage(
              cardMsgId,
              buildPermissionResolvedCard(cur.title, label)
            )
          } else {
            cur.messageId = cardMsgId
          }
        })
      } else if (evt.type === 'permission_resolved') {
        const payload = evt.data as { requestId: string; threadId: string; outcome: string }
        if (payload.threadId !== threadId) return
        const tracked = this.permissionCards.get(payload.requestId)
        if (!tracked) return
        if (tracked.messageId) {
          this.permissionCards.delete(payload.requestId)
          const label = formatPermissionOutcomeLabel(payload.outcome)
          void this.patchCardMessage(
            tracked.messageId,
            buildPermissionResolvedCard(tracked.title, label)
          )
        } else {
          tracked.resolvedOutcome = payload.outcome
        }
      } else if (evt.type === 'generation_completed') {
        const d = evt.data as { threadId: string; messageId?: string; aborted?: boolean }
        if (d.threadId !== threadId) return
        const stored = d.messageId ? this.db.getMessageById(d.messageId) : null
        const replyText = stored
          ? stored.message.parts
              .filter(p => p.type === 'text')
              .map(p => (p as { type: 'text'; text: string }).text)
              .join('\n')
              .trim()
          : ''
        const finalCard = buildTextCard('cjh 助手', replyText || '（已结束，无文本输出）', 'blue')
        session.lastFinalCard = finalCard

        const head = session.queue.shift()
        if (head) {
          void this.finishThinkingMessage(head.chatId, head.thinkingMsgId, finalCard)
        }

        if (d.aborted) {
          const stopCard = buildTextCard('cjh 助手', '*(已停止生成)*', 'blue')
          while (session.queue.length > 0) {
            const rest = session.queue.shift()!
            void this.finishThinkingMessage(rest.chatId, rest.thinkingMsgId, stopCard)
          }
          session.cleanup()
        } else if (session.queue.length === 0) {
          session.cleanup()
        }
      } else if (evt.type === 'generation_error') {
        const d = evt.data as { threadId: string; error?: string }
        if (d.threadId !== threadId) return
        const errCard = buildTextCard('cjh 助手（出错）', `⚠ ${d.error || '生成失败'}`, 'red')
        while (session.queue.length > 0) {
          const card = session.queue.shift()!
          void this.finishThinkingMessage(card.chatId, card.thinkingMsgId, errCard)
        }
        session.cleanup()
      } else if (evt.type === 'thread_status_changed') {
        const d = evt.data as { threadId: string; status?: string }
        if (d.threadId !== threadId || d.status !== 'idle') return
        if (session.queue.length > 0) {
          const mergedCard =
            session.lastFinalCard || buildTextCard('cjh 助手', '（已合并处理完毕）', 'blue')
          while (session.queue.length > 0) {
            const card = session.queue.shift()!
            void this.finishThinkingMessage(card.chatId, card.thinkingMsgId, mergedCard)
          }
        }
        session.cleanup()
      }
    })

    session.cleanup = () => {
      unsubscribe()
      if (this.threadTurnSessions.get(threadId) === session) {
        this.threadTurnSessions.delete(threadId)
      }
    }

    this.threadTurnSessions.set(threadId, session)
    return session
  }

  private async finishThinkingMessage(
    chatId: string,
    thinkingMsgId: string | null,
    finalCardJson: string
  ): Promise<void> {
    if (thinkingMsgId) {
      const patched = await this.patchCardMessage(thinkingMsgId, finalCardJson)
      if (patched) return
    }
    await this.sendCardMessage(chatId, finalCardJson)
  }

  async handleCardActionEvent(rawEvent: any): Promise<any> {
    const action = rawEvent?.action || rawEvent?.event?.action
    let value: any = action?.value
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        // leave as string
      }
    }

    if (value && typeof value === 'object' && value.kind === 'cjh_permission') {
      const requestId = String(value.requestId || '')
      const optionId = String(value.optionId || '__reject__')
      const label = String(value.label || optionId)

      if (requestId) {
        this.logger.info(this.TAG, `Card permission callback: ${requestId} -> ${optionId}`)
        this.pushEvent('permission_callback', `${requestId} -> ${label}`)
        this.dispatchWsClientMessage({
          type: 'permission_response',
          data: { requestId, optionId }
        })
        return {
          toast: {
            type: /reject|deny|cancel/i.test(optionId) ? 'warning' : 'success',
            content: `已提交审批结果：${label}`
          }
        }
      }
    }

    return { toast: { type: 'info', content: '已收到交互操作' } }
  }

  async deliverCronResult(chatId: string, jobName: string, content: string): Promise<void> {
    const cleanChatId = chatId.trim()
    if (!cleanChatId) return

    let restClient = this.client
    if (!restClient) {
      const cfg = this.db.getSettings().channels.feishu
      const secret = this.db.getSecret('channels.feishu.app_secret')
      if (!cfg.appId.trim() || !secret) {
        throw new Error('飞书渠道未配置 App ID 或 App Secret，无法投递定时任务结果')
      }
      restClient = this.sdkFactory.createClient({
        appId: cfg.appId.trim(),
        appSecret: secret,
        domain: cfg.domain
      })
    }

    const card = buildTextCard(`定时任务汇报 · ${jobName}`, content, 'indigo')
    const msgId = await this.sendCardMessage(cleanChatId, card, restClient)
    if (!msgId) {
      throw new Error(`向飞书会话 ${cleanChatId} 投递消息失败`)
    }
    this.logger.info(this.TAG, `Delivered cron "${jobName}" output to Feishu chat ${cleanChatId}`)
    this.pushEvent('cron_delivery', `${jobName} -> ${cleanChatId}`)
  }
}
