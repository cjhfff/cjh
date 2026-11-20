export interface TermCliIo {
  log: (msg: string) => void
  error: (msg: string) => void
}

export interface TermCliDeps {
  io: TermCliIo
  apiRequest: (path: string, init?: RequestInit) => Promise<any>
  parseFlags: (args: string[]) => {
    flags: Record<string, string | boolean>
    positional: string[]
  }
  getStringFlag: (flags: Record<string, string | boolean>, ...keys: string[]) => string
}

export async function runTermCommand(args: string[], deps: TermCliDeps): Promise<void> {
  const { io, apiRequest, parseFlags, getStringFlag } = deps
  const [sub, ...subRest] = args

  switch (sub) {
    case 'ls':
    case 'list': {
      const { flags } = parseFlags(subRest)
      const allParam = flags.all ? '1' : '0'
      const data = await apiRequest(`/api/herdr/terminals?all=${allParam}`)
      if (!data?.available) {
        io.log(`herdr 不可用: ${data?.reason || '未连接'}`)
        return
      }
      const terminals: any[] = Array.isArray(data.terminals) ? data.terminals : []
      for (const t of terminals) {
        const statusCol =
          t.state === 'finished'
            ? `finished(${t.exit_code ?? '-'})`
            : t.status?.state || t.state || '-'
        const cwdCol = t.foreground?.cwd || t.cwd || '-'
        const titleOrMsg = String(t.status?.msg || t.title || '-').replace(/[\r\n]+/g, ' ')
        io.log(
          [
            t.address,
            t.name || '-',
            t.agent || '-',
            statusCol,
            String(t.turn ?? 0),
            cwdCol,
            titleOrMsg
          ].join('\t')
        )
      }
      return
    }

    case 'read': {
      const { flags, positional } = parseFlags(subRest)
      const target = positional[0]
      if (!target) {
        throw new Error('用法: cjh term read <terminal> [--lines N]')
      }
      const linesRaw = getStringFlag(flags, 'lines').trim()
      const query = linesRaw ? `?lines=${encodeURIComponent(linesRaw)}` : ''
      const res = await apiRequest(
        `/api/herdr/terminals/${encodeURIComponent(target)}/screen${query}`
      )
      io.log(res?.text ?? '')
      return
    }

    case 'run': {
      const { flags, positional } = parseFlags(subRest)
      const agent = positional[0]
      if (!agent) {
        throw new Error(
          '用法: cjh term run <agent> [--cwd dir] [--name n] [--follow <threadId>] [task...]'
        )
      }
      const task = positional.slice(1).join(' ').trim() || undefined
      const cwd = getStringFlag(flags, 'cwd').trim() || undefined
      const name = getStringFlag(flags, 'name', 'n').trim() || undefined
      const followThreadId = getStringFlag(flags, 'follow').trim() || undefined

      const res = await apiRequest('/api/herdr/terminals', {
        method: 'POST',
        body: JSON.stringify({ agent, cwd, name, task, followThreadId })
      })
      io.log(JSON.stringify(res, null, 2))
      return
    }

    case 'send': {
      const { flags, positional } = parseFlags(subRest)
      const target = positional[0]
      const text = positional.slice(1).join(' ').trim()
      if (!target || !text) {
        throw new Error(
          '用法: cjh term send <terminal> [--force] [--wait] [--follow <threadId>] <text...>'
        )
      }
      const force = Boolean(flags.force)
      const wait = Boolean(flags.wait || flags.w)
      const followThreadId = getStringFlag(flags, 'follow').trim() || undefined

      const res = await apiRequest(`/api/herdr/terminals/${encodeURIComponent(target)}/send`, {
        method: 'POST',
        body: JSON.stringify({ text, force, wait, followThreadId })
      })
      io.log(JSON.stringify(res, null, 2))
      return
    }

    case 'answer': {
      const { flags, positional } = parseFlags(subRest)
      const target = positional[0]
      const textFlag = getStringFlag(flags, 'text')
      const choiceRaw = positional[1]
      const useArrows = Boolean(flags.arrows)
      if (!target || (!textFlag && !choiceRaw)) {
        throw new Error('用法: cjh term answer <terminal> <n | --text <str>> [--arrows]')
      }

      const body: Record<string, unknown> = { useArrows }
      if (textFlag) {
        body.text = textFlag
      } else if (/^\d+$/.test(choiceRaw)) {
        body.choice = Number(choiceRaw)
      } else {
        body.choice = choiceRaw
      }

      const res = await apiRequest(`/api/herdr/terminals/${encodeURIComponent(target)}/answer`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
      io.log(JSON.stringify(res, null, 2))
      return
    }

    case 'follow': {
      const { flags, positional } = parseFlags(subRest)
      const target = positional[0]
      const threadId = getStringFlag(flags, 'thread', 't').trim()
      if (!target || !threadId) {
        throw new Error('用法: cjh term follow <terminal> --thread <threadId>')
      }
      const res = await apiRequest(`/api/herdr/terminals/${encodeURIComponent(target)}/follow`, {
        method: 'POST',
        body: JSON.stringify({ threadId })
      })
      io.log(JSON.stringify(res, null, 2))
      return
    }

    case 'unfollow': {
      const { positional } = parseFlags(subRest)
      const target = positional[0]
      if (!target) {
        throw new Error('用法: cjh term unfollow <terminal>')
      }
      const res = await apiRequest(`/api/herdr/terminals/${encodeURIComponent(target)}/follow`, {
        method: 'DELETE'
      })
      io.log(JSON.stringify(res, null, 2))
      return
    }

    default:
      throw new Error('用法: cjh term <ls|read|run|send|answer|follow|unfollow>')
  }
}
