import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  tag: string
  message: string
}

const MAX_BUFFER = 300

export class TaggedLogger {
  private buffer: LogEntry[] = []
  private logsDir: string

  constructor(logsDir: string) {
    this.logsDir = logsDir
    mkdirSync(logsDir, { recursive: true })
  }

  private write(level: LogLevel, tag: string, message: string, detail?: unknown): void {
    const now = new Date()
    const timestamp = now.toISOString()
    const suffix =
      detail !== undefined
        ? ' ' + (detail instanceof Error ? detail.stack || detail.message : JSON.stringify(detail))
        : ''
    const fullMessage = `${message}${suffix}`
    const entry: LogEntry = { timestamp, level, tag, message: fullMessage }

    this.buffer.push(entry)
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift()
    }

    const day = timestamp.slice(0, 10)
    const filePath = join(this.logsDir, `cjh-${day}.log`)
    const line = `[${timestamp}] [${level}] [${tag}] ${fullMessage}\n`
    try {
      appendFileSync(filePath, line, 'utf8')
    } catch {
      // Ignore file append failure in read-only edge cases
    }
  }

  debug(tag: string, message: string, detail?: unknown): void {
    this.write('DEBUG', tag, message, detail)
  }

  info(tag: string, message: string, detail?: unknown): void {
    this.write('INFO', tag, message, detail)
  }

  warn(tag: string, message: string, detail?: unknown): void {
    this.write('WARN', tag, message, detail)
  }

  error(tag: string, message: string, detail?: unknown): void {
    this.write('ERROR', tag, message, detail)
  }

  getRecent(tagFilter?: string, limit = 150): LogEntry[] {
    const filtered = tagFilter
      ? this.buffer.filter(e => e.tag.toLowerCase().includes(tagFilter.toLowerCase()))
      : this.buffer
    return filtered.slice(-limit)
  }

  getLogsDir(): string {
    return this.logsDir
  }
}
