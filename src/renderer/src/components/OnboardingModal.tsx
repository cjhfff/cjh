import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Blocks, Check, Clock, Cpu, Globe, Sparkles, X, Zap } from 'lucide-react'
import type {
  AppSettings,
  CompositeModelOption,
  ProviderDto,
  SkillDto
} from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { CustomSelect, Switch } from './ui/primitives'

interface Props {
  open: boolean
  onClose: () => void
}

export function OnboardingModal({ open, onClose }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1)
  const [sub2apiBaseUrl, setSub2apiBaseUrl] = useState('https://yangyue99.store/v1')
  const [sub2apiKey, setSub2apiKey] = useState('')
  const [step1Msg, setStep1Msg] = useState<string | null>(null)
  const [step1Err, setStep1Err] = useState<string | null>(null)

  const [defaultModel, setDefaultModel] = useState('')
  const [toolModel, setToolModel] = useState('')

  const [createDailyCron, setCreateDailyCron] = useState(true)
  const [dailyPrompt, setDailyPrompt] = useState('')

  const { data: providers = [] } = useQuery<ProviderDto[]>({
    queryKey: ['providers'],
    queryFn: () => apiFetch('/api/providers'),
    enabled: open
  })

  const { data: models = [] } = useQuery<CompositeModelOption[]>({
    queryKey: ['models'],
    queryFn: () => apiFetch('/api/models'),
    enabled: open
  })

  const { data: skills = [] } = useQuery<SkillDto[]>({
    queryKey: ['skills'],
    queryFn: () => apiFetch('/api/skills'),
    enabled: open
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings'),
    enabled: open
  })

  useEffect(() => {
    if (!open) return
    setStep(1)
    setStep1Msg(null)
    setStep1Err(null)
    setDailyPrompt(t('onboarding.dailyDefaultPrompt'))
  }, [open, t])

  useEffect(() => {
    if (!settings) return
    if (settings.chat.defaultModel) setDefaultModel(settings.chat.defaultModel)
    else if (models.length > 0 && !defaultModel) setDefaultModel(models[0].compositeId)
    if (settings.toolModel.model) setToolModel(settings.toolModel.model)
  }, [settings, models])

  const claudeSkills = skills.filter(s => s.source === 'claude')

  const addSub2apiMut = useMutation({
    mutationFn: () =>
      apiFetch<ProviderDto>('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: providers.some(p => p.id === 'sub2api')
            ? `sub2api-${Date.now().toString().slice(-3)}`
            : 'sub2api',
          name: t('provider.presetSub2apiName'),
          type: 'openai-compatible',
          apiFormat: 'openai-responses',
          isResponseApi: true,
          useMaxCompletionTokens: true,
          baseUrl: sub2apiBaseUrl.trim() || 'https://yangyue99.store/v1',
          apiKey: sub2apiKey.trim() || null,
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
              name: t('provider.presetToolModelName'),
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
        })
      }),
    onSuccess: created => {
      setSub2apiKey('')
      setStep1Err(null)
      setStep1Msg(t('onboarding.providerAddedOk', { name: created.name }))
      setDefaultModel(prev => prev || `${created.id}:gpt-5.5`)
      setToolModel(prev => prev || `${created.id}:gpt-4.1-mini`)
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
    },
    onError: err => {
      setStep1Err(err instanceof Error ? err.message : String(err))
    }
  })

  const addClaudeAcpMut = useMutation({
    mutationFn: () => {
      const sub2apiExists = providers.find(p => p.id === 'sub2api' || p.id.startsWith('sub2api-'))
      return apiFetch<ProviderDto>('/api/providers', {
        method: 'POST',
        body: JSON.stringify({
          id: providers.some(p => p.id === 'claude-acp')
            ? `claude-acp-${Date.now().toString().slice(-3)}`
            : 'claude-acp',
          name: t('provider.presetClaudeAcpName'),
          type: 'acp',
          apiFormat: 'anthropic',
          isResponseApi: false,
          useMaxCompletionTokens: false,
          acpPreset: 'claude',
          acpCommand: 'claude-agent-acp',
          acpArgs: [],
          acpEnv: {},
          acpApiProviderId: sub2apiExists ? sub2apiExists.id : null,
          acpMcpServerIds: [],
          acpPermissionMode: 'default',
          acpAvailableModes: [],
          customHeaders: {},
          models: [
            {
              id: 'opus',
              name: 'Claude Opus',
              description: t('provider.presetClaudeOpusDesc'),
              enabled: true,
              capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
            },
            {
              id: 'sonnet',
              name: 'Claude Sonnet',
              description: t('provider.presetClaudeSonnetDesc'),
              enabled: true,
              capabilities: { vision: true, reasoning: true, streaming: true, functionCalling: true }
            }
          ],
          availableModels: [],
          enabled: true,
          sortOrder: 1
        })
      })
    },
    onSuccess: created => {
      setStep1Err(null)
      setStep1Msg(t('onboarding.providerAddedOk', { name: created.name }))
      if (created.models.length > 0) {
        setDefaultModel(prev => prev || `${created.id}:${created.models[0].id}`)
      }
      void qc.invalidateQueries({ queryKey: ['providers'] })
      void qc.invalidateQueries({ queryKey: ['models'] })
    },
    onError: err => {
      setStep1Err(err instanceof Error ? err.message : String(err))
    }
  })

  const toggleSkillMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled })
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] })
  })

  const saveStep2Mut = useMutation({
    mutationFn: () =>
      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          chat: { defaultModel },
          toolModel: { model: toolModel }
        })
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] })
  })

  const completeMut = useMutation({
    mutationFn: async (opts: { skip?: boolean }) => {
      if (!opts.skip && createDailyCron) {
        const existing = await apiFetch<Array<{ name: string }>>('/api/cron')
        if (!existing.some(j => j.name === t('onboarding.dailyDefaultName'))) {
          await apiFetch('/api/cron', {
            method: 'POST',
            body: JSON.stringify({
              name: t('onboarding.dailyDefaultName'),
              cronExpr: '30 7 * * *',
              timezone: 'Asia/Shanghai',
              prompt: dailyPrompt.trim() || t('onboarding.dailyDefaultPrompt'),
              model: defaultModel || null,
              enabled: true
            })
          })
        }
      }
      await apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          general: { onboardingCompleted: true },
          ...(!opts.skip
            ? {
                chat: { defaultModel },
                toolModel: { model: toolModel }
              }
            : {})
        })
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings'] })
      void qc.invalidateQueries({ queryKey: ['cron-jobs'] })
      onClose()
    }
  })

  const handleGoToStep = async (nextStep: 1 | 2 | 3 | 4) => {
    if (step === 1 && nextStep > 1 && sub2apiKey.trim()) {
      try {
        await addSub2apiMut.mutateAsync()
        await Promise.all([
          qc.refetchQueries({ queryKey: ['providers'] }),
          qc.refetchQueries({ queryKey: ['models'] })
        ])
      } catch {
        return
      }
    }
    if (step === 2 && nextStep !== 2) {
      saveStep2Mut.mutate()
    }
    setStep(nextStep)
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/55 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-2xl surface-card p-6 space-y-5 text-xs animate-enter shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 pb-3 border-b border-[var(--border-subtle)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#8b5cf6] to-[#4f46e5] text-white flex items-center justify-center shadow-sm">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight">{t('onboarding.title')}</h2>
              <p className="text-[var(--text-muted)] mt-0.5">{t('onboarding.subtitle')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="px-2.5 py-1 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-mono text-[11px] font-medium">
              {t('onboarding.stepIndicator', { step })}
            </span>
            <button
              type="button"
              onClick={() => completeMut.mutate({ skip: true })}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
              title={t('onboarding.skip')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Step Progress Bar */}
        <div className="grid grid-cols-4 gap-2">
          {[1, 2, 3, 4].map(n => (
            <button
              key={n}
              type="button"
              disabled={addSub2apiMut.isPending || addClaudeAcpMut.isPending}
              onClick={() => void handleGoToStep(n as 1 | 2 | 3 | 4)}
              className={`h-1.5 rounded-full transition-all ${
                n <= step ? 'bg-[var(--accent)]' : 'bg-[var(--bg-elevated)]'
              }`}
            />
          ))}
        </div>

        {/* Step 1: Add Provider */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold flex items-center gap-2">
                <Cpu className="w-4 h-4 text-[var(--accent)]" />
                <span>{t('onboarding.step1Title')}</span>
              </div>
              <p className="text-[var(--text-muted)] mt-1">{t('onboarding.step1Desc')}</p>
            </div>

            {step1Msg && (
              <div className="px-3.5 py-2 rounded-xl bg-[var(--success-soft)] text-[var(--success)] font-medium">
                {step1Msg}
              </div>
            )}
            {step1Err && (
              <div className="px-3.5 py-2 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] font-mono">
                {step1Err}
              </div>
            )}

            <div className="p-4 rounded-2xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] space-y-3">
              <div className="flex items-center gap-2 font-semibold">
                <Globe className="w-4 h-4 text-[var(--accent)]" />
                <span>sub2api</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[11px] text-[var(--text-secondary)]">
                    {t('onboarding.sub2apiUrlLabel')}
                  </label>
                  <input
                    value={sub2apiBaseUrl}
                    onChange={e => setSub2apiBaseUrl(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] text-[var(--text-secondary)]">
                    {t('onboarding.sub2apiKeyLabel')}
                  </label>
                  <input
                    type="password"
                    value={sub2apiKey}
                    onChange={e => setSub2apiKey(e.target.value)}
                    placeholder={t('onboarding.sub2apiKeyPlaceholder')}
                    className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={addSub2apiMut.isPending}
                  onClick={() => addSub2apiMut.mutate()}
                  className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>{t('onboarding.addSub2apiBtn')}</span>
                </button>
                <button
                  type="button"
                  disabled={addClaudeAcpMut.isPending}
                  onClick={() => addClaudeAcpMut.mutate()}
                  className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium inline-flex items-center gap-1.5"
                >
                  <Zap className="w-3.5 h-3.5 text-[var(--warning)]" />
                  <span>{t('onboarding.addClaudeAcpBtn')}</span>
                </button>
              </div>
            </div>

            {providers.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-[var(--text-muted)]">
                  {t('onboarding.addedProvidersLabel')} ({providers.length})
                </div>
                <div className="flex flex-wrap gap-2">
                  {providers.map(p => (
                    <span
                      key={p.id}
                      className="px-2.5 py-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-mono text-[11px]"
                    >
                      {p.name} ({p.id})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Default & Tool Model */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold">{t('onboarding.step2Title')}</div>
              <p className="text-[var(--text-muted)] mt-1">{t('onboarding.step2Desc')}</p>
            </div>

            {models.length === 0 ? (
              <div className="p-4 rounded-xl bg-[var(--warning-soft)] text-[var(--warning)]">
                {t('onboarding.noModelsTip')}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('onboarding.defaultModelLabel')}
                  </label>
                  <CustomSelect
                    value={defaultModel}
                    onChange={setDefaultModel}
                    options={models.map(m => ({
                      value: m.compositeId,
                      label: `${m.providerName} · ${m.modelId}`
                    }))}
                    className="w-full"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('onboarding.toolModelLabel')}
                  </label>
                  <CustomSelect
                    value={toolModel}
                    onChange={setToolModel}
                    options={[
                      { value: '', label: t('onboarding.followChatModel') },
                      ...models
                        .filter(m => m.providerType !== 'acp')
                        .map(m => ({
                          value: m.compositeId,
                          label: `${m.providerName} · ${m.modelId}`
                        }))
                    ]}
                    className="w-full"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: ~/.claude/skills */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-semibold flex items-center gap-2">
                  <Blocks className="w-4 h-4 text-[var(--accent)]" />
                  <span>{t('onboarding.step3Title')}</span>
                </div>
                <p className="text-[var(--text-muted)] mt-1">{t('onboarding.step3Desc')}</p>
              </div>
              {claudeSkills.length > 0 && (
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      for (const s of claudeSkills) {
                        if (!s.enabled) toggleSkillMut.mutate({ id: s.id, enabled: true })
                      }
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[var(--bg-elevated)] hover:opacity-90 text-[11px]"
                  >
                    {t('onboarding.enableAll')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      for (const s of claudeSkills) {
                        if (s.enabled) toggleSkillMut.mutate({ id: s.id, enabled: false })
                      }
                    }}
                    className="px-2.5 py-1 rounded-lg bg-[var(--bg-elevated)] hover:opacity-90 text-[11px]"
                  >
                    {t('onboarding.disableAll')}
                  </button>
                </div>
              )}
            </div>

            {claudeSkills.length === 0 ? (
              <div className="p-5 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] text-center text-[var(--text-muted)]">
                {t('onboarding.claudeSkillsEmpty')}
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                {claudeSkills.map(sk => (
                  <label
                    key={sk.id}
                    className="p-3 flex items-center justify-between gap-3 cursor-pointer hover:bg-[var(--bg-elevated)]/40"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--text-primary)]">{sk.name}</div>
                      <div className="text-[11px] text-[var(--text-muted)] truncate">
                        {sk.description}
                      </div>
                    </div>
                    <Switch
                      checked={sk.enabled}
                      onChange={checked => toggleSkillMut.mutate({ id: sk.id, enabled: checked })}
                    />
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 4: Daily Report Cron */}
        {step === 4 && (
          <div className="space-y-4">
            <div>
              <div className="text-sm font-semibold flex items-center gap-2">
                <Clock className="w-4 h-4 text-[var(--accent)]" />
                <span>{t('onboarding.step4Title')}</span>
              </div>
              <p className="text-[var(--text-muted)] mt-1">{t('onboarding.step4Desc')}</p>
            </div>

            <div className="p-4 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] flex items-center justify-between gap-3">
              <span className="font-medium">{t('onboarding.createDailyToggle')}</span>
              <Switch checked={createDailyCron} onChange={setCreateDailyCron} />
            </div>

            {createDailyCron && (
              <div className="space-y-1.5">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('onboarding.dailyPromptLabel')}
                </label>
                <textarea
                  rows={3}
                  value={dailyPrompt}
                  onChange={e => setDailyPrompt(e.target.value)}
                  className="w-full p-3 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                />
              </div>
            )}
          </div>
        )}

        {/* Footer Controls */}
        <div className="flex items-center justify-between pt-3 border-t border-[var(--border-subtle)]">
          <button
            type="button"
            onClick={() => completeMut.mutate({ skip: true })}
            className="px-3.5 py-1.5 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] transition"
          >
            {t('onboarding.skip')}
          </button>
          <div className="flex items-center gap-2">
            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep(s => (s - 1) as 1 | 2 | 3 | 4)}
                className="px-4 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
              >
                {t('onboarding.prev')}
              </button>
            )}
            {step < 4 ? (
              <button
                type="button"
                disabled={addSub2apiMut.isPending || addClaudeAcpMut.isPending}
                onClick={() => void handleGoToStep((step + 1) as 1 | 2 | 3 | 4)}
                className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium shadow-sm disabled:opacity-50"
              >
                {t('onboarding.next')}
              </button>
            ) : (
              <button
                type="button"
                disabled={completeMut.isPending}
                onClick={() => completeMut.mutate({ skip: false })}
                className="px-5 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium shadow-sm"
              >
                {t('onboarding.finish')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
