import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Check,
  FolderSearch,
  Globe,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Zap
} from 'lucide-react'
import type {
  AcpCliInspectResult,
  AppSettings,
  CompositeModelOption,
  ModelDefinition,
  ProviderDto,
  ProviderUpsertInput
} from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { CustomSelect, Switch } from './ui/primitives'

const SUB2API_TEMPLATE: ProviderUpsertInput = {
  id: 'sub2api',
  name: 'sub2api',
  type: 'openai-compatible',
  apiFormat: 'openai-responses',
  isResponseApi: true,
  useMaxCompletionTokens: true,
  baseUrl: 'https://yangyue99.store/v1',
  customHeaders: {},
  models: [
    {
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      enabled: true,
      capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
    },
    {
      id: 'gpt-4.1-mini',
      name: 'GPT-4.1 Mini',
      enabled: true,
      capabilities: { vision: true, reasoning: false, streaming: true, functionCalling: true }
    }
  ],
  availableModels: [],
  acpArgs: [],
  acpEnv: {},
  acpMcpServerIds: [],
  acpPermissionMode: 'default',
  acpAvailableModes: [],
  enabled: true,
  sortOrder: 0
}

const CLAUDE_ACP_TEMPLATE: ProviderUpsertInput = {
  id: 'claude-acp',
  name: 'Claude Agent (ACP)',
  type: 'acp',
  apiFormat: 'anthropic',
  isResponseApi: false,
  useMaxCompletionTokens: false,
  acpPreset: 'claude',
  acpCommand: 'claude-agent-acp',
  acpArgs: [],
  acpEnv: {},
  acpApiProviderId: 'sub2api',
  acpMcpServerIds: [],
  acpPermissionMode: 'default',
  acpAvailableModes: [],
  customHeaders: {},
  models: [
    {
      id: 'opus',
      name: 'Claude Opus',
      description: 'Claude Opus',
      enabled: true,
      capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
    },
    {
      id: 'sonnet',
      name: 'Claude Sonnet',
      description: 'Claude Sonnet',
      enabled: true,
      capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
    }
  ],
  availableModels: [],
  enabled: true,
  sortOrder: 1
}

const CODEX_ACP_TEMPLATE: ProviderUpsertInput = {
  id: 'codex-acp',
  name: 'Codex Agent (ACP)',
  type: 'acp',
  apiFormat: 'openai-responses',
  isResponseApi: true,
  useMaxCompletionTokens: true,
  acpPreset: 'codex',
  acpCommand: 'codex-acp',
  acpArgs: [],
  acpEnv: {},
  acpMcpServerIds: [],
  acpPermissionMode: 'default',
  acpAvailableModes: [],
  customHeaders: {},
  models: [
    {
      id: 'o4-mini',
      name: 'Codex o4-mini',
      description: 'Codex o4-mini',
      enabled: true,
      capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
    }
  ],
  availableModels: [],
  enabled: true,
  sortOrder: 2
}

export function ProvidersView() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: providers = [] } = useQuery<ProviderDto[]>({
    queryKey: ['providers'],
    queryFn: () => apiFetch('/api/providers')
  })

  const { data: allModels = [] } = useQuery<CompositeModelOption[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models')
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderUpsertInput | null>(null)
  const [headersJson, setHeadersJson] = useState('{}')
  const [acpEnvJson, setAcpEnvJson] = useState('{}')
  const [newModelId, setNewModelId] = useState('')
  const [statusBanner, setStatusBanner] = useState<{ ok: boolean; text: string } | null>(null)
  const [cliInfo, setCliInfo] = useState<AcpCliInspectResult | null>(null)

  const selectedProvider = providers.find(p => p.id === selectedId) || null

  useEffect(() => {
    if (!selectedId && providers.length > 0) {
      setSelectedId(providers[0].id)
    }
  }, [providers, selectedId])

  useEffect(() => {
    if (selectedProvider) {
      setForm({
        id: selectedProvider.id,
        name: selectedProvider.name,
        type: selectedProvider.type,
        apiFormat: selectedProvider.apiFormat,
        isResponseApi: selectedProvider.isResponseApi,
        useMaxCompletionTokens: selectedProvider.useMaxCompletionTokens,
        apiVersion: selectedProvider.apiVersion,
        baseUrl: selectedProvider.baseUrl,
        apiKey: undefined,
        customHeaders: selectedProvider.customHeaders,
        models: selectedProvider.models,
        availableModels: selectedProvider.availableModels,
        acpPreset: selectedProvider.acpPreset,
        acpCommand: selectedProvider.acpCommand,
        acpExecutablePath: selectedProvider.acpExecutablePath,
        acpArgs: selectedProvider.acpArgs,
        acpEnv: selectedProvider.acpEnv,
        acpApiProviderId: selectedProvider.acpApiProviderId,
        acpMcpServerIds: selectedProvider.acpMcpServerIds,
        acpPermissionMode: selectedProvider.acpPermissionMode || 'default',
        acpAvailableModes: selectedProvider.acpAvailableModes || [],
        acpLastModeId: selectedProvider.acpLastModeId,
        enabled: selectedProvider.enabled,
        sortOrder: selectedProvider.sortOrder
      })
      setHeadersJson(JSON.stringify(selectedProvider.customHeaders || {}, null, 2))
      setAcpEnvJson(JSON.stringify(selectedProvider.acpEnv || {}, null, 2))
      setStatusBanner(null)

      if (selectedProvider.type === 'acp') {
        void apiFetch<AcpCliInspectResult>(`/api/providers/${selectedProvider.id}/cli-info`)
          .then(setCliInfo)
          .catch(() => setCliInfo(null))
      } else {
        setCliInfo(null)
      }
    }
  }, [selectedProvider])

  const createPresetMut = useMutation({
    mutationFn: (tpl: ProviderUpsertInput) =>
      apiFetch<ProviderDto>('/api/providers', {
        method: 'POST',
        body: JSON.stringify(tpl)
      }),
    onSuccess: created => {
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
      setSelectedId(created.id)
      setStatusBanner({ ok: true, text: t('provider.createdBanner', { name: created.name }) })
    }
  })

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form || !selectedId) throw new Error(t('provider.unselectedError'))
      const parsedHeaders = JSON.parse(headersJson || '{}')
      const parsedEnv = JSON.parse(acpEnvJson || '{}')
      return apiFetch<ProviderDto>(`/api/providers/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...form,
          customHeaders: parsedHeaders,
          acpEnv: parsedEnv
        })
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
      setStatusBanner({ ok: true, text: t('provider.savedBanner') })
    },
    onError: err => {
      setStatusBanner({
        ok: false,
        text: t('provider.saveFailedBanner', {
          msg: err instanceof Error ? err.message : String(err)
        })
      })
    }
  })

  const testMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; latencyMs: number; message: string }>(`/api/providers/${id}/test`, {
        method: 'POST'
      }),
    onSuccess: res => {
      setStatusBanner({ ok: res.ok, text: res.message })
    }
  })

  const fetchModelsMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ models: ModelDefinition[] }>(`/api/providers/${id}/models/fetch`, {
        method: 'POST'
      }),
    onSuccess: res => {
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
      setStatusBanner({ ok: true, text: t('provider.fetchOkBanner', { count: res.models.length }) })
    },
    onError: err => {
      setStatusBanner({
        ok: false,
        text: t('provider.fetchFailedBanner', {
          msg: err instanceof Error ? err.message : String(err)
        })
      })
    }
  })

  const redetectCliMut = useMutation({
    mutationFn: (id: string) =>
      apiFetch<AcpCliInspectResult>(`/api/providers/${id}/redetect`, {
        method: 'POST'
      }),
    onSuccess: info => {
      setCliInfo(info)
      setStatusBanner({
        ok: true,
        text: t('provider.redetectOkBanner', { target: info.localVersion || info.activeSource })
      })
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/providers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
      setSelectedId(null)
      setForm(null)
    }
  })

  const updateSettingsMut = useMutation({
    mutationFn: (patch: Partial<AppSettings>) =>
      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify(patch)
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  const addManualModel = () => {
    const trimmed = newModelId.trim()
    if (!trimmed || !form) return
    if (form.models.some(m => m.id === trimmed)) return
    const next: ModelDefinition = {
      id: trimmed,
      name: trimmed,
      enabled: true,
      capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
    }
    setForm({ ...form, models: [...form.models, next] })
    setNewModelId('')
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Velvet Left Rail */}
      <aside className="w-76 bg-[var(--bg-sidebar)] border-r border-[var(--border-subtle)] p-4 flex flex-col justify-between overflow-y-auto shrink-0">
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t('provider.addPresetTitle')}
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                onClick={() =>
                  createPresetMut.mutate({
                    ...SUB2API_TEMPLATE,
                    name: t('provider.presetSub2apiName'),
                    models: [
                      SUB2API_TEMPLATE.models[0],
                      { ...SUB2API_TEMPLATE.models[1], name: t('provider.presetToolModelName') }
                    ],
                    id: providers.some(p => p.id === 'sub2api')
                      ? `sub2api-${Date.now().toString().slice(-3)}`
                      : 'sub2api'
                  })
                }
                className="py-2 px-3 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium flex items-center justify-center gap-1.5 hover:opacity-90 transition shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>sub2api</span>
              </button>
              <button
                onClick={() =>
                  createPresetMut.mutate({
                    ...CLAUDE_ACP_TEMPLATE,
                    name: t('provider.presetClaudeAcpName'),
                    models: [
                      { ...CLAUDE_ACP_TEMPLATE.models[0], description: t('provider.presetClaudeOpusDesc') },
                      { ...CLAUDE_ACP_TEMPLATE.models[1], description: t('provider.presetClaudeSonnetDesc') }
                    ],
                    id: providers.some(p => p.id === 'claude-acp')
                      ? `claude-acp-${Date.now().toString().slice(-3)}`
                      : 'claude-acp'
                  })
                }
                className="py-2 px-3 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-medium flex items-center justify-center gap-1.5 transition"
              >
                <Zap className="w-3.5 h-3.5 text-[var(--warning)]" />
                <span>Claude ACP</span>
              </button>
              <button
                onClick={() =>
                  createPresetMut.mutate({
                    ...CODEX_ACP_TEMPLATE,
                    models: [{ ...CODEX_ACP_TEMPLATE.models[0], description: t('provider.presetCodexDesc') }],
                    id: providers.some(p => p.id === 'codex-acp')
                      ? `codex-acp-${Date.now().toString().slice(-3)}`
                      : 'codex-acp'
                  })
                }
                className="py-2 px-3 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-medium flex items-center justify-center gap-1.5 col-span-2 transition text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <Server className="w-3.5 h-3.5" />
                <span>{t('provider.addCodexCustom')}</span>
              </button>
            </div>
          </div>

          <div className="space-y-1 pt-2 border-t border-[var(--border-subtle)]">
            <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {t('provider.configuredListTitle', { count: providers.length })}
            </div>
            {providers.map(p => {
              const active = p.id === selectedId
              return (
                <button
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl transition flex items-center justify-between gap-2 ${
                    active
                      ? 'bg-[var(--bg-surface)] border border-[var(--border-strong)] shadow-2xs'
                      : 'border border-transparent hover:bg-[var(--bg-surface)]/60 text-[var(--text-secondary)]'
                  }`}
                >
                  <div className="min-w-0 flex items-center gap-2.5">
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                        p.type === 'acp'
                          ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                          : 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      }`}
                    >
                      {p.type === 'acp' ? (
                        <Zap className="w-3.5 h-3.5" />
                      ) : (
                        <Globe className="w-3.5 h-3.5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-[var(--text-primary)] truncate">
                        {p.name}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)] font-mono truncate">
                        {p.id}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      p.enabled ? 'bg-[var(--success)]' : 'bg-[var(--text-muted)]/40'
                    }`}
                  />
                </button>
              )
            })}
          </div>
        </div>

        {/* Dedicated Global Tool Model Card */}
        {settings && (
          <div className="p-3.5 rounded-2xl surface-card space-y-2.5 mt-4 text-xs">
            <div className="flex items-center gap-1.5 font-semibold">
              <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />
              <span>{t('provider.toolModelTitle')}</span>
            </div>
            <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
              {t('provider.toolModelDesc')}
            </p>
            <CustomSelect
              direction="up"
              value={settings.toolModel.model}
              onChange={val =>
                updateSettingsMut.mutate({
                  toolModel: { ...settings.toolModel, model: val }
                })
              }
              options={[
                { value: '', label: t('provider.toolModelFollowChat') },
                ...allModels
                  .filter(m => m.providerType !== 'acp')
                  .map(m => ({ value: m.compositeId, label: m.compositeId }))
              ]}
              className="w-full"
            />
          </div>
        )}
      </aside>

      {/* Right Detail Stage */}
      <div
        className="flex-1 p-8 overflow-y-auto select-text"
        style={{ backgroundImage: 'var(--ambient-glow)' }}
      >
        {!form || !selectedProvider ? (
          <div className="h-full max-w-md mx-auto flex flex-col items-center justify-center text-center space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
              <Globe className="w-5 h-5" />
            </div>
            <div className="text-sm font-semibold">{t('provider.noSelectedTitle')}</div>
            <p className="text-xs text-[var(--text-muted)] leading-relaxed">
              {t('provider.noSelectedDesc')}
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-6 text-xs animate-enter">
            {/* Header Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[var(--border-subtle)]">
              <div className="space-y-1">
                <div className="flex items-center gap-2.5">
                  <h3 className="text-lg font-semibold tracking-tight">{selectedProvider.name}</h3>
                  <span className="px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[11px] font-mono text-[var(--text-secondary)]">
                    {selectedProvider.id}:*
                  </span>
                </div>
                <p className="text-[var(--text-muted)]">{t('provider.keyStorageHint')}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => testMut.mutate(selectedProvider.id)}
                  disabled={testMut.isPending}
                  className="px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-medium transition"
                >
                  {testMut.isPending ? t('provider.testingConn') : t('provider.testConn')}
                </button>
                <button
                  onClick={() => fetchModelsMut.mutate(selectedProvider.id)}
                  disabled={fetchModelsMut.isPending}
                  className="px-3.5 py-2 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-medium inline-flex items-center gap-1.5 transition"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${fetchModelsMut.isPending ? 'animate-spin' : ''}`}
                  />
                  <span>{t('provider.fetchModels')}</span>
                </button>
                <button
                  onClick={() => saveMut.mutate()}
                  className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{t('provider.save')}</span>
                </button>
                <button
                  onClick={() => deleteMut.mutate(selectedProvider.id)}
                  className="p-2 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] hover:opacity-80 transition"
                  title={t('provider.delete')}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            {statusBanner && (
              <div
                className={`px-4 py-2.5 rounded-xl border font-mono text-xs animate-enter ${
                  statusBanner.ok
                    ? 'bg-[var(--success-soft)] border-[var(--success)]/30 text-[var(--success)]'
                    : 'bg-[var(--danger-soft)] border-[var(--danger)]/30 text-[var(--danger)]'
                }`}
              >
                {statusBanner.text}
              </div>
            )}

            {/* Main Config Card */}
            <div className="p-5 rounded-2xl surface-card space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-[var(--border-subtle)]">
                <div>
                  <div className="font-semibold text-[13px]">{t('provider.basicSectionTitle')}</div>
                  <div className="text-[var(--text-muted)] mt-0.5">
                    {t('provider.basicSectionDesc')}
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  <span className="text-[var(--text-secondary)]">
                    {t('provider.enableSource')}
                  </span>
                  <Switch
                    checked={form.enabled}
                    onChange={checked => setForm({ ...form, enabled: checked })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('provider.displayName')}
                  </label>
                  <input
                    value={form.name}
                    onChange={e => setForm({ ...form, name: e.target.value })}
                    className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] focus:border-[var(--accent)] outline-none transition"
                  />
                </div>

                {form.type !== 'acp' && (
                  <div className="space-y-1.5">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('provider.apiFormat')}
                    </label>
                    <CustomSelect
                      value={form.apiFormat}
                      onChange={val =>
                        setForm({
                          ...form,
                          apiFormat: val as ProviderUpsertInput['apiFormat']
                        })
                      }
                      options={[
                        {
                          value: 'openai-responses',
                          label: t('provider.apiFormatResponsesLabel'),
                          sublabel: t('provider.apiFormatResponsesSub')
                        },
                        {
                          value: 'openai-chat',
                          label: t('provider.apiFormatChatLabel'),
                          sublabel: t('provider.apiFormatChatSub')
                        },
                        {
                          value: 'anthropic',
                          label: t('provider.apiFormatAnthropicLabel'),
                          sublabel: t('provider.apiFormatAnthropicSub')
                        }
                      ]}
                      className="w-full"
                    />
                  </div>
                )}
              </div>

              {form.type !== 'acp' ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="font-medium text-[var(--text-secondary)]">
                        {t('provider.baseUrlLabel')}
                      </label>
                      <input
                        value={form.baseUrl || ''}
                        onChange={e => setForm({ ...form, baseUrl: e.target.value })}
                        placeholder="https://yangyue99.store/v1"
                        className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] focus:border-[var(--accent)] font-mono outline-none transition"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="font-medium text-[var(--text-secondary)]">
                        {t('provider.apiKeyLabel')}{' '}
                        {selectedProvider.hasApiKey && `(${selectedProvider.apiKeyPreview})`}
                      </label>
                      <input
                        type="password"
                        value={form.apiKey ?? ''}
                        onChange={e => setForm({ ...form, apiKey: e.target.value })}
                        placeholder={
                          selectedProvider.hasApiKey ? t('provider.apiKeyKeepPlaceholder') : 'sk-...'
                        }
                        className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] focus:border-[var(--accent)] font-mono outline-none transition"
                      />
                    </div>
                  </div>

                  {/* Relay Compatibility Switches */}
                  <div className="pt-2 space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-3 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] flex items-center justify-between gap-3">
                        <span>{t('provider.forceResponses')}</span>
                        <Switch
                          checked={form.isResponseApi}
                          onChange={checked => setForm({ ...form, isResponseApi: checked })}
                        />
                      </div>
                      <div className="p-3 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] flex items-center justify-between gap-3">
                        <span>{t('provider.maxCompletionTokens')}</span>
                        <Switch
                          checked={form.useMaxCompletionTokens}
                          onChange={checked =>
                            setForm({ ...form, useMaxCompletionTokens: checked })
                          }
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="font-medium text-[var(--text-secondary)]">
                        {t('provider.customHeaders')}
                      </label>
                      <textarea
                        rows={2}
                        value={headersJson}
                        onChange={e => setHeadersJson(e.target.value)}
                        className="w-full p-3 rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] focus:border-[var(--accent)] font-mono text-xs outline-none"
                      />
                    </div>
                  </div>
                </>
              ) : (
                /* ACP Agent Config */
                <div className="space-y-4 pt-1">
                  <div className="p-3.5 rounded-xl bg-[var(--bg-canvas)]/80 border border-[var(--border-subtle)] flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <div className="font-semibold flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-[var(--success)]" />
                        <span>
                          {t('provider.cliStatusPrefix')}
                          {cliInfo?.localVersion || cliInfo?.activeSource || t('provider.cliAutoDetect')}
                        </span>
                      </div>
                      <div className="text-[var(--text-muted)] font-mono truncate">
                        {cliInfo?.resolvedPath || t('provider.cliFallbackNpx')}
                      </div>
                    </div>
                    <button
                      onClick={() => redetectCliMut.mutate(selectedProvider.id)}
                      className="px-3 py-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] shrink-0 font-medium transition"
                    >
                      {t('provider.redetectCli')}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="font-medium text-[var(--text-secondary)]">
                        {t('provider.acpCommandLabel')}
                      </label>
                      <input
                        value={form.acpCommand || ''}
                        onChange={e => setForm({ ...form, acpCommand: e.target.value })}
                        className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="font-medium text-[var(--text-secondary)]">
                        {t('provider.acpBorrowKey')}
                      </label>
                      <CustomSelect
                        value={form.acpApiProviderId || ''}
                        onChange={val => setForm({ ...form, acpApiProviderId: val || null })}
                        options={[
                          { value: '', label: t('provider.acpBorrowNone') },
                          ...providers
                            .filter(p => p.type !== 'acp')
                            .map(p => ({
                              value: p.id,
                              label: t('provider.acpBorrowItem', { name: p.name }),
                              sublabel: t('provider.acpBorrowSub', { id: p.id })
                            }))
                        ]}
                        className="w-full"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('provider.acpPermissionModeLabel')}
                    </label>
                    <CustomSelect
                      value={form.acpPermissionMode || 'default'}
                      onChange={val => setForm({ ...form, acpPermissionMode: val })}
                      options={
                        selectedProvider.acpAvailableModes &&
                        selectedProvider.acpAvailableModes.length > 0
                          ? selectedProvider.acpAvailableModes.map(mode => ({
                              value: mode.id,
                              label: `${mode.name} (${mode.id})`,
                              sublabel: mode.description
                            }))
                          : [
                              {
                                value: 'default',
                                label: t('provider.modeDefaultLabel'),
                                sublabel: t('provider.modeDefaultSub')
                              },
                              {
                                value: 'acceptEdits',
                                label: t('provider.modeAcceptEditsLabel'),
                                sublabel: t('provider.modeAcceptEditsSub')
                              },
                              {
                                value: 'plan',
                                label: t('provider.modePlanLabel'),
                                sublabel: t('provider.modePlanSub')
                              },
                              {
                                value: 'bypassPermissions',
                                label: t('provider.modeBypassLabel'),
                                sublabel: t('provider.modeBypassSub')
                              }
                            ]
                      }
                      className="w-full"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('provider.acpExecPath')}
                    </label>
                    <div className="flex gap-2">
                      <input
                        value={form.acpExecutablePath || ''}
                        onChange={e =>
                          setForm({ ...form, acpExecutablePath: e.target.value || null })
                        }
                        placeholder={t('provider.acpExecPathPlaceholder')}
                        className="flex-1 px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                      />
                      {window.cjhShell && (
                        <button
                          onClick={async () => {
                            const picked = await window.cjhShell!.pickFile()
                            if (picked) setForm({ ...form, acpExecutablePath: picked })
                          }}
                          className="px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition"
                        >
                          <FolderSearch className="w-3.5 h-3.5" />
                          <span>{t('common.browse')}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('provider.acpEnv')}
                    </label>
                    <textarea
                      rows={3}
                      value={acpEnvJson}
                      onChange={e => setAcpEnvJson(e.target.value)}
                      className="w-full p-3 rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] font-mono text-xs outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Models Card */}
            <div className="p-5 rounded-2xl surface-card space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-[13px]">{t('provider.modelsCardTitle')}</div>
                  <div className="text-[var(--text-muted)] mt-0.5">
                    {t('provider.modelsCardDesc')}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={newModelId}
                    onChange={e => setNewModelId(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addManualModel()
                    }}
                    placeholder={t('provider.manualModelPlaceholder')}
                    className="px-3 py-1.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={addManualModel}
                    className="px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium"
                  >
                    + {t('common.add')}
                  </button>
                </div>
              </div>

              <div className="divide-y divide-[var(--border-subtle)] max-h-80 overflow-y-auto">
                {form.models.map((m, idx) => (
                  <div key={m.id} className="py-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Switch
                        checked={m.enabled}
                        onChange={checked => {
                          const next = [...form.models]
                          next[idx] = { ...m, enabled: checked }
                          setForm({ ...form, models: next })
                        }}
                      />
                      <div className="min-w-0">
                        <div className="font-mono font-medium truncate">{m.id}</div>
                        {m.description && (
                          <div className="text-[11px] text-[var(--text-muted)] truncate">
                            {m.description}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {(['vision', 'reasoning', 'functionCalling'] as const).map(capKey => {
                        const on = m.capabilities[capKey]
                        return (
                          <button
                            key={capKey}
                            type="button"
                            onClick={() => {
                              const next = [...form.models]
                              next[idx] = {
                                ...m,
                                capabilities: {
                                  ...m.capabilities,
                                  [capKey]: !on
                                }
                              }
                              setForm({ ...form, models: next })
                            }}
                            className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition ${
                              on
                                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                                : 'bg-[var(--bg-canvas)] text-[var(--text-muted)] opacity-60'
                            }`}
                          >
                            {capKey === 'vision'
                              ? t('provider.capVision')
                              : capKey === 'reasoning'
                                ? t('provider.capReasoning')
                                : t('provider.capTool')}
                          </button>
                        )
                      })}
                      <button
                        onClick={() =>
                          setForm({
                            ...form,
                            models: form.models.filter(x => x.id !== m.id)
                          })
                        }
                        className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--danger)] transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
