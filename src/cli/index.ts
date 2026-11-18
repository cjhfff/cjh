import { resolveCliTarget } from './runtime'

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

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv

  switch (cmd) {
    case 'status': {
      const data = await apiRequest('/api/health')
      console.log(JSON.stringify(data, null, 2))
      break
    }
    case 'models': {
      const models = await apiRequest('/api/models')
      for (const m of models) {
        console.log(`${m.compositeId}\t[${m.providerType}]\t${m.description || m.modelName}`)
      }
      break
    }
    case 'threads': {
      const threads = await apiRequest('/api/threads')
      for (const t of threads) {
        console.log(`${t.id}\t[${t.runtimeStatus}]\t${t.model || '-'}\t${t.title}`)
      }
      break
    }
    case 'new': {
      const title = rest.join(' ').trim() || undefined
      const created = await apiRequest('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ title })
      })
      console.log(created.id)
      break
    }
    case 'send': {
      let threadId = ''
      let model: string | undefined
      const words: string[] = []
      for (let i = 0; i < rest.length; i++) {
        if ((rest[i] === '-t' || rest[i] === '--thread') && rest[i + 1]) {
          threadId = rest[++i]
        } else if ((rest[i] === '-m' || rest[i] === '--model') && rest[i + 1]) {
          model = rest[++i]
        } else {
          words.push(rest[i])
        }
      }
      const text = words.join(' ').trim()
      if (!threadId || !text) {
        console.error('用法: cjh send -t <threadId> [-m provider:model] "<消息内容>"')
        process.exit(1)
      }
      const res = await apiRequest(`/api/threads/${encodeURIComponent(threadId)}/generate`, {
        method: 'POST',
        body: JSON.stringify({
          model,
          source: 'cli',
          userMessage: {
            role: 'user',
            parts: [{ type: 'text', text }]
          }
        })
      })
      console.log(JSON.stringify(res))
      break
    }
    case 'config': {
      const cfg = await apiRequest('/api/settings')
      console.log(JSON.stringify(cfg, null, 2))
      break
    }
    default: {
      console.log(
        [
          'cjh CLI — 本地 AI 与 ACP 工作台命令行接口',
          '',
          '可用命令:',
          '  cjh status                              查看守护服务状态与便携目录模式',
          '  cjh models                              列出所有已启用模型 (providerId:modelId)',
          '  cjh threads                             列出对话线程与实时状态',
          '  cjh new [标题]                           创建新对话并输出 threadId',
          '  cjh send -t <id> [-m <model>] "<内容>"   向指定线程发起生成请求',
          '  cjh config                              打印当前全局设置'
        ].join('\n')
      )
      break
    }
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
