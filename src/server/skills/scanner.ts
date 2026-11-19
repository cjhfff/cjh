import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SkillDto } from '@shared/schemas'
import { AppDatabase } from '../db/database'

function parseSkillFrontmatter(markdown: string, fallbackName: string): {
  name: string
  description: string
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (!match) {
    return { name: fallbackName, description: '本地自定义技能' }
  }
  const block = match[1]
  const nameMatch = /^name:\s*["']?(.+?)["']?\s*$/m.exec(block)
  const descMatch = /^description:\s*["']?(.+?)["']?\s*$/m.exec(block)
  return {
    name: nameMatch?.[1]?.trim() || fallbackName,
    description: descMatch?.[1]?.trim() || '本地技能扩展'
  }
}

export class SkillsScanner {
  private cached: SkillDto[] = []

  constructor(
    private db: AppDatabase,
    private localSkillsDir: string,
    private builtinSkillsDir?: string
  ) {}

  scan(): SkillDto[] {
    const enabledMap = this.db.getSkillsEnabledMap()
    const roots: Array<{ dir: string; source: 'builtin' | 'local' | 'claude' }> = []
    if (this.builtinSkillsDir) {
      roots.push({ dir: this.builtinSkillsDir, source: 'builtin' })
    }
    roots.push({ dir: this.localSkillsDir, source: 'local' })
    roots.push({ dir: join(homedir(), '.claude', 'skills'), source: 'claude' })

    const found: SkillDto[] = []
    for (const root of roots) {
      if (!existsSync(root.dir)) continue
      let entries: Array<{ name: string; isDirectory: () => boolean }> = []
      try {
        entries = readdirSync(root.dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillMdPath = join(root.dir, entry.name, 'SKILL.md')
        if (!existsSync(skillMdPath)) continue
        try {
          const content = readFileSync(skillMdPath, 'utf8')
          const meta = parseSkillFrontmatter(content, entry.name)
          const id = `${root.source}:${entry.name}`
          const enabled = enabledMap.has(id) ? enabledMap.get(id)! : true
          found.push({
            id,
            name: meta.name,
            description: meta.description,
            path: skillMdPath,
            source: root.source,
            enabled
          })
        } catch {
          // Skip malformed skill file
        }
      }
    }

    this.cached = found
    return found
  }

  list(): SkillDto[] {
    if (!this.cached.length) return this.scan()
    return this.cached
  }

  getContent(id: string): { skill: SkillDto; content: string } | null {
    const target = this.list().find(s => s.id === id)
    if (!target || !existsSync(target.path)) return null
    try {
      return { skill: target, content: readFileSync(target.path, 'utf8') }
    } catch {
      return null
    }
  }

  setEnabled(id: string, enabled: boolean): SkillDto | null {
    const target = this.list().find(s => s.id === id)
    if (!target) return null
    this.db.setSkillEnabled(id, target.path, enabled)
    target.enabled = enabled
    return target
  }

  buildSystemPromptAppendix(selectedIds?: string[] | null): string {
    const all = this.list().filter(s => s.enabled)
    const filtered = selectedIds ? all.filter(s => selectedIds.includes(s.id)) : all
    if (!filtered.length) return ''
    const lines = filtered.map(s => `- [${s.id}] ${s.name}: ${s.description}`)
    return `\n\n<available_skills>\n以下技能已启用（渐进加载：仅展示名称与简介，需要执行相关流程时请调用 skill_read 工具读取完整 SKILL.md）：\n${lines.join('\n')}\n</available_skills>`
  }
}
