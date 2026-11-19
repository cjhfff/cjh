import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_READ_BYTES = 200 * 1024
const MAX_GREP_FILE_BYTES = 1024 * 1024
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'out'])

function isSameOrInside(parent: string, child: string): boolean {
  const normParent = process.platform === 'win32' ? parent.toLowerCase() : parent
  const normChild = process.platform === 'win32' ? child.toLowerCase() : child
  const normSep = sep
  return normChild === normParent || normChild.startsWith(normParent + normSep)
}

function normalizeReadlinkTarget(rawLink: string): string {
  if (rawLink.startsWith('\\\\?\\UNC\\')) {
    return '\\\\' + rawLink.slice(8)
  }
  if (rawLink.startsWith('\\\\?\\')) {
    return rawLink.slice(4)
  }
  return rawLink
}

function resolveRealCandidatePath(targetPath: string, depth = 0): string | null {
  if (depth > 16) return null
  try {
    const lst = lstatSync(targetPath, { throwIfNoEntry: false })
    if (lst) {
      if (lst.isSymbolicLink()) {
        const rawLink = normalizeReadlinkTarget(readlinkSync(targetPath))
        const nextTarget = isAbsolute(rawLink)
          ? resolve(rawLink)
          : resolve(dirname(targetPath), rawLink)
        return resolveRealCandidatePath(nextTarget, depth + 1)
      }
      return realpathSync(targetPath)
    }

    const parent = dirname(targetPath)
    if (parent === targetPath) {
      return null
    }
    const realParent = resolveRealCandidatePath(parent, depth)
    if (!realParent) return null
    return join(realParent, basename(targetPath))
  } catch {
    return null
  }
}

/**
 * Resolves a relative (or workspace-contained) path inside `workspaceRoot`,
 * blocking lexical `..` traversal, cross-drive escapes, junctions, and active/dangling symlinks.
 */
export function resolveSafeWorkspacePath(workspaceRoot: string, rawInput: string): string | null {
  if (typeof rawInput !== 'string' || rawInput.includes('\0')) return null
  const root = resolve(workspaceRoot)
  const trimmed = rawInput.trim()

  let candidate: string
  if (!trimmed || trimmed === '.') {
    candidate = root
  } else if (isAbsolute(trimmed)) {
    candidate = resolve(trimmed)
  } else {
    const cleanRel = trimmed.replace(/^[/\\]+/, '')
    candidate = resolve(root, cleanRel)
  }

  if (!isSameOrInside(root, candidate)) {
    return null
  }

  // Symlink / dangling symlink / junction escape protection
  try {
    const realRoot = existsSync(root) ? realpathSync(root) : root
    const realCandidate = resolveRealCandidatePath(candidate)
    if (!realCandidate || !isSameOrInside(realRoot, realCandidate)) {
      return null
    }
  } catch {
    return null
  }

  return candidate
}

function assertWorkspaceBound(workspacePath: string | null | undefined): string {
  if (!workspacePath || !workspacePath.trim()) {
    throw new Error('请先为该线程绑定工作目录')
  }
  const root = resolve(workspacePath)
  if (!existsSync(root)) {
    throw new Error(`绑定的工作目录不存在: ${workspacePath}`)
  }
  return root
}

function assertSafeTarget(workspaceRoot: string, targetPath: string): string {
  const resolved = resolveSafeWorkspacePath(workspaceRoot, targetPath)
  if (!resolved) {
    throw new Error(`路径越界：禁止访问工作目录之外的路径 (${targetPath})`)
  }
  return resolved
}

export function workspaceFsList(
  workspacePath: string | null | undefined,
  opts?: { dir?: string; recursive?: boolean; maxEntries?: number }
): {
  dir: string
  entries: Array<{ name: string; path: string; isDir: boolean; size: number }>
  truncated: boolean
} {
  const root = assertWorkspaceBound(workspacePath)
  const relDir = opts?.dir || '.'
  const targetDir = assertSafeTarget(root, relDir)
  if (!existsSync(targetDir)) {
    throw new Error(`目录不存在: ${relDir}`)
  }
  const st = statSync(targetDir)
  if (!st.isDirectory()) {
    throw new Error(`路径不是目录: ${relDir}`)
  }

  const realRoot = realpathSync(root)
  const visitedDirs = new Set<string>([realpathSync(targetDir)])
  const maxEntries = Math.min(500, Math.max(1, opts?.maxEntries ?? 200))
  const entries: Array<{ name: string; path: string; isDir: boolean; size: number }> = []
  let truncated = false

  const walk = (dir: string) => {
    if (entries.length >= maxEntries) {
      truncated = true
      return
    }
    const items = readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
    )
    for (const item of items) {
      if (entries.length >= maxEntries) {
        truncated = true
        return
      }
      if (IGNORED_DIRS.has(item.name)) continue
      const full = join(dir, item.name)
      if (!resolveSafeWorkspacePath(root, full)) continue
      const rel = relative(root, full).replace(/\\/g, '/')
      let isDir = item.isDirectory()
      let size = 0
      if (item.isSymbolicLink()) {
        try {
          const st = statSync(full)
          isDir = st.isDirectory()
          if (!isDir) size = st.size
        } catch {
          isDir = false
          size = 0
        }
      } else if (!isDir) {
        try {
          size = statSync(full).size
        } catch {
          size = 0
        }
      }
      entries.push({
        name: item.name,
        path: rel,
        isDir,
        size
      })
      if (opts?.recursive && isDir) {
        try {
          const realSub = realpathSync(full)
          if (!isSameOrInside(realRoot, realSub) || visitedDirs.has(realSub)) continue
          visitedDirs.add(realSub)
          walk(full)
        } catch {
          // Skip unreadable or broken directory link
        }
      }
    }
  }

  walk(targetDir)
  return {
    dir: relative(root, targetDir).replace(/\\/g, '/') || '.',
    entries,
    truncated
  }
}

export function workspaceFsRead(
  workspacePath: string | null | undefined,
  opts: { path: string; startLine?: number; endLine?: number }
): {
  path: string
  totalLines: number
  startLine: number
  endLine: number
  content: string
  truncated: boolean
} {
  const root = assertWorkspaceBound(workspacePath)
  const targetFile = assertSafeTarget(root, opts.path)
  if (!existsSync(targetFile)) {
    throw new Error(`文件不存在: ${opts.path}`)
  }
  const st = statSync(targetFile)
  if (st.isDirectory()) {
    throw new Error(`路径是目录，不能按文件读取: ${opts.path}`)
  }

  const rawBuf = readFileSync(targetFile)
  const sample = rawBuf.subarray(0, Math.min(rawBuf.byteLength, 8192))
  if (sample.includes(0)) {
    throw new Error(`不支持读取二进制文件: ${opts.path}`)
  }

  const fullText = rawBuf.toString('utf8')
  const lines = fullText.split(/\r?\n/)
  const totalLines = lines.length

  const start = Math.max(1, opts.startLine ?? 1)
  const end = Math.min(totalLines, opts.endLine ?? totalLines)
  const selectedText = start > end ? '' : lines.slice(start - 1, end).join('\n')

  const byteLen = Buffer.byteLength(selectedText, 'utf8')
  let content = selectedText
  let truncated = false
  if (byteLen > MAX_READ_BYTES) {
    content = Buffer.from(selectedText, 'utf8').subarray(0, MAX_READ_BYTES).toString('utf8')
    truncated = true
  }

  return {
    path: relative(root, targetFile).replace(/\\/g, '/'),
    totalLines,
    startLine: start,
    endLine: Math.max(start, end),
    content,
    truncated
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  let regexStr = '^'
  let i = 0
  while (i < normalized.length) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.*/)?'
          i += 3
        } else {
          regexStr += '.*'
          i += 2
        }
      } else {
        regexStr += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      regexStr += '[^/]'
      i++
    } else if (ch === '{') {
      const closeIdx = normalized.indexOf('}', i)
      if (closeIdx !== -1) {
        const inner = normalized
          .slice(i + 1, closeIdx)
          .split(',')
          .map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('|')
        regexStr += `(?:${inner})`
        i = closeIdx + 1
      } else {
        regexStr += '\\{'
        i++
      }
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`
      i++
    } else {
      regexStr += ch
      i++
    }
  }
  regexStr += '$'
  return new RegExp(regexStr, process.platform === 'win32' ? 'i' : '')
}

export function workspaceFsGlob(
  workspacePath: string | null | undefined,
  opts: { pattern: string; maxResults?: number }
): { pattern: string; files: string[]; truncated: boolean } {
  const root = assertWorkspaceBound(workspacePath)
  const rawPattern = (opts.pattern || '*').trim()
  if (isAbsolute(rawPattern) || rawPattern.split(/[\\/]/).includes('..')) {
    throw new Error(`非法的 glob 模式（不允许越界或绝对路径）: ${rawPattern}`)
  }

  const realRoot = realpathSync(root)
  const visitedDirs = new Set<string>([realRoot])
  const maxResults = Math.min(500, Math.max(1, opts.maxResults ?? 200))
  const matcher = globToRegExp(rawPattern)
  const files: string[] = []
  let truncated = false

  const walk = (dir: string) => {
    if (files.length >= maxResults) {
      truncated = true
      return
    }
    let items: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }> =
      []
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (files.length >= maxResults) {
        truncated = true
        return
      }
      if (IGNORED_DIRS.has(item.name)) continue
      const full = join(dir, item.name)
      if (!resolveSafeWorkspacePath(root, full)) continue
      const rel = relative(root, full).replace(/\\/g, '/')
      let isDir = item.isDirectory()
      if (item.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
      }
      if (isDir) {
        try {
          const realSub = realpathSync(full)
          if (!isSameOrInside(realRoot, realSub) || visitedDirs.has(realSub)) continue
          visitedDirs.add(realSub)
          walk(full)
        } catch {
          // Skip broken directory
        }
      } else if (matcher.test(rel)) {
        files.push(rel)
      }
    }
  }

  walk(root)
  return { pattern: rawPattern, files, truncated }
}

export function workspaceFsGrep(
  workspacePath: string | null | undefined,
  opts: { query: string; isRegex?: boolean; include?: string; maxMatches?: number }
): {
  query: string
  matches: Array<{ path: string; line: number; text: string }>
  truncated: boolean
} {
  const root = assertWorkspaceBound(workspacePath)
  if (!opts.query) {
    throw new Error('搜索关键词不能为空')
  }
  const maxMatches = Math.min(200, Math.max(1, opts.maxMatches ?? 50))
  const includeRegex = opts.include ? globToRegExp(opts.include) : null

  let searchRegex: RegExp | null = null
  if (opts.isRegex) {
    searchRegex = new RegExp(opts.query, 'i')
  }
  const lowerQuery = opts.query.toLowerCase()

  const realRoot = realpathSync(root)
  const visitedDirs = new Set<string>([realRoot])
  const matches: Array<{ path: string; line: number; text: string }> = []
  let truncated = false

  const walk = (dir: string) => {
    if (matches.length >= maxMatches) {
      truncated = true
      return
    }
    let items: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }> =
      []
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (matches.length >= maxMatches) {
        truncated = true
        return
      }
      if (IGNORED_DIRS.has(item.name)) continue
      const full = join(dir, item.name)
      if (!resolveSafeWorkspacePath(root, full)) continue
      const rel = relative(root, full).replace(/\\/g, '/')
      let isDir = item.isDirectory()
      if (item.isSymbolicLink()) {
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
      }
      if (isDir) {
        try {
          const realSub = realpathSync(full)
          if (!isSameOrInside(realRoot, realSub) || visitedDirs.has(realSub)) continue
          visitedDirs.add(realSub)
          walk(full)
        } catch {
          // Skip broken directory
        }
        continue
      }
      if (includeRegex && !includeRegex.test(rel)) continue
      try {
        const st = statSync(full)
        if (st.size > MAX_GREP_FILE_BYTES) continue
        const buf = readFileSync(full)
        if (buf.subarray(0, 4096).includes(0)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let idx = 0; idx < lines.length; idx++) {
          const lineText = lines[idx]
          const hit = searchRegex
            ? searchRegex.test(lineText)
            : lineText.toLowerCase().includes(lowerQuery)
          if (hit) {
            matches.push({
              path: rel,
              line: idx + 1,
              text: lineText.slice(0, 300)
            })
            if (matches.length >= maxMatches) {
              truncated = true
              return
            }
          }
        }
      } catch {
        // Skip unreadable file
      }
    }
  }

  walk(root)
  return { query: opts.query, matches, truncated }
}

export function workspaceFsWrite(
  workspacePath: string | null | undefined,
  opts: { path: string; content: string }
): { path: string; bytesWritten: number } {
  const root = assertWorkspaceBound(workspacePath)
  const targetFile = assertSafeTarget(root, opts.path)
  if (existsSync(targetFile) && statSync(targetFile).isDirectory()) {
    throw new Error(`目标路径是目录，无法写入文件: ${opts.path}`)
  }
  mkdirSync(dirname(targetFile), { recursive: true })
  writeFileSync(targetFile, opts.content, 'utf8')
  return {
    path: relative(root, targetFile).replace(/\\/g, '/'),
    bytesWritten: Buffer.byteLength(opts.content, 'utf8')
  }
}

export function workspaceFsEdit(
  workspacePath: string | null | undefined,
  opts: { path: string; oldText: string; newText: string; replaceAll?: boolean }
): { path: string; replacements: number } {
  const root = assertWorkspaceBound(workspacePath)
  const targetFile = assertSafeTarget(root, opts.path)
  if (!existsSync(targetFile)) {
    throw new Error(`文件不存在: ${opts.path}`)
  }
  if (!opts.oldText) {
    throw new Error('oldText 不能为空')
  }
  const content = readFileSync(targetFile, 'utf8')
  const parts = content.split(opts.oldText)
  const occurrences = parts.length - 1
  if (occurrences === 0) {
    throw new Error(`未在文件 ${opts.path} 中找到匹配的 oldText`)
  }
  if (occurrences > 1 && !opts.replaceAll) {
    throw new Error(
      `在文件 ${opts.path} 中找到 ${occurrences} 处匹配，请提供更多上下文以唯一定位，或设置 replaceAll: true`
    )
  }
  const updated = parts.join(opts.newText)
  writeFileSync(targetFile, updated, 'utf8')
  return {
    path: relative(root, targetFile).replace(/\\/g, '/'),
    replacements: opts.replaceAll ? occurrences : 1
  }
}
