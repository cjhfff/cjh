import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Blocks, BookMarked, Pencil, Plug, Plus, RefreshCw, Terminal, Trash2 } from 'lucide-react'
import type { McpServerRuntimeDto, PromptTemplateDto, SkillDto } from '@shared/schemas'
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
              <div className="md:col-span-2 p-8 rounded-2xl surface-card text-center space-y-2">
                <div className="w-10 h-10 mx-auto rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
                  <Plug className="w-5 h-5" />
                </div>
                <div className="font-semibold">{t('mcp.emptyTitle')}</div>
                <p className="text-[var(--text-muted)]">{t('mcp.emptyDesc')}</p>
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
              <div className="p-6 text-center text-[var(--text-muted)]">{t('mcp.skillsEmpty')}</div>
            ) : (
              skills.map(sk => (
                <div key={sk.id} className="p-4 flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-[13px]">{sk.name}</span>
                      <span className="px-2 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[11px] font-mono text-[var(--text-secondary)]">
                        {sk.source}
                      </span>
                    </div>
                    <p className="text-[var(--text-secondary)] truncate">{sk.description}</p>
                    <p className="text-[11px] text-[var(--text-muted)] font-mono truncate">
                      {sk.path}
                    </p>
                  </div>
                  <Switch
                    checked={sk.enabled}
                    onChange={checked =>
                      toggleSkillMut.mutate({ id: sk.id, enabled: checked })
                    }
                  />
                </div>
              ))
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
              <div className="p-6 text-center text-[var(--text-muted)]">{t('mcp.promptsEmpty')}</div>
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
    </div>
  )
}
