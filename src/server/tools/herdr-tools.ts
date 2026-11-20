import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { HerdrClientLike, HerdrFollowManagerLike, HerdrTerminal } from '@shared/herdr-types'
import { ThreadDto } from '@shared/schemas'

export interface HerdrToolContext {
  herdrClient: HerdrClientLike
  followManager?: HerdrFollowManagerLike
  thread: ThreadDto
  runWithPermission: <T>(
    toolName: string,
    requiresConfirmation: boolean,
    rawInput: unknown,
    fn: () => Promise<T> | T
  ) => Promise<T>
}

function normalizeCwd(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function summarizeTerminal(t: HerdrTerminal) {
  return {
    address: t.address,
    name: t.name ?? null,
    agent: t.agent ?? null,
    state: t.state,
    status: t.status ?? null,
    turn: t.turn,
    cwd: t.foreground?.cwd || t.cwd,
    title: t.title ?? null,
    muted: Boolean(t.muted),
    followedByThreadId: t.followedByThreadId ?? null
  }
}

export function formatHerdrToolTitle(toolName: string, input: unknown): string | null {
  if (!toolName.startsWith('herdr_')) return null
  if (!input || typeof input !== 'object') return toolName
  const obj = input as Record<string, unknown>

  if (toolName === 'herdr_run') {
    const agent = typeof obj.agent === 'string' && obj.agent ? obj.agent : ''
    const name = typeof obj.name === 'string' && obj.name ? obj.name : ''
    if (agent && name) return `${toolName} · ${agent} (${name})`
    if (agent) return `${toolName} · ${agent}`
  }

  if (typeof obj.terminal === 'string' && obj.terminal) {
    return `${toolName} · ${obj.terminal}`
  }
  if (typeof obj.cwd === 'string' && obj.cwd) {
    return `${toolName} · ${obj.cwd}`
  }
  return toolName
}

export function buildHerdrToolSet(ctx: HerdrToolContext): ToolSet {
  return {
    herdr_list: tool({
      description: '列出当前 herdr 终端列表与状态（只读），可按 cwd 工作目录过滤。',
      inputSchema: z.object({
        all: z.boolean().optional().describe('是否包含已结束（finished）的终端，默认 false'),
        cwd: z.string().optional().describe('可选工作目录过滤路径')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_list', false, input, async () => {
          const res = await ctx.herdrClient.listTerminals({ all: input.all })
          const targetCwd = input.cwd?.trim() ? normalizeCwd(input.cwd.trim()) : null
          const terminals = targetCwd
            ? res.terminals.filter(t => {
                const launchCwd = t.cwd ? normalizeCwd(t.cwd) : ''
                const fgCwd = t.foreground?.cwd ? normalizeCwd(t.foreground.cwd) : ''
                return launchCwd === targetCwd || fgCwd === targetCwd
              })
            : res.terminals

          return {
            available: res.available,
            reason: res.reason ?? null,
            hiddenFinished: res.hiddenFinished,
            terminals: terminals.map(summarizeTerminal)
          }
        })
    }),

    herdr_read: tool({
      description: '读取指定 herdr 终端的屏幕内容与可选历史行数（只读，history 行数上限 500）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称'),
        lines: z.number().int().min(0).optional().describe('附加历史行数（0 表示仅可见屏幕，上限 500）')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_read', false, input, async () => {
          const lines =
            input.lines === undefined ? 0 : Math.min(Math.max(0, Math.floor(input.lines)), 500)
          return ctx.herdrClient.readTerminal(input.terminal, lines)
        })
    }),

    herdr_wait: tool({
      description: '等待指定 herdr 终端停止 working 或输出匹配指定文本（只读，超时上限 300 秒）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称'),
        timeout: z.number().optional().describe('等待超时秒数（默认 60，最大限制 300 秒）'),
        output: z.string().optional().describe('可选等待匹配的输出子串')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_wait', false, input, async () => {
          const clampedTimeout = Math.min(Math.max(1, input.timeout ?? 60), 300)
          return ctx.herdrClient.waitTerminal(input.terminal, {
            timeout: clampedTimeout,
            output: input.output
          })
        })
    }),

    herdr_run: tool({
      description:
        '在 herdr 中后台启动新的终端或编码代理（如 agy / codex / claude / pi / shell），可设置 follow:true 自动跟进结果（需用户确认权限）。',
      inputSchema: z.object({
        agent: z
          .string()
          .min(1)
          .describe('代理或运行类型，如 agy / codex / claude / pi / shell 或自定义命令'),
        cwd: z.string().optional().describe('工作目录（默认使用当前线程绑定的 workspacePath）'),
        name: z.string().optional().describe('可选终端短名称（1-32 位小写字母/数字/-/_/.）'),
        task: z.string().optional().describe('首条任务指令（推荐启动时一并传入，避免漏发）'),
        command: z.array(z.string()).optional().describe('可选自定义启动命令与参数数组'),
        line: z.string().optional().describe('当 agent 为 shell 时可指定执行的命令行'),
        labels: z.record(z.string(), z.string()).optional().describe('可选终端标签键值对'),
        follow: z
          .boolean()
          .optional()
          .describe('是否在终端每次从 working 停下时自动向当前线程注入状态与屏幕回调')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_run', true, input, async () => {
          const cwd = input.cwd?.trim() || ctx.thread.workspacePath || undefined
          const created = await ctx.herdrClient.runTerminal({
            agent: input.agent,
            cwd,
            name: input.name,
            task: input.task,
            command: input.command,
            line: input.line,
            labels: input.labels
          })

          let following = false
          if (input.follow === true && ctx.followManager) {
            ctx.followManager.follow(created.address, ctx.thread.id)
            following = true
          }

          return {
            terminal: summarizeTerminal(created),
            following
          }
        })
    }),

    herdr_send: tool({
      description:
        '向指定 herdr 终端发送文本消息或下一轮任务，支持 follow:true 自动跟进（需用户确认权限）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称'),
        text: z.string().min(1).describe('要发送的指令文本'),
        force: z.boolean().optional().describe('是否在终端非 idle/done 时强制发送，默认 false'),
        wait: z.boolean().optional().describe('是否同步等待本轮完成，默认 false'),
        timeout: z.number().positive().max(600).optional().describe('wait=true 时的等待超时秒数'),
        follow: z.boolean().optional().describe('是否为本线程绑定终端跟进回调')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_send', true, input, async () => {
          if (input.follow === true && ctx.followManager) {
            const existing = ctx.followManager.getFollower(input.terminal)
            if (existing && existing.threadId !== ctx.thread.id) {
              throw new Error(
                `终端 ${existing.terminal} 已被线程 ${existing.threadId} 跟进，请先取消原有跟进`
              )
            }
          }

          const res = await ctx.herdrClient.sendTerminal(input.terminal, {
            text: input.text,
            force: input.force ?? false,
            wait: input.wait ?? false,
            timeout: input.timeout
          })

          let following = false
          if (input.follow === true && ctx.followManager) {
            ctx.followManager.follow(input.terminal, ctx.thread.id)
            following = true
          }

          return {
            ...res,
            following
          }
        })
    }),

    herdr_answer: tool({
      description:
        '对处于 blocked（等待选择/确认/输入）状态的 herdr 终端作答，可传入选项编号或文本（需用户确认权限）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称'),
        choice: z.number().int().min(1).max(99).optional().describe('选项编号（如 1、2）'),
        text: z.string().min(1).optional().describe('文本作答内容'),
        useArrows: z.boolean().optional().describe('是否使用方向键+回车选择而非数字键，默认 false')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_answer', true, input, async () => {
          if (input.choice === undefined && input.text === undefined) {
            throw new Error('必须提供 choice（选项号）或 text（作答文本）之一')
          }
          return ctx.herdrClient.answerTerminal(input.terminal, {
            choice: input.choice,
            text: input.text,
            useArrows: input.useArrows ?? false
          })
        })
    }),

    herdr_keys: tool({
      description: '向指定 herdr 终端发送底层按键序列（如 ["down", "enter"]）（需用户确认权限）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称'),
        keys: z.array(z.string().min(1)).min(1).describe('按键名称数组')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_keys', true, input, async () =>
          ctx.herdrClient.keysTerminal(input.terminal, input.keys)
        )
    }),

    herdr_kill: tool({
      description:
        '终止并清理你创建的 herdr 终端（可选同时 rm 移除记录）。切勿终止非自己启动的终端（需用户确认权限）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称'),
        remove: z.boolean().optional().describe('终止后是否同时执行 rm 移除终端记录，默认 false')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_kill', true, input, async () => {
          const killed = await ctx.herdrClient.killTerminal(input.terminal)
          ctx.followManager?.unfollow(input.terminal)
          let removed = null
          if (input.remove) {
            removed = await ctx.herdrClient.rmTerminal(input.terminal)
          }
          return {
            killed: summarizeTerminal(killed),
            removed
          }
        })
    }),

    herdr_unfollow: tool({
      description: '取消当前线程对指定 herdr 终端的自动跟进回调（只读/无破坏性操作）。',
      inputSchema: z.object({
        terminal: z.string().min(1).describe('终端地址（如 t5）或名称')
      }),
      execute: async input =>
        ctx.runWithPermission('herdr_unfollow', false, input, async () => {
          if (!ctx.followManager) {
            return { ok: false, terminal: input.terminal, unfollowed: false }
          }
          const existing = ctx.followManager.getFollower(input.terminal)
          if (existing && existing.threadId !== ctx.thread.id) {
            throw new Error(`终端 ${existing.terminal} 当前由其他线程 (${existing.threadId}) 跟进`)
          }
          const unfollowed = ctx.followManager.unfollow(input.terminal)
          return {
            ok: true,
            terminal: existing?.terminal || input.terminal,
            unfollowed
          }
        })
    })
  }
}
