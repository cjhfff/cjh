import { runTermCommand } from './herdr-cli'
import { resolveCliTarget } from './runtime'

export interface CliIo {
  log: (msg: string) => void
  error: (msg: string) => void
}

const defaultIo: CliIo = {
  log: msg => console.log(msg),
  error: msg => console.error(msg)
}

async function apiRequest(path: string, init?: RequestInit): Promise<any> {
  const { baseUrl, token } = await resolveCliTarget()
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {})
    }
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`HTTP ${res.status}: ${errText}`)
  }
  return res.json()
}

const BOOLEAN_FLAGS = new Set(['wait', 'w', 'disabled', 'help', 'h', 'all', 'force', 'arrows'])
const VALUE_FLAGS = new Set([
  't',
  'thread',
  'm',
  'model',
  'name',
  'n',
  'expr',
  'e',
  'prompt',
  'p',
  'tz',
  'timezone',
  'feishu-chat',
  'title',
  'content',
  'c',
  'tags',
  'days',
  'd',
  'cwd',
  'lines',
  'text',
  'follow'
])

function getStringFlag(flags: Record<string, string | boolean>, ...keys: string[]): string {
  for (const k of keys) {
    const val = flags[k]
    if (typeof val === 'string' && val.length > 0) return val
  }
  return ''
}

export function parseFlags(args: string[]): {
  flags: Record<string, string | boolean>
  positional: string[]
} {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const cur = args[i]
    if (cur === '--') {
      positional.push(...args.slice(i + 1))
      break
    }
    if (cur.startsWith('--')) {
      const eqIdx = cur.indexOf('=')
      if (eqIdx !== -1) {
        const key = cur.slice(2, eqIdx)
        const val = cur.slice(eqIdx + 1)
        flags[key] = BOOLEAN_FLAGS.has(key) ? val !== 'false' && val !== '0' : val
      } else {
        const key = cur.slice(2)
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = true
        } else if (VALUE_FLAGS.has(key)) {
          if (i + 1 < args.length) {
            flags[key] = args[++i]
          } else {
            flags[key] = ''
          }
        } else {
          const next = args[i + 1]
          if (next !== undefined && !next.startsWith('-')) {
            flags[key] = next
            i++
          } else {
            flags[key] = true
          }
        }
      }
    } else if (
      cur.startsWith('-') &&
      cur.length === 2 &&
      (BOOLEAN_FLAGS.has(cur.slice(1)) || VALUE_FLAGS.has(cur.slice(1)))
    ) {
      const key = cur.slice(1)
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true
      } else if (i + 1 < args.length) {
        flags[key] = args[++i]
      } else {
        flags[key] = ''
      }
    } else {
      positional.push(cur)
    }
  }
  return { flags, positional }
}

function printHelp(io: CliIo): void {
  io.log(
    [
      'cjh CLI — 本地 AI 与 ACP 工作台命令行接口',
      '',
      '可用命令:',
      '  cjh status                                       查看守护服务状态与便携目录模式',
      '  cjh models                                       列出所有已启用模型 (providerId:modelId)',
      '  cjh threads                                      列出对话线程与实时状态',
      '  cjh new [标题]                                    创建新对话并输出 threadId',
      '  cjh send -t <id> [-m <model>] [--wait] "<内容>"   向指定线程发送消息',
      '  cjh thread list|new|rm|send <id> <text>          管理线程并同步等待回复打印',
      '  cjh cron list                                    列出定时任务',
      '  cjh cron add --name <n> --expr <e> --prompt <p>  创建定时任务',
      '  cjh cron rm <id>                                 删除定时任务',
      '  cjh cron run <id>                                立即执行定时任务',
      '  cjh search <q>                                   全文检索线程标题与消息内容',
      '  cjh memory add --title <t> --content <c>         新增一条记忆',
      '  cjh memory search <q>                            检索记忆',
      '  cjh memory list                                  列出记忆',
      '  cjh usage [--days 30]                            查询用量统计',
      '  cjh config [set <key> <value>]                   查看或修改全局设置',
      '  cjh term ls [--all]                              列出 herdr 终端',
      '  cjh term read <t> [--lines N]                    读取 herdr 终端屏幕',
      '  cjh term run <agent> [--cwd dir] [--name n] [--follow <threadId>] [task]',
      '                                                   后台启动 herdr 终端',
      '  cjh term send <t> [--force] [--wait] [--follow <threadId>] <text>',
      '                                                   向 herdr 终端发送消息',
      '  cjh term answer <t> <n|--text str> [--arrows]    回答阻塞中的 herdr 终端',
      '  cjh term follow <t> --thread <id>                绑定线程自动跟进终端',
      '  cjh term unfollow <t>                            取消终端跟进'
    ].join('\n')
  )
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<void> {
  const [cmd, ...rest] = argv

  switch (cmd) {
    case 'status': {
      const data = await apiRequest('/api/health')
      io.log(JSON.stringify(data, null, 2))
      break
    }

    case 'models': {
      const models = await apiRequest('/api/models')
      for (const m of models) {
        io.log(`${m.compositeId}\t[${m.providerType}]\t${m.description || m.modelName}`)
      }
      break
    }

    case 'threads': {
      const threads = await apiRequest('/api/threads')
      for (const t of threads) {
        io.log(`${t.id}\t[${t.runtimeStatus}]\t${t.model || '-'}\t${t.title}`)
      }
      break
    }

    case 'new': {
      const title = rest.join(' ').trim() || undefined
      const created = await apiRequest('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ title })
      })
      io.log(created.id)
      break
    }

    case 'send': {
      const { flags, positional } = parseFlags(rest)
      const threadId = getStringFlag(flags, 't', 'thread').trim()
      const model = getStringFlag(flags, 'm', 'model').trim() || undefined
      const wait = Boolean(flags.wait || flags.w)
      const text = positional.join(' ').trim()
      if (!threadId || !text) {
        throw new Error('用法: cjh send -t <threadId> [-m provider:model] [--wait] "<消息内容>"')
      }
      const res = await apiRequest(`/api/threads/${encodeURIComponent(threadId)}/generate`, {
        method: 'POST',
        body: JSON.stringify({
          model,
          wait,
          source: 'cli',
          userMessage: {
            role: 'user',
            parts: [{ type: 'text', text }]
          }
        })
      })
      if (wait) {
        if (!res.ok) {
          throw new Error(res.error || '生成失败')
        }
        io.log(res.text || '')
      } else {
        io.log(JSON.stringify(res))
      }
      break
    }

    case 'thread': {
      const [sub, ...subRest] = rest
      if (sub === 'list') {
        const threads = await apiRequest('/api/threads')
        for (const t of threads) {
          io.log(`${t.id}\t[${t.runtimeStatus}]\t${t.model || '-'}\t${t.title}`)
        }
      } else if (sub === 'new') {
        const title = subRest.join(' ').trim() || undefined
        const created = await apiRequest('/api/threads', {
          method: 'POST',
          body: JSON.stringify({ title })
        })
        io.log(created.id)
      } else if (sub === 'rm' || sub === 'delete') {
        const id = subRest[0]
        if (!id) throw new Error('用法: cjh thread rm <threadId>')
        const res = await apiRequest(`/api/threads/${encodeURIComponent(id)}`, { method: 'DELETE' })
        io.log(JSON.stringify(res))
      } else if (sub === 'send') {
        const { flags, positional } = parseFlags(subRest)
        const threadId = positional[0] || ''
        const text = positional.slice(1).join(' ').trim()
        const model = getStringFlag(flags, 'm', 'model').trim() || undefined
        if (!threadId || !text) {
          throw new Error('用法: cjh thread send <threadId> <text> [-m provider:model]')
        }
        const res = await apiRequest(`/api/threads/${encodeURIComponent(threadId)}/generate`, {
          method: 'POST',
          body: JSON.stringify({
            model,
            wait: true,
            source: 'cli',
            userMessage: {
              role: 'user',
              parts: [{ type: 'text', text }]
            }
          })
        })
        if (!res.ok) {
          throw new Error(res.error || '生成失败')
        }
        io.log(res.text || '')
      } else {
        throw new Error('用法: cjh thread <list|new|rm|send>')
      }
      break
    }

    case 'cron': {
      const [sub, ...subRest] = rest
      if (sub === 'list') {
        const jobs = await apiRequest('/api/cron')
        for (const j of jobs) {
          io.log(
            `${j.id}\t[${j.enabled ? 'enabled' : 'disabled'}]\t${j.cronExpr}\t${j.timezone}\t${j.name}`
          )
        }
      } else if (sub === 'add') {
        const { flags } = parseFlags(subRest)
        const name = getStringFlag(flags, 'name', 'n').trim()
        const cronExpr = getStringFlag(flags, 'expr', 'e').trim()
        const prompt = getStringFlag(flags, 'prompt', 'p').trim()
        const timezone = getStringFlag(flags, 'tz', 'timezone').trim() || 'Asia/Shanghai'
        const threadId = getStringFlag(flags, 'thread', 't').trim() || null
        const model = getStringFlag(flags, 'model', 'm').trim() || null
        const feishuChatId = getStringFlag(flags, 'feishu-chat').trim() || null
        const enabled = !flags.disabled

        if (!name || !cronExpr || !prompt) {
          throw new Error(
            '用法: cjh cron add --name <名称> --expr "<5段Cron>" --prompt "<提示词>" [--tz Asia/Shanghai] [--thread <id>] [--model <m>]'
          )
        }
        const created = await apiRequest('/api/cron', {
          method: 'POST',
          body: JSON.stringify({
            name,
            cronExpr,
            timezone,
            prompt,
            threadId,
            model,
            feishuChatId,
            enabled
          })
        })
        io.log(JSON.stringify(created, null, 2))
      } else if (sub === 'rm' || sub === 'delete' || sub === 'del') {
        const id = subRest[0]
        if (!id) throw new Error('用法: cjh cron rm <jobId>')
        const res = await apiRequest(`/api/cron/${encodeURIComponent(id)}`, { method: 'DELETE' })
        io.log(JSON.stringify(res))
      } else if (sub === 'run') {
        const id = subRest[0]
        if (!id) throw new Error('用法: cjh cron run <jobId>')
        const res = await apiRequest(`/api/cron/${encodeURIComponent(id)}/run`, { method: 'POST' })
        io.log(JSON.stringify(res, null, 2))
      } else {
        throw new Error('用法: cjh cron <list|add|rm|run>')
      }
      break
    }

    case 'search': {
      const q = rest.join(' ').trim()
      if (!q) throw new Error('用法: cjh search <关键词>')
      const res = await apiRequest(`/api/search?q=${encodeURIComponent(q)}`)
      io.log(JSON.stringify(res, null, 2))
      break
    }

    case 'memory': {
      const [sub, ...subRest] = rest
      if (sub === 'list') {
        const items = await apiRequest('/api/memories')
        for (const m of items) {
          io.log(`${m.id}\t${m.title}\t[${(m.tags || []).join(',')}]`)
        }
      } else if (sub === 'add') {
        const { flags, positional } = parseFlags(subRest)
        const hasFlagTitle = Boolean(getStringFlag(flags, 'title', 't'))
        const title = (getStringFlag(flags, 'title', 't') || positional[0] || '').trim()
        const content = (
          getStringFlag(flags, 'content', 'c') ||
          positional.slice(hasFlagTitle ? 0 : 1).join(' ') ||
          ''
        ).trim()
        const rawTags = getStringFlag(flags, 'tags')
        const tags = rawTags
          ? rawTags
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          : []
        const sourceThreadId = getStringFlag(flags, 'thread').trim() || null

        if (!title || !content) {
          throw new Error(
            '用法: cjh memory add --title "<标题>" --content "<正文>" [--tags a,b] [--thread <id>]'
          )
        }
        const created = await apiRequest('/api/memories', {
          method: 'POST',
          body: JSON.stringify({ title, content, tags, sourceThreadId })
        })
        io.log(JSON.stringify(created, null, 2))
      } else if (sub === 'search') {
        const q = subRest.join(' ').trim()
        if (!q) throw new Error('用法: cjh memory search <关键词>')
        const res = await apiRequest(`/api/memories/search?q=${encodeURIComponent(q)}`)
        io.log(JSON.stringify(res, null, 2))
      } else {
        throw new Error('用法: cjh memory <add|search|list>')
      }
      break
    }

    case 'usage': {
      const { flags } = parseFlags(rest)
      const days = Number(getStringFlag(flags, 'days', 'd') || 30) || 30
      const stats = await apiRequest(`/api/usage/stats?days=${days}`)
      io.log(JSON.stringify(stats, null, 2))
      break
    }

    case 'config': {
      const [sub, keyPath, rawVal] = rest
      if (sub === 'set' && keyPath && rawVal !== undefined) {
        const parts = keyPath.split('.').filter(Boolean)
        if (parts.length < 1 || parts.length > 3) {
          throw new Error('用法: cjh config set <section.key> <value>')
        }
        let parsedVal: unknown = rawVal
        if (rawVal === 'true') parsedVal = true
        else if (rawVal === 'false') parsedVal = false
        else if (/^-?\d+(\.\d+)?$/.test(rawVal)) parsedVal = Number(rawVal)

        const patch: Record<string, any> = {}
        let cursor = patch
        for (let i = 0; i < parts.length - 1; i++) {
          cursor[parts[i]] = {}
          cursor = cursor[parts[i]]
        }
        cursor[parts[parts.length - 1]] = parsedVal
        const updated = await apiRequest('/api/settings', {
          method: 'PUT',
          body: JSON.stringify(patch)
        })
        io.log(JSON.stringify(updated, null, 2))
      } else {
        const cfg = await apiRequest('/api/settings')
        io.log(JSON.stringify(cfg, null, 2))
      }
      break
    }

    case 'term': {
      await runTermCommand(rest, {
        io,
        apiRequest,
        parseFlags,
        getStringFlag
      })
      break
    }

    default: {
      printHelp(io)
      break
    }
  }
}

const isDirectEntry =
  Boolean(process.argv[1]) &&
  (/(?:^|[\\/])cli\.c?m?js$/i.test(process.argv[1]) ||
    (!process.env.VITEST && /(?:cli|index)\.(?:c?m?js|ts)$/i.test(process.argv[1])))

if (isDirectEntry) {
  runCli(process.argv.slice(2)).catch(err => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
