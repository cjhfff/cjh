import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { jsonSchema, tool, type ToolSet } from 'ai'
import { McpServerRuntimeDto } from '@shared/schemas'
import { AppDatabase } from '../db/database'
import { TaggedLogger } from '../logger'
import { prepareSafeSpawnPlan } from '../proc/spawner'

interface ConnectedMcpEntry {
  id: string
  client: Client | null
  status: McpServerRuntimeDto['status']
  lastError: string | null
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
}

export class McpHub {
  private states = new Map<string, ConnectedMcpEntry>()

  constructor(
    private db: AppDatabase,
    private logger: TaggedLogger,
    private onStatusChanged: () => void
  ) {}

  async syncAllEnabled(): Promise<void> {
    const configs = this.db.listMcpServers()
    await Promise.all(
      configs.map(async cfg => {
        if (cfg.enabled) {
          await this.connectOne(cfg.id).catch(() => undefined)
        } else {
          await this.disconnectOne(cfg.id)
        }
      })
    )
  }

  async connectOne(id: string): Promise<void> {
    await this.disconnectOne(id)
    const cfg = this.db.listMcpServers().find(s => s.id === id)
    if (!cfg || !cfg.enabled) return

    this.states.set(id, {
      id,
      client: null,
      status: 'connecting',
      lastError: null,
      tools: []
    })
    this.onStatusChanged()

    try {
      const client = new Client({ name: 'cjh-desktop', version: '0.1.0' }, { capabilities: {} })
      let transport: StdioClientTransport | StreamableHTTPClientTransport

      if (cfg.transport === 'stdio') {
        if (!cfg.config.command) {
          throw new Error('stdio MCP 缺少启动命令 (command)')
        }
        const plan = prepareSafeSpawnPlan({
          command: cfg.config.command,
          args: cfg.config.args || [],
          extraEnv: cfg.config.env || {}
        })
        const stringEnv: Record<string, string> = {}
        for (const [k, v] of Object.entries(plan.env)) {
          if (typeof v === 'string') stringEnv[k] = v
        }
        transport = new StdioClientTransport({
          command: plan.executable,
          args: plan.args,
          env: stringEnv
        })
      } else {
        if (!cfg.config.url) {
          throw new Error('HTTP MCP 缺少服务地址 (url)')
        }
        transport = new StreamableHTTPClientTransport(new URL(cfg.config.url), {
          requestInit: {
            headers: cfg.config.headers || {}
          }
        })
      }

      await client.connect(transport)
      const listRes = await client.listTools()
      const tools = (listRes.tools || []).map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema as Record<string, unknown>) || {
          type: 'object',
          properties: {}
        }
      }))

      this.states.set(id, {
        id,
        client,
        status: 'connected',
        lastError: null,
        tools
      })
      this.logger.info(`MCP:${cfg.name}`, `Connected (${tools.length} tools)`)
      this.onStatusChanged()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`MCP:${cfg.name}`, `Connection failed: ${msg}`)
      this.states.set(id, {
        id,
        client: null,
        status: 'error',
        lastError: msg,
        tools: []
      })
      this.onStatusChanged()
    }
  }

  async disconnectOne(id: string): Promise<void> {
    const prev = this.states.get(id)
    if (prev?.client) {
      await prev.client.close().catch(() => undefined)
    }
    this.states.delete(id)
    this.onStatusChanged()
  }

  getRuntimeList(): McpServerRuntimeDto[] {
    const configs = this.db.listMcpServers()
    return configs.map(c => {
      const st = this.states.get(c.id)
      return {
        id: c.id,
        name: c.name,
        transport: c.transport,
        command: c.config.command ?? null,
        args: c.config.args || [],
        env: c.config.env || {},
        url: c.config.url ?? null,
        headers: c.config.headers || {},
        enabled: c.enabled,
        status: c.enabled ? st?.status || 'disconnected' : 'disconnected',
        lastError: st?.lastError || null,
        toolCount: st?.tools.length || 0,
        tools: (st?.tools || []).map(t => ({ name: t.name, description: t.description }))
      }
    })
  }

  buildAiSdkToolSet(allowedServerIds?: string[] | null): ToolSet {
    const configs = this.db.listMcpServers().filter(s => s.enabled)
    const allowedSet = allowedServerIds ? new Set(allowedServerIds) : null
    const toolSet: ToolSet = {}

    for (const cfg of configs) {
      if (allowedSet && !allowedSet.has(cfg.id)) continue
      const st = this.states.get(cfg.id)
      if (!st || st.status !== 'connected' || !st.client) continue

      for (const mcpTool of st.tools) {
        const safeServerPrefix = cfg.name.replace(/[^a-zA-Z0-9_-]/g, '_')
        const compositeToolName = `${safeServerPrefix}__${mcpTool.name}`.slice(0, 64)
        const clientRef = st.client

        toolSet[compositeToolName] = tool({
          description: `[MCP:${cfg.name}] ${mcpTool.description || mcpTool.name}`,
          inputSchema: jsonSchema(mcpTool.inputSchema as any),
          execute: async (args: unknown) => {
            const res = await clientRef.callTool({
              name: mcpTool.name,
              arguments: (args as Record<string, unknown>) || {}
            })
            return res.content
          }
        })
      }
    }

    return toolSet
  }

  getStdioServersForAcp(serverIds: string[]): Array<{
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
  }> {
    if (!serverIds.length) return []
    const wanted = new Set(serverIds)
    const configs = this.db.listMcpServers().filter(s => s.enabled && wanted.has(s.id))
    const out: Array<{
      name: string
      command: string
      args: string[]
      env: Array<{ name: string; value: string }>
    }> = []

    for (const cfg of configs) {
      if (cfg.transport === 'stdio' && cfg.config.command) {
        out.push({
          name: cfg.name,
          command: cfg.config.command,
          args: cfg.config.args || [],
          env: Object.entries(cfg.config.env || {}).map(([name, value]) => ({ name, value }))
        })
      }
    }
    return out
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.states.keys()]) {
      await this.disconnectOne(id)
    }
  }
}
