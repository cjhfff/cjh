import { Context, Hono } from 'hono'
import { ZodError } from 'zod'
import {
  HERDR_WS_EVENTS,
  HerdrAnswerRequestSchema,
  HerdrClientLike,
  HerdrFollowManagerLike,
  HerdrFollowRequestSchema,
  HerdrInterruptRequestSchema,
  HerdrKeysRequestSchema,
  HerdrLabelRequestSchema,
  HerdrMuteRequestSchema,
  HerdrPutRequestSchema,
  HerdrRunRequestSchema,
  HerdrSendRequestSchema
} from '@shared/herdr-types'
import { AppDatabase } from '../db/database'
import { WsHub } from '../ws-hub'
import { HerdrRpcError, HerdrUnavailableError } from './client'

export interface HerdrRouteDeps {
  herdrClient: HerdrClientLike
  followManager?: HerdrFollowManagerLike
  db: AppDatabase
  wsHub: WsHub
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

function mapRpcKindToHttpStatus(kind: string): 400 | 404 | 409 | 503 | 500 {
  switch (kind) {
    case 'not_found':
    case 'machine_unknown':
      return 404
    case 'blocked':
    case 'name_taken':
    case 'live':
    case 'finished':
    case 'status_mismatch':
    case 'conflict':
    case 'already_added':
      return 409
    case 'invalid_params':
    case 'invalid_template':
    case 'config':
    case 'needs_target':
      return 400
    case 'unavailable':
    case 'spawn_failed':
      return 503
    default:
      return 500
  }
}

function handleHerdrError(c: Context, err: unknown): Response {
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
  if (err instanceof HerdrUnavailableError) {
    return c.json(
      {
        error: err.message,
        available: false,
        reason: err.reason
      },
      503
    )
  }
  if (err instanceof HerdrRpcError) {
    const status = mapRpcKindToHttpStatus(err.kind)
    return c.json(
      {
        error: err.message,
        kind: err.kind,
        code: err.rpcCode,
        ...(err.hint ? { hint: err.hint } : {})
      },
      status
    )
  }
  return c.json(
    {
      error: err instanceof Error ? err.message : 'Internal Server Error'
    },
    500
  )
}

export function registerHerdrRoutes(app: Hono, deps: HerdrRouteDeps): void {
  const { herdrClient, followManager, wsHub } = deps

  app.get('/api/herdr/status', c => {
    return c.json(herdrClient.getStatus())
  })

  app.get('/api/herdr/terminals', async c => {
    const all = c.req.query('all') === '1' || c.req.query('all') === 'true'
    try {
      const res = await herdrClient.listTerminals({ all })
      return c.json(res)
    } catch (err) {
      if (err instanceof HerdrUnavailableError) {
        return c.json({
          available: false,
          reason: err.reason,
          terminals: [],
          hiddenFinished: 0,
          machines: []
        })
      }
      return handleHerdrError(c, err)
    }
  })

  app.get('/api/herdr/workspaces', async c => {
    const all = c.req.query('all') === '1' || c.req.query('all') === 'true'
    try {
      const res = await herdrClient.listWorkspaces(all)
      return c.json(res)
    } catch (err) {
      if (err instanceof HerdrUnavailableError) {
        return c.json({
          available: false,
          reason: err.reason,
          workspaces: []
        })
      }
      return handleHerdrError(c, err)
    }
  })

  app.get('/api/herdr/terminals/:t', async c => {
    try {
      const terminal = await herdrClient.getTerminal(c.req.param('t'))
      return c.json(terminal)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.get('/api/herdr/terminals/:t/screen', async c => {
    try {
      const rawLines = Number(c.req.query('lines') || '0')
      const lines = Number.isFinite(rawLines) && rawLines >= 0 ? Math.floor(rawLines) : 0
      const screen = await herdrClient.readTerminal(c.req.param('t'), lines)
      return c.json(screen)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals', async c => {
    try {
      const parsed = HerdrRunRequestSchema.parse(await c.req.json())
      const terminal = await herdrClient.runTerminal(parsed)
      if (parsed.followThreadId && followManager) {
        const binding = followManager.follow(terminal.address, parsed.followThreadId)
        terminal.followedByThreadId = parsed.followThreadId
        wsHub.broadcast(HERDR_WS_EVENTS.FOLLOW_UPDATED, {
          action: 'follow',
          binding,
          follows: followManager.listFollows()
        })
      }
      return c.json(terminal, 201)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/send', async c => {
    try {
      const target = c.req.param('t')
      const parsed = HerdrSendRequestSchema.parse(await c.req.json())
      const result = await herdrClient.sendTerminal(target, parsed)
      if (parsed.followThreadId && followManager) {
        const addr = herdrClient.getCachedTerminal(target)?.address || target
        const binding = followManager.follow(addr, parsed.followThreadId)
        wsHub.broadcast(HERDR_WS_EVENTS.FOLLOW_UPDATED, {
          action: 'follow',
          binding,
          follows: followManager.listFollows()
        })
      }
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/keys', async c => {
    try {
      const parsed = HerdrKeysRequestSchema.parse(await c.req.json())
      const result = await herdrClient.keysTerminal(c.req.param('t'), parsed.keys)
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/interrupt', async c => {
    try {
      const body = await readOptionalJsonBody(c)
      const parsed = HerdrInterruptRequestSchema.parse(body)
      const result = await herdrClient.interruptTerminal(c.req.param('t'), parsed.timeout)
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/answer', async c => {
    try {
      const parsed = HerdrAnswerRequestSchema.parse(await c.req.json())
      const result = await herdrClient.answerTerminal(c.req.param('t'), parsed)
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.delete('/api/herdr/terminals/:t', async c => {
    try {
      const queryConfirm = c.req.query('confirm')
      let confirmed = queryConfirm === '1' || queryConfirm === 'true'
      if (!confirmed) {
        const body = await readOptionalJsonBody(c)
        confirmed = body.confirm === true
      }
      if (!confirmed) {
        return c.json({ error: '需要二次确认 (confirm=true)' }, 400)
      }
      const result = await herdrClient.killTerminal(c.req.param('t'))
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/rm', async c => {
    try {
      const target = c.req.param('t')
      const resolvedAddr = herdrClient.getCachedTerminal(target)?.address || target
      const result = await herdrClient.rmTerminal(target)
      if (followManager) {
        const removedFollow = followManager.unfollow(resolvedAddr) || followManager.unfollow(target)
        if (removedFollow) {
          wsHub.broadcast(HERDR_WS_EVENTS.FOLLOW_UPDATED, {
            action: 'unfollow',
            terminal: resolvedAddr,
            follows: followManager.listFollows()
          })
        }
      }
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/label', async c => {
    try {
      const parsed = HerdrLabelRequestSchema.parse(await c.req.json())
      const result = await herdrClient.labelTerminal(c.req.param('t'), parsed.labels)
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/mute', async c => {
    try {
      const parsed = HerdrMuteRequestSchema.parse(await c.req.json())
      const result = await herdrClient.setMuted(c.req.param('t'), parsed.muted)
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.post('/api/herdr/terminals/:t/put', async c => {
    try {
      const contentType = (c.req.header('content-type') || '').toLowerCase()
      let name: string
      let data: string

      if (contentType.includes('multipart/form-data')) {
        const form = await c.req.formData()
        const file = form.get('file')
        if (!file || typeof file === 'string') {
          return c.json({ error: '缺少上传文件 (file)' }, 400)
        }
        const customName = form.get('name')
        name =
          typeof customName === 'string' && customName.trim()
            ? customName.trim()
            : file.name || 'upload.bin'
        const buf = Buffer.from(await file.arrayBuffer())
        data = buf.toString('base64')
      } else {
        const parsed = HerdrPutRequestSchema.parse(await c.req.json())
        name = parsed.name
        data = parsed.data
      }

      const result = await herdrClient.putFile(c.req.param('t'), name, data)
      return c.json(result)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.get('/api/herdr/machines', async c => {
    try {
      const machines = await herdrClient.listMachines()
      return c.json({ machines })
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.get('/api/herdr/templates', async c => {
    try {
      const templates = await herdrClient.listTemplates()
      return c.json({ templates })
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.get('/api/herdr/follows', c => {
    return c.json({
      follows: followManager ? followManager.listFollows() : []
    })
  })

  app.post('/api/herdr/terminals/:t/follow', async c => {
    try {
      if (!followManager) {
        return c.json({ error: 'Follow manager not initialized' }, 503)
      }
      const parsed = HerdrFollowRequestSchema.parse(await c.req.json())
      const target = c.req.param('t')
      const addr = herdrClient.getCachedTerminal(target)?.address || target
      const binding = followManager.follow(addr, parsed.threadId)
      wsHub.broadcast(HERDR_WS_EVENTS.FOLLOW_UPDATED, {
        action: 'follow',
        binding,
        follows: followManager.listFollows()
      })
      return c.json(binding)
    } catch (err) {
      return handleHerdrError(c, err)
    }
  })

  app.delete('/api/herdr/terminals/:t/follow', c => {
    if (!followManager) {
      return c.json({ error: 'Follow manager not initialized' }, 503)
    }
    const target = c.req.param('t')
    const addr = herdrClient.getCachedTerminal(target)?.address || target
    const ok = followManager.unfollow(addr) || followManager.unfollow(target)
    if (ok) {
      wsHub.broadcast(HERDR_WS_EVENTS.FOLLOW_UPDATED, {
        action: 'unfollow',
        terminal: addr,
        follows: followManager.listFollows()
      })
    }
    return c.json({ ok })
  })
}
