import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  ExternalLink,
  Link2,
  Power,
  Radio,
  RefreshCw,
  Trash2,
  Unplug
} from 'lucide-react'
import type {
  AppSettings,
  ChannelMappingDto,
  FeishuBridgeStatusDto
} from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { useWorkspaceStore } from '../store/workspace-store'
import { CustomSelect, Switch } from './ui/primitives'

function formatTime(ts: number | null): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function ChannelsView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const setActiveThreadId = useWorkspaceStore(s => s.setActiveThreadId)
  const setActiveView = useWorkspaceStore(s => s.setActiveView)

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  const { data: feishuStatus } = useQuery<FeishuBridgeStatusDto>({
    queryKey: ['feishu-status'],
    queryFn: () => apiFetch('/api/channels/feishu/status'),
    refetchInterval: 5000
  })

  const { data: mappings = [] } = useQuery<ChannelMappingDto[]>({
    queryKey: ['feishu-mappings'],
    queryFn: () => apiFetch('/api/channels/feishu/mappings')
  })

  const { data: feishuChats = [] } = useQuery<
    Array<{ chatId: string; chatType: string; updatedAt: number }>
  >({
    queryKey: ['feishu-chats'],
    queryFn: () => apiFetch('/api/channels/feishu/chats')
  })

  const [enabled, setEnabled] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu')
  const [notifyChatId, setNotifyChatId] = useState('')
  const [savedBanner, setSavedBanner] = useState(false)

  useEffect(() => {
    if (!settings?.channels?.feishu) return
    setEnabled(settings.channels.feishu.enabled)
    setAppId(settings.channels.feishu.appId || '')
    setDomain(settings.channels.feishu.domain || 'feishu')
    setNotifyChatId(settings.channels.feishu.notifyChatId || '')
  }, [settings])

  const saveMut = useMutation({
    mutationFn: () => {
      const feishuPatch: Record<string, unknown> = {
        enabled,
        appId: appId.trim(),
        domain,
        notifyChatId: notifyChatId.trim()
      }
      if (appSecret.trim()) {
        feishuPatch.appSecret = appSecret.trim()
      }
      return apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ channels: { feishu: feishuPatch } })
      })
    },
    onSuccess: () => {
      setAppSecret('')
      setSavedBanner(true)
      window.setTimeout(() => setSavedBanner(false), 2500)
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['feishu-status'] })
    }
  })

  const clearSecretMut = useMutation({
    mutationFn: () =>
      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ channels: { feishu: { appSecret: null } } })
      }),
    onSuccess: () => {
      setAppSecret('')
      setSavedBanner(true)
      window.setTimeout(() => setSavedBanner(false), 2500)
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['feishu-status'] })
    }
  })

  const connectMut = useMutation({
    mutationFn: () => apiFetch('/api/channels/feishu/connect', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['feishu-status'] })
  })

  const reconnectMut = useMutation({
    mutationFn: () => apiFetch('/api/channels/feishu/reconnect', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['feishu-status'] })
  })

  const disconnectMut = useMutation({
    mutationFn: () => apiFetch('/api/channels/feishu/disconnect', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['feishu-status'] })
  })

  const deleteMappingMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/channels/feishu/mappings/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['feishu-mappings'] })
  })

  const statusBadge = (() => {
    const st = feishuStatus?.status || 'disconnected'
    if (st === 'connected') {
      return {
        cls: 'bg-[var(--success-soft)] text-[var(--success)]',
        label: t('channels.statusConnected')
      }
    }
    if (st === 'connecting') {
      return {
        cls: 'bg-[var(--warning-soft)] text-[var(--warning)]',
        label: t('channels.statusConnecting')
      }
    }
    if (st === 'error') {
      return {
        cls: 'bg-[var(--danger-soft)] text-[var(--danger)]',
        label: t('channels.statusError')
      }
    }
    return {
      cls: 'bg-[var(--bg-elevated)] text-[var(--text-muted)]',
      label: t('channels.statusDisconnected')
    }
  })()

  return (
    <div
      className="flex-1 overflow-y-auto p-8 select-text"
      style={{ backgroundImage: 'var(--ambient-glow)' }}
    >
      <div className="max-w-4xl mx-auto space-y-6 text-xs animate-enter">
        {/* Header */}
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-[var(--accent)]" />
            <h3 className="text-base font-semibold tracking-tight">{t('channels.title')}</h3>
          </div>
          <p className="text-[var(--text-muted)]">{t('channels.subtitle')}</p>
        </div>

        {/* Feishu Config Card */}
        <section className="p-5 rounded-2xl surface-card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
            <div className="flex items-center gap-2.5">
              <span className="font-semibold text-[13px]">{t('channels.feishuCardTitle')}</span>
              <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium ${statusBadge.cls}`}>
                {statusBadge.label}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[var(--text-secondary)]">{t('channels.enableLabel')}</span>
              <Switch checked={enabled} onChange={setEnabled} />
            </div>
          </div>

          {savedBanner && (
            <div className="px-3.5 py-2 rounded-xl bg-[var(--success-soft)] text-[var(--success)] font-medium">
              {t('channels.configSaved')}
            </div>
          )}

          {feishuStatus?.lastError && (
            <div className="px-3.5 py-2 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] font-mono break-all">
              {feishuStatus.lastError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('channels.appIdLabel')}
              </label>
              <input
                value={appId}
                onChange={e => setAppId(e.target.value)}
                placeholder={t('channels.appIdPlaceholder')}
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('channels.appSecretLabel')}
                </label>
                {settings?.channels?.feishu?.hasAppSecret && (
                  <button
                    type="button"
                    disabled={clearSecretMut.isPending}
                    onClick={() => clearSecretMut.mutate()}
                    className="text-[11px] text-[var(--danger)] hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{t('channels.clearSavedSecret')}</span>
                  </button>
                )}
              </div>
              <input
                type="password"
                value={appSecret}
                onChange={e => setAppSecret(e.target.value)}
                placeholder={
                  settings?.channels?.feishu?.hasAppSecret
                    ? t('channels.appSecretConfiguredHint', {
                        preview: settings.channels.feishu.appSecretPreview
                      })
                    : t('channels.appSecretPlaceholder')
                }
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('channels.domainLabel')}
              </label>
              <CustomSelect
                value={domain}
                onChange={v => setDomain(v as 'feishu' | 'lark')}
                options={[
                  { value: 'feishu', label: t('channels.domainFeishu') },
                  { value: 'lark', label: t('channels.domainLark') }
                ]}
                className="w-full"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="font-medium text-[var(--text-secondary)]">
              {t('channels.notifyChatLabel')}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {feishuChats.length > 0 && (
                <CustomSelect
                  value={feishuChats.some(c => c.chatId === notifyChatId) ? notifyChatId : ''}
                  onChange={setNotifyChatId}
                  options={[
                    { value: '', label: t('channels.notifyChatNone') },
                    ...feishuChats.map(c => ({
                      value: c.chatId,
                      label: `${c.chatType} · ${c.chatId}`
                    }))
                  ]}
                  className="w-full"
                />
              )}
              <input
                value={notifyChatId}
                onChange={e => setNotifyChatId(e.target.value)}
                placeholder={t('channels.notifyChatPlaceholder')}
                className={`w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)] ${
                  feishuChats.length === 0 ? 'sm:col-span-2' : ''
                }`}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-[var(--text-muted)] font-mono">
              {feishuStatus?.botOpenId && (
                <span>
                  {t('channels.botOpenIdLabel')}: {feishuStatus.botOpenId}
                </span>
              )}
              <span>
                {t('channels.lastConnectedLabel')}: {formatTime(feishuStatus?.lastConnectedAt ?? null)}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={saveMut.isPending}
                onClick={() => saveMut.mutate()}
                className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium hover:opacity-90 transition shadow-sm"
              >
                {t('channels.saveConfig')}
              </button>
              {feishuStatus?.status === 'connected' ? (
                <>
                  <button
                    type="button"
                    disabled={reconnectMut.isPending}
                    onClick={() => reconnectMut.mutate()}
                    className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium inline-flex items-center gap-1.5 hover:opacity-90"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>{t('channels.reconnectBtn')}</span>
                  </button>
                  <button
                    type="button"
                    disabled={disconnectMut.isPending}
                    onClick={() => disconnectMut.mutate()}
                    className="px-3.5 py-1.5 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] font-medium inline-flex items-center gap-1.5 hover:opacity-90"
                  >
                    <Unplug className="w-3.5 h-3.5" />
                    <span>{t('channels.disconnectBtn')}</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={connectMut.isPending}
                  onClick={() => connectMut.mutate()}
                  className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium inline-flex items-center gap-1.5 hover:opacity-90"
                >
                  <Power className="w-3.5 h-3.5 text-[var(--success)]" />
                  <span>{t('channels.connectBtn')}</span>
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Usage Hint */}
        <section className="p-4 rounded-2xl surface-card space-y-1.5">
          <div className="font-semibold text-[13px]">{t('channels.commandsHintTitle')}</div>
          <p className="text-[var(--text-secondary)] leading-relaxed">
            {t('channels.commandsHintDesc')}
          </p>
        </section>

        {/* Thread Mappings */}
        <section className="rounded-2xl surface-card overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--border-subtle)] flex items-center gap-2 font-semibold text-[13px]">
            <Link2 className="w-4 h-4 text-[var(--accent)]" />
            <span>{t('channels.mappingsTitle')}</span>
          </div>
          {mappings.length === 0 ? (
            <div className="p-6 text-center text-[var(--text-muted)]">
              {t('channels.mappingsEmpty')}
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-subtle)]">
              {mappings.map(m => (
                <div
                  key={m.id}
                  className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 font-mono text-[11px]"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-secondary)]">
                        {m.chatType}
                      </span>
                      <span className="text-[var(--text-primary)] truncate">
                        chat: {m.externalChatId}
                      </span>
                      <span className="text-[var(--text-muted)] truncate">
                        user: {m.externalUserId}
                      </span>
                    </div>
                    <div className="text-[var(--text-muted)]">
                      thread: {m.threadId} · {formatTime(m.updatedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setActiveThreadId(m.threadId)
                        setActiveView('chat')
                      }}
                      className="px-2.5 py-1 rounded-lg bg-[var(--bg-elevated)] text-[var(--accent)] hover:opacity-90 inline-flex items-center gap-1 font-sans"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>{t('channels.openThread')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteMappingMut.mutate(m.id)}
                      className="p-1.5 rounded-lg hover:bg-[var(--danger-soft)] text-[var(--text-muted)] hover:text-[var(--danger)]"
                      title={t('channels.deleteMapping')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent Events */}
        <section className="rounded-2xl surface-card overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--border-subtle)] flex items-center gap-2 font-semibold text-[13px]">
            <Activity className="w-4 h-4 text-[var(--accent)]" />
            <span>{t('channels.recentEventsTitle')}</span>
          </div>
          {!feishuStatus?.recentEvents?.length ? (
            <div className="p-6 text-center text-[var(--text-muted)]">
              {t('channels.recentEventsEmpty')}
            </div>
          ) : (
            <div className="p-4 bg-[var(--bg-code)] font-mono text-[11px] max-h-60 overflow-y-auto space-y-1.5">
              {feishuStatus.recentEvents.map(ev => (
                <div key={ev.id} className="leading-relaxed break-all">
                  <span className="text-[var(--text-muted)]">{formatTime(ev.timestamp)}</span>{' '}
                  <span className="text-[var(--accent)]">[{ev.type}]</span>{' '}
                  <span className="text-[var(--text-secondary)]">{ev.summary}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
