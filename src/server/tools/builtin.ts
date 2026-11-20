import { readFileSync } from 'node:fs'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import {
  HerdrClientLike,
  HerdrFollowManagerLike,
  PermissionOptionDto,
  ThreadDto
} from '@shared/schemas'
import { computeNextRunAt, parseCronExpression, validateTimezone } from '../cron/scheduler'
import { AppDatabase } from '../db/database'
import { MemoryStore } from '../memory/store'
import { isAllowPermissionOption, PermissionGate } from '../permissions/gate'
import { SkillsScanner } from '../skills/scanner'
import { WsHub } from '../ws-hub'
import { buildHerdrToolSet, formatHerdrToolTitle } from './herdr-tools'
import { executeShellCommand } from './shell'
import { webFetch, webSearch } from './web'
import {
  workspaceFsEdit,
  workspaceFsGlob,
  workspaceFsGrep,
  workspaceFsList,
  workspaceFsRead,
  workspaceFsWrite
} from './workspace-fs'

export interface BuiltinToolContext {
  db: AppDatabase
  wsHub: WsHub
  permissionGate: PermissionGate
  skillsScanner: SkillsScanner
  memoryStore?: MemoryStore
  herdrClient?: HerdrClientLike
  followManager?: HerdrFollowManagerLike
  thread: ThreadDto
  providerId: string
  abortSignal?: AbortSignal
  fetchFn?: typeof fetch
  daemonEnv?: {
    apiUrl: string
    apiToken: string
  }
}

export function formatBuiltinToolTitle(toolName: string, input: unknown): string {
  const herdrTitle = formatHerdrToolTitle(toolName, input)
  if (herdrTitle) return herdrTitle
  if (!input || typeof input !== 'object') return toolName
  const obj = input as Record<string, unknown>
  if (typeof obj.path === 'string' && obj.path) return `${toolName} · ${obj.path}`
  if (typeof obj.dir === 'string' && obj.dir) return `${toolName} · ${obj.dir}`
  if (typeof obj.pattern === 'string' && obj.pattern) return `${toolName} · ${obj.pattern}`
  if (typeof obj.query === 'string' && obj.query) return `${toolName} · ${obj.query}`
  if (typeof obj.url === 'string' && obj.url) return `${toolName} · ${obj.url}`
  if (typeof obj.command === 'string' && obj.command) {
    return `${toolName} · ${obj.command.slice(0, 60)}`
  }
  if (typeof obj.name === 'string' && obj.name) return `${toolName} · ${obj.name}`
  if (typeof obj.idOrName === 'string' && obj.idOrName) return `${toolName} · ${obj.idOrName}`
  if (typeof obj.id === 'string' && obj.id) return `${toolName} · ${obj.id}`
  return toolName
}

export function buildBuiltinToolSet(ctx: BuiltinToolContext): ToolSet {
  const initialAllowed = Array.isArray(ctx.thread.metadata?.allowedBuiltinTools)
    ? ctx.thread.metadata.allowedBuiltinTools.filter((x): x is string => typeof x === 'string')
    : []
  const allowedTools = new Set<string>(initialAllowed)

  const ensureWorkspaceBound = (): string => {
    const fresh = ctx.db.getThread(ctx.thread.id) || ctx.thread
    if (!fresh.workspacePath || !fresh.workspacePath.trim()) {
      throw new Error('请先为该线程绑定工作目录')
    }
    return fresh.workspacePath
  }

  const runWithPermission = async <T>(
    toolName: string,
    requiresConfirmation: boolean,
    rawInput: unknown,
    fn: () => Promise<T> | T
  ): Promise<T> => {
    const settings = ctx.db.getSettings()
    const needsConfirm = requiresConfirmation || !settings.tools.autoApproveReadOnly

    if (needsConfirm && !allowedTools.has(toolName)) {
      const options: PermissionOptionDto[] = [
        { optionId: 'allow_once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'allow_always', name: '本线程总是允许该工具', kind: 'allow_always' },
        { optionId: 'reject', name: '拒绝', kind: 'reject_once' }
      ]
      const outcome = await ctx.permissionGate.requestPermission({
        threadId: ctx.thread.id,
        providerId: ctx.providerId,
        title: formatBuiltinToolTitle(toolName, rawInput),
        toolName,
        rawInput,
        cwd: ctx.thread.workspacePath || null,
        options,
        abortSignal: ctx.abortSignal,
        logTag: `BuiltinTool:${toolName}`
      })

      const selectedOption =
        outcome.outcome === 'selected'
          ? options.find(o => o.optionId === outcome.optionId)
          : undefined

      if (!isAllowPermissionOption(selectedOption)) {
        throw new Error(`权限被拒绝：用户拒绝执行 ${toolName} 或审批已超时`)
      }

      if (selectedOption!.kind === 'allow_always') {
        allowedTools.add(toolName)
        const updated = ctx.db.addThreadAllowedBuiltinTool(ctx.thread.id, toolName)
        if (updated) ctx.wsHub.broadcast('thread_updated', updated)
        ctx.permissionGate.approvePendingForThreadTool(ctx.thread.id, toolName)
      }
    }

    return await fn()
  }

  return {
    web_fetch: tool({
      description: '抓取指定 http/https URL 的网页内容，HTML 自动转换为 Markdown（限制 200KB、超时 20s）。',
      inputSchema: z.object({
        url: z.string().describe('要抓取的 http 或 https 网址')
      }),
      execute: async input =>
        runWithPermission('web_fetch', false, input, () =>
          webFetch(input.url, {
            abortSignal: ctx.abortSignal,
            fetchFn: ctx.fetchFn
          })
        )
    }),

    web_search: tool({
      description: '使用配置的网页搜索引擎（Tavily / Brave / SearXNG / DuckDuckGo 兜底）搜索互联网信息。',
      inputSchema: z.object({
        query: z.string().describe('搜索关键词'),
        maxResults: z.number().int().min(1).max(10).optional().describe('返回结果数量，默认 5')
      }),
      execute: async input =>
        runWithPermission('web_search', false, input, () => {
          const settings = ctx.db.getSettings()
          return webSearch(input.query, {
            maxResults: input.maxResults,
            abortSignal: ctx.abortSignal,
            fetchFn: ctx.fetchFn,
            config: {
              backend: settings.tools.webSearch.backend,
              searxngUrl: settings.tools.webSearch.searxngUrl,
              tavilyApiKey: ctx.db.getSecret('web_search.tavily_api_key'),
              braveApiKey: ctx.db.getSecret('web_search.brave_api_key')
            }
          })
        })
    }),

    fs_list: tool({
      description: '列出线程绑定工作目录中的文件和子目录（只读）。',
      inputSchema: z.object({
        dir: z.string().optional().describe('相对工作目录的子目录路径，默认根目录 "."'),
        recursive: z.boolean().optional().describe('是否递归列出子目录，默认 false'),
        maxEntries: z.number().int().min(1).max(500).optional()
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('fs_list', false, input, () => workspaceFsList(wp, input))
      }
    }),

    fs_read: tool({
      description: '读取工作目录内指定文本文件的内容，支持 1-based 行范围（只读）。',
      inputSchema: z.object({
        path: z.string().describe('相对工作目录的文件路径'),
        startLine: z.number().int().min(1).optional().describe('起始行号（从 1 开始）'),
        endLine: z.number().int().min(1).optional().describe('结束行号（包含）')
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('fs_read', false, input, () => workspaceFsRead(wp, input))
      }
    }),

    fs_glob: tool({
      description: '按 glob 通配符模式（如 "**/*.ts"）在工作目录内查找文件（只读）。',
      inputSchema: z.object({
        pattern: z.string().describe('glob 匹配模式，例如 "**/*.ts" 或 "src/*.json"'),
        maxResults: z.number().int().min(1).max(500).optional()
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('fs_glob', false, input, () => workspaceFsGlob(wp, input))
      }
    }),

    fs_grep: tool({
      description: '在工作目录内的文本文件中搜索指定关键词或正则表达式（只读）。',
      inputSchema: z.object({
        query: z.string().describe('搜索字符串或正则表达式'),
        isRegex: z.boolean().optional().describe('是否按正则表达式匹配，默认 false'),
        include: z.string().optional().describe('可选文件 glob 过滤，如 "**/*.ts"'),
        maxMatches: z.number().int().min(1).max(200).optional()
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('fs_grep', false, input, () => workspaceFsGrep(wp, input))
      }
    }),

    fs_write: tool({
      description: '向工作目录内的指定路径写入或覆盖文件（需用户确认权限）。',
      inputSchema: z.object({
        path: z.string().describe('相对工作目录的文件路径'),
        content: z.string().describe('完整文件内容')
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('fs_write', true, input, () => workspaceFsWrite(wp, input))
      }
    }),

    fs_edit: tool({
      description: '对工作目录内的文件执行「旧文本 → 新文本」精确替换（需用户确认权限）。',
      inputSchema: z.object({
        path: z.string().describe('相对工作目录的文件路径'),
        oldText: z.string().describe('要被替换的原文本（须精确匹配）'),
        newText: z.string().describe('替换后的新文本'),
        replaceAll: z.boolean().optional().describe('是否替换全部匹配，默认 false（要求唯一匹配）')
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('fs_edit', true, input, () => workspaceFsEdit(wp, input))
      }
    }),

    shell_exec: tool({
      description:
        '在线程绑定的工作目录中执行命令（Windows 使用 PowerShell，参数数组安全执行，默认超时 120s，输出上限 30KB，需用户确认权限）。',
      inputSchema: z.object({
        command: z.string().describe('要执行的命令或 PowerShell 语句'),
        args: z.array(z.string()).optional().describe('可选直接可执行程序的精确参数数组'),
        timeoutSec: z.number().int().min(1).max(600).optional().describe('超时秒数，默认读取设置（120s）')
      }),
      execute: async input => {
        const wp = ensureWorkspaceBound()
        return runWithPermission('shell_exec', true, input, () => {
          const settings = ctx.db.getSettings()
          return executeShellCommand({
            command: input.command,
            args: input.args,
            workspacePath: wp,
            timeoutSec: input.timeoutSec ?? settings.tools.shellTimeoutSec ?? 120,
            abortSignal: ctx.abortSignal,
            daemonEnv: ctx.daemonEnv
          })
        })
      }
    }),

    cron_list: tool({
      description: '列出所有已配置的定时任务（只读）。',
      inputSchema: z.object({}),
      execute: async input =>
        runWithPermission('cron_list', false, input, () => ctx.db.listCronJobs())
    }),

    cron_create: tool({
      description: '创建一个新的定时任务（需用户确认权限）。',
      inputSchema: z.object({
        name: z.string().describe('任务名称'),
        cronExpr: z.string().describe('5 段式 Cron 表达式，如 "30 7 * * *"'),
        timezone: z.string().optional().describe('IANA 时区，默认 "Asia/Shanghai"'),
        prompt: z.string().describe('到点触发执行的提示词'),
        threadId: z.string().optional().describe('可选目标线程 ID；留空则每次触发自动建新线程'),
        model: z.string().optional().describe('可选指定模型 providerId:modelId'),
        enabled: z.boolean().optional().describe('是否立即启用，默认 true')
      }),
      execute: async input =>
        runWithPermission('cron_create', true, input, () => {
          const tz = validateTimezone(input.timezone || 'Asia/Shanghai')
          parseCronExpression(input.cronExpr)
          const enabled = input.enabled !== false
          const nextRunAt = enabled ? computeNextRunAt(input.cronExpr, tz) : null
          const created = ctx.db.upsertCronJob({
            name: input.name,
            cronExpr: input.cronExpr,
            timezone: tz,
            threadId: input.threadId ?? ctx.thread.id,
            prompt: input.prompt,
            model: input.model ?? null,
            enabled,
            nextRunAt
          })
          ctx.wsHub.broadcast('cron_job_updated', created)
          return created
        })
    }),

    cron_delete: tool({
      description: '按 ID 删除指定的定时任务（需用户确认权限）。',
      inputSchema: z.object({
        id: z.string().describe('定时任务 ID')
      }),
      execute: async input =>
        runWithPermission('cron_delete', true, input, () => {
          const ok = ctx.db.deleteCronJob(input.id)
          if (!ok) throw new Error(`未找到定时任务: ${input.id}`)
          ctx.wsHub.broadcast('cron_job_updated', { id: input.id, deleted: true })
          return { ok: true, id: input.id }
        })
    }),

    usage_query: tool({
      description: '查询最近 N 天的模型调用与 Token 用量统计（只读）。',
      inputSchema: z.object({
        days: z.number().int().min(1).max(365).optional().describe('统计天数，默认 30 天')
      }),
      execute: async input =>
        runWithPermission('usage_query', false, input, () =>
          ctx.db.getUsageStats(input.days ?? 30)
        )
    }),

    skill_read: tool({
      description: '读取某个已启用技能的完整 SKILL.md 指南内容（渐进加载）。',
      inputSchema: z.object({
        idOrName: z.string().describe('技能 ID（如 builtin:cjh-self）或技能名称（如 cjh-self）')
      }),
      execute: async input =>
        runWithPermission('skill_read', false, input, () => {
          const q = input.idOrName.trim().toLowerCase()
          const freshThread = ctx.db.getThread(ctx.thread.id) || ctx.thread
          const allowedIds = Array.isArray(freshThread.skillIds) ? freshThread.skillIds : null
          const enabled = ctx.skillsScanner
            .list()
            .filter(s => s.enabled && (!allowedIds || allowedIds.includes(s.id)))
          const target = enabled.find(
            s => s.id.toLowerCase() === q || s.name.toLowerCase() === q
          )
          if (!target) {
            throw new Error(`未找到已启用的技能: ${input.idOrName}`)
          }
          const content = readFileSync(target.path, 'utf8')
          return {
            id: target.id,
            name: target.name,
            source: target.source,
            path: target.path,
            content
          }
        })
    }),

    ...(ctx.memoryStore
      ? {
          memory_save: tool({
            description:
              '将需要长期记住的用户偏好、项目约定、重要结论保存到本地持久化记忆中（Markdown + FTS 索引）。',
            inputSchema: z.object({
              title: z.string().describe('简明记忆标题'),
              content: z.string().describe('完整记忆内容'),
              tags: z.array(z.string()).optional().describe('可选分类标签，如 ["偏好", "项目"]')
            }),
            execute: async input =>
              runWithPermission('memory_save', false, input, () => {
                const created = ctx.memoryStore!.create({
                  title: input.title,
                  content: input.content,
                  tags: input.tags || [],
                  sourceThreadId: ctx.thread.id
                })
                ctx.wsHub.broadcast('memories_updated', created)
                return created
              })
          }),

          memory_search: tool({
            description: '使用全文检索（FTS5）从本地记忆库中搜索相关历史记忆（只读）。',
            inputSchema: z.object({
              query: z.string().describe('搜索关键词'),
              limit: z.number().int().min(1).max(20).optional().describe('返回条数，默认 5')
            }),
            execute: async input =>
              runWithPermission('memory_search', false, input, () =>
                ctx.memoryStore!.search(input.query, input.limit ?? 5)
              )
          })
        }
      : {}),

    ...(ctx.herdrClient
      ? buildHerdrToolSet({
          herdrClient: ctx.herdrClient,
          followManager: ctx.followManager,
          thread: ctx.thread,
          runWithPermission
        })
      : {})
  }
}
