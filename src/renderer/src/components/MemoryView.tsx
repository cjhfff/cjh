import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Brain,
  ExternalLink,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  X
} from 'lucide-react'
import type { AppSettings, MemoryDto, MemorySearchHitDto } from '@shared/schemas'
import { apiFetch } from '../lib/api'
import { useWorkspaceStore } from '../store/workspace-store'
import { Switch } from './ui/primitives'

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function MemoryView() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const setActiveThreadId = useWorkspaceStore(s => s.setActiveThreadId)
  const setActiveView = useWorkspaceStore(s => s.setActiveView)

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)

  const [titleInput, setTitleInput] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [contentInput, setContentInput] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 180)
    return () => clearTimeout(timer)
  }, [query])

  const { data: settings } = useQuery<AppSettings>({
    queryKey: ['settings'],
    queryFn: () => apiFetch('/api/settings')
  })

  const { data: memories = [] } = useQuery<Array<MemoryDto | MemorySearchHitDto>>({
    queryKey: ['memories', debouncedQuery],
    queryFn: () =>
      debouncedQuery
        ? apiFetch(`/api/memories/search?q=${encodeURIComponent(debouncedQuery)}&limit=50`)
        : apiFetch('/api/memories')
  })

  const selected = memories.find(m => m.id === selectedId) || memories[0] || null

  const openCreate = () => {
    setCreating(true)
    setEditing(false)
    setTitleInput('')
    setTagsInput('')
    setContentInput('')
  }

  const openEdit = (mem: MemoryDto) => {
    setCreating(false)
    setEditing(true)
    setTitleInput(mem.title)
    setTagsInput(mem.tags.join(', '))
    setContentInput(mem.content)
  }

  const toggleAutoInjectMut = useMutation({
    mutationFn: (next: boolean) =>
      apiFetch('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ tools: { memoryAutoInject: next } })
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] })
  })

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        title: titleInput.trim(),
        content: contentInput.trim(),
        tags: tagsInput
          .split(/[,，]/)
          .map(s => s.trim())
          .filter(Boolean)
      }
      if (creating) {
        return apiFetch<MemoryDto>('/api/memories', {
          method: 'POST',
          body: JSON.stringify(payload)
        })
      }
      if (!selected) throw new Error('No memory selected')
      return apiFetch<MemoryDto>(`/api/memories/${selected.id}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      })
    },
    onSuccess: saved => {
      setCreating(false)
      setEditing(false)
      setSelectedId(saved.id)
      void qc.invalidateQueries({ queryKey: ['memories'] })
    }
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/memories/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, id) => {
      if (selectedId === id) setSelectedId(null)
      setEditing(false)
      void qc.invalidateQueries({ queryKey: ['memories'] })
    }
  })

  return (
    <div
      className="flex-1 overflow-y-auto p-8 select-text"
      style={{ backgroundImage: 'var(--ambient-glow)' }}
    >
      <div className="max-w-5xl mx-auto space-y-5 text-xs animate-enter">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Brain className="w-4 h-4 text-[var(--accent)]" />
              <h3 className="text-base font-semibold tracking-tight">{t('memory.title')}</h3>
            </div>
            <p className="text-[var(--text-muted)]">{t('memory.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5 hover:opacity-90 transition shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t('memory.addBtn')}</span>
          </button>
        </div>

        {/* Auto-inject toggle + search */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          <div className="p-3.5 rounded-2xl surface-card flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-medium text-[var(--text-primary)]">
                {t('memory.autoInjectLabel')}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">
                {t('memory.autoInjectDesc')}
              </div>
            </div>
            <Switch
              checked={settings?.tools.memoryAutoInject !== false}
              onChange={next => toggleAutoInjectMut.mutate(next)}
            />
          </div>

          <div className="p-3.5 rounded-2xl surface-card flex items-center">
            <div className="relative w-full">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[var(--text-muted)]" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('memory.searchPlaceholder')}
                className="w-full pl-8 pr-8 py-1.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Main Master-Detail Grid */}
        {memories.length === 0 && !creating ? (
          <div className="p-10 rounded-2xl surface-card text-center space-y-3">
            <div className="w-10 h-10 mx-auto rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center">
              <Brain className="w-5 h-5" />
            </div>
            <div className="font-semibold text-[13px]">
              {debouncedQuery ? t('memory.emptySearch') : t('memory.emptyTitle')}
            </div>
            <p className="text-[var(--text-muted)]">{t('memory.emptyDesc')}</p>
            <div className="pt-1">
              <button
                type="button"
                onClick={openCreate}
                className="px-4 py-2 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium inline-flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{t('memory.addBtn')}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            {/* Left list */}
            <div className="lg:col-span-2 rounded-2xl surface-card divide-y divide-[var(--border-subtle)] overflow-hidden max-h-[560px] overflow-y-auto">
              {memories.map(m => {
                const active = !creating && selected?.id === m.id
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setCreating(false)
                      setEditing(false)
                      setSelectedId(m.id)
                    }}
                    className={`w-full text-left p-3.5 space-y-1.5 transition ${
                      active ? 'bg-[var(--accent-soft)]/50' : 'hover:bg-[var(--bg-elevated)]/50'
                    }`}
                  >
                    <div className="font-semibold text-[13px] truncate text-[var(--text-primary)]">
                      {m.title}
                    </div>
                    <div className="text-[11px] text-[var(--text-secondary)] line-clamp-2">
                      {'snippet' in m && m.snippet ? m.snippet : m.content}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                      {m.tags.map(tag => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[10px] text-[var(--text-muted)]"
                        >
                          <Tag className="w-2.5 h-2.5" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Right detail / editor */}
            <div className="lg:col-span-3 rounded-2xl surface-card p-5 space-y-4">
              {creating || editing ? (
                <div className="space-y-3.5">
                  <div className="space-y-1">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('memory.titleLabel')}
                    </label>
                    <input
                      value={titleInput}
                      onChange={e => setTitleInput(e.target.value)}
                      placeholder={t('memory.titlePlaceholder')}
                      className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('memory.tagsLabel')}
                    </label>
                    <input
                      value={tagsInput}
                      onChange={e => setTagsInput(e.target.value)}
                      placeholder={t('memory.tagsPlaceholder')}
                      className="w-full px-3.5 py-2 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="font-medium text-[var(--text-secondary)]">
                      {t('memory.contentLabel')}
                    </label>
                    <textarea
                      rows={10}
                      value={contentInput}
                      onChange={e => setContentInput(e.target.value)}
                      placeholder={t('memory.contentPlaceholder')}
                      className="w-full p-3.5 rounded-xl bg-[var(--bg-canvas)] border border-[var(--border-subtle)] font-mono outline-none focus:border-[var(--accent)]"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setCreating(false)
                        setEditing(false)
                      }}
                      className="px-3.5 py-1.5 rounded-xl bg-[var(--bg-elevated)] font-medium"
                    >
                      {t('memory.cancelBtn')}
                    </button>
                    <button
                      type="button"
                      disabled={
                        !titleInput.trim() || !contentInput.trim() || saveMut.isPending
                      }
                      onClick={() => saveMut.mutate()}
                      className="px-4 py-1.5 rounded-xl bg-[var(--accent)] text-[var(--accent-fg)] font-medium disabled:opacity-40"
                    >
                      {t('memory.saveBtn')}
                    </button>
                  </div>
                </div>
              ) : selected ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3 pb-3 border-b border-[var(--border-subtle)]">
                    <div className="space-y-1 min-w-0">
                      <h4 className="text-base font-semibold tracking-tight">{selected.title}</h4>
                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)] font-mono">
                        <span>
                          {t('memory.updatedAt')}: {formatTime(selected.updatedAt)}
                        </span>
                        {selected.sourceThreadId && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveThreadId(selected.sourceThreadId)
                              setActiveView('chat')
                            }}
                            className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>
                              {t('memory.sourceThread')}: {selected.sourceThreadId}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEdit(selected)}
                        className="px-3 py-1.5 rounded-xl bg-[var(--bg-elevated)] hover:opacity-90 font-medium inline-flex items-center gap-1"
                      >
                        <Pencil className="w-3 h-3" />
                        <span>{t('memory.editBtn')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteMut.mutate(selected.id)}
                        className="p-1.5 rounded-xl bg-[var(--danger-soft)] text-[var(--danger)] hover:opacity-80"
                        title={t('memory.deleteBtn')}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {selected.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selected.tags.map(tag => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] text-[11px]"
                        >
                          <Tag className="w-3 h-3" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <pre className="p-4 rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] font-mono text-xs whitespace-pre-wrap leading-relaxed text-[var(--text-primary)]">
                    {selected.content}
                  </pre>

                  <div className="text-[11px] text-[var(--text-muted)] font-mono truncate">
                    {t('memory.filePath')}: {selected.filePath}
                  </div>
                </div>
              ) : (
                <div className="py-16 text-center text-[var(--text-muted)]">
                  {t('memory.selectHint')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
