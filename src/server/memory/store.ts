import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, join } from 'node:path'
import { nanoid } from 'nanoid'
import { MemoryDto, MemorySearchHitDto, MemoryUpsertInput } from '@shared/schemas'
import { AppDatabase } from '../db/database'

function serializeFrontmatter(meta: {
  id: string
  title: string
  tags: string[]
  createdAt: number
  updatedAt: number
  sourceThreadId: string | null
}): string {
  const safeTitle = JSON.stringify(meta.title)
  const tagsLines = meta.tags.length
    ? meta.tags.map(t => `  - ${JSON.stringify(t)}`).join('\n')
    : ' []'
  return [
    '---',
    `id: ${meta.id}`,
    `title: ${safeTitle}`,
    meta.tags.length ? `tags:\n${tagsLines}` : 'tags: []',
    `createdAt: ${meta.createdAt}`,
    `updatedAt: ${meta.updatedAt}`,
    `sourceThreadId: ${meta.sourceThreadId ? JSON.stringify(meta.sourceThreadId) : 'null'}`,
    '---'
  ].join('\n')
}

function unquoteYaml(val: string): string {
  const trimmed = val.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      if (trimmed.startsWith('"')) return JSON.parse(trimmed)
    } catch {
      // Fallback strip quotes
    }
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseMemoryMarkdown(
  raw: string,
  fallbackId: string,
  fallbackTs: number
): {
  id: string
  title: string
  tags: string[]
  createdAt: number
  updatedAt: number
  sourceThreadId: string | null
  content: string
} {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!fmMatch) {
    const firstLine = raw.trim().split(/\r?\n/)[0] || fallbackId
    return {
      id: fallbackId,
      title: firstLine.replace(/^#+\s*/, '').slice(0, 60) || fallbackId,
      tags: [],
      createdAt: fallbackTs,
      updatedAt: fallbackTs,
      sourceThreadId: null,
      content: raw.trim()
    }
  }

  const header = fmMatch[1]
  const body = fmMatch[2].trim()
  const lines = header.split(/\r?\n/)

  let id = fallbackId
  let title = fallbackId
  const tags: string[] = []
  let createdAt = fallbackTs
  let updatedAt = fallbackTs
  let sourceThreadId: string | null = null
  let inTagsList = false

  for (const line of lines) {
    if (inTagsList) {
      const itemMatch = /^\s*-\s+(.+)$/.exec(line)
      if (itemMatch) {
        const tag = unquoteYaml(itemMatch[1])
        if (tag) tags.push(tag)
        continue
      }
      inTagsList = false
    }

    const kv = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    const rawVal = kv[2].trim()

    if (key === 'id' && rawVal) {
      id = unquoteYaml(rawVal)
    } else if (key === 'title' && rawVal) {
      title = unquoteYaml(rawVal)
    } else if (key === 'tags') {
      if (!rawVal) {
        inTagsList = true
      } else if (rawVal.startsWith('[')) {
        try {
          const arr = JSON.parse(rawVal)
          if (Array.isArray(arr)) {
            for (const x of arr) {
              if (typeof x === 'string' && x.trim()) tags.push(x.trim())
            }
          }
        } catch {
          const inner = rawVal.slice(1, -1)
          for (const part of inner.split(',')) {
            const t = unquoteYaml(part)
            if (t) tags.push(t)
          }
        }
      }
    } else if (key === 'createdAt' && rawVal) {
      const n = Number(rawVal)
      if (Number.isFinite(n) && n > 0) createdAt = n
    } else if (key === 'updatedAt' && rawVal) {
      const n = Number(rawVal)
      if (Number.isFinite(n) && n > 0) updatedAt = n
    } else if (key === 'sourceThreadId') {
      const v = unquoteYaml(rawVal)
      sourceThreadId = !v || v === 'null' ? null : v
    }
  }

  return { id, title, tags, createdAt, updatedAt, sourceThreadId, content: body }
}

export class MemoryStore {
  constructor(
    private db: AppDatabase,
    private memoryDir: string
  ) {
    mkdirSync(this.memoryDir, { recursive: true })
  }

  syncFromDisk(): void {
    mkdirSync(this.memoryDir, { recursive: true })
    const files = readdirSync(this.memoryDir).filter(f => f.toLowerCase().endsWith('.md'))
    const diskIds = new Set<string>()

    for (const fileName of files) {
      const fullPath = join(this.memoryDir, fileName)
      try {
        const st = statSync(fullPath)
        if (!st.isFile()) continue
        const raw = readFileSync(fullPath, 'utf8')
        const fallbackId = basename(fileName, '.md')
        const parsed = parseMemoryMarkdown(raw, fallbackId, Math.round(st.mtimeMs))
        diskIds.add(parsed.id)
        this.db.upsertMemoryIndex({
          id: parsed.id,
          title: parsed.title,
          tags: parsed.tags,
          content: parsed.content,
          sourceThreadId: parsed.sourceThreadId,
          fileName,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt
        })
      } catch {
        // Ignore unreadable markdown file
      }
    }

    const dbRows = this.db.listMemoryRows(10_000)
    for (const row of dbRows) {
      if (!diskIds.has(row.id) && !existsSync(join(this.memoryDir, row.fileName))) {
        this.db.deleteMemoryIndex(row.id)
      }
    }
  }

  private readContentForRow(fileName: string, fallbackId: string, fallbackTs: number): string {
    const fullPath = join(this.memoryDir, fileName)
    if (!existsSync(fullPath)) return ''
    try {
      const raw = readFileSync(fullPath, 'utf8')
      return parseMemoryMarkdown(raw, fallbackId, fallbackTs).content
    } catch {
      return ''
    }
  }

  list(limit = 200): MemoryDto[] {
    const rows = this.db.listMemoryRows(limit)
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      tags: r.tags,
      content: this.readContentForRow(r.fileName, r.id, r.updatedAt),
      sourceThreadId: r.sourceThreadId,
      fileName: r.fileName,
      filePath: join(this.memoryDir, r.fileName),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }))
  }

  get(id: string): MemoryDto | null {
    const row = this.db.getMemoryRow(id)
    if (!row) return null
    return {
      id: row.id,
      title: row.title,
      tags: row.tags,
      content: this.readContentForRow(row.fileName, row.id, row.updatedAt),
      sourceThreadId: row.sourceThreadId,
      fileName: row.fileName,
      filePath: join(this.memoryDir, row.fileName),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  }

  create(input: MemoryUpsertInput): MemoryDto {
    mkdirSync(this.memoryDir, { recursive: true })
    const id = `mem_${nanoid(10)}`
    const now = Date.now()
    const cleanTags = (input.tags || []).map(t => t.trim()).filter(Boolean)
    const fileName = `${id}.md`
    const filePath = join(this.memoryDir, fileName)
    const title = input.title.trim()
    const content = input.content.trim()
    const sourceThreadId = input.sourceThreadId || null

    const md = `${serializeFrontmatter({
      id,
      title,
      tags: cleanTags,
      createdAt: now,
      updatedAt: now,
      sourceThreadId
    })}\n\n${content}\n`
    writeFileSync(filePath, md, 'utf8')

    this.db.upsertMemoryIndex({
      id,
      title,
      tags: cleanTags,
      content,
      sourceThreadId,
      fileName,
      createdAt: now,
      updatedAt: now
    })

    return {
      id,
      title,
      tags: cleanTags,
      content,
      sourceThreadId,
      fileName,
      filePath,
      createdAt: now,
      updatedAt: now
    }
  }

  update(id: string, patch: Partial<MemoryUpsertInput>): MemoryDto | null {
    const existing = this.get(id)
    if (!existing) return null
    const now = Date.now()
    const title = patch.title !== undefined ? patch.title.trim() : existing.title
    const content = patch.content !== undefined ? patch.content.trim() : existing.content
    const tags =
      patch.tags !== undefined
        ? patch.tags.map(t => t.trim()).filter(Boolean)
        : existing.tags
    const sourceThreadId =
      patch.sourceThreadId !== undefined ? patch.sourceThreadId || null : existing.sourceThreadId

    const filePath = join(this.memoryDir, existing.fileName)
    const md = `${serializeFrontmatter({
      id: existing.id,
      title,
      tags,
      createdAt: existing.createdAt,
      updatedAt: now,
      sourceThreadId
    })}\n\n${content}\n`
    writeFileSync(filePath, md, 'utf8')

    this.db.upsertMemoryIndex({
      id: existing.id,
      title,
      tags,
      content,
      sourceThreadId,
      fileName: existing.fileName,
      createdAt: existing.createdAt,
      updatedAt: now
    })

    return {
      id: existing.id,
      title,
      tags,
      content,
      sourceThreadId,
      fileName: existing.fileName,
      filePath,
      createdAt: existing.createdAt,
      updatedAt: now
    }
  }

  delete(id: string): boolean {
    const existing = this.db.getMemoryRow(id)
    if (!existing) return false
    const filePath = join(this.memoryDir, existing.fileName)
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true })
    }
    return this.db.deleteMemoryIndex(id)
  }

  search(query: string, limit = 5): MemorySearchHitDto[] {
    const hits = this.db.searchMemoryFts(query, limit)
    return hits.map(h => {
      const content = this.readContentForRow(h.fileName, h.id, h.updatedAt)
      return {
        id: h.id,
        title: h.title,
        tags: h.tags,
        content,
        snippet: h.snippet || content.slice(0, 160),
        sourceThreadId: h.sourceThreadId,
        fileName: h.fileName,
        filePath: join(this.memoryDir, h.fileName),
        createdAt: h.createdAt,
        updatedAt: h.updatedAt
      }
    })
  }

  buildSystemPromptAppendix(userMessageText: string, limit = 5): string {
    const clean = userMessageText.trim()
    if (!clean) return ''
    const hits = this.search(clean, limit)
    if (!hits.length) return ''
    const blocks = hits.map(
      (h, i) =>
        `${i + 1}. **${h.title}**${h.tags.length ? ` [${h.tags.join(', ')}]` : ''}\n${h.content.slice(0, 600)}`
    )
    return `\n\n<recalled_memories>\n以下是与当前用户消息相关的长期记忆（由 FTS 检索召回，供参考）：\n${blocks.join('\n\n')}\n</recalled_memories>`
  }
}
