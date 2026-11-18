import { CronJobDto, CronRunDto } from '@shared/schemas'
import { AppDatabase } from '../db/database'
import { GenerationEngine } from '../engine/generation-engine'
import { TaggedLogger } from '../logger'
import { WsHub } from '../ws-hub'

interface ParsedCron {
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  domWildcard: boolean
  dowWildcard: boolean
}

const PRESET_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23'
    })
    formatterCache.set(timeZone, fmt)
  }
  return fmt
}

export function validateTimezone(timeZone: string): string {
  const tz = timeZone.trim()
  if (!tz) throw new Error('时区不能为空')
  try {
    getFormatter(tz)
    return tz
  } catch {
    throw new Error(`无效的时区: ${tz}`)
  }
}

function parseCronField(
  token: string,
  min: number,
  max: number,
  normalizeValue?: (v: number) => number
): { values: Set<number>; isWildcard: boolean } {
  const trimmed = token.trim()
  if (!trimmed) throw new Error('Cron 字段不能为空')
  const isWildcard = trimmed === '*'
  const out = new Set<number>()

  for (const part of trimmed.split(',')) {
    const seg = part.trim()
    if (!seg) throw new Error(`无效的 Cron 片段: "${token}"`)

    const slashParts = seg.split('/')
    if (slashParts.length > 2) throw new Error(`无效的 Cron 步长语法: "${seg}"`)
    const rangeStr = slashParts[0]
    const step = slashParts[1] !== undefined ? Number(slashParts[1]) : 1
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`无效的 Cron 步长值: "${seg}"`)
    }

    let start: number
    let end: number
    if (rangeStr === '*') {
      start = min
      end = max
    } else if (rangeStr.includes('-')) {
      const bounds = rangeStr.split('-')
      if (bounds.length !== 2) throw new Error(`无效的 Cron 范围: "${rangeStr}"`)
      start = Number(bounds[0])
      end = Number(bounds[1])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new Error(`无效的 Cron 范围: "${rangeStr}"`)
      }
    } else {
      start = Number(rangeStr)
      end = slashParts[1] !== undefined ? max : start
      if (!Number.isInteger(start)) {
        throw new Error(`无效的 Cron 数值: "${rangeStr}"`)
      }
    }

    if (start < min || end > max) {
      throw new Error(`Cron 数值越界 (${min}-${max}): "${seg}"`)
    }

    for (let v = start; v <= end; v += step) {
      out.add(normalizeValue ? normalizeValue(v) : v)
    }
  }

  if (out.size === 0) throw new Error(`Cron 字段 "${token}" 未匹配任何值`)
  return { values: out, isWildcard }
}

export function parseCronExpression(expr: string): ParsedCron {
  const normalized = PRESET_ALIASES[expr.trim().toLowerCase()] || expr.trim()
  const fields = normalized.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`Cron 表达式必须包含 5 个字段 (分 时 日 月 周)，当前: "${expr}"`)
  }
  const minField = parseCronField(fields[0], 0, 59)
  const hourField = parseCronField(fields[1], 0, 23)
  const domField = parseCronField(fields[2], 1, 31)
  const monField = parseCronField(fields[3], 1, 12)
  const dowField = parseCronField(fields[4], 0, 7, v => (v === 7 ? 0 : v))

  return {
    minutes: minField.values,
    hours: hourField.values,
    daysOfMonth: domField.values,
    months: monField.values,
    daysOfWeek: dowField.values,
    domWildcard: domField.isWildcard,
    dowWildcard: dowField.isWildcard
  }
}

function getZonedDateParts(
  timestampMs: number,
  timeZone: string
): {
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
} {
  const parts = getFormatter(timeZone).formatToParts(new Date(timestampMs))
  let month = 1
  let day = 1
  let hour = 0
  let minute = 0
  let weekday = 0

  for (const p of parts) {
    if (p.type === 'month') month = Number(p.value)
    else if (p.type === 'day') day = Number(p.value)
    else if (p.type === 'hour') hour = Number(p.value) % 24
    else if (p.type === 'minute') minute = Number(p.value)
    else if (p.type === 'weekday') weekday = WEEKDAY_MAP[p.value] ?? 0
  }

  return { month, day, hour, minute, weekday }
}

function matchesDateBucket(
  parsed: ParsedCron,
  zoned: { month: number; day: number; hour: number; weekday: number }
): boolean {
  if (!parsed.months.has(zoned.month)) return false
  if (!parsed.hours.has(zoned.hour)) return false

  const domMatch = parsed.daysOfMonth.has(zoned.day)
  const dowMatch = parsed.daysOfWeek.has(zoned.weekday)
  if (!parsed.domWildcard && !parsed.dowWildcard) {
    return domMatch || dowMatch
  }
  return domMatch && dowMatch
}

export function matchesCronAt(expr: string, timestampMs: number, timeZone = 'Asia/Shanghai'): boolean {
  const parsed = parseCronExpression(expr)
  validateTimezone(timeZone)
  const z = getZonedDateParts(timestampMs, timeZone)
  return matchesDateBucket(parsed, z) && parsed.minutes.has(z.minute)
}

export function computeNextRunAt(
  expr: string,
  timeZone = 'Asia/Shanghai',
  afterMs = Date.now()
): number | null {
  const parsed = parseCronExpression(expr)
  const tz = validateTimezone(timeZone)
  const startMs = Math.floor(afterMs / 60_000) * 60_000 + 60_000
  const maxMs = startMs + 366 * 24 * 60 * 60_000

  // Fine scan first 24 hours minute-by-minute
  const fineLimit = Math.min(maxMs, startMs + 24 * 60 * 60_000)
  let ts = startMs
  for (; ts < fineLimit; ts += 60_000) {
    const z = getZonedDateParts(ts, tz)
    if (matchesDateBucket(parsed, z) && parsed.minutes.has(z.minute)) {
      return ts
    }
  }

  // Coarse scan every 30 minutes across remaining year (DST-safe), then refine per minute
  while (ts < maxMs) {
    const z = getZonedDateParts(ts, tz)
    if (matchesDateBucket(parsed, z)) {
      const scanFrom = Math.max(fineLimit, ts - 30 * 60_000)
      const scanTo = Math.min(maxMs, ts + 60 * 60_000)
      for (let m = scanFrom; m < scanTo; m += 60_000) {
        const zm = getZonedDateParts(m, tz)
        if (matchesDateBucket(parsed, zm) && parsed.minutes.has(zm.minute)) {
          return m
        }
      }
    }
    ts += 30 * 60_000
  }

  return null
}

export class CronScheduler {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private activeJobIds = new Set<string>()

  constructor(
    private db: AppDatabase,
    private engine: GenerationEngine,
    private wsHub: WsHub,
    private logger: TaggedLogger,
    private intervalMs = 15_000
  ) {}

  start(): void {
    if (this.timer) return
    // Ensure all enabled jobs have a valid nextRunAt computed
    const jobs = this.db.listCronJobs()
    const now = Date.now()
    for (const job of jobs) {
      if (job.enabled && !job.nextRunAt) {
        try {
          const nextRunAt = computeNextRunAt(job.cronExpr, job.timezone, now)
          this.db.updateCronJobRuntime(job.id, { nextRunAt })
        } catch {
          // Leave invalid cron untouched
        }
      }
    }

    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(now = Date.now()): Promise<CronRunDto[]> {
    if (this.ticking) return []
    this.ticking = true
    const runs: CronRunDto[] = []
    try {
      const dueJobs = this.db.listDueCronJobs(now)
      for (const job of dueJobs) {
        if (this.activeJobIds.has(job.id)) continue
        let nextRunAt: number | null = null
        try {
          nextRunAt = computeNextRunAt(job.cronExpr, job.timezone, now)
        } catch {
          nextRunAt = null
        }
        this.db.updateCronJobRuntime(job.id, {
          lastRunAt: now,
          nextRunAt
        })
        const run = await this.executeJob(job, 'schedule', now)
        if (run) runs.push(run)
      }
    } finally {
      this.ticking = false
    }
    return runs
  }

  async triggerNow(jobId: string, now = Date.now()): Promise<CronRunDto | null> {
    const job = this.db.getCronJob(jobId)
    if (!job) return null
    return this.executeJob(job, 'manual', now)
  }

  private async executeJob(
    job: CronJobDto,
    triggerType: 'schedule' | 'manual',
    startedAt: number
  ): Promise<CronRunDto> {
    this.activeJobIds.add(job.id)

    let targetThread = job.threadId ? this.db.getThread(job.threadId) : null
    if (!targetThread) {
      targetThread = this.db.createThread({
        title: `[定时] ${job.name}`,
        model: job.model || undefined
      })
      this.wsHub.broadcast('thread_created', targetThread)
    }

    let run = this.db.insertCronRun({
      jobId: job.id,
      threadId: targetThread.id,
      triggerType,
      status: 'running',
      startedAt
    })
    this.wsHub.broadcast('cron_run_updated', run)

    try {
      const result = await this.engine.startTurn({
        threadId: targetThread.id,
        userMessage: {
          role: 'user',
          parts: [{ type: 'text', text: job.prompt }]
        },
        model: job.model || undefined,
        source: 'cron'
      })

      const finishedAt = Date.now()
      const status = result.ok ? 'success' : 'error'
      run =
        this.db.finishCronRun(run.id, {
          status,
          messageId: result.messageId ?? null,
          error: result.error ?? null,
          finishedAt
        }) || run

      const updatedJob = this.db.updateCronJobRuntime(job.id, {
        lastRunAt: startedAt,
        lastStatus: status,
        lastError: result.error ?? null
      })
      if (updatedJob) this.wsHub.broadcast('cron_job_updated', updatedJob)
      this.wsHub.broadcast('cron_run_updated', run)
      return run
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.logger.error('Cron', `Job "${job.name}" (${job.id}) failed: ${errMsg}`)
      const finishedAt = Date.now()
      run =
        this.db.finishCronRun(run.id, {
          status: 'error',
          error: errMsg,
          finishedAt
        }) || run
      const updatedJob = this.db.updateCronJobRuntime(job.id, {
        lastRunAt: startedAt,
        lastStatus: 'error',
        lastError: errMsg
      })
      if (updatedJob) this.wsHub.broadcast('cron_job_updated', updatedJob)
      this.wsHub.broadcast('cron_run_updated', run)
      return run
    } finally {
      this.activeJobIds.delete(job.id)
    }
  }
}
