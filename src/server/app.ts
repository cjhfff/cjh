import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { nanoid } from 'nanoid'
import { ZodError } from 'zod'
import {
  CronJobUpsertSchema,
  DataImportRequestSchema,
  McpServerUpsertSchema,
  PromptTemplateUpsertSchema,
  ProviderUpsertSchema,
  SettingsPatchSchema,
  ThreadCreateSchema,
  ThreadUpdateSchema,
  WsClientMessageSchema
} from '@shared/schemas'
import { AppPaths } from './paths'
import { TaggedLogger } from './logger'
import { AppDatabase } from './db/database'
import { WsHub } from './ws-hub'
import { GenerationEngine } from './engine/generation-engine'
import { AcpAgentManager } from './acp/manager'
import { McpHub } from './mcp/hub'
import { SkillsScanner } from './skills/scanner'
import { PortableUpdater } from './updater/portable-updater'
import { CronScheduler, computeNextRunAt, parseCronExpression, validateTimezone } from './cron/scheduler'
import { fetchProviderRemoteModels, testApiProviderConnection } from './providers/ai-provider'

export interface ServerContext {
  paths: AppPaths
  authToken: string
  getPort: () => number
  logger: TaggedLogger
  db: AppDatabase
  wsHub: WsHub
  acpManager: AcpAgentManager
  mcpHub: McpHub
  skillsScanner: SkillsScanner
  engine: GenerationEngine
  updater: PortableUpdater
  cronScheduler: CronScheduler
  requestUpdateInstall?: (opts?: { dryRun?: boolean }) => Promise<boolean> | boolean
}

async function readOptionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text()
  if (!raw.trim()) return {}
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SyntaxError('Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function normalizeProviderInput(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const obj = { ...(raw as Record<string, unknown>) }
  if (obj.acpPermissionMode === undefined && typeof obj.acp_permission_mode === 'string') {
    obj.acpPermissionMode = obj.acp_permission_mode
  }
  delete obj.acp_permission_mode
  return obj
}

export function createHttpApp(ctx: ServerContext): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json(
        {
          error: 'Validation failed',
          issues: err.issues
        },
        400
      )
    }
    if (err instanceof SyntaxError) {
      return c.json(
        {
          error: `Invalid JSON body: ${err.message}`
        },
        400
      )
    }
    if (err instanceof HTTPException) {
      return err.getResponse()
    }
    ctx.logger.error('HTTP', `Unhandled error on ${c.req.method} ${c.req.path}`, err)
    return c.json(
      {
        error: err instanceof Error ? err.message : 'Internal Server Error'
      },
      500
    )
  })

  app.use(
    '/api/*',
    cors({
      origin: origin => origin || '*',
      allowHeaders: ['Content-Type', 'Authorization', 'X-CJH-Token'],
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
    })
  )

  // Bearer / X-CJH-Token Auth Middleware on all /api/* routes
  app.use('/api/*', async (c, next) => {
    const authHeader = c.req.header('Authorization') || ''
    const xToken = c.req.header('X-CJH-Token') || ''
    const queryToken = c.req.query('token') || ''
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    const supplied = bearer || xToken || queryToken

    if (supplied !== ctx.authToken) {
      return c.json({ error: 'Unauthorized local API request' }, 401)
    }
    await next()
  })

  // ==================== Health & System ====================

  app.get('/api/health', c => {
    return c.json({
      ok: true,
      version: '0.1.0',
      port: ctx.getPort(),
      storageMode: ctx.paths.mode,
      dataDir: ctx.paths.dataDir,
      wsClients: ctx.wsHub.clientCount
    })
  })

  app.get('/api/settings', c => {
    return c.json(ctx.db.getSettings())
  })

  app.put('/api/settings', async c => {
    const body = await c.req.json()
    const parsed = SettingsPatchSchema.parse(body)
    const updated = ctx.db.updateSettings(parsed)
    ctx.wsHub.broadcast('settings_updated', updated)
    return c.json(updated)
  })

  app.get('/api/logs/recent', c => {
    const tag = c.req.query('tag') || undefined
    return c.json({
      logsDir: ctx.paths.logsDir,
      entries: ctx.logger.getRecent(tag, 200)
    })
  })

  app.get('/api/usage/stats', c => {
    const days = Number(c.req.query('days') || '30')
    return c.json(ctx.db.getUsageStats(days))
  })

  app.get('/api/data/export', c => {
    return c.json(ctx.db.exportAllData())
  })

  app.post('/api/data/import', async c => {
    const body = await c.req.json()
    const parsed = DataImportRequestSchema.parse(body)
    const result = ctx.db.importAllData(parsed.data, parsed.mode)
    ctx.wsHub.broadcast('settings_updated', ctx.db.getSettings())
    ctx.wsHub.broadcast('thread_created', {})
    ctx.wsHub.broadcast('provider_updated', {})
    ctx.wsHub.broadcast('cron_job_updated', {})
    void ctx.mcpHub.syncAllEnabled()
    return c.json({ ok: true, ...result })
  })

  // ==================== Portable Self-Update ====================

  app.get('/api/update/status', c => {
    return c.json(ctx.updater.getStatus())
  })

  app.post('/api/update/check', async c => {
    const body = await readOptionalJsonBody(c)
    const feedUrl = body.feedUrl || ctx.db.getSettings().update.feedUrl
    const status = await ctx.updater.check(String(feedUrl || ''))
    return c.json(status)
  })

  app.post('/api/update/download', async c => {
    const status = await ctx.updater.downloadAndStage()
    return c.json(status)
  })

  app.post('/api/update/install', async c => {
    const body = await readOptionalJsonBody(c)
    const dryRun = Boolean(body.dryRun)
    try {
      const status = ctx.updater.verifyStagedAndPrepareInstall()
      const triggered = ctx.requestUpdateInstall
        ? await ctx.requestUpdateInstall({ dryRun })
        : false
      return c.json({ ok: true, triggered, status })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // ==================== Providers & Models ====================

  app.get('/api/providers', c => {
    return c.json(ctx.db.listProviders())
  })

  app.post('/api/providers', async c => {
    const body = await c.req.json()
    const input = ProviderUpsertSchema.parse(normalizeProviderInput(body))
    const created = ctx.db.upsertProvider(input)
    ctx.wsHub.broadcast('provider_updated', created)
    return c.json(created, 201)
  })

  app.put('/api/providers/:id', async c => {
    const id = c.req.param('id')
    const existing = ctx.db.getProvider(id)
    if (!existing) return c.json({ error: 'Provider not found' }, 404)

    const body = normalizeProviderInput(await c.req.json())
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Request body must be a JSON object' }, 400)
    }
    const mergedInput = ProviderUpsertSchema.parse({
      ...existing,
      ...(body as Record<string, unknown>),
      id
    })
    const updated = ctx.db.upsertProvider(mergedInput, id)
    if (
      existing.type === 'acp' &&
      (existing.acpPermissionMode !== updated.acpPermissionMode ||
        existing.acpCommand !== updated.acpCommand ||
        existing.acpExecutablePath !== updated.acpExecutablePath ||
        existing.acpApiProviderId !== updated.acpApiProviderId ||
        JSON.stringify(existing.acpArgs) !== JSON.stringify(updated.acpArgs) ||
        JSON.stringify(existing.acpEnv) !== JSON.stringify(updated.acpEnv) ||
        JSON.stringify(existing.acpMcpServerIds) !== JSON.stringify(updated.acpMcpServerIds))
    ) {
      ctx.acpManager.releaseProviderSessions(id, 'provider config updated')
    }
    ctx.wsHub.broadcast('provider_updated', updated)
    return c.json(updated)
  })

  app.delete('/api/providers/:id', c => {
    const id = c.req.param('id')
    ctx.acpManager.releaseProviderSessions(id, 'provider deleted')
    const ok = ctx.db.deleteProvider(id)
    if (ok) ctx.wsHub.broadcast('provider_deleted', { id })
    return c.json({ ok })
  })

  app.post('/api/providers/:id/test', async c => {
    const id = c.req.param('id')
    const provider = ctx.db.getProvider(id)
    if (!provider) return c.json({ error: 'Provider not found' }, 404)

    if (provider.type === 'acp') {
      const started = Date.now()
      try {
        const res = await ctx.acpManager.discoverProviderModels(provider)
        const updatedProv = ctx.db.updateProviderAcpModeInfo(
          id,
          res.availableModes,
          res.currentModeId
        )
        if (updatedProv) ctx.wsHub.broadcast('provider_updated', updatedProv)
        const latencyMs = Date.now() - started
        return c.json({
          ok: true,
          latencyMs,
          availableModes: res.availableModes,
          currentModeId: res.currentModeId,
          message: `ACP 握手成功 (${latencyMs}ms)，解析到 ${res.models.length} 个模型`
        })
      } catch (err) {
        return c.json({
          ok: false,
          latencyMs: Date.now() - started,
          message: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const secretKey = ctx.db.getProviderSecretKey(id)
    const result = await testApiProviderConnection(provider, secretKey)
    return c.json(result)
  })

  app.post('/api/providers/:id/redetect', c => {
    const id = c.req.param('id')
    const provider = ctx.db.getProvider(id)
    if (!provider) return c.json({ error: 'Provider not found' }, 404)
    const info = ctx.acpManager.inspectCli(provider, true)
    return c.json(info)
  })

  app.get('/api/providers/:id/cli-info', c => {
    const id = c.req.param('id')
    const provider = ctx.db.getProvider(id)
    if (!provider) return c.json({ error: 'Provider not found' }, 404)
    return c.json(ctx.acpManager.inspectCli(provider, false))
  })

  app.post('/api/providers/:id/models/fetch', async c => {
    const id = c.req.param('id')
    const provider = ctx.db.getProvider(id)
    if (!provider) return c.json({ error: 'Provider not found' }, 404)

    if (provider.type === 'acp') {
      const discovered = await ctx.acpManager.discoverProviderModels(provider)
      ctx.db.updateProviderModels(id, discovered.models, discovered.models)
      const updated = ctx.db.updateProviderAcpModeInfo(
        id,
        discovered.availableModes,
        discovered.currentModeId
      )
      if (updated) ctx.wsHub.broadcast('provider_updated', updated)
      return c.json({
        models: discovered.models,
        availableModes: discovered.availableModes,
        currentModeId: discovered.currentModeId,
        agentInfo: discovered.agentInfo
      })
    }

    const secretKey = ctx.db.getProviderSecretKey(id)
    const remoteModels = await fetchProviderRemoteModels(provider, secretKey)
    // Keep existing enabled selections; if none existed yet, auto-enable up to first 5 models for convenience
    const hasAnyEnabled = provider.models.some(m => m.enabled)
    const nextEnabledModels = hasAnyEnabled
      ? remoteModels.filter(m => m.enabled)
      : remoteModels.slice(0, 6).map(m => ({ ...m, enabled: true }))

    const mergedAvailable = remoteModels.map(m => ({
      ...m,
      enabled: nextEnabledModels.some(e => e.id === m.id)
    }))

    const updated = ctx.db.updateProviderModels(id, nextEnabledModels, mergedAvailable)
    if (updated) ctx.wsHub.broadcast('provider_updated', updated)
    return c.json({ models: mergedAvailable })
  })

  app.get('/api/models', c => {
    return c.json(ctx.db.listCompositeModels())
  })

  // ==================== Threads & Messages ====================

  app.get('/api/threads', c => {
    const includeArchived = c.req.query('archived') === '1'
    return c.json(ctx.db.listThreads(ctx.engine.getThreadStatus, includeArchived))
  })

  app.get('/api/search', c => {
    const q = c.req.query('q') || ''
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '30')))
    return c.json(ctx.db.search(q, limit, ctx.engine.getThreadStatus))
  })

  app.post('/api/threads', async c => {
    const body = await readOptionalJsonBody(c)
    const parsed = ThreadCreateSchema.parse(body)
    const created = ctx.db.createThread(parsed)
    ctx.wsHub.broadcast('thread_created', created)
    return c.json(created, 201)
  })

  app.get('/api/threads/:id', c => {
    const t = ctx.db.getThread(c.req.param('id'), ctx.engine.getThreadStatus)
    if (!t) return c.json({ error: 'Thread not found' }, 404)
    return c.json(t)
  })

  app.put('/api/threads/:id', async c => {
    const id = c.req.param('id')
    const prev = ctx.db.getThread(id)
    if (!prev) return c.json({ error: 'Thread not found' }, 404)
    const body = await c.req.json()
    const parsed = ThreadUpdateSchema.parse(body)
    const updated = ctx.db.updateThread(id, parsed, ctx.engine.getThreadStatus)
    if (!updated) return c.json({ error: 'Thread not found' }, 404)

    const cwdChanged = prev.workspacePath !== updated.workspacePath
    const prevProvId = ctx.db.resolveModelString(prev.model)?.provider.id
    const nextProvId = ctx.db.resolveModelString(updated.model)?.provider.id
    const providerChanged = prev.model !== updated.model && prevProvId !== nextProvId
    if (cwdChanged || providerChanged) {
      ctx.acpManager.releaseThreadSession(id, cwdChanged ? 'cwd changed' : 'provider changed')
    }

    const fresh = ctx.db.getThread(id, ctx.engine.getThreadStatus) || updated
    ctx.wsHub.broadcast('thread_updated', fresh)
    return c.json(fresh)
  })

  app.delete('/api/threads/:id', c => {
    const id = c.req.param('id')
    ctx.engine.stopGeneration(id)
    ctx.acpManager.releaseThreadSession(id, 'thread deleted')
    const ok = ctx.db.deleteThread(id)
    if (ok) ctx.wsHub.broadcast('thread_deleted', { id })
    return c.json({ ok })
  })

  app.post('/api/threads/batch-delete', async c => {
    const body = (await c.req.json()) as { ids?: string[] }
    if (!body || typeof body !== 'object' || !Array.isArray(body.ids)) {
      return c.json({ error: 'Request body must include ids array' }, 400)
    }
    const ids = body.ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    for (const id of ids) {
      ctx.engine.stopGeneration(id)
      ctx.acpManager.releaseThreadSession(id, 'thread deleted')
    }
    const count = ctx.db.batchDeleteThreads(ids)
    for (const id of ids) ctx.wsHub.broadcast('thread_deleted', { id })
    return c.json({ deleted: count })
  })

  app.post('/api/threads/:id/archive', c => {
    const id = c.req.param('id')
    ctx.engine.stopGeneration(id)
    ctx.acpManager.releaseThreadSession(id, 'idle timeout')
    const updated = ctx.db.updateThread(id, { archived: true }, ctx.engine.getThreadStatus)
    if (!updated) return c.json({ error: 'Thread not found' }, 404)
    ctx.wsHub.broadcast('thread_updated', updated)
    return c.json(updated)
  })

  app.post('/api/threads/:id/unarchive', c => {
    const id = c.req.param('id')
    const updated = ctx.db.updateThread(id, { archived: false }, ctx.engine.getThreadStatus)
    if (!updated) return c.json({ error: 'Thread not found' }, 404)
    ctx.wsHub.broadcast('thread_updated', updated)
    return c.json(updated)
  })

  app.get('/api/threads/:id/messages', c => {
    const id = c.req.param('id')
    const messages = ctx.db.getActiveBranchMessages(id)
    const pendingPermissions = ctx.acpManager.getPendingPermissionsForThread(id)
    return c.json({ messages, pendingPermissions })
  })

  app.post('/api/threads/:id/regenerate-title', async c => {
    const id = c.req.param('id')
    const title = await ctx.engine.maybeGenerateThreadTitle(id, undefined, true)
    return c.json({ title })
  })

  app.post('/api/threads/:id/compact', async c => {
    const id = c.req.param('id')
    const thread = ctx.db.getThread(id)
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    const result = await ctx.engine.compactThreadContext(id)
    return c.json(result)
  })

  app.post('/api/threads/:id/branch', async c => {
    const id = c.req.param('id')
    const body = await readOptionalJsonBody(c)
    const messageId = typeof body.messageId === 'string' ? body.messageId : undefined
    const title = typeof body.title === 'string' ? body.title : undefined
    const branched = ctx.db.branchThread(id, messageId, title)
    if (!branched) return c.json({ error: 'Thread not found' }, 404)
    ctx.wsHub.broadcast('thread_created', branched.thread)
    return c.json(branched, 201)
  })

  // ==================== Thread Workspace Readonly Panel (B7) ====================

  const resolveSafeWorkspacePath = (workspaceRoot: string, relInput: string): string | null => {
    const root = resolve(workspaceRoot)
    const cleanRel = relInput.replace(/^[/\\]+/, '')
    const target = resolve(root, cleanRel)
    if (target !== root && !target.startsWith(root + sep)) {
      return null
    }
    return target
  }

  app.get('/api/threads/:id/workspace/tree', c => {
    const id = c.req.param('id')
    const thread = ctx.db.getThread(id)
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    if (!thread.workspacePath || !existsSync(thread.workspacePath)) {
      return c.json({ error: 'Workspace path not bound or missing' }, 400)
    }

    const relDir = c.req.query('dir') || ''
    const targetDir = resolveSafeWorkspacePath(thread.workspacePath, relDir)
    if (!targetDir) return c.json({ error: 'Invalid workspace path' }, 403)
    if (!existsSync(targetDir)) return c.json({ error: 'Directory not found' }, 404)

    const root = resolve(thread.workspacePath)
    const entries = readdirSync(targetDir, { withFileTypes: true })
      .filter(e => e.name !== '.git' && e.name !== 'node_modules')
      .slice(0, 300)
      .map(e => {
        const full = join(targetDir, e.name)
        let size = 0
        if (!e.isDirectory()) {
          try {
            size = statSync(full).size
          } catch {
            size = 0
          }
        }
        return {
          name: e.name,
          relPath: relative(root, full).replace(/\\/g, '/'),
          isDir: e.isDirectory(),
          size
        }
      })
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))

    return c.json({ workspacePath: root, dir: relDir, entries })
  })

  app.get('/api/threads/:id/workspace/file', c => {
    const id = c.req.param('id')
    const thread = ctx.db.getThread(id)
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    if (!thread.workspacePath) {
      return c.json({ error: 'Workspace path not bound' }, 400)
    }

    const relPath = c.req.query('path') || ''
    if (!relPath) return c.json({ error: 'Missing path query' }, 400)
    const targetFile = resolveSafeWorkspacePath(thread.workspacePath, relPath)
    if (!targetFile) return c.json({ error: 'Invalid workspace path' }, 403)
    if (!existsSync(targetFile)) return c.json({ error: 'File not found' }, 404)

    const stat = statSync(targetFile)
    if (stat.isDirectory()) return c.json({ error: 'Path is a directory' }, 400)
    const maxBytes = 200 * 1024
    const buf = readFileSync(targetFile)
    const sliced = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf
    const isBinary = sliced.includes(0)
    return c.json({
      path: relPath,
      size: stat.size,
      truncated: buf.byteLength > maxBytes,
      binary: isBinary,
      content: isBinary ? '' : sliced.toString('utf8')
    })
  })

  app.get('/api/threads/:id/workspace/git', c => {
    const id = c.req.param('id')
    const thread = ctx.db.getThread(id)
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    if (!thread.workspacePath || !existsSync(thread.workspacePath)) {
      return c.json({ error: 'Workspace path not bound or missing' }, 400)
    }

    const root = resolve(thread.workspacePath)
    const statusRun = spawnSync('git', ['status', '--porcelain=v1', '-b'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5000
    })

    if (statusRun.status !== 0) {
      return c.json({ isGitRepo: false, branch: null, files: [], diff: '' })
    }

    const lines = (statusRun.stdout || '').split(/\r?\n/).filter(Boolean)
    let branch: string | null = null
    const files: Array<{ status: string; path: string }> = []
    for (const line of lines) {
      if (line.startsWith('## ')) {
        branch = line.slice(3).split('...')[0].trim()
      } else if (line.length >= 4) {
        files.push({
          status: line.slice(0, 2).trim() || '?',
          path: line.slice(3).trim()
        })
      }
    }

    const diffRun = spawnSync('git', ['diff', '--no-color'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5000
    })
    const cachedRun = spawnSync('git', ['diff', '--cached', '--no-color'], {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 5000
    })
    const combinedDiff = [cachedRun.stdout || '', diffRun.stdout || ''].filter(Boolean).join('\n')

    return c.json({
      isGitRepo: true,
      branch,
      files,
      diff: combinedDiff.slice(0, 120_000)
    })
  })

  app.get('/api/threads/:id/acp-commands', c => {
    return c.json({ commands: ctx.acpManager.getThreadCommands(c.req.param('id')) })
  })

  app.post('/api/threads/:id/acp-reset', c => {
    const id = c.req.param('id')
    const thread = ctx.db.getThread(id)
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    const released = ctx.acpManager.releaseThreadSession(id, 'manual reset')
    const fresh = ctx.db.getThread(id, ctx.engine.getThreadStatus)
    if (fresh) ctx.wsHub.broadcast('thread_updated', fresh)
    return c.json({ ok: true, released })
  })

  app.post('/api/threads/:id/acp-mode', async c => {
    const id = c.req.param('id')
    const thread = ctx.db.getThread(id)
    if (!thread) return c.json({ error: 'Thread not found' }, 404)
    const body = (await c.req.json()) as { modeId?: unknown }
    if (!body || typeof body.modeId !== 'string' || !body.modeId.trim()) {
      return c.json({ error: 'Missing modeId' }, 400)
    }
    const resolved = ctx.db.resolveModelString(thread.model)
    try {
      const result = await ctx.acpManager.setThreadMode(
        id,
        body.modeId,
        resolved?.provider.type === 'acp' ? resolved.provider : null
      )
      const fresh = ctx.db.getThread(id, ctx.engine.getThreadStatus)
      return c.json({ ok: true, thread: fresh, ...result })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  })

  // CLI convenience endpoint: trigger generation via HTTP POST too (routes into exact same engine!)
  app.post('/api/threads/:id/generate', async c => {
    const threadId = c.req.param('id')
    const body = await c.req.json()
    const parsed = WsClientMessageSchema.parse({
      type: 'generate_response',
      data: { ...body, threadId }
    })
    if (parsed.type === 'generate_response') {
      ctx.engine.steerOrGenerate(parsed.data)
    }
    return c.json({ accepted: true, threadId })
  })

  app.post('/api/messages/:id/switch-version', c => {
    const res = ctx.db.switchMessageVersion(c.req.param('id'))
    if (!res) return c.json({ error: 'Message not found' }, 404)
    const messages = ctx.db.getActiveBranchMessages(res.threadId)
    return c.json({ ...res, messages })
  })

  app.post('/api/messages/:id/rollback', c => {
    const res = ctx.db.rollbackToMessage(c.req.param('id'))
    if (!res) return c.json({ error: 'Message not found' }, 404)
    const messages = ctx.db.getActiveBranchMessages(res.threadId)
    return c.json({ ...res, messages })
  })

  app.get('/api/messages/:id/trace', c => {
    const trace = ctx.db.getTraceByMessageId(c.req.param('id'))
    if (!trace) return c.json({ error: 'Trace not found' }, 404)
    return c.json(trace)
  })

  app.get('/api/threads/:id/traces', c => {
    const id = c.req.param('id')
    if (!ctx.db.getThread(id)) return c.json({ error: 'Thread not found' }, 404)
    return c.json(ctx.db.listTracesForThread(id))
  })

  // ==================== Attachments ====================

  app.post('/api/attachments', async c => {
    const form = await c.req.formData()
    const file = form.get('file')
    const threadId = form.get('threadId')?.toString() || null

    if (!(file instanceof File)) {
      return c.json({ error: 'Missing file field' }, 400)
    }

    const id = nanoid(12)
    const ext = extname(file.name) || '.bin'
    const safeRelName = `${id}${ext.replace(/[^a-zA-Z0-9._-]/g, '')}`
    const fullPath = join(ctx.paths.attachmentsDir, safeRelName)
    const bytes = Buffer.from(await file.arrayBuffer())
    writeFileSync(fullPath, bytes)

    const saved = ctx.db.insertAttachment({
      id,
      threadId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      byteSize: bytes.byteLength,
      relPath: safeRelName
    })

    return c.json(saved, 201)
  })

  app.get('/api/attachments/:id', c => {
    const att = ctx.db.getAttachment(c.req.param('id'))
    if (!att) return c.json({ error: 'Attachment not found' }, 404)
    const full = join(ctx.paths.attachmentsDir, att.relPath)
    if (!existsSync(full)) return c.json({ error: 'Attachment file missing' }, 404)
    const data = readFileSync(full)
    return new Response(data, {
      headers: {
        'Content-Type': att.mimeType,
        'Content-Length': String(att.byteSize)
      }
    })
  })

  // ==================== Permissions ====================

  app.post('/api/permissions/:requestId/respond', async c => {
    const requestId = c.req.param('requestId')
    const body = (await c.req.json()) as { optionId?: string }
    if (!body.optionId) return c.json({ error: 'Missing optionId' }, 400)
    const ok = ctx.acpManager.resolvePermission(requestId, body.optionId)
    return c.json({ ok })
  })

  // ==================== MCP & Skills ====================

  app.get('/api/mcp-servers', c => {
    return c.json(ctx.mcpHub.getRuntimeList())
  })

  app.post('/api/mcp-servers', async c => {
    const input = McpServerUpsertSchema.parse(await c.req.json())
    const saved = ctx.db.upsertMcpServer(input)
    if (saved.enabled) {
      void ctx.mcpHub.connectOne(saved.id)
    }
    return c.json(saved, 201)
  })

  app.put('/api/mcp-servers/:id', async c => {
    const id = c.req.param('id')
    const input = McpServerUpsertSchema.parse(await c.req.json())
    const saved = ctx.db.upsertMcpServer(input, id)
    if (saved.enabled) {
      void ctx.mcpHub.connectOne(saved.id)
    } else {
      void ctx.mcpHub.disconnectOne(saved.id)
    }
    return c.json(saved)
  })

  app.delete('/api/mcp-servers/:id', async c => {
    const id = c.req.param('id')
    await ctx.mcpHub.disconnectOne(id)
    const ok = ctx.db.deleteMcpServer(id)
    return c.json({ ok })
  })

  app.post('/api/mcp-servers/:id/reconnect', async c => {
    const id = c.req.param('id')
    await ctx.mcpHub.connectOne(id)
    return c.json(ctx.mcpHub.getRuntimeList().find(s => s.id === id) || { ok: true })
  })

  app.get('/api/skills', c => {
    return c.json(ctx.skillsScanner.list())
  })

  app.post('/api/skills/refresh', c => {
    return c.json(ctx.skillsScanner.scan())
  })

  app.put('/api/skills/:id', async c => {
    const id = decodeURIComponent(c.req.param('id'))
    const body = (await c.req.json()) as { enabled?: boolean }
    const updated = ctx.skillsScanner.setEnabled(id, Boolean(body.enabled))
    if (!updated) return c.json({ error: 'Skill not found' }, 404)
    return c.json(updated)
  })

  // ==================== Prompts Library (B5) ====================

  app.get('/api/prompts', c => {
    return c.json(ctx.db.listPrompts())
  })

  app.post('/api/prompts', async c => {
    const input = PromptTemplateUpsertSchema.parse(await c.req.json())
    const saved = ctx.db.upsertPrompt(input)
    ctx.wsHub.broadcast('prompts_updated', saved)
    return c.json(saved, 201)
  })

  app.put('/api/prompts/:id', async c => {
    const id = c.req.param('id')
    if (!ctx.db.getPrompt(id)) return c.json({ error: 'Prompt not found' }, 404)
    const input = PromptTemplateUpsertSchema.parse(await c.req.json())
    const saved = ctx.db.upsertPrompt(input, id)
    ctx.wsHub.broadcast('prompts_updated', saved)
    return c.json(saved)
  })

  app.delete('/api/prompts/:id', c => {
    const ok = ctx.db.deletePrompt(c.req.param('id'))
    if (ok) ctx.wsHub.broadcast('prompts_updated', { id: c.req.param('id') })
    return c.json({ ok })
  })

  // ==================== Cron Jobs ====================

  app.get('/api/cron', c => {
    return c.json(ctx.db.listCronJobs())
  })

  app.post('/api/cron', async c => {
    const input = CronJobUpsertSchema.parse(await c.req.json())
    try {
      parseCronExpression(input.cronExpr)
      validateTimezone(input.timezone)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
    const nextRunAt = input.enabled ? computeNextRunAt(input.cronExpr, input.timezone) : null
    const saved = ctx.db.upsertCronJob({ ...input, nextRunAt })
    ctx.wsHub.broadcast('cron_job_updated', saved)
    return c.json(saved, 201)
  })

  app.put('/api/cron/:id', async c => {
    const id = c.req.param('id')
    const existing = ctx.db.getCronJob(id)
    if (!existing) return c.json({ error: 'Cron job not found' }, 404)
    const body = await c.req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'Request body must be a JSON object' }, 400)
    }
    const merged = CronJobUpsertSchema.parse({
      ...existing,
      ...(body as Record<string, unknown>),
      id
    })
    try {
      parseCronExpression(merged.cronExpr)
      validateTimezone(merged.timezone)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
    const nextRunAt = merged.enabled ? computeNextRunAt(merged.cronExpr, merged.timezone) : null
    const updated = ctx.db.upsertCronJob({ ...merged, nextRunAt }, id)
    ctx.wsHub.broadcast('cron_job_updated', updated)
    return c.json(updated)
  })

  app.delete('/api/cron/:id', c => {
    const ok = ctx.db.deleteCronJob(c.req.param('id'))
    return c.json({ ok })
  })

  app.post('/api/cron/:id/toggle', async c => {
    const id = c.req.param('id')
    const existing = ctx.db.getCronJob(id)
    if (!existing) return c.json({ error: 'Cron job not found' }, 404)
    const body = await readOptionalJsonBody(c)
    const nextEnabled = typeof body.enabled === 'boolean' ? body.enabled : !existing.enabled
    const nextRunAt = nextEnabled
      ? computeNextRunAt(existing.cronExpr, existing.timezone)
      : null
    const updated = ctx.db.updateCronJobRuntime(id, { enabled: nextEnabled, nextRunAt })
    if (updated) ctx.wsHub.broadcast('cron_job_updated', updated)
    return c.json(updated)
  })

  app.post('/api/cron/:id/run', async c => {
    const id = c.req.param('id')
    const run = await ctx.cronScheduler.triggerNow(id)
    if (!run) return c.json({ error: 'Cron job not found' }, 404)
    return c.json(run)
  })

  app.get('/api/cron/:id/runs', c => {
    const id = c.req.param('id')
    const existing = ctx.db.getCronJob(id)
    if (!existing) return c.json({ error: 'Cron job not found' }, 404)
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') || '50')))
    return c.json(ctx.db.listCronRuns(id, limit))
  })

  // Serve built renderer UI on `/` and `/assets/*` for local webview / headless preview
  const here = dirname(fileURLToPath(import.meta.url))
  const rendererDir = resolve(here, '../renderer')
  app.get('*', c => {
    const reqPath = c.req.path === '/' ? '/index.html' : c.req.path
    if (reqPath.startsWith('/api/')) return c.notFound()
    const target = resolve(rendererDir, '.' + reqPath)
    if (!target.startsWith(rendererDir) || !existsSync(target)) {
      return c.notFound()
    }
    const ext = extname(target).toLowerCase()
    const mime =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.js' || ext === '.mjs'
            ? 'application/javascript; charset=utf-8'
            : ext === '.svg'
              ? 'image/svg+xml'
              : 'application/octet-stream'
    return new Response(readFileSync(target), { headers: { 'Content-Type': mime } })
  })

  return app
}
