import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Clock,
  ExternalLink,
  History,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2
} from 'lucide-react'
import type {
  CompositeModelOption,
  CronJobDto,
  CronRunDto,
  ThreadDto
} from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { useWorkspaceStore } from '../store/workspace-store'
import { CustomSelect, Switch } from './ui/primitives'

const CRON_PRESETS = [
  { label: '07:30', expr: '30 7 * * *' },
  { label: '09:00 (1-5)', expr: '0 9 * * 1-5' },
  { label: '1h', expr: '0 * * * *' },
  { label: '30m', expr: '*/30 * * * *' }
]

function formatTime(ts: number | null): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function CronView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const setActiveThreadId = useWorkspaceStore(s => s.setActiveThreadId)
  const setActiveView = useWorkspaceStore(s => s.setActiveView)

  const { data: jobs = [] } = useQuery<CronJobDto[]>({
    queryKey: ['cron-jobs'],
    queryFn: () => apiFetch('/api/cron')
  })

  const { data: threads = [] } = useQuery<ThreadDto[]>({
    queryKey: ['threads'],
    queryFn: () => apiFetch('/api/threads')
  })

  const { data: models = [] } = useQuery<CompositeModelOption[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models')
  })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [cronExpr, setCronExpr] = useState('30 7 * * *')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [threadId, setThreadId] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)
  const [historyJobId, setHistoryJobId] = useState<string | null>(null)

  const { data: runs = [] } = useQuery<CronRunDto[]>({
    queryKey: ['cron-runs', historyJobId],
    queryFn: () => apiFetch(`/api/cron/${historyJobId}/runs`),
    enabled: Boolean(historyJobId)
  })

  const openCreate = (presetDaily = false) => {
    setEditingId(null)
    setName(presetDaily ? t('cron.presetDailyName') : '')
    setCronExpr('30 7 * * *')
    setTimezone('Asia/Shanghai')
    setThreadId(threads[0]?.id || '')
    setModel('')
    setPrompt(presetDaily ? t('cron.presetDailyPrompt') : '')
    setEnabled(true)
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (job: CronJobDto) => {
    setEditingId(job.id)
    setName(job.name)
    setCronExpr(job.cronExpr)
    setTimezone(job.timezone)
    setThreadId(job.threadId || '')
    setModel(job.model || '')
    setPrompt(job.prompt)
    setEnabled(job.enabled)
    setFormError(null)
    setFormOpen(true)
  }

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        cronExpr: cronExpr.trim(),
        timezone: timezone.trim() || 'Asia/Shanghai',
        threadId: threadId || null,
        model: model || null,
        prompt: prompt.trim(),
        enabled
      }
      if (editingId) {
        return apiFetch<CronJobDto>(`/api/cron/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        })
      }
      return apiFetch<CronJobDto>('/api/cron', {
        method: 'POST',
        body: JSON.stringify(payload)
      })
    },
    onSuccess: () => {
      setFormOpen(false)
      setEditingId(null)
      setFormError(null)
      void qc.invalidateQueries({ queryKey: ['cron-jobs'] })
    },
    onError: err => {
      setFormError(err instanceof Error ? err.message : String(err))
    }
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) =>
      apiFetch(`/api/cron/${id}/toggle`, {
        method: 'POST',
        body: JSON.stringify({ enabled: next })
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cron-jobs'] })
  })

  const runNowMut = useMutation({
    mutationFn: (id: string) => apiFetch<CronRunDto>(`/api/cron/${id}/run`, { method: 'POST' }),
    onSuccess: (_res, jobId) => {
      setHistoryJobId(jobId)
      void qc.invalidateQueries({ queryKey: ['cron-jobs'] })
      void qc.invalidateQueries({ queryKey: ['cron-runs', jobId] })
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/cron/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, id) => {
      if (historyJobId === id) setHistoryJobId(null)
      void qc.invalidateQueries({ queryKey: ['cron-jobs'] })
    }
  })

  const jumpToThread = (targetThreadId: string | null) => {
    if (!targetThreadId) return
    setActiveThreadId(targetThreadId)
    setActiveView('chat')
  }

  return (
    <div
      className="flex-1 overflow-y-auto p-8 select-text"
      style={{ backgroundImage: 'var(--ambient-glow)' }}
    >
      <div className="max-w-4xl mx-auto space-y-6 text-xs animate-enter">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="text-base font-semibold tracking-tight">{t('cron.title')}</h3>
            </div>
            <p className="text-[var(--text-muted)]">{t('cron.subtitle')}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => openCreate(true)}
              className="px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-medium inline-flex items-center gap-1.5 transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-[var(--warning)]" />
              <span>{t('cron.presetDailyReport')}</span>
            </button>
            <button
              type="button"
              onClick={() => openCreate(false)}
              className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('cron.addJob')}</span>
            </button>
          </div>
        </div>

        {formOpen && (
          <div className="p-5 rounded-2xl surface-card space-y-4 animate-enter">
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
              <span className="font-semibold text-[13px]">
                {editingId ? t('cron.editJob') : t('cron.addJob')}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-secondary)]">{t('cron.enabledLabel')}</span>
                <Switch checked={enabled} onChange={setEnabled} />
              </div>
            </div>

            {formError && (
              <div className="px-3.5 py-2 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] font-mono">
                {formError}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('cron.nameLabel')}
                </label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={t('cron.namePlaceholder')}
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('cron.timezoneLabel')}
                </label>
                <CustomSelect
                  value={timezone}
                  onChange={setTimezone}
                  options={[
                    { value: 'Asia/Shanghai', label: 'Asia/Shanghai (UTC+8)' },
                    { value: 'Asia/Tokyo', label: 'Asia/Tokyo (UTC+9)' },
                    { value: 'UTC', label: 'UTC' },
                    { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
                    { value: 'America/New_York', label: 'America/New_York' }
                  ]}
                  className="w-full"
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('cron.exprLabel')}
                </label>
                <input
                  value={cronExpr}
                  onChange={e => setCronExpr(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                />
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {CRON_PRESETS.map(p => (
                    <button
                      key={p.expr}
                      type="button"
                      onClick={() => setCronExpr(p.expr)}
                      className="px-2 py-0.5 rounded-md bg-[var(--bg-elevated)] hover:text-[var(--accent)] font-mono text-[11px]"
                    >
                      {p.label}: {p.expr}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('cron.threadLabel')}
                </label>
                <CustomSelect
                  value={threadId}
                  onChange={setThreadId}
                  options={[
                    { value: '', label: t('cron.autoNewThread') },
                    ...threads.map(th => ({
                      value: th.id,
                      label: th.title,
                      sublabel: th.id
                    }))
                  ]}
                  className="w-full"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('cron.modelLabel')}
              </label>
              <CustomSelect
                value={model}
                onChange={setModel}
                options={[
                  { value: '', label: t('cron.followThreadModel') },
                  ...models.map(m => ({
                    value: m.compositeId,
                    label: `${m.providerName} · ${m.modelId}`
                  }))
                ]}
                className="w-full"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('cron.promptLabel')}
              </label>
              <textarea
                rows={3}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder={t('cron.promptPlaceholder')}
                className="w-full p-3 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
              >
                {t('cron.cancel')}
              </button>
              <button
                type="button"
                disabled={saveMut.isPending || !name.trim() || !prompt.trim()}
                onClick={() => saveMut.mutate()}
                className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium disabled:opacity-40"
              >
                {t('cron.save')}
              </button>
            </div>
          </div>
        )}

        {jobs.length === 0 ? (
          <div className="p-10 rounded-2xl surface-card text-center space-y-2">
            <div className="w-10 h-10 mx-auto rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
              <Clock className="w-5 h-5" />
            </div>
            <div className="font-semibold text-[13px]">{t('cron.emptyTitle')}</div>
            <p className="text-[var(--text-muted)]">{t('cron.emptyDesc')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {jobs.map(job => (
              <div key={job.id} className="p-4 rounded-2xl surface-card space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[13px]">{job.name}</span>
                      <span className="px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] font-mono text-[11px] text-[var(--text-secondary)]">
                        {job.cronExpr} · {job.timezone}
                      </span>
                      {job.lastStatus && (
                        <span
                          className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            job.lastStatus === 'success'
                              ? 'bg-[var(--success-soft)] text-[var(--success)]'
                              : 'bg-[var(--danger-soft)] text-[var(--danger)]'
                          }`}
                        >
                          {job.lastStatus === 'success'
                            ? t('cron.statusSuccess')
                            : t('cron.statusError')}
                        </span>
                      )}
                    </div>
                    <p className="text-[var(--text-secondary)] line-clamp-2">{job.prompt}</p>
                    <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--text-muted)] font-mono pt-0.5">
                      <span>
                        {t('cron.nextRun')}: {formatTime(job.nextRunAt)}
                      </span>
                      <span>
                        {t('cron.lastRun')}: {formatTime(job.lastRunAt)}
                      </span>
                      {job.model && <span>{job.model}</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={job.enabled}
                      onChange={next => toggleMut.mutate({ id: job.id, next })}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)]">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={runNowMut.isPending}
                      onClick={() => runNowMut.mutate(job.id)}
                      className="px-3 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90 font-medium inline-flex items-center gap-1"
                    >
                      <Play className="w-3 h-3" />
                      <span>
                        {runNowMut.isPending && runNowMut.variables === job.id
                          ? t('cron.runningNow')
                          : t('cron.runNow')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setHistoryJobId(prev => (prev === job.id ? null : job.id))
                      }
                      className="px-3 py-1 rounded-lg bg-[var(--bg-elevated)] hover:opacity-90 inline-flex items-center gap-1"
                    >
                      <History className="w-3 h-3" />
                      <span>{t('cron.history')}</span>
                    </button>
                    {job.threadId && (
                      <button
                        type="button"
                        onClick={() => jumpToThread(job.threadId)}
                        className="px-3 py-1 rounded-lg bg-[var(--bg-elevated)] hover:text-[var(--accent)] inline-flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>{t('cron.openThread')}</span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openEdit(job)}
                      className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                      title={t('cron.editJob')}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteMut.mutate(job.id)}
                      className="p-1.5 rounded-lg hover:bg-[var(--danger-soft)] text-[var(--text-muted)] hover:text-[var(--danger)]"
                      title={t('cron.deleteJob')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {historyJobId === job.id && (
                  <div className="pt-2 border-t border-[var(--border-subtle)] space-y-1.5 animate-enter">
                    <div className="font-semibold text-[11px] text-[var(--text-muted)] uppercase tracking-wider">
                      {t('cron.history')}
                    </div>
                    {runs.length === 0 ? (
                      <div className="text-[var(--text-muted)] py-2">{t('cron.noRuns')}</div>
                    ) : (
                      <div className="divide-y divide-[var(--border-subtle)] rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] overflow-hidden">
                        {runs.map(r => (
                          <div
                            key={r.id}
                            className="px-3 py-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  r.status === 'success'
                                    ? 'bg-[var(--success-soft)] text-[var(--success)]'
                                    : r.status === 'error'
                                      ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                                      : 'bg-[var(--warning-soft)] text-[var(--warning)]'
                                }`}
                              >
                                {r.status === 'success'
                                  ? t('cron.statusSuccess')
                                  : r.status === 'error'
                                    ? t('cron.statusError')
                                    : t('cron.statusRunning')}
                              </span>
                              <span className="text-[var(--text-secondary)]">
                                {formatTime(r.startedAt)}
                              </span>
                              <span className="text-[var(--text-muted)]">({r.triggerType})</span>
                              {r.error && (
                                <span className="text-[var(--danger)] truncate max-w-xs">
                                  {r.error}
                                </span>
                              )}
                            </div>
                            {r.threadId && (
                              <button
                                type="button"
                                onClick={() => jumpToThread(r.threadId)}
                                className="text-[var(--accent)] hover:underline inline-flex items-center gap-1"
                              >
                                <ExternalLink className="w-3 h-3" />
                                <span>{t('cron.openThread')}</span>
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
