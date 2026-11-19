import { nanoid } from 'nanoid'
import { PendingPermissionRequestDto, PermissionOptionDto } from '@shared/schemas'
import { AppDatabase } from '../db/database'
import { TaggedLogger } from '../logger'

export type PermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string }

export function isAllowPermissionOption(opt: PermissionOptionDto | undefined): boolean {
  if (!opt || !opt.optionId) return false
  return /^allow_/i.test(opt.kind)
}

interface PendingPermissionEntry {
  dto: PendingPermissionRequestDto
  rejectOptionId: string | null
  timer: NodeJS.Timeout
  abortCleanup?: () => void
  resolve: (outcome: PermissionOutcome) => void
}

export class PermissionGate {
  private pendingPermissions = new Map<string, PendingPermissionEntry>()

  constructor(
    private db: AppDatabase,
    private logger: TaggedLogger,
    private onPermissionRequested: (dto: PendingPermissionRequestDto) => void,
    private onPermissionResolved: (payload: {
      requestId: string
      threadId: string
      outcome: string
    }) => void
  ) {}

  /**
   * Fail-Closed Permission Gate:
   * Never auto-approves! If timeout expires, abort triggers, or user rejects,
   * resolves to reject option or cancelled.
   */
  requestPermission(params: {
    threadId: string
    providerId: string
    title: string
    toolName: string
    rawInput: unknown
    cwd: string | null
    options: PermissionOptionDto[]
    abortSignal?: AbortSignal
    logTag?: string
  }): Promise<PermissionOutcome> {
    const rejectOption = params.options.find(
      o =>
        !isAllowPermissionOption(o) &&
        (/reject|deny|cancel/i.test(o.kind) ||
          /reject|deny|cancel|拒绝/i.test(o.name) ||
          /reject|deny|cancel/i.test(o.optionId))
    )
    const rejectOptionId = rejectOption?.optionId ?? null

    if (params.abortSignal?.aborted) {
      return Promise.resolve(
        rejectOptionId
          ? { outcome: 'selected', optionId: rejectOptionId }
          : { outcome: 'cancelled' }
      )
    }

    const timeoutSec = this.db.getSettings().acp.permissionTimeoutSec || 60
    const requestId = `perm_${nanoid(10)}`
    const dto: PendingPermissionRequestDto = {
      requestId,
      threadId: params.threadId,
      providerId: params.providerId,
      title: params.title,
      toolName: params.toolName,
      rawInput: params.rawInput,
      cwd: params.cwd,
      options: params.options,
      expiresAt: Date.now() + timeoutSec * 1000
    }

    const logTag = params.logTag || params.providerId || 'Permission'

    return new Promise<PermissionOutcome>(resolvePromise => {
      const timer = setTimeout(() => {
        this.logger.warn(
          logTag,
          `Permission ${requestId} timed out after ${timeoutSec}s -> auto-rejecting (fail-closed)`
        )
        this.resolvePermission(requestId, '__cancel__')
      }, timeoutSec * 1000)
      timer.unref?.()

      let abortCleanup: (() => void) | undefined
      if (params.abortSignal) {
        const onAbort = () => {
          this.resolvePermission(requestId, '__cancel__')
        }
        params.abortSignal.addEventListener('abort', onAbort, { once: true })
        abortCleanup = () => params.abortSignal?.removeEventListener('abort', onAbort)
      }

      this.pendingPermissions.set(requestId, {
        dto,
        rejectOptionId,
        timer,
        abortCleanup,
        resolve: resolvePromise
      })

      this.onPermissionRequested(dto)
    })
  }

  resolvePermission(requestId: string, selectedOptionId: string): boolean {
    const entry = this.pendingPermissions.get(requestId)
    if (!entry) return false
    clearTimeout(entry.timer)
    entry.abortCleanup?.()
    this.pendingPermissions.delete(requestId)

    // Strict whitelist: only an option present in `entry.dto.options` with `kind` = `allow_*` is permitted
    const matchedOption =
      selectedOptionId !== '__cancel__' && selectedOptionId !== '__reject__'
        ? entry.dto.options.find(o => o.optionId === selectedOptionId)
        : undefined

    const isAllowed = Boolean(
      matchedOption &&
        matchedOption.optionId !== entry.rejectOptionId &&
        isAllowPermissionOption(matchedOption)
    )

    if (!isAllowed) {
      const rejectId =
        matchedOption && !isAllowPermissionOption(matchedOption)
          ? matchedOption.optionId
          : entry.rejectOptionId
      const outcome: PermissionOutcome = rejectId
        ? { outcome: 'selected', optionId: rejectId }
        : { outcome: 'cancelled' }
      entry.resolve(outcome)
      this.onPermissionResolved({
        requestId,
        threadId: entry.dto.threadId,
        outcome: 'rejected'
      })
      return true
    }

    entry.resolve({ outcome: 'selected', optionId: matchedOption!.optionId })
    this.onPermissionResolved({
      requestId,
      threadId: entry.dto.threadId,
      outcome: matchedOption!.kind === 'allow_always' ? 'allow_always' : matchedOption!.optionId
    })
    return true
  }

  approvePendingForThreadTool(threadId: string, toolName: string): void {
    for (const [reqId, entry] of [...this.pendingPermissions.entries()]) {
      if (entry.dto.threadId === threadId && entry.dto.toolName === toolName) {
        const allowAlwaysOpt =
          entry.dto.options.find(o => o.kind === 'allow_always') ||
          entry.dto.options.find(o => isAllowPermissionOption(o))
        if (allowAlwaysOpt) {
          this.resolvePermission(reqId, allowAlwaysOpt.optionId)
        }
      }
    }
  }

  getPendingPermissionsForThread(threadId: string): PendingPermissionRequestDto[] {
    const out: PendingPermissionRequestDto[] = []
    for (const entry of this.pendingPermissions.values()) {
      if (entry.dto.threadId === threadId) out.push(entry.dto)
    }
    return out
  }

  cancelThreadPermissions(threadId: string): void {
    for (const [reqId, entry] of [...this.pendingPermissions.entries()]) {
      if (entry.dto.threadId === threadId) {
        this.resolvePermission(reqId, '__cancel__')
      }
    }
  }

  disposeAll(): void {
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer)
      entry.abortCleanup?.()
      entry.resolve({ outcome: 'cancelled' })
    }
    this.pendingPermissions.clear()
  }
}
