import React, { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Keyboard,
  RefreshCw,
  Sparkles,
  Upload,
  Zap
} from 'lucide-react'
import type { AppSettings } from '@shared/schemas'
import { apiFetch, getDaemonConnection } from '../lib/api'
import { CustomSelect, Switch } from './ui/primitives'

export function DiagnosticsView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const importFileRef = useRef<HTMLInputElement>(null)

  const [connInfo, setConnInfo] = useState<{
    dataDir: string
    mode: string
    port: number
  } | null>(null)
  const [tagFilter, setTagFilter] = useState('')
  const [feedUrlDraft, setFeedUrlDraft] = useState('')
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const [importBanner, setImportBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const [shortcutInput, setShortcutInput] = useState('Alt+Space')
  const [shortcutStatusMsg, setShortcutStatusMsg] = useState<string | null>(null)

  useEffect(() => {
    void getDaemonConnection().then(setConnInfo)
  }, [])

  const { data: usage } = useQuery<{
    byCategory: Array<{
      category: string
      totalTokens: number
      inputTokens: number
      outputTokens: number
      cachedInputTokens: number
      requestCount: number
    }>
    byModel: Array<{
      providerId: string
      model: string
      category: string
      totalTokens: number
      calls: number
    }>
  }>({
    queryKey: ['usage'],
    queryFn: () => apiFetch('/api/usage/stats?days=30')
  })

  const { data: logsData, refetch: refetchLogs } = useQuery<{
    logsDir: string
    entries: Array<{ timestamp: string; level: string; tag: string; message: string }>
  }>({
    queryKey: ['logs', tagFilter],
    queryFn: () =>
      apiFetch(`/api/logs/recent${tagFilter ? `?tag=${encodeURIComponent(tagFilter)}` : ''}`)
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  const { data: updateStatus, refetch: refetchUpdate } = useQuery<{
    currentVersion: string
    state: string
    latest?: { version: string; notes?: string; sha256?: string } | null
    error?: string | null
    sha256Verified?: boolean
    actualSha256?: string | null
  }>({
    queryKey: ['update-status'],
    queryFn: () => apiFetch('/api/update/status')
  })

  useEffect(() => {
    if (settings?.update.feedUrl !== undefined) {
      setFeedUrlDraft(settings.update.feedUrl)
    }
    if (settings?.general.globalShortcut) {
      setShortcutInput(settings.general.globalShortcut)
    }
  }, [settings])

  const checkUpdateMut = useMutation({
    mutationFn: async () => {
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ update: { feedUrl: feedUrlDraft, autoCheck: false } })
      })
      return apiFetch('/api/update/check', {
        method: 'POST',
        body: JSON.stringify({ feedUrl: feedUrlDraft })
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void refetchUpdate()
    }
  })

  const downloadUpdateMut = useMutation({
    mutationFn: () => apiFetch('/api/update/download', { method: 'POST' }),
    onSuccess: () => void refetchUpdate()
  })

  const installUpdateMut = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/update/install', {
        method: 'POST',
        body: JSON.stringify({ dryRun: false })
      })
      if (!res?.triggered && window.cjhShell) {
        await window.cjhShell.applyPortableUpdate()
      }
      return res
    },
    onSuccess: () => void refetchUpdate()
  })

  const updateDesktopPrefMut = useMutation({
    mutationFn: async (patch: {
      autoLaunch?: boolean
      globalShortcutEnabled?: boolean
      globalShortcut?: string
    }) => {
      const updated = await apiFetch<AppSettings>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ general: patch })
      })
      if (window.cjhShell?.syncDesktopPrefs) {
        const res = await window.cjhShell.syncDesktopPrefs({
          autoLaunch: updated.general.autoLaunch,
          globalShortcutEnabled: updated.general.globalShortcutEnabled,
          globalShortcut: updated.general.globalShortcut
        })
        setShortcutStatusMsg(
          t('system.globalShortcutSaved', {
            status: res.shortcutRegistered
              ? t('system.shortcutRegistered')
              : t('system.shortcutUnregistered'),
            accelerator: res.accelerator
          })
        )
      }
      return updated
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  const handleExport = async () => {
    const data = await apiFetch('/api/data/export')
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `cjh-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const res = await apiFetch<{
        ok: boolean
        mode: 'merge' | 'replace'
        imported: {
          providers: number
          threads: number
          messages: number
          mcpServers: number
          cronJobs: number
        }
      }>('/api/data/import', {
        method: 'POST',
        body: JSON.stringify({ mode: importMode, data: parsed })
      })
      setImportBanner({
        ok: true,
        text: t('system.importSuccess', {
          mode: importMode === 'merge' ? t('system.importMerge') : t('system.importReplace'),
          ...res.imported
        })
      })
      void qc.invalidateQueries()
    } catch (err) {
      setImportBanner({
        ok: false,
        text: t('system.importFailed', {
          msg: err instanceof Error ? err.message : String(err)
        })
      })
    }
  }

  const chatStat = usage?.byCategory.find(c => c.category === 'chat')
  const auxStat = usage?.byCategory.find(c => c.category === 'aux')

  return (
    <div
      className="flex-1 overflow-y-auto p-8 select-text"
      style={{ backgroundImage: 'var(--ambient-glow)' }}
    >
      <div className="max-w-4xl mx-auto space-y-6 text-xs animate-enter">
        {/* Bento Telemetry Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-5 rounded-2xl surface-card space-y-1.5">
            <div className="flex items-center justify-between text-[var(--text-muted)]">
              <span>{t('system.chatTokens')} (30d)</span>
              <Zap className="w-3.5 h-3.5 text-[var(--accent)]" />
            </div>
            <div className="text-2xl font-semibold tracking-tight font-mono pt-0.5">
              {(chatStat?.totalTokens || 0).toLocaleString()}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {t('system.chatRoundsHit', {
                rounds: chatStat?.requestCount || 0,
                cached: (chatStat?.cachedInputTokens || 0).toLocaleString()
              })}
            </div>
          </div>

          <div className="p-5 rounded-2xl surface-card space-y-1.5">
            <div className="flex items-center justify-between text-[var(--text-muted)]">
              <span>{t('system.auxTokens')} (30d)</span>
              <Sparkles className="w-3.5 h-3.5 text-[var(--warning)]" />
            </div>
            <div className="text-2xl font-semibold tracking-tight font-mono pt-0.5">
              {(auxStat?.totalTokens || 0).toLocaleString()}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              {t('system.auxTasksCount', { count: auxStat?.requestCount || 0 })}
            </div>
          </div>

          <div className="p-5 rounded-2xl surface-card space-y-2">
            <div className="flex items-center justify-between text-[var(--text-muted)]">
              <span>
                {t('system.storageDirLabel', {
                  mode:
                    connInfo?.mode === 'portable'
                      ? t('system.storagePortable')
                      : t('system.storageAppdata')
                })}
              </span>
              <HardDrive className="w-3.5 h-3.5 text-[var(--success)]" />
            </div>
            <div
              className="font-mono text-[11px] truncate text-[var(--text-primary)]"
              title={connInfo?.dataDir}
            >
              {connInfo?.dataDir || '-'}
            </div>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {window.cjhShell && connInfo?.dataDir && (
                <button
                  onClick={() => window.cjhShell!.openPath(connInfo.dataDir)}
                  className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline font-medium"
                >
                  <ExternalLink className="w-3 h-3" />
                  {t('system.openDir')}
                </button>
              )}
              <button
                onClick={() => void handleExport()}
                className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline font-medium"
              >
                <Download className="w-3 h-3" />
                {t('system.exportBackup')}
              </button>
              <button
                onClick={() => importFileRef.current?.click()}
                className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline font-medium"
              >
                <Upload className="w-3 h-3" />
                {t('system.importBackup')}
              </button>
              <input
                ref={importFileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImportFile}
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <CustomSelect
                value={importMode}
                onChange={v => setImportMode(v as 'merge' | 'replace')}
                options={[
                  { value: 'merge', label: t('system.importMerge') },
                  { value: 'replace', label: t('system.importReplace') }
                ]}
                className="w-32"
              />
            </div>
          </div>
        </div>

        {importBanner && (
          <div
            className={`px-4 py-2.5 rounded-xl border font-mono text-xs animate-enter ${
              importBanner.ok
                ? 'bg-[var(--success-soft)] border-[var(--success)]/30 text-[var(--success)]'
                : 'bg-[var(--danger-soft)] border-[var(--danger)]/30 text-[var(--danger)]'
            }`}
          >
            {importBanner.text}
          </div>
        )}

        {/* Desktop Integration & Global Shortcut Card (A10) */}
        {settings && (
          <div className="p-5 rounded-2xl surface-card space-y-4">
            <div className="flex items-center gap-2">
              <Keyboard className="w-4 h-4 text-[var(--accent)]" />
              <div>
                <div className="font-semibold text-[13px]">{t('system.desktopSectionTitle')}</div>
                <p className="text-[var(--text-muted)]">{t('system.desktopSectionDesc')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="p-3 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <span>{t('system.autoLaunchLabel')}</span>
                <Switch
                  checked={Boolean(settings.general.autoLaunch)}
                  onChange={checked => updateDesktopPrefMut.mutate({ autoLaunch: checked })}
                />
              </div>

              <div className="p-3 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] flex items-center justify-between gap-3">
                <span>{t('system.globalShortcutEnabledLabel')}</span>
                <Switch
                  checked={settings.general.globalShortcutEnabled !== false}
                  onChange={checked =>
                    updateDesktopPrefMut.mutate({ globalShortcutEnabled: checked })
                  }
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[var(--text-secondary)] font-medium">
                {t('system.globalShortcutLabel')}:
              </span>
              <input
                value={shortcutInput}
                onChange={e => setShortcutInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    updateDesktopPrefMut.mutate({ globalShortcut: shortcutInput.trim() || 'Alt+Space' })
                  }
                }}
                className="w-44 px-3 py-1.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() =>
                  updateDesktopPrefMut.mutate({
                    globalShortcut: shortcutInput.trim() || 'Alt+Space'
                  })
                }
                className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium"
              >
                {t('provider.save')}
              </button>
              {shortcutStatusMsg && (
                <span className="text-[11px] font-mono text-[var(--text-muted)]">
                  {shortcutStatusMsg}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Portable Self-Updater Card (A8) */}
        <div className="p-5 rounded-2xl surface-card space-y-3.5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="font-semibold text-[13px]">{t('system.portableUpdateTitle')}</div>
              <p className="text-[var(--text-muted)]">{t('system.portableUpdateDesc')}</p>
            </div>
            <span className="px-2.5 py-1 rounded-full bg-[var(--bg-elevated)] font-mono text-[11px] shrink-0">
              v{updateStatus?.currentVersion || '0.1.0'}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              value={feedUrlDraft}
              onChange={e => setFeedUrlDraft(e.target.value)}
              placeholder="https://hk.your-server.com/cjh-updates"
              className="flex-1 min-w-[240px] px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={() => checkUpdateMut.mutate()}
              disabled={checkUpdateMut.isPending}
              className="px-4 py-2 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium transition"
            >
              {checkUpdateMut.isPending ? t('system.checkingUpdate') : t('system.checkUpdate')}
            </button>
            {updateStatus?.state === 'available' && (
              <button
                onClick={() => downloadUpdateMut.mutate()}
                disabled={downloadUpdateMut.isPending}
                className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium shadow-sm"
              >
                {downloadUpdateMut.isPending
                  ? t('system.downloadingUpdate')
                  : t('system.downloadVersion', { version: updateStatus.latest?.version })}
              </button>
            )}
            {updateStatus?.state === 'ready' && (
              <button
                onClick={() => installUpdateMut.mutate()}
                disabled={installUpdateMut.isPending}
                className="px-4 py-2 rounded-xl bg-[var(--success)] text-white font-medium shadow-sm"
              >
                {installUpdateMut.isPending
                  ? t('system.installingUpdate')
                  : t('system.applyUpdate')}
              </button>
            )}
          </div>

          {updateStatus?.state === 'ready' && (
            <div className="flex flex-wrap items-center gap-3 text-[var(--success)] font-mono">
              <span className="inline-flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {t('system.readyToInstall', { version: updateStatus.latest?.version })}
              </span>
              {updateStatus.sha256Verified && (
                <span className="px-2 py-0.5 rounded-full bg-[var(--success-soft)] text-[11px]">
                  {t('system.sha256Verified')}
                </span>
              )}
            </div>
          )}
          {updateStatus?.error && (
            <div className="text-[var(--danger)] font-mono">{updateStatus.error}</div>
          )}
          {updateStatus?.state === 'up-to-date' && (
            <div className="text-[var(--success)] font-mono">{t('system.upToDate')}</div>
          )}
        </div>

        {/* Model Usage Breakdown */}
        {usage && usage.byModel.length > 0 && (
          <div className="rounded-2xl surface-card overflow-hidden">
            <div className="px-5 py-3 border-b border-[var(--border-subtle)] font-semibold text-[13px]">
              {t('system.modelUsageTitle')}
            </div>
            <div className="divide-y divide-[var(--border-subtle)]">
              {usage.byModel.map((row, idx) => (
                <div
                  key={idx}
                  className="px-5 py-3 flex items-center justify-between font-mono text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {row.providerId}:{row.model}
                    </span>
                    <span className="px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[11px] text-[var(--text-secondary)]">
                      {row.category}
                    </span>
                  </div>
                  <span className="text-[var(--text-secondary)]">
                    {t('system.modelUsageSummary', {
                      calls: row.calls,
                      tokens: row.totalTokens.toLocaleString()
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Unified Tagged Logs */}
        <div className="rounded-2xl surface-card overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--border-subtle)] flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-[13px]">{t('system.logsTitle')}</span>
            <div className="flex items-center gap-2">
              <input
                value={tagFilter}
                onChange={e => setTagFilter(e.target.value)}
                placeholder={t('system.logsFilterPlaceholder')}
                className="px-3 py-1.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
              <button
                onClick={() => void refetchLogs()}
                className="p-2 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90"
                title={t('common.refresh')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              {window.cjhShell && logsData?.logsDir && (
                <button
                  onClick={() => void window.cjhShell!.openPath(logsData.logsDir)}
                  className="px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] inline-flex items-center gap-1.5 font-medium"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>{t('system.openLogDir')}</span>
                </button>
              )}
            </div>
          </div>

          <div className="p-4 bg-[var(--bg-code)] font-mono text-[11px] max-h-72 overflow-y-auto space-y-1.5">
            {(logsData?.entries || []).map((entry, idx) => (
              <div key={idx} className="leading-relaxed break-all">
                <span className="text-[var(--text-muted)]">
                  {entry.timestamp.slice(11, 19)}
                </span>{' '}
                <span className="text-[var(--accent)]">[{entry.tag}]</span>{' '}
                <span className="text-[var(--text-secondary)]">{entry.message}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
