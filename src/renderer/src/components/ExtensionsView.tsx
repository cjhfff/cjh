import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Blocks, BookMarked, Eye, Pencil, Plug, Plus, RefreshCw, Terminal, Trash2, Wrench, X } from 'lucide-react'
import type {
  AppSettings,
  McpServerRuntimeDto,
  PromptTemplateDto,
  SkillDto,
  WebSearchBackend
} from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { CustomSelect, Switch } from './ui/primitives'

export function ExtensionsView() {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: servers = [] } = useQuery<McpServerRuntimeDto[]>({
    queryKey: ['mcp-servers'],
    queryFn: () => apiFetch('/api/mcp-servers')
  })

  const { data: skills = [] } = useQuery<SkillDto[]>({
    queryKey: ['skills'],
    queryFn: () => apiFetch('/api/skills')
  })

  const { data: prompts = [] } = useQuery<PromptTemplateDto[]>({
    queryKey: ['prompts'],
    queryFn: () => apiFetch('/api/prompts')
  })

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  const [autoApproveReadOnly, setAutoApproveReadOnly] = useState(true)
  const [maxSteps, setMaxSteps] = useState(20)
  const [shellTimeoutSec, setShellTimeoutSec] = useState(120)
  const [searchBackend, setSearchBackend] = useState<WebSearchBackend>('auto')
  const [searxngUrl, setSearxngUrl] = useState('')
  const [tavilyKeyInput, setTavilyKeyInput] = useState('')
  const [braveKeyInput, setBraveKeyInput] = useState('')
  const [toolsSavedBanner, setToolsSavedBanner] = useState(false)

  useEffect(() => {
    if (!settings?.tools) return
    setAutoApproveReadOnly(settings.tools.autoApproveReadOnly)
    setMaxSteps(settings.tools.maxSteps)
    setShellTimeoutSec(settings.tools.shellTimeoutSec)
    setSearchBackend(settings.tools.webSearch.backend)
    setSearxngUrl(settings.tools.webSearch.searxngUrl || '')
  }, [settings])

  const saveToolsSettingsMut = useMutation({
    mutationFn: () => {
      const webSearchPatch: Record<string, unknown> = {
        backend: searchBackend,
        searxngUrl: searxngUrl.trim()
      }
      if (tavilyKeyInput.trim()) {
        webSearchPatch.tavilyApiKey = tavilyKeyInput.trim()
      }
      if (braveKeyInput.trim()) {
        webSearchPatch.braveApiKey = braveKeyInput.trim()
      }
      return apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          tools: {
            autoApproveReadOnly,
            maxSteps: Math.min(100, Math.max(1, Number(maxSteps) || 20)),
            shellTimeoutSec: Math.min(600, Math.max(5, Number(shellTimeoutSec) || 120)),
            webSearch: webSearchPatch
          }
        })
      })
    },
    onSuccess: () => {
      setTavilyKeyInput('')
      setBraveKeyInput('')
      setToolsSavedBanner(true)
      window.setTimeout(() => setToolsSavedBanner(false), 2500)
      void qc.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  const clearSearchKeyMut = useMutation({
    mutationFn: (which: 'tavily' | 'brave') =>
      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          tools: {
            webSearch: which === 'tavily' ? { tavilyApiKey: null } : { braveApiKey: null }
          }
        })
      }),
    onSuccess: (_res, which) => {
      if (which === 'tavily') setTavilyKeyInput('')
      else setBraveKeyInput('')
      setToolsSavedBanner(true)
      window.setTimeout(() => setToolsSavedBanner(false), 2500)
      void qc.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('stdio')
  const [command, setCommand] = useState('npx')
  const [argsText, setArgsText] = useState(
    '-y @modelcontextprotocol/server-filesystem D:\\workspace'
  )
  const [url, setUrl] = useState('https://')

  // B5 Prompts Library form state
  const [promptFormOpen, setPromptFormOpen] = useState(false)
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null)
  const [promptTitle, setPromptTitle] = useState('')
  const [promptShortcut, setPromptShortcut] = useState('')
  const [promptCategory, setPromptCategory] = useState('')
  const [promptContent, setPromptContent] = useState('')
  const [skillPreview, setSkillPreview] = useState<{ skill: SkillDto; content: string } | null>(null)

  const createMcpMut = useMutation({
    mutationFn: () =>
      apiFetch('/api/mcp-servers', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim() || 'mcp-server',
          transport,
          command: transport === 'stdio' ? command.trim() : null,
          args: transport === 'stdio' ? argsText.split(/\s+/).filter(Boolean) : [],
          url: transport === 'streamable-http' ? url.trim() : null,
          enabled: true
        })
      }),
    onSuccess: () => {
      setAdding(false)
      setName('')
      void qc.invalidateQueries({ queryKey: ['mcp-servers'] })
    }
  })

  const reconnectMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mcp-servers/${id}/reconnect`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  })

  const deleteMcpMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/mcp-servers/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mcp-servers'] })
  })

  const rescanSkillsMut = useMutation({
    mutationFn: () => apiFetch('/api/skills/refresh', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] })
  })

  const toggleSkillMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled })
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] })
  })

  const savePromptMut = useMutation({
    mutationFn: () => {
      const payload = {
        title: promptTitle.trim(),
        shortcut: promptShortcut.trim() || null,
        category: promptCategory.trim() || null,
        content: promptContent
      }
      if (editingPromptId) {
        return apiFetch(`/api/prompts/${editingPromptId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        })
      }
      return apiFetch('/api/prompts', {
        method: 'POST',
        body: JSON.stringify(payload)
      })
    },
    onSuccess: () => {
      setPromptFormOpen(false)
      setEditingPromptId(null)
      setPromptTitle('')
      setPromptShortcut('')
      setPromptCategory('')
      setPromptContent('')
      void qc.invalidateQueries({ queryKey: ['prompts'] })
    }
  })

  const deletePromptMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/prompts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['prompts'] })
  })

  return (
    <div
      className="flex-1 overflow-y-auto p-8 select-text"
      style={{ backgroundImage: 'var(--ambient-glow)' }}
    >
      <div className="max-w-4xl mx-auto space-y-7 text-xs animate-enter">
        {/* R1 Built-in Tools & Web Search Settings */}
        <section className="p-5 rounded-2xl surface-card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Wrench className="w-4 h-4 text-[var(--accent)]" />
                <h3 className="text-sm font-semibold">{t('mcp.builtinToolsTitle')}</h3>
              </div>
              <p className="text-[var(--text-muted)]">{t('mcp.builtinToolsDesc')}</p>
            </div>
            <button
              type="button"
              disabled={saveToolsSettingsMut.isPending}
              onClick={() => saveToolsSettingsMut.mutate()}
              className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium hover:opacity-90 transition shadow-sm"
            >
              {t('mcp.saveToolsConfig')}
            </button>
          </div>

          {toolsSavedBanner && (
            <div className="px-3.5 py-2 rounded-xl bg-[var(--success-soft)] text-[var(--success)] font-medium">
              {t('mcp.toolsConfigSaved')}
            </div>
          )}

          <div className="p-3.5 rounded-xl bg-[var(--bg-canvas)]/70 border border-[var(--border-subtle)] flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="font-medium text-[var(--text-primary)]">
                {t('mcp.autoApproveReadOnlyLabel')}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {t('mcp.autoApproveReadOnlyDesc')}
              </div>
            </div>
            <Switch checked={autoApproveReadOnly} onChange={setAutoApproveReadOnly} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('mcp.maxStepsLabel')}
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={maxSteps}
                onChange={e => setMaxSteps(Number(e.target.value) || 20)}
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('mcp.shellTimeoutLabel')}
              </label>
              <input
                type="number"
                min={5}
                max={600}
                value={shellTimeoutSec}
                onChange={e => setShellTimeoutSec(Number(e.target.value) || 120)}
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('mcp.webSearchBackendLabel')}
              </label>
              <CustomSelect
                value={searchBackend}
                onChange={v => setSearchBackend(v as WebSearchBackend)}
                options={[
                  { value: 'auto', label: t('mcp.webSearchBackendAuto') },
                  { value: 'tavily', label: t('mcp.webSearchBackendTavily') },
                  { value: 'brave', label: t('mcp.webSearchBackendBrave') },
                  { value: 'searxng', label: t('mcp.webSearchBackendSearxng') },
                  { value: 'duckduckgo', label: t('mcp.webSearchBackendDuckduckgo') }
                ]}
                className="w-full"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('mcp.tavilyKeyLabel')}
                </label>
                {settings?.tools.webSearch.hasTavilyApiKey && (
                  <button
                    type="button"
                    disabled={clearSearchKeyMut.isPending}
                    onClick={() => clearSearchKeyMut.mutate('tavily')}
                    className="text-[11px] text-[var(--danger)] hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{t('mcp.clearSavedKey')}</span>
                  </button>
                )}
              </div>
              <input
                type="password"
                value={tavilyKeyInput}
                onChange={e => setTavilyKeyInput(e.target.value)}
                placeholder={
                  settings?.tools.webSearch.hasTavilyApiKey
                    ? t('mcp.keyConfiguredHint', {
                        preview: settings.tools.webSearch.tavilyApiKeyPreview
                      })
                    : t('mcp.keyInputPlaceholder')
                }
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('mcp.braveKeyLabel')}
                </label>
                {settings?.tools.webSearch.hasBraveApiKey && (
                  <button
                    type="button"
                    disabled={clearSearchKeyMut.isPending}
                    onClick={() => clearSearchKeyMut.mutate('brave')}
                    className="text-[11px] text-[var(--danger)] hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>{t('mcp.clearSavedKey')}</span>
                  </button>
                )}
              </div>
              <input
                type="password"
                value={braveKeyInput}
                onChange={e => setBraveKeyInput(e.target.value)}
                placeholder={
                  settings?.tools.webSearch.hasBraveApiKey
                    ? t('mcp.keyConfiguredHint', {
                        preview: settings.tools.webSearch.braveApiKeyPreview
                      })
                    : t('mcp.keyInputPlaceholder')
                }
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>

            <div className="space-y-1.5">
              <label className="font-medium text-[var(--text-secondary)]">
                {t('mcp.searxngUrlLabel')}
              </label>
              <input
                value={searxngUrl}
                onChange={e => setSearxngUrl(e.target.value)}
                placeholder="https://searx.example.com"
                className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>
        </section>

        {/* MCP Section */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <Plug className="w-4 h-4 text-[var(--accent)]" />
                <h3 className="text-base font-semibold tracking-tight">{t('mcp.title')}</h3>
              </div>
              <p className="text-[var(--text-muted)]">{t('mcp.subtitle')}</p>
            </div>
            <button
              onClick={() => setAdding(v => !v)}
              className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('mcp.addServer')}</span>
            </button>
          </div>

          {adding && (
            <div className="p-5 rounded-2xl surface-card space-y-4 animate-enter">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('mcp.nameLabel')}
                  </label>
                  <input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder={t('mcp.namePlaceholder')}
                    className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('mcp.transportLabel')}
                  </label>
                  <CustomSelect
                    value={transport}
                    onChange={val => setTransport(val as 'stdio' | 'streamable-http')}
                    options={[
                      { value: 'stdio', label: t('mcp.transportStdio') },
                      { value: 'streamable-http', label: t('mcp.transportHttp') }
                    ]}
                    className="w-full"
                  />
                </div>
              </div>

              {transport === 'stdio' ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="space-y-1.5">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('mcp.commandLabel')}
                    </label>
                    <input
                      value={command}
                      onChange={e => setCommand(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('mcp.argsLabel')}
                    </label>
                    <input
                      value={argsText}
                      onChange={e => setArgsText(e.target.value)}
                      className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('mcp.urlLabel')}
                  </label>
                  <input
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setAdding(false)}
                  className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => createMcpMut.mutate()}
                  className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium"
                >
                  {t('mcp.saveAndConnect')}
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {servers.length === 0 ? (
              <div className="md:col-span-2 p-8 rounded-2xl surface-card text-center space-y-3">
                <div className="w-10 h-10 mx-auto rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
                  <Plug className="w-5 h-5" />
                </div>
                <div className="font-semibold">{t('mcp.emptyTitle')}</div>
                <p className="text-[var(--text-muted)]">{t('mcp.emptyDesc')}</p>
                <div>
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t('mcp.addServer')}</span>
                  </button>
                </div>
              </div>
            ) : (
              servers.map(srv => (
                <div key={srv.id} className="p-4 rounded-2xl surface-card space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-[13px]">{srv.name}</span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium font-mono ${
                        srv.status === 'connected'
                          ? 'bg-[var(--success-soft)] text-[var(--success)]'
                          : srv.status === 'error'
                            ? 'bg-[var(--danger-soft)] text-[var(--danger)]'
                            : 'bg-[var(--bg-elevated)] text-[var(--text-muted)]'
                      }`}
                    >
                      {srv.transport} · {srv.status}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--text-muted)] truncate">
                    {srv.transport === 'stdio'
                      ? `${srv.command} ${(srv.args || []).join(' ')}`
                      : srv.url}
                  </div>
                  {srv.lastError && (
                    <div className="text-[var(--danger)] font-mono text-[11px] break-all">
                      {srv.lastError}
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-2 border-t border-[var(--border-subtle)] text-[var(--text-secondary)]">
                    <span>{t('mcp.toolsReady', { count: srv.toolCount })}</span>
                    <div className="flex items-center gap-2.5">
                      <button
                        onClick={() => reconnectMut.mutate(srv.id)}
                        className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                      >
                        <RefreshCw className="w-3 h-3" />
                        {t('mcp.reconnect')}
                      </button>
                      <button
                        onClick={() => deleteMcpMut.mutate(srv.id)}
                        className="text-[var(--text-muted)] hover:text-[var(--danger)] transition"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Skills Scanner Section */}
        <section className="space-y-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Blocks className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="text-sm font-semibold">{t('mcp.skillsTitle')}</h3>
            </div>
            <button
              onClick={() => rescanSkillsMut.mutate()}
              className="px-3 py-1.5 rounded-xl bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] inline-flex items-center gap-1.5 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{t('mcp.rescanSkills')}</span>
            </button>
          </div>

          <div className="rounded-2xl surface-card divide-y divide-[var(--border-subtle)] overflow-hidden">
            {skills.length === 0 ? (
              <div className="p-6 text-center space-y-3">
                <div className="text-[var(--text-muted)]">{t('mcp.skillsEmpty')}</div>
                <button
                  type="button"
                  onClick={() => rescanSkillsMut.mutate()}
                  className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium inline-flex items-center gap-1.5"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>{t('mcp.rescanSkills')}</span>
                </button>
              </div>
            ) : (
              skills.map(sk => {
                const badgeCls =
                  sk.source === 'builtin'
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : sk.source === 'claude'
                      ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                      : 'bg-[var(--bg-elevated)] text-[var(--text-secondary)]'
                const badgeLabel =
                  sk.source === 'builtin'
                    ? t('mcp.skillSourceBuiltin')
                    : sk.source === 'claude'
                      ? t('mcp.skillSourceClaude')
                      : t('mcp.skillSourceLocal')
                return (
                  <div key={sk.id} className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-[13px]">{sk.name}</span>
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${badgeCls}`}>
                          {badgeLabel}
                        </span>
                      </div>
                      <p className="text-[var(--text-secondary)] truncate">{sk.description}</p>
                      <p className="text-[11px] text-[var(--text-muted)] font-mono truncate">
                        {sk.path}
                      </p>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          void apiFetch<{ skill: SkillDto; content: string }>(
                            `/api/skills/${encodeURIComponent(sk.id)}/content`
                          ).then(setSkillPreview)
                        }}
                        className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                        title={t('mcp.viewSkill')}
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                      <Switch
                        checked={sk.enabled}
                        onChange={checked =>
                          toggleSkillMut.mutate({ id: sk.id, enabled: checked })
                        }
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </section>

        {/* Prompts Library Section (B5) */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <BookMarked className="w-4 h-4 text-[var(--accent)]" />
                <h3 className="text-sm font-semibold">{t('mcp.promptsTitle')}</h3>
              </div>
              <p className="text-[var(--text-muted)]">{t('mcp.promptsDesc')}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingPromptId(null)
                setPromptTitle('')
                setPromptShortcut('')
                setPromptCategory('')
                setPromptContent('')
                setPromptFormOpen(v => !v)
              }}
              className="px-3.5 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{t('mcp.addPrompt')}</span>
            </button>
          </div>

          {promptFormOpen && (
            <div className="p-5 rounded-2xl surface-card space-y-3.5 animate-enter">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div className="space-y-1">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('mcp.promptTitleLabel')}
                  </label>
                  <input
                    value={promptTitle}
                    onChange={e => setPromptTitle(e.target.value)}
                    placeholder={t('mcp.promptTitlePlaceholder')}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('mcp.promptShortcutLabel')}
                  </label>
                  <input
                    value={promptShortcut}
                    onChange={e => setPromptShortcut(e.target.value)}
                    placeholder={t('mcp.promptShortcutPlaceholder')}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="font-medium text-[var(--text-secondary)]">
                    {t('mcp.promptCategoryLabel')}
                  </label>
                  <input
                    value={promptCategory}
                    onChange={e => setPromptCategory(e.target.value)}
                    placeholder={t('mcp.promptCategoryPlaceholder')}
                    className="w-full px-3 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="font-medium text-[var(--text-secondary)]">
                  {t('mcp.promptContentLabel')}
                </label>
                <textarea
                  rows={3}
                  value={promptContent}
                  onChange={e => setPromptContent(e.target.value)}
                  placeholder={t('mcp.promptContentPlaceholder')}
                  className="w-full p-3 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPromptFormOpen(false)}
                  className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  disabled={!promptTitle.trim() || !promptContent.trim() || savePromptMut.isPending}
                  onClick={() => savePromptMut.mutate()}
                  className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium disabled:opacity-40"
                >
                  {t('mcp.savePrompt')}
                </button>
              </div>
            </div>
          )}

          <div className="rounded-2xl surface-card divide-y divide-[var(--border-subtle)] overflow-hidden">
            {prompts.length === 0 ? (
              <div className="p-6 text-center space-y-3">
                <div className="text-[var(--text-muted)]">{t('mcp.promptsEmpty')}</div>
                <button
                  type="button"
                  onClick={() => {
                    setEditingPromptId(null)
                    setPromptTitle('')
                    setPromptShortcut('')
                    setPromptCategory('')
                    setPromptContent('')
                    setPromptFormOpen(true)
                  }}
                  className="px-3.5 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{t('mcp.addPrompt')}</span>
                </button>
              </div>
            ) : (
              prompts.map(pr => (
                <div key={pr.id} className="p-4 flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[13px]">{pr.title}</span>
                      {pr.shortcut && (
                        <span className="px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-mono text-[11px]">
                          /{pr.shortcut}
                        </span>
                      )}
                      {pr.category && (
                        <span className="px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-secondary)] text-[11px]">
                          {pr.category}
                        </span>
                      )}
                    </div>
                    <p className="text-[var(--text-secondary)] line-clamp-2 whitespace-pre-wrap">
                      {pr.content}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPromptId(pr.id)
                        setPromptTitle(pr.title)
                        setPromptShortcut(pr.shortcut || '')
                        setPromptCategory(pr.category || '')
                        setPromptContent(pr.content)
                        setPromptFormOpen(true)
                      }}
                      className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-secondary)]"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePromptMut.mutate(pr.id)}
                      className="p-1.5 rounded-lg hover:bg-[var(--danger-soft)] text-[var(--text-muted)] hover:text-[var(--danger)]"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* CLI Bridge Info */}
        <section className="p-5 rounded-2xl surface-card space-y-2">
          <div className="flex items-center gap-2 font-semibold text-[13px]">
            <Terminal className="w-4 h-4 text-[var(--accent)]" />
            <span>{t('mcp.cliHintTitle')}</span>
          </div>
          <p className="text-[var(--text-secondary)] leading-relaxed">{t('mcp.cliHintDesc')}</p>
        </section>
      </div>

      {skillPreview && (
        <div
          onClick={() => setSkillPreview(null)}
          className="fixed inset-0 z-50 bg-black/45 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl surface-card p-5 space-y-3 text-xs animate-enter"
          >
            <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
              <div className="font-semibold text-sm">{skillPreview.skill.name}</div>
              <button
                type="button"
                onClick={() => setSkillPreview(null)}
                className="p-1 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-y-auto p-3.5 rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] font-mono text-[11px] whitespace-pre-wrap text-[var(--text-secondary)]">
              {skillPreview.content}
            </pre>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setSkillPreview(null)}
                className="px-4 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
              >
                {t('mcp.closeSkill')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
