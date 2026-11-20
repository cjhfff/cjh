import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type TextPart,
  type ToolCallPart,
  type ToolResultPart
} from 'ai'
import { nanoid } from 'nanoid'
import {
  GenerateRequestData,
  HerdrClientLike,
  HerdrFollowManagerLike,
  MessagePart,
  StoredMessageDto,
  ThreadRuntimeStatus,
  UIMessage
} from '@shared/schemas'
import { AppDatabase } from '../db/database'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'
import { createLanguageModelForProvider } from '../providers/ai-provider'
import { AcpAgentManager, AcpPromptAttachment, AcpToolCallUpdatePatch } from '../acp/manager'
import { McpHub } from '../mcp/hub'
import { MemoryStore } from '../memory/store'
import { PermissionGate } from '../permissions/gate'
import { SkillsScanner } from '../skills/scanner'
import { buildBuiltinToolSet, formatBuiltinToolTitle } from '../tools/builtin'

interface ActiveGenerationState {
  threadId: string
  assistantMessageId: string
  abortController: AbortController
  status: ThreadRuntimeStatus
  steeredPrompts: string[]
}

export class GenerationEngine {
  private active = new Map<string, ActiveGenerationState>()
  private permissionGate: PermissionGate
  private herdrClient?: HerdrClientLike
  private followManager?: HerdrFollowManagerLike

  constructor(
    private db: AppDatabase,
    private wsHub: WsHub,
    private logger: TaggedLogger,
    private acpManager: AcpAgentManager,
    private mcpHub: McpHub,
    private skillsScanner: SkillsScanner,
    private attachmentsDir: string,
    permissionGate?: PermissionGate,
    private memoryStore?: MemoryStore,
    private getDaemonEnv?: () => { apiUrl: string; apiToken: string }
  ) {
    this.permissionGate =
      permissionGate ||
      new PermissionGate(
        db,
        logger,
        dto => {
          this.wsHub.broadcast('permission_requested', dto)
          this.notifyPermissionStateChanged(dto.threadId)
        },
        payload => {
          this.wsHub.broadcast('permission_resolved', payload)
          this.notifyPermissionStateChanged(payload.threadId)
        }
      )
  }

  setHerdrServices(
    herdrClient?: HerdrClientLike,
    followManager?: HerdrFollowManagerLike
  ): void {
    this.herdrClient = herdrClient
    this.followManager = followManager
  }

  getThreadStatus = (threadId: string): ThreadRuntimeStatus => {
    const st = this.active.get(threadId)
    if (!st) return 'idle'
    if (
      this.permissionGate.getPendingPermissionsForThread(threadId).length > 0 ||
      this.acpManager.getPendingPermissionsForThread(threadId).length > 0
    ) {
      return 'waiting_permission'
    }
    return st.status
  }

  notifyPermissionStateChanged(threadId: string): void {
    const status = this.getThreadStatus(threadId)
    this.wsHub.broadcast('thread_status_changed', { threadId, status })
  }

  stopGeneration(threadId: string): boolean {
    const running = this.active.get(threadId)
    if (!running) return false
    this.permissionGate.cancelThreadPermissions(threadId)
    running.abortController.abort()
    return true
  }

  steerOrGenerate(req: GenerateRequestData): void {
    const running = this.active.get(req.threadId)
    if (running && req.userMessage) {
      const steerText = req.userMessage.parts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map(p => p.text)
        .join('\n')
        .trim()
      if (steerText) {
        running.steeredPrompts.push(steerText)
        this.logger.info('Engine', `Queued steer message for active thread ${req.threadId}`)
        return
      }
    }
    void this.startTurn(req)
  }

  async startTurn(
    req: GenerateRequestData
  ): Promise<{ ok: boolean; messageId?: string; error?: string }> {
    // Supersede any existing run on the same thread
    if (this.active.has(req.threadId)) {
      this.stopGeneration(req.threadId)
    }

    const thread = this.db.getThread(req.threadId, this.getThreadStatus)
    if (!thread) {
      const error = `线程不存在 (${req.threadId})`
      this.wsHub.broadcast('generation_error', {
        threadId: req.threadId,
        error
      })
      return { ok: false, error }
    }

    const modelTarget = req.ephemeralModel || req.model || thread.model
    const resolved = this.db.resolveModelString(modelTarget)
    if (!resolved) {
      const error = '尚未配置可用模型，请先在「模型与 ACP」中添加并启用模型（如 sub2api）'
      this.wsHub.broadcast('generation_error', {
        threadId: req.threadId,
        error
      })
      return { ok: false, error }
    }

    const { provider, modelId } = resolved
    const compositeModel = `${provider.id}:${modelId}`

    // Persist sticky model / effort onto thread unless ephemeral
    if (!req.ephemeralModel && (req.model || req.reasoningEffort !== undefined)) {
      const updated = this.db.updateThread(
        thread.id,
        {
          model: req.model ?? thread.model ?? compositeModel,
          reasoningEffort:
            req.reasoningEffort !== undefined ? req.reasoningEffort : thread.reasoningEffort
        },
        this.getThreadStatus
      )
      if (updated) this.wsHub.broadcast('thread_updated', updated)
    }

    // Determine parent & slot for user message / retry / edit
    let assistantParentId: string | null = thread.activeLeafId
    let assistantSlotId: string | undefined
    const isBranchEditOrRetry = Boolean(req.retryOfMessageId || (req.replaceMessageId && req.userMessage))

    if (req.retryOfMessageId) {
      const targetMsg = this.db.getMessageById(req.retryOfMessageId)
      if (targetMsg && targetMsg.threadId === thread.id) {
        if (targetMsg.role === 'assistant') {
          assistantParentId = targetMsg.parentId
          assistantSlotId = targetMsg.slotId
        } else {
          assistantParentId = targetMsg.id
        }
      }
    } else if (req.replaceMessageId && req.userMessage) {
      const oldUserMsg = this.db.getMessageById(req.replaceMessageId)
      const validOld = oldUserMsg && oldUserMsg.threadId === thread.id ? oldUserMsg : null
      const userId = nanoid(12)
      const insertedUser = this.db.insertMessage({
        id: userId,
        threadId: thread.id,
        parentId: validOld ? validOld.parentId : thread.activeLeafId,
        slotId: validOld ? validOld.slotId : undefined,
        role: 'user',
        message: { id: userId, role: 'user', parts: req.userMessage.parts }
      })
      if (!isBranchEditOrRetry) {
        this.wsHub.broadcast('message_added', insertedUser)
      }
      assistantParentId = insertedUser.id
    } else if (req.userMessage) {
      const userId = nanoid(12)
      const insertedUser = this.db.insertMessage({
        id: userId,
        threadId: thread.id,
        parentId: thread.activeLeafId,
        role: 'user',
        message: { id: userId, role: 'user', parts: req.userMessage.parts }
      })
      this.wsHub.broadcast('message_added', insertedUser)
      assistantParentId = insertedUser.id
    }

    // Create placeholder assistant message on the tree immediately
    const assistantId = nanoid(12)
    const liveParts: MessagePart[] = []
    const assistantMsg = this.db.insertMessage({
      id: assistantId,
      threadId: thread.id,
      parentId: assistantParentId,
      slotId: assistantSlotId,
      role: 'assistant',
      message: { id: assistantId, role: 'assistant', parts: liveParts },
      metadata: { providerId: provider.id, model: compositeModel }
    })

    const abortController = new AbortController()
    const runState: ActiveGenerationState = {
      threadId: thread.id,
      assistantMessageId: assistantId,
      abortController,
      status: 'generating',
      steeredPrompts: []
    }
    this.active.set(thread.id, runState)

    this.wsHub.broadcast('thread_status_changed', { threadId: thread.id, status: 'generating' })
    if (isBranchEditOrRetry) {
      this.wsHub.broadcast('thread_messages_replaced', {
        threadId: thread.id,
        messages: this.db.getActiveBranchMessages(thread.id)
      })
    } else {
      this.wsHub.broadcast('message_added', assistantMsg)
    }
    this.wsHub.broadcast('message_start', {
      threadId: thread.id,
      messageId: assistantId,
      model: compositeModel
    })

    const startedAt = Date.now()
    let usageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0
    }
    let finishReason = 'stop'

    const appendTextDelta = (delta: string) => {
      if (!delta) return
      const last = liveParts[liveParts.length - 1]
      if (last && last.type === 'text') {
        last.text += delta
      } else {
        liveParts.push({ type: 'text', text: delta })
      }
      this.wsHub.broadcast('message_delta', {
        threadId: thread.id,
        messageId: assistantId,
        partType: 'text',
        delta
      })
    }

    const appendReasoningDelta = (delta: string) => {
      if (!delta) return
      const last = liveParts[liveParts.length - 1]
      if (last && last.type === 'reasoning') {
        last.text += delta
      } else {
        liveParts.push({ type: 'reasoning', text: delta })
      }
      this.wsHub.broadcast('message_delta', {
        threadId: thread.id,
        messageId: assistantId,
        partType: 'reasoning',
        delta
      })
    }

    const upsertToolCall = (
      toolCallId: string,
      toolName: string,
      title: string,
      input: unknown,
      kind?: string,
      status: 'running' | 'completed' | 'failed' = 'running'
    ) => {
      const existing = liveParts.find(
        (p): p is Extract<MessagePart, { type: 'tool-call' }> =>
          p.type === 'tool-call' && p.toolCallId === toolCallId
      )
      if (!existing) {
        liveParts.push({
          type: 'tool-call',
          toolCallId,
          toolName,
          title,
          ...(kind !== undefined ? { kind } : {}),
          input,
          status
        })
      } else {
        existing.toolName = toolName
        existing.title = title
        if (kind !== undefined) existing.kind = kind
        if (input !== undefined) existing.input = input
        existing.status = status
      }
      this.wsHub.broadcast('tool_call_start', {
        threadId: thread.id,
        messageId: assistantId,
        toolCallId,
        toolName,
        title,
        ...(kind !== undefined ? { kind } : {}),
        input,
        status
      })
    }

    const updateToolCall = (patch: AcpToolCallUpdatePatch) => {
      const existing = liveParts.find(
        (p): p is Extract<MessagePart, { type: 'tool-call' }> =>
          p.type === 'tool-call' && p.toolCallId === patch.toolCallId
      )
      if (existing) {
        if (patch.toolName !== undefined) existing.toolName = patch.toolName
        if (patch.title !== undefined) existing.title = patch.title
        if (patch.kind !== undefined) existing.kind = patch.kind
        if (patch.input !== undefined) existing.input = patch.input
        if (patch.status !== undefined) existing.status = patch.status
        if (patch.output !== undefined) existing.output = patch.output
        if (patch.isError !== undefined) existing.isError = patch.isError
      } else {
        liveParts.push({
          type: 'tool-call',
          toolCallId: patch.toolCallId,
          toolName: patch.toolName || patch.title || 'Tool',
          title: patch.title || patch.toolName || 'Tool',
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.input !== undefined ? { input: patch.input } : {}),
          ...(patch.output !== undefined ? { output: patch.output } : {}),
          status: patch.status || 'running',
          ...(patch.isError !== undefined ? { isError: patch.isError } : {})
        })
      }
      this.wsHub.broadcast('tool_call_update', {
        threadId: thread.id,
        messageId: assistantId,
        ...patch
      })
    }

    const completeToolCall = (
      toolCallId: string,
      status: 'running' | 'completed' | 'failed',
      output: unknown,
      isError?: boolean
    ) => {
      updateToolCall({ toolCallId, status, output, isError })
    }

    try {
      // Assemble history up to assistantParentId
      const branchHistory = assistantParentId
        ? this.db.getActiveBranchMessages(thread.id, assistantParentId)
        : []

      const appSettings = this.db.getSettings()
      const latestUserMsg = [...branchHistory].reverse().find(m => m.role === 'user')
      const latestUserText = latestUserMsg
        ? latestUserMsg.message.parts
            .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
            .map(p => p.text)
            .join('\n')
            .trim()
        : ''
      const memoryAppendix =
        this.memoryStore && appSettings.tools?.memoryAutoInject !== false && latestUserText
          ? this.memoryStore.buildSystemPromptAppendix(latestUserText, 5)
          : ''

      if (provider.type === 'acp') {
        const lastMsg = branchHistory[branchHistory.length - 1]
        const latestUser = lastMsg?.role === 'user' ? lastMsg : null
        const priorMessages = latestUser ? branchHistory.slice(0, -1) : branchHistory
        const acpAttachments: AcpPromptAttachment[] = []
        const textSegments: string[] = []

        if (latestUser) {
          for (const p of latestUser.message.parts) {
            if (p.type === 'text' && p.text) {
              textSegments.push(p.text)
            } else if (p.type === 'file') {
              if (p.attachmentId) {
                const att = this.db.getAttachment(p.attachmentId)
                if (att) {
                  const diskPath = join(this.attachmentsDir, att.relPath)
                  acpAttachments.push({
                    fileName: att.fileName,
                    mimeType: att.mimeType,
                    byteSize: att.byteSize,
                    diskPath,
                    fileUri: pathToFileURL(diskPath).toString()
                  })
                }
              } else if (p.url?.startsWith('data:')) {
                acpAttachments.push({
                  fileName: p.fileName,
                  mimeType: p.mediaType || 'application/octet-stream',
                  byteSize: p.byteSize || 0,
                  dataUrl: p.url
                })
              }
            }
          }
        }

        const promptText = textSegments.length
          ? textSegments.join('\n')
          : acpAttachments.length > 0
            ? ''
            : '继续'

        const combinedEphemeral = [req.ephemeralContext, memoryAppendix.trim()]
          .filter(Boolean)
          .join('\n\n')
        const fullPrompt = combinedEphemeral
          ? `${combinedEphemeral}${promptText ? `\n\n${promptText}` : ''}`
          : promptText

        const cwd = thread.workspacePath || process.cwd()
        const mcpForAcp = this.mcpHub.getStdioServersForAcp(provider.acpMcpServerIds || [])

        const acpRes = await this.acpManager.runPromptTurn({
          threadId: thread.id,
          provider,
          modelId,
          cwd,
          promptText: fullPrompt,
          attachments: acpAttachments,
          buildFallbackHistoryContext: () => this.buildAcpFallbackHistoryContext(priorMessages),
          mcpServersForAcp: mcpForAcp,
          abortSignal: abortController.signal,
          callbacks: {
            onTextDelta: appendTextDelta,
            onReasoningDelta: appendReasoningDelta,
            onToolCallStart: upsertToolCall,
            onToolCallUpdate: updateToolCall,
            onContextUsageUpdate: ctxUsage => {
              const updatedThread = this.db.updateThreadMetadata(
                thread.id,
                { contextUsage: ctxUsage },
                this.getThreadStatus
              )
              if (updatedThread) {
                this.wsHub.broadcast('thread_updated', updatedThread)
              }
              this.wsHub.broadcast('context_usage_update', {
                threadId: thread.id,
                ...ctxUsage
              })
            },
            onCommandsUpdate: commands => {
              this.wsHub.broadcast('acp_commands_updated', {
                threadId: thread.id,
                commands
              })
            }
          }
        })
        finishReason = acpRes.stopReason
        usageTotals = {
          inputTokens: acpRes.usage.inputTokens,
          outputTokens: acpRes.usage.outputTokens,
          cachedInputTokens: acpRes.usage.cachedInputTokens,
          reasoningTokens: acpRes.usage.reasoningTokens,
          totalTokens: acpRes.usage.totalTokens
        }
      } else {
        // Standard API / Relay (sub2api, OpenAI, Anthropic) via Vercel AI SDK
        const apiKey = this.db.getProviderSecretKey(provider.id)
        const lm = createLanguageModelForProvider(provider, apiKey, modelId)
        const modelMessages = this.convertHistoryToModelMessages(branchHistory)

        const enabledMcpIds =
          req.enabledMCPServerIds !== undefined ? req.enabledMCPServerIds : thread.enabledMcpIds
        const mcpTools = req.noTools ? {} : this.mcpHub.buildAiSdkToolSet(enabledMcpIds)
        const enableBuiltinTools = !req.noTools && thread.builtinToolsEnabled
        const builtinTools = enableBuiltinTools
          ? buildBuiltinToolSet({
              db: this.db,
              wsHub: this.wsHub,
              permissionGate: this.permissionGate,
              skillsScanner: this.skillsScanner,
              memoryStore: this.memoryStore,
              herdrClient: this.herdrClient,
              followManager: this.followManager,
              thread,
              providerId: provider.id,
              abortSignal: abortController.signal,
              daemonEnv: this.getDaemonEnv?.()
            })
          : {}
        const tools = { ...mcpTools, ...builtinTools }
        const hasTools = Object.keys(tools).length > 0
        const maxSteps = appSettings.tools?.maxSteps || 20
        const skillsAppendix = enableBuiltinTools
          ? this.skillsScanner.buildSystemPromptAppendix(thread.skillIds)
          : ''

        let systemPrompt =
          '你是运行在 cjh 本地工作台中的智能助手，回答清晰、准确、务实。' +
          (thread.workspacePath
            ? `\n当前线程绑定的工作目录为：${thread.workspacePath}`
            : '') +
          skillsAppendix +
          memoryAppendix
        if (req.ephemeralContext) {
          systemPrompt += `\n\n<ephemeral_context>\n${req.ephemeralContext}\n</ephemeral_context>`
        }

        const effectiveEffort = req.reasoningEffort ?? thread.reasoningEffort
        const providerOptions: Record<string, any> = {}
        if (effectiveEffort) {
          providerOptions.openai = { reasoningEffort: effectiveEffort }
        }

        const result = streamText({
          model: lm,
          system: systemPrompt,
          messages: modelMessages,
          tools: hasTools ? tools : undefined,
          stopWhen: stepCountIs(maxSteps),
          providerOptions: Object.keys(providerOptions).length ? providerOptions : undefined,
          abortSignal: abortController.signal
        })

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            appendTextDelta(part.text)
          } else if (part.type === 'reasoning-delta') {
            appendReasoningDelta(part.text)
          } else if (part.type === 'tool-call') {
            upsertToolCall(
              part.toolCallId,
              part.toolName,
              formatBuiltinToolTitle(part.toolName, part.input),
              part.input
            )
          } else if (part.type === 'tool-result') {
            completeToolCall(part.toolCallId, 'completed', part.output, false)
          } else if (part.type === 'tool-error') {
            const errText = part.error instanceof Error ? part.error.message : String(part.error)
            completeToolCall(part.toolCallId, 'failed', errText, true)
          } else if (part.type === 'error') {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          }
        }

        const [usage, reason] = await Promise.all([
          Promise.resolve(result.totalUsage).catch(() => undefined),
          Promise.resolve(result.finishReason).catch(() => 'stop')
        ])
        finishReason = String(reason || 'stop')
        if (usage) {
          usageTotals = {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
            reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
            totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
          }

          if (usageTotals.inputTokens > 0 || usageTotals.outputTokens > 0) {
            const modelDef = provider.models.find(m => m.id === modelId)
            const ctxWindow = modelDef?.capabilities?.contextWindow || 200_000
            const usedCtx = usageTotals.inputTokens + usageTotals.outputTokens
            const ctxUsage = { used: usedCtx, size: ctxWindow, updatedAt: Date.now() }
            const updatedThread = this.db.updateThreadMetadata(
              thread.id,
              { contextUsage: ctxUsage },
              this.getThreadStatus
            )
            if (updatedThread) {
              this.wsHub.broadcast('thread_updated', updatedThread)
            }
            this.wsHub.broadcast('context_usage_update', {
              threadId: thread.id,
              ...ctxUsage
            })
          }
        }
      }

      if (!liveParts.length) {
        liveParts.push({ type: 'text', text: '（已结束，无文本输出）' })
      }

      const latencyMs = Date.now() - startedAt
      const finalUiMessage: UIMessage = {
        id: assistantId,
        role: 'assistant',
        parts: liveParts
      }
      const updatedMsg = this.db.updateMessageContent(assistantId, finalUiMessage, {
        providerId: provider.id,
        model: compositeModel,
        latencyMs,
        finishReason,
        usage: usageTotals
      })

      this.db.insertUsage({
        threadId: thread.id,
        messageId: assistantId,
        category: 'chat',
        purpose: 'reply',
        providerId: provider.id,
        model: modelId,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        cachedInputTokens: usageTotals.cachedInputTokens,
        reasoningTokens: usageTotals.reasoningTokens,
        totalTokens: usageTotals.totalTokens,
        latencyMs
      })

      const finishedAt = Date.now()
      const traceToolCalls = liveParts
        .filter((p): p is Extract<MessagePart, { type: 'tool-call' }> => p.type === 'tool-call')
        .map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          title: tc.title,
          status: tc.status,
          isError: tc.isError
        }))
      this.db.insertTrace({
        threadId: thread.id,
        messageId: assistantId,
        providerId: provider.id,
        model: compositeModel,
        source: req.source || 'gui',
        status: 'success',
        durationMs: latencyMs,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        cachedInputTokens: usageTotals.cachedInputTokens,
        reasoningTokens: usageTotals.reasoningTokens,
        totalTokens: usageTotals.totalTokens,
        toolCalls: traceToolCalls,
        error: null,
        startedAt,
        finishedAt
      })

      if (updatedMsg) {
        this.wsHub.broadcast('message_updated', updatedMsg)
      }
      this.wsHub.broadcast('generation_completed', {
        threadId: thread.id,
        messageId: assistantId,
        usage: usageTotals,
        latencyMs
      })

      // Trigger asynchronous auto-title generation via toolModel if still default title
      const freshThread = this.db.getThread(thread.id)
      if (freshThread && freshThread.titleSource === 'default') {
        void this.maybeGenerateThreadTitle(freshThread.id, compositeModel)
      }

      // If user steered additional messages during streaming, immediately chain follow-up turn
      if (runState.steeredPrompts.length > 0) {
        const combinedSteer = runState.steeredPrompts.join('\n')
        this.active.delete(thread.id)
        void this.startTurn({
          threadId: thread.id,
          userMessage: {
            role: 'user',
            parts: [{ type: 'text', text: combinedSteer }]
          },
          source: 'steer'
        })
        return { ok: true, messageId: assistantId }
      }
      return { ok: true, messageId: assistantId }
    } catch (err) {
      const isAbort =
        abortController.signal.aborted ||
        (err instanceof Error && err.name === 'AbortError')
      const errMsg = isAbort
        ? '已手动停止生成'
        : err instanceof Error
          ? err.message
          : String(err)

      this.logger.warn('Engine', `Turn ended on thread ${thread.id}: ${errMsg}`)
      if (!liveParts.length) {
        liveParts.push({ type: 'text', text: isAbort ? '*(已停止生成)*' : `⚠ 生成出错：${errMsg}` })
      }
      const errFinishedAt = Date.now()
      const errLatency = errFinishedAt - startedAt
      const updatedMsg = this.db.updateMessageContent(
        assistantId,
        { id: assistantId, role: 'assistant', parts: liveParts },
        {
          providerId: provider.id,
          model: compositeModel,
          latencyMs: errLatency,
          finishReason: isAbort ? 'aborted' : 'error',
          error: isAbort ? undefined : errMsg
        }
      )
      const errToolCalls = liveParts
        .filter((p): p is Extract<MessagePart, { type: 'tool-call' }> => p.type === 'tool-call')
        .map(tc => ({
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          title: tc.title,
          status: tc.status,
          isError: tc.isError
        }))
      this.db.insertTrace({
        threadId: thread.id,
        messageId: assistantId,
        providerId: provider.id,
        model: compositeModel,
        source: req.source || 'gui',
        status: isAbort ? 'aborted' : 'error',
        durationMs: errLatency,
        inputTokens: usageTotals.inputTokens,
        outputTokens: usageTotals.outputTokens,
        cachedInputTokens: usageTotals.cachedInputTokens,
        reasoningTokens: usageTotals.reasoningTokens,
        totalTokens: usageTotals.totalTokens,
        toolCalls: errToolCalls,
        error: isAbort ? null : errMsg,
        startedAt,
        finishedAt: errFinishedAt
      })
      if (updatedMsg) this.wsHub.broadcast('message_updated', updatedMsg)
      if (!isAbort) {
        this.wsHub.broadcast('generation_error', {
          threadId: thread.id,
          messageId: assistantId,
          error: errMsg
        })
      } else {
        this.wsHub.broadcast('generation_completed', {
          threadId: thread.id,
          messageId: assistantId,
          aborted: true
        })
      }
      return { ok: false, messageId: assistantId, error: errMsg }
    } finally {
      if (this.active.get(thread.id) === runState) {
        this.active.delete(thread.id)
        this.wsHub.broadcast('thread_status_changed', {
          threadId: thread.id,
          status: 'idle'
        })
      }
    }
  }

  private sliceFromLastCompaction(history: StoredMessageDto[]): StoredMessageDto[] {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'system' && history[i].metadata?.isCompactionSummary) {
        return history.slice(i)
      }
    }
    return history
  }

  private buildAcpFallbackHistoryContext(priorMessages: StoredMessageDto[]): string | null {
    const effective = this.sliceFromLastCompaction(priorMessages)
    if (!effective.length) return null
    const recent = effective.slice(-24)
    const reversedLines: string[] = []
    let charBudget = 12_000

    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i]
      const roleLabel =
        m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统摘要'
      const textParts: string[] = []
      for (const p of m.message.parts) {
        if (p.type === 'text' && p.text.trim()) {
          textParts.push(p.text.trim())
        } else if (p.type === 'file') {
          textParts.push(`[文件: ${p.fileName}]`)
        } else if (p.type === 'tool-call') {
          textParts.push(`[工具 ${p.title || p.toolName}: ${p.status}]`)
        }
      }
      const content = textParts.join(' ').trim()
      if (!content) continue
      const clipped = content.length > 800 ? content.slice(0, 800) + '…' : content
      const line = `[${roleLabel}]: ${clipped}`
      if (charBudget - line.length < 0 && reversedLines.length > 0) break
      reversedLines.push(line)
      charBudget -= line.length
    }

    if (!reversedLines.length) return null
    return [
      '<conversation_history_context>',
      '以下是本对话此前的历史上下文（由于当前 ACP Agent 不支持 session/load 或会话已重建，由 cjh 自动前置恢复，请在此基础上继续）：',
      ...reversedLines.reverse(),
      '</conversation_history_context>'
    ].join('\n')
  }

  convertHistoryToModelMessages(history: StoredMessageDto[]): ModelMessage[] {
    const effectiveHistory = this.sliceFromLastCompaction(history)
    const out: ModelMessage[] = []
    for (const item of effectiveHistory) {
      if (item.role === 'system') {
        const sysText = item.message.parts
          .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
          .map(p => p.text)
          .join('\n')
          .trim()
        if (sysText) {
          out.push({
            role: 'user',
            content: `<compacted_conversation_summary>\n${sysText}\n</compacted_conversation_summary>`
          })
        }
      } else if (item.role === 'user') {
        const contentParts: Array<any> = []
        for (const p of item.message.parts) {
          if (p.type === 'text' && p.text.trim()) {
            contentParts.push({ type: 'text', text: p.text })
          } else if (p.type === 'file') {
            if (p.attachmentId) {
              const att = this.db.getAttachment(p.attachmentId)
              if (att) {
                const diskPath = join(this.attachmentsDir, att.relPath)
                if (existsSync(diskPath)) {
                  const buf = readFileSync(diskPath)
                  if (att.mimeType.startsWith('image/')) {
                    contentParts.push({
                      type: 'image',
                      image: buf,
                      mediaType: att.mimeType
                    })
                  } else if (att.mimeType.startsWith('text/') || /\.(md|json|ts|tsx|js|py|sql|txt|yaml|yml|toml)$/i.test(att.fileName)) {
                    contentParts.push({
                      type: 'text',
                      text: `\n<file name="${att.fileName}">\n${buf.toString('utf8')}\n</file>\n`
                    })
                  } else {
                    contentParts.push({
                      type: 'file',
                      data: buf,
                      mediaType: att.mimeType
                    })
                  }
                }
              }
            } else if (p.url?.startsWith('data:')) {
              contentParts.push({ type: 'image', image: p.url })
            }
          }
        }
        if (contentParts.length) {
          out.push({ role: 'user', content: contentParts })
        }
      } else if (item.role === 'assistant') {
        let pendingAssistant: Array<TextPart | ToolCallPart> = []
        let pendingToolResults: ToolResultPart[] = []

        const flushAssistantStep = () => {
          if (pendingAssistant.length > 0) {
            if (pendingAssistant.every(p => p.type === 'text')) {
              const joined = pendingAssistant
                .map(p => (p as TextPart).text)
                .join('\n')
                .trim()
              if (joined) {
                out.push({ role: 'assistant', content: joined })
              }
            } else {
              out.push({ role: 'assistant', content: pendingAssistant })
            }
            pendingAssistant = []
          }
          if (pendingToolResults.length > 0) {
            out.push({ role: 'tool', content: pendingToolResults })
            pendingToolResults = []
          }
        }

        for (const p of item.message.parts) {
          if (p.type === 'text') {
            if (p.text.trim()) {
              if (pendingToolResults.length > 0) {
                flushAssistantStep()
              }
              pendingAssistant.push({ type: 'text', text: p.text })
            }
          } else if (p.type === 'tool-call') {
            const toolCallId = p.toolCallId || `call_${nanoid(8)}`
            const toolName = p.toolName || 'tool'
            const normalizedInput =
              p.input !== undefined && p.input !== null && typeof p.input === 'object'
                ? p.input
                : p.input !== undefined
                  ? { value: p.input }
                  : {}

            pendingAssistant.push({
              type: 'tool-call',
              toolCallId,
              toolName,
              input: normalizedInput
            })

            let toolOutput: ToolResultPart['output']
            if (p.isError || p.status === 'failed') {
              const errStr =
                typeof p.output === 'string'
                  ? p.output
                  : JSON.stringify(p.output ?? 'Tool execution failed')
              toolOutput = { type: 'error-text', value: errStr }
            } else if (p.status === 'running') {
              toolOutput = {
                type: 'error-text',
                value: 'Tool call was interrupted before completion'
              }
            } else if (typeof p.output === 'string') {
              toolOutput = { type: 'text', value: p.output }
            } else if (p.output !== undefined) {
              toolOutput = { type: 'json', value: JSON.parse(JSON.stringify(p.output)) }
            } else {
              toolOutput = { type: 'text', value: '' }
            }

            pendingToolResults.push({
              type: 'tool-result',
              toolCallId,
              toolName,
              output: toolOutput
            })
          }
        }

        flushAssistantStep()
      }
    }
    return out
  }

  async maybeGenerateThreadTitle(
    threadId: string,
    fallbackModel?: string,
    force = false
  ): Promise<string | null> {
    const settings = this.db.getSettings()
    if (!force && !settings.toolModel.autoTitle) return null

    const cur = this.db.getThread(threadId)
    if (!cur || (!force && cur.titleSource === 'manual')) return null

    const targetModelStr = settings.toolModel.model || fallbackModel
    const resolved = this.db.resolveModelString(targetModelStr)
    let generated: string | null = null

    if (!resolved || resolved.provider.type === 'acp') {
      // Avoid spinning up heavy ACP coding subprocess just for short title; fallback to first non-ACP provider if available
      const nonAcp = this.db
        .listProviders()
        .find(p => p.enabled && p.type !== 'acp' && p.models.some(m => m.enabled))
      if (nonAcp) {
        const firstModel = nonAcp.models.find(m => m.enabled)!
        generated = await this.runTitleModel(threadId, nonAcp.id, firstModel.id, force)
      }
    } else {
      generated = await this.runTitleModel(threadId, resolved.provider.id, resolved.modelId, force)
    }

    if (generated) return generated
    return this.fallbackTitleFromFirstUserMessage(threadId, force)
  }

  private fallbackTitleFromFirstUserMessage(threadId: string, force = false): string | null {
    const cur = this.db.getThread(threadId)
    if (!cur || (!force && cur.titleSource === 'manual')) return null

    const msgs = this.db.getActiveBranchMessages(threadId)
    const firstUser = msgs.find(m => m.role === 'user')
    if (!firstUser) return null

    const rawText = firstUser.message.parts
      .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
      .map(p => p.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    const fallbackSource =
      rawText ||
      firstUser.message.parts.find((p): p is Extract<MessagePart, { type: 'file' }> => p.type === 'file')
        ?.fileName ||
      ''
    const chars = Array.from(fallbackSource.trim())
    if (!chars.length) return null

    const fallbackTitle = chars.slice(0, 20).join('')
    const updated = this.db.updateThread(
      threadId,
      { title: fallbackTitle, titleSource: 'auto' },
      this.getThreadStatus
    )
    if (updated) {
      this.wsHub.broadcast('title_generated', { threadId, title: fallbackTitle })
      this.wsHub.broadcast('thread_updated', updated)
    }
    return fallbackTitle
  }

  private async runTitleModel(
    threadId: string,
    providerId: string,
    modelId: string,
    force = false
  ): Promise<string | null> {
    const provider = this.db.getProvider(providerId)
    if (!provider) return null
    const msgs = this.db.getActiveBranchMessages(threadId)
    if (!msgs.length) return null

    const snippet = msgs
      .slice(0, 2)
      .map(m => {
        const t = m.message.parts
          .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
          .map(p => p.text)
          .join(' ')
          .slice(0, 300)
        return `${m.role}: ${t}`
      })
      .join('\n')

    const started = Date.now()
    try {
      const apiKey = this.db.getProviderSecretKey(provider.id)
      const lm = createLanguageModelForProvider(provider, apiKey, modelId)
      const res = await generateText({
        model: lm,
        prompt: `请为以下对话生成一个简短精炼的中文标题（不超过 16 个字，不要加引号、句号或任何解释）：\n\n${snippet}`,
        maxOutputTokens: 40,
        abortSignal: AbortSignal.timeout(15_000)
      })

      const cleanTitle = res.text.replace(/["'“”《》\r\n]/g, '').trim().slice(0, 28)
      if (!cleanTitle) return null

      this.db.insertUsage({
        threadId,
        category: 'aux',
        purpose: 'title',
        providerId: provider.id,
        model: modelId,
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
        totalTokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
        latencyMs: Date.now() - started
      })

      const cur = this.db.getThread(threadId)
      if (cur && (force || cur.titleSource !== 'manual')) {
        const updated = this.db.updateThread(
          threadId,
          { title: cleanTitle, titleSource: 'auto' },
          this.getThreadStatus
        )
        if (updated) {
          this.wsHub.broadcast('title_generated', { threadId, title: cleanTitle })
          this.wsHub.broadcast('thread_updated', updated)
        }
      }
      return cleanTitle
    } catch (err) {
      this.logger.debug('ToolModel', `Auto-title skipped: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  async compactThreadContext(threadId: string): Promise<{
    compacted: boolean
    summaryMessage?: StoredMessageDto
    messages: StoredMessageDto[]
    reason?: string
  }> {
    const thread = this.db.getThread(threadId, this.getThreadStatus)
    if (!thread) {
      throw new Error(`线程不存在 (${threadId})`)
    }

    const branchMsgs = this.db.getActiveBranchMessages(threadId)
    const effective = this.sliceFromLastCompaction(branchMsgs)
    const candidates = effective.filter(m => !(m.role === 'system' && m.metadata?.isCompactionSummary))

    if (candidates.length < 2) {
      return {
        compacted: false,
        reason: '当前待压缩消息过少',
        messages: branchMsgs
      }
    }

    const transcript = candidates
      .map(m => {
        const roleLabel = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'
        const txt = m.message.parts
          .map(p => {
            if (p.type === 'text') return p.text
            if (p.type === 'file') return `[附件: ${p.fileName}]`
            if (p.type === 'tool-call') return `[工具 ${p.title || p.toolName}: ${p.status}]`
            return ''
          })
          .filter(Boolean)
          .join(' ')
          .slice(0, 1200)
        return `[${roleLabel}]: ${txt}`
      })
      .join('\n')

    const settings = this.db.getSettings()
    const targetModelStr = settings.toolModel.model || thread.model
    let resolved = this.db.resolveModelString(targetModelStr)
    if (!resolved || resolved.provider.type === 'acp') {
      const nonAcp = this.db
        .listProviders()
        .find(p => p.enabled && p.type !== 'acp' && p.models.some(m => m.enabled))
      if (nonAcp) {
        resolved = { provider: nonAcp, modelId: nonAcp.models.find(m => m.enabled)!.id }
      } else {
        resolved = null
      }
    }

    let summaryText = ''
    if (resolved) {
      try {
        const started = Date.now()
        const apiKey = this.db.getProviderSecretKey(resolved.provider.id)
        const lm = createLanguageModelForProvider(resolved.provider, apiKey, resolved.modelId)
        const res = await generateText({
          model: lm,
          prompt: `请把以下对话历史压缩成一段简洁、高信息密度的中文上下文摘要（保留关键结论、技术细节、文件路径、未完成事项与约束条件，不超过 500 字）：\n\n${transcript.slice(0, 24_000)}`,
          maxOutputTokens: 700,
          abortSignal: AbortSignal.timeout(25_000)
        })
        summaryText = res.text.trim()
        this.db.insertUsage({
          threadId,
          category: 'aux',
          purpose: 'compact',
          providerId: resolved.provider.id,
          model: resolved.modelId,
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
          totalTokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
          latencyMs: Date.now() - started
        })
      } catch (err) {
        this.logger.warn(
          'Compact',
          `ToolModel compact failed, using extractive fallback: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    if (!summaryText) {
      const lines = candidates.map(m => {
        const label = m.role === 'user' ? '用户' : '助手'
        const txt = m.message.parts
          .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
          .map(p => p.text.replace(/\s+/g, ' ').trim())
          .join(' ')
          .slice(0, 140)
        return `- ${label}: ${txt}`
      })
      summaryText = `已压缩此前 ${candidates.length} 条对话消息：\n${lines.slice(-10).join('\n')}`
    }

    const summaryId = nanoid(12)
    const summaryMsg = this.db.insertMessage({
      id: summaryId,
      threadId,
      parentId: thread.activeLeafId,
      role: 'system',
      message: {
        id: summaryId,
        role: 'system',
        parts: [{ type: 'text', text: summaryText }]
      },
      metadata: {
        isCompactionSummary: true,
        compactedCount: candidates.length
      },
      setActiveLeaf: true
    })

    // Reset ACP session if thread used ACP so next turn starts fresh from the compacted summary
    const resolvedThreadModel = this.db.resolveModelString(thread.model)
    if (resolvedThreadModel?.provider.type === 'acp') {
      this.acpManager.releaseThreadSession(threadId, 'manual reset')
    }

    // Update estimated contextUsage downward after compaction
    const prevCtx = thread.metadata?.contextUsage as { size?: number } | undefined
    const ctxSize = prevCtx?.size || 200_000
    const nextUsed = Math.max(200, Math.ceil(summaryText.length * 1.2))
    const nextCtxUsage = { used: nextUsed, size: ctxSize, updatedAt: Date.now() }
    const updatedThread = this.db.updateThreadMetadata(
      threadId,
      { contextUsage: nextCtxUsage },
      this.getThreadStatus
    )
    if (updatedThread) {
      this.wsHub.broadcast('thread_updated', updatedThread)
    }
    this.wsHub.broadcast('context_usage_update', { threadId, ...nextCtxUsage })

    const refreshedMessages = this.db.getActiveBranchMessages(threadId)
    this.wsHub.broadcast('context_compacted', {
      threadId,
      summaryMessage: summaryMsg,
      compactedCount: candidates.length
    })
    this.wsHub.broadcast('thread_messages_replaced', {
      threadId,
      messages: refreshedMessages
    })

    return {
      compacted: true,
      summaryMessage: summaryMsg,
      messages: refreshedMessages
    }
  }
}
