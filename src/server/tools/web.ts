import { WebSearchBackend } from '@shared/schemas'

const MAX_FETCH_BYTES = 200 * 1024
const FETCH_TIMEOUT_MS = 20_000

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
}

export function htmlToMarkdown(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  out = out.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, inner) => {
    const clean = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim()
    return clean ? `\n\n${'#'.repeat(Number(lvl))} ${clean}\n\n` : ''
  })

  out = out.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const clean = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim()
    return clean ? `\n\n\`\`\`\n${clean}\n\`\`\`\n\n` : ''
  })

  out = out.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    const clean = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim()
    return clean ? `\`${clean}\`` : ''
  })

  out = out.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const label = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim()
    if (!label) return href
    return `[${label}](${href})`
  })

  out = out
    .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, '**$1**')
    .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, '*$1*')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|tr|blockquote|ul|ol|header|footer)>/gi, '\n\n')
    .replace(/<(?:td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')

  out = decodeHtmlEntities(out)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return out
}

async function readResponseWithLimit(
  res: Response,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text()
    const buf = Buffer.from(text, 'utf8')
    if (buf.byteLength <= maxBytes) return { text, truncated: false }
    return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true }
  }

  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const remaining = maxBytes - received
    if (remaining <= 0) {
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    if (value.byteLength > remaining) {
      chunks.push(Buffer.from(value.subarray(0, remaining)))
      received += remaining
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(Buffer.from(value))
    received += value.byteLength
  }

  return { text: Buffer.concat(chunks).toString('utf8'), truncated }
}

function combineSignals(a?: AbortSignal, timeoutMs = FETCH_TIMEOUT_MS): AbortSignal {
  const timeoutSig = AbortSignal.timeout(timeoutMs)
  if (!a) return timeoutSig
  return AbortSignal.any([a, timeoutSig])
}

export async function webFetch(
  rawUrl: string,
  opts?: {
    maxBytes?: number
    abortSignal?: AbortSignal
    fetchFn?: typeof fetch
  }
): Promise<{
  url: string
  status: number
  contentType: string
  content: string
  truncated: boolean
}> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error(`无效的 URL: ${rawUrl}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http 和 https 协议，当前为: ${parsed.protocol}`)
  }

  const fetchImpl = opts?.fetchFn || fetch
  const maxBytes = Math.min(MAX_FETCH_BYTES, Math.max(1024, opts?.maxBytes ?? MAX_FETCH_BYTES))

  const res = await fetchImpl(parsed.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': 'cjh-workspace/0.1.0 (+https://localhost)',
      Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
    },
    signal: combineSignals(opts?.abortSignal, FETCH_TIMEOUT_MS)
  })

  if (!res.ok) {
    throw new Error(`抓取失败: HTTP ${res.status} ${res.statusText}`)
  }

  const contentType = res.headers.get('content-type') || 'text/plain'
  const { text, truncated: rawTruncated } = await readResponseWithLimit(res, maxBytes * 2)

  let formatted = text
  if (/text\/html|application\/xhtml\+xml/i.test(contentType) || /<html[\s>]/i.test(text.slice(0, 512))) {
    formatted = htmlToMarkdown(text)
  }

  const outBuf = Buffer.from(formatted, 'utf8')
  const finalTruncated = rawTruncated || outBuf.byteLength > maxBytes
  const content =
    outBuf.byteLength > maxBytes ? outBuf.subarray(0, maxBytes).toString('utf8') : formatted

  return {
    url: res.url || parsed.toString(),
    status: res.status,
    contentType,
    content,
    truncated: finalTruncated
  }
}

export interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
}

export interface WebSearchConfig {
  backend: WebSearchBackend
  tavilyApiKey?: string | null
  braveApiKey?: string | null
  searxngUrl?: string | null
}

function unwrapDuckDuckGoHref(rawHref: string): string {
  const decoded = decodeHtmlEntities(rawHref).trim()
  const full = decoded.startsWith('//') ? `https:${decoded}` : decoded
  try {
    const u = new URL(full, 'https://html.duckduckgo.com')
    const uddg = u.searchParams.get('uddg')
    if (uddg) return uddg
    return u.toString()
  } catch {
    return decoded
  }
}

export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = []
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<(?:a|div|span)[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/gi

  const links: Array<{ url: string; title: string; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = linkRegex.exec(html)) !== null) {
    const url = unwrapDuckDuckGoHref(m[1])
    const title = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '')).trim()
    if (url && title) {
      links.push({ url, title, index: m.index })
    }
  }

  const snippets: Array<{ text: string; index: number }> = []
  while ((m = snippetRegex.exec(html)) !== null) {
    const text = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim()
    snippets.push({ text, index: m.index })
  }

  for (let i = 0; i < links.length && results.length < maxResults; i++) {
    const cur = links[i]
    const nextIdx = i + 1 < links.length ? links[i + 1].index : Number.MAX_SAFE_INTEGER
    const matchedSnippet = snippets.find(s => s.index > cur.index && s.index < nextIdx)
    results.push({
      title: cur.title,
      url: cur.url,
      snippet: matchedSnippet?.text || ''
    })
  }

  return results
}

export async function webSearch(
  query: string,
  opts: {
    maxResults?: number
    config: WebSearchConfig
    abortSignal?: AbortSignal
    fetchFn?: typeof fetch
  }
): Promise<{
  backend: string
  query: string
  results: WebSearchResultItem[]
}> {
  const cleanQuery = query.trim()
  if (!cleanQuery) throw new Error('搜索关键词不能为空')

  const maxResults = Math.min(10, Math.max(1, opts.maxResults ?? 5))
  const fetchImpl = opts.fetchFn || fetch
  const cfg = opts.config

  let resolvedBackend = cfg.backend
  if (resolvedBackend === 'auto') {
    if (cfg.tavilyApiKey?.trim()) resolvedBackend = 'tavily'
    else if (cfg.braveApiKey?.trim()) resolvedBackend = 'brave'
    else if (cfg.searxngUrl?.trim()) resolvedBackend = 'searxng'
    else resolvedBackend = 'duckduckgo'
  }

  if (resolvedBackend === 'tavily') {
    if (!cfg.tavilyApiKey?.trim()) throw new Error('未配置 Tavily API Key')
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.tavilyApiKey.trim(),
        query: cleanQuery,
        max_results: maxResults
      }),
      signal: combineSignals(opts.abortSignal, FETCH_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`Tavily 搜索失败: HTTP ${res.status}`)
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>
    }
    return {
      backend: 'tavily',
      query: cleanQuery,
      results: (data.results || []).slice(0, maxResults).map(r => ({
        title: String(r.title || ''),
        url: String(r.url || ''),
        snippet: String(r.content || '')
      }))
    }
  }

  if (resolvedBackend === 'brave') {
    if (!cfg.braveApiKey?.trim()) throw new Error('未配置 Brave Search API Key')
    const u = new URL('https://api.search.brave.com/res/v1/web/search')
    u.searchParams.set('q', cleanQuery)
    u.searchParams.set('count', String(maxResults))
    const res = await fetchImpl(u.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': cfg.braveApiKey.trim()
      },
      signal: combineSignals(opts.abortSignal, FETCH_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`Brave 搜索失败: HTTP ${res.status}`)
    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
    }
    return {
      backend: 'brave',
      query: cleanQuery,
      results: (data.web?.results || []).slice(0, maxResults).map(r => ({
        title: String(r.title || ''),
        url: String(r.url || ''),
        snippet: String(r.description || '')
      }))
    }
  }

  if (resolvedBackend === 'searxng') {
    if (!cfg.searxngUrl?.trim()) throw new Error('未配置 SearXNG 服务地址')
    const base = cfg.searxngUrl.trim().replace(/\/+$/, '')
    const u = new URL(`${base}/search`)
    u.searchParams.set('q', cleanQuery)
    u.searchParams.set('format', 'json')
    const res = await fetchImpl(u.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: combineSignals(opts.abortSignal, FETCH_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`SearXNG 搜索失败: HTTP ${res.status}`)
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>
    }
    return {
      backend: 'searxng',
      query: cleanQuery,
      results: (data.results || []).slice(0, maxResults).map(r => ({
        title: String(r.title || ''),
        url: String(r.url || ''),
        snippet: String(r.content || '')
      }))
    }
  }

  // Fallback: DuckDuckGo HTML
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`
  const res = await fetchImpl(ddgUrl, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'text/html'
    },
    signal: combineSignals(opts.abortSignal, FETCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`DuckDuckGo 搜索失败: HTTP ${res.status}`)
  const html = await res.text()
  return {
    backend: 'duckduckgo',
    query: cleanQuery,
    results: parseDuckDuckGoHtml(html, maxResults)
  }
}
