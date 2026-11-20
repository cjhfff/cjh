import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { WebSocketServer } from 'ws'
import { WsClientMessage, WsClientMessageSchema, HerdrClientLike } from '@shared/schemas'
import { resolveAppPaths } from './paths'
import { TaggedLogger } from './logger'
import { SecretVault } from './crypto/vault'
import { AppDatabase } from './db/database'
import { WsHub } from './ws-hub'
import { AcpAgentManager } from './acp/manager'
import { McpHub } from './mcp/hub'
import { MemoryStore } from './memory/store'
import { PermissionGate } from './permissions/gate'
import { SkillsScanner } from './skills/scanner'
import { GenerationEngine } from './engine/generation-engine'
import { PortableUpdater } from './updater/portable-updater'
import { CronScheduler } from './cron/scheduler'
import { FeishuBridge, FeishuSdkFactory } from './channels/feishu'
import { HerdrClient, HerdrFollowManager, HerdrNotifier } from './herdr'
import { createHttpApp, ServerContext } from './app'

export interface RunningDaemon {
  port: number
  authToken: string
  ctx: ServerContext
  shutdown: () => Promise<void>
}

export async function startLocalDaemon(opts?: {
  port?: number
  authToken?: string
  masterKeyHex?: string
  feishuSdkFactory?: FeishuSdkFactory
  herdrClient?: HerdrClientLike
  herdrExecPath?: string | null
  onRequestUpdateInstall?: (opts?: { dryRun?: boolean }) => Promise<boolean> | boolean
}): Promise<RunningDaemon> {
  const envToken = process.env.CJH_LOCAL_TOKEN
  const envMasterKey = process.env.CJH_MASTER_KEY_HEX
  delete process.env.CJH_LOCAL_TOKEN
  delete process.env.CJH_MASTER_KEY_HEX

  const paths = resolveAppPaths()
  const logger = new TaggedLogger(paths.logsDir)
  const authToken = opts?.authToken || envToken || randomBytes(32).toString('hex')
  const vault = new SecretVault(opts?.masterKeyHex || envMasterKey, paths.masterKeyPath)

  const db = new AppDatabase(paths.dbPath, vault)
  const wsHub = new WsHub()
  let boundPort = opts?.port ?? Number(process.env.CJH_PORT || 0)

  const mcpHub = new McpHub(db, logger, () => {
    wsHub.broadcast('mcp_status_changed', mcpHub.getRuntimeList())
  })
  const skillsScanner = new SkillsScanner(db, paths.skillsDir, paths.builtinSkillsDir)
  skillsScanner.scan()

  const memoryStore = new MemoryStore(db, paths.memoryDir)
  memoryStore.syncFromDisk()

  let engineRef: GenerationEngine | null = null

  const onPermissionRequested = (permDto: Parameters<ConstructorParameters<typeof PermissionGate>[2]>[0]) => {
    wsHub.broadcast('permission_requested', permDto)
    engineRef?.notifyPermissionStateChanged(permDto.threadId)
  }
  const onPermissionResolved = (
    resolvedPayload: Parameters<ConstructorParameters<typeof PermissionGate>[3]>[0]
  ) => {
    wsHub.broadcast('permission_resolved', resolvedPayload)
    engineRef?.notifyPermissionStateChanged(resolvedPayload.threadId)
  }

  const permissionGate = new PermissionGate(db, logger, onPermissionRequested, onPermissionResolved)

  const acpManager = new AcpAgentManager(
    db,
    logger,
    () => ({
      apiUrl: `http://127.0.0.1:${boundPort}`,
      apiToken: authToken
    }),
    onPermissionRequested,
    onPermissionResolved,
    {
      permissionGate,
      onThreadMetadataChanged: updatedThread => {
        wsHub.broadcast('thread_updated', updatedThread)
      },
      onModeUpdated: payload => {
        wsHub.broadcast('acp_mode_updated', payload)
      },
      onProviderModeDiscovered: updatedProv => {
        wsHub.broadcast('provider_updated', updatedProv)
      },
      onCommandsUpdated: payload => {
        wsHub.broadcast('acp_commands_updated', payload)
      }
    }
  )

  const engine = new GenerationEngine(
    db,
    wsHub,
    logger,
    acpManager,
    mcpHub,
    skillsScanner,
    paths.attachmentsDir,
    permissionGate,
    memoryStore,
    () => ({
      apiUrl: `http://127.0.0.1:${boundPort}`,
      apiToken: authToken
    })
  )
  engineRef = engine

  const dispatchWsClientMessage = (rawMsg: WsClientMessage) => {
    const parsed = WsClientMessageSchema.parse(rawMsg)
    if (parsed.type === 'generate_response' || parsed.type === 'steer_generation') {
      engine.steerOrGenerate(parsed.data)
    } else if (parsed.type === 'stop_generation') {
      engine.stopGeneration(parsed.data.threadId)
    } else if (parsed.type === 'permission_response') {
      permissionGate.resolvePermission(parsed.data.requestId, parsed.data.optionId)
    }
  }

  const updater = new PortableUpdater('0.1.0', paths.updatesStagingDir)
  const feishuBridge = new FeishuBridge(
    db,
    wsHub,
    logger,
    dispatchWsClientMessage,
    opts?.feishuSdkFactory
  )
  const cronScheduler = new CronScheduler(db, engine, wsHub, logger, 15_000, feishuBridge)

  let herdrFollowManagerRef: HerdrFollowManager | null = null
  const shouldAutoStartHerdr =
    Boolean(opts?.herdrClient) || opts?.herdrExecPath !== undefined || !process.env.VITEST
  const herdrClient: HerdrClientLike =
    opts?.herdrClient ||
    new HerdrClient(db, logger, wsHub, {
      execPathOverride:
        opts?.herdrExecPath !== undefined
          ? opts.herdrExecPath
          : process.env.VITEST
            ? '__vitest_herdr_disabled__'
            : undefined,
      getFollower: address => herdrFollowManagerRef?.getFollower(address)?.threadId ?? null
    })

  const herdrFollowManager = new HerdrFollowManager(herdrClient, wsHub, logger, {
    triggerFollowTurn: (threadId, promptText) => {
      engine.steerOrGenerate({
        threadId,
        userMessage: {
          role: 'user',
          parts: [{ type: 'text', text: promptText }]
        },
        source: 'herdr_follow'
      })
    }
  })
  herdrFollowManagerRef = herdrFollowManager

  const herdrNotifier = new HerdrNotifier(db, wsHub, logger, herdrClient, {
    feishuBridge
  })
  feishuBridge.setHerdrClient(herdrClient)
  engine.setHerdrServices(herdrClient, herdrFollowManager)

  const ctx: ServerContext = {
    paths,
    authToken,
    getPort: () => boundPort,
    logger,
    db,
    wsHub,
    permissionGate,
    acpManager,
    mcpHub,
    skillsScanner,
    memoryStore,
    engine,
    updater,
    cronScheduler,
    feishuBridge,
    herdrClient,
    herdrFollowManager,
    requestUpdateInstall: opts?.onRequestUpdateInstall
  }

  const app = createHttpApp(ctx)

  const server = await new Promise<ReturnType<typeof serve>>(resolve => {
    const srv = serve(
      {
        fetch: app.fetch,
        hostname: '127.0.0.1',
        port: boundPort
      },
      info => {
        boundPort = (info as AddressInfo).port
        resolve(srv)
      }
    )
  })

  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://127.0.0.1:${boundPort}`)
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      const token = url.searchParams.get('token') || ''
      if (token !== authToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, ws => {
        wsHub.add(ws)
        ws.on('message', raw => {
          try {
            const json = JSON.parse(raw.toString('utf8'))
            dispatchWsClientMessage(json)
          } catch (err) {
            ws.send(
              JSON.stringify({
                type: 'error',
                data: { error: err instanceof Error ? err.message : String(err) },
                timestamp: Date.now()
              })
            )
          }
        })
      })
    } catch {
      socket.destroy()
    }
  })

  // Write runtime.json for `cjh` CLI discovery
  writeFileSync(
    paths.runtimeJsonPath,
    JSON.stringify(
      {
        port: boundPort,
        token: authToken,
        pid: process.pid,
        mode: paths.mode,
        startedAt: new Date().toISOString()
      },
      null,
      2
    ),
    { mode: 0o600 }
  )

  logger.info(
    'Server',
    `Listening on http://127.0.0.1:${boundPort} (mode=${paths.mode}, dataDir=${paths.dataDir})`
  )

  void mcpHub.syncAllEnabled()
  cronScheduler.start()
  void feishuBridge.startIfEnabled()
  herdrNotifier.start()
  if (shouldAutoStartHerdr) {
    void herdrClient.start()
  }

  const shutdown = async () => {
    logger.info('Server', 'Shutting down daemon...')
    cronScheduler.stop()
    herdrNotifier.dispose()
    herdrFollowManager.dispose()
    await herdrClient.dispose().catch(() => undefined)
    await feishuBridge.disconnect().catch(() => undefined)
    try {
      rmSync(paths.runtimeJsonPath, { force: true })
    } catch {
      // Ignore
    }
    acpManager.disposeAll()
    await mcpHub.disposeAll()
    wss.close()
    server.close()
    db.close()
  }

  return {
    port: boundPort,
    authToken,
    ctx,
    shutdown
  }
}

// Auto-run when launched as utilityProcess or standalone server entry
const isDirectEntry =
  process.env.CJH_DAEMON_AUTOSTART === '1' ||
  Boolean((process as any).parentPort) ||
  (process.argv[1] && /server\.(m?js|ts)$/i.test(process.argv[1]))

if (isDirectEntry) {
  const parentPort = (process as any).parentPort

  const boot = async (bootstrapOpts?: { authToken?: string; masterKeyHex?: string }) => {
    const daemon = await startLocalDaemon({
      ...bootstrapOpts,
      onRequestUpdateInstall: reqOpts => {
        if (reqOpts?.dryRun) return false
        if (parentPort && typeof parentPort.postMessage === 'function') {
          parentPort.postMessage({ type: 'request_apply_portable_update' })
          return true
        }
        const appExe = process.env.CJH_APP_EXE
        if (appExe) {
          const ok = daemon.ctx.updater.spawnAtomicSwapOnExit(appExe, process.pid)
          if (ok) {
            void daemon.shutdown().then(() => process.exit(0))
          }
          return ok
        }
        return false
      }
    })
    const readyMsg = {
      type: 'daemon_ready',
      port: daemon.port,
      token: daemon.authToken,
      dataDir: daemon.ctx.paths.dataDir,
      mode: daemon.ctx.paths.mode
    }
    if (parentPort && typeof parentPort.postMessage === 'function') {
      parentPort.postMessage(readyMsg)
      parentPort.on('message', (e: any) => {
        const data = e?.data || e
        if (data?.type === 'apply_portable_update_and_exit') {
          daemon.ctx.updater.spawnAtomicSwapOnExit(data.appExePath, data.mainPid)
          void daemon.shutdown().then(() => process.exit(0))
        } else if (data?.type === 'shutdown') {
          void daemon.shutdown().then(() => process.exit(0))
        }
      })
    } else if (process.send) {
      process.send(readyMsg)
    }

    process.on('SIGINT', () => void daemon.shutdown().then(() => process.exit(0)))
    process.on('SIGTERM', () => void daemon.shutdown().then(() => process.exit(0)))
  }

  if (parentPort && typeof parentPort.on === 'function') {
    let started = false
    const startWithTimeout = setTimeout(() => {
      if (!started) {
        started = true
        void boot().catch(err => {
          console.error('Failed to start cjh local daemon:', err)
          process.exit(1)
        })
      }
    }, 3000)

    const onBootstrapMsg = (e: any) => {
      const data = e?.data || e
      if (data?.type === 'daemon_bootstrap' && !started) {
        started = true
        clearTimeout(startWithTimeout)
        parentPort.off?.('message', onBootstrapMsg)
        void boot({
          authToken: typeof data.authToken === 'string' ? data.authToken : undefined,
          masterKeyHex: typeof data.masterKeyHex === 'string' ? data.masterKeyHex : undefined
        }).catch(err => {
          console.error('Failed to start cjh local daemon:', err)
          process.exit(1)
        })
      }
    }
    parentPort.on('message', onBootstrapMsg)
  } else {
    void boot().catch(err => {
      console.error('Failed to start cjh local daemon:', err)
      process.exit(1)
    })
  }
}
