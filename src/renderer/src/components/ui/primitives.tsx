import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, Copy, Eye, Globe, Search, Sparkles, Wrench, Zap } from 'lucide-react'
import type { CompositeModelOption } from '@shared/schemas'

// ==================== Tactile Toggle Switch ====================

export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none disabled:opacity-40 ${
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-elevated)] border border-[var(--border-strong)]'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

// ==================== Custom Popover Select ====================

export interface SelectOption {
  value: string
  label: string
  sublabel?: string
  badge?: string
}

export function CustomSelect({
  value,
  options,
  onChange,
  placeholder,
  align = 'left',
  direction = 'down',
  className = ''
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  align?: 'left' | 'right'
  direction?: 'up' | 'down'
  className?: string
}) {
  const { t } = useTranslation()
  const resolvedPlaceholder = placeholder ?? t('common.selectPlaceholder')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = options.find(o => o.value === value)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div ref={rootRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full px-3 py-1.5 rounded-lg bg-[var(--bg-surface)] hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] text-xs flex items-center justify-between gap-2 transition"
      >
        <span className="truncate font-medium text-[var(--text-primary)]">
          {selected ? selected.label : resolvedPlaceholder}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-[var(--text-muted)] shrink-0 transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>

      {open && (
        <div
          className={`absolute z-40 min-w-[220px] w-full p-1 rounded-xl popover-glass animate-enter max-h-64 overflow-y-auto ${
            direction === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          } ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {options.map(opt => {
            const isSel = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={`w-full text-left px-2.5 py-2 rounded-lg text-xs flex items-center justify-between gap-2 transition ${
                  isSel
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium'
                    : 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate">{opt.label}</div>
                  {opt.sublabel && (
                    <div className="text-[11px] text-[var(--text-muted)] truncate mt-0.5">
                      {opt.sublabel}
                    </div>
                  )}
                </div>
                {isSel && <Check className="w-3.5 h-3.5 shrink-0 text-[var(--accent)]" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ==================== Luxury Grouped Model Picker ====================

export function ModelPickerPopover({
  models,
  value,
  onChange,
  onOpenProviders,
  open: controlledOpen,
  onOpenChange
}: {
  models: CompositeModelOption[]
  value: string
  onChange: (compositeId: string) => void
  onOpenProviders: () => void
  open?: boolean
  onOpenChange?: (next: boolean) => void
}) {
  const { t } = useTranslation()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next
    if (controlledOpen === undefined) setInternalOpen(resolved)
    onOpenChange?.(resolved)
  }
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const current = models.find(m => m.compositeId === value) || models[0]
  const filtered = query.trim()
    ? models.filter(
        m =>
          m.compositeId.toLowerCase().includes(query.toLowerCase()) ||
          (m.description || '').toLowerCase().includes(query.toLowerCase())
      )
    : models

  // Group by providerName
  const grouped = new Map<string, CompositeModelOption[]>()
  for (const m of filtered) {
    const key = m.providerName
    const arr = grouped.get(key) || []
    arr.push(m)
    grouped.set(key, arr)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="h-8 px-2.5 rounded-lg bg-[var(--bg-elevated)]/70 hover:bg-[var(--bg-elevated)] border border-[var(--border-subtle)] hover:border-[var(--border-strong)] text-xs flex items-center gap-2 transition"
      >
        {current ? (
          <>
            {current.providerType === 'acp' ? (
              <Zap className="w-3.5 h-3.5 text-[var(--warning)] shrink-0" />
            ) : (
              <Globe className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
            )}
            <span className="font-medium text-[var(--text-primary)] max-w-[190px] truncate">
              {current.modelName || current.modelId}
            </span>
            <span className="text-[var(--text-muted)] font-mono hidden sm:inline">
              {current.providerId}
            </span>
          </>
        ) : (
          <span className="text-[var(--text-muted)]">{t('modelPicker.placeholder')}</span>
        )}
        <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
      </button>

      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-84 rounded-2xl popover-glass p-2 z-50 animate-enter">
          <div className="relative mb-2">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-muted)]" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('modelPicker.searchPlaceholder')}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--bg-canvas)] border border-[var(--border-subtle)] text-xs outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="max-h-68 overflow-y-auto space-y-2 pr-0.5">
            {models.length === 0 ? (
              <div className="p-4 text-center space-y-2.5">
                <p className="text-xs text-[var(--text-muted)]">{t('modelPicker.emptyTitle')}</p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onOpenProviders()
                  }}
                  className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-[var(--accent-fg)] text-xs font-medium"
                >
                  {t('modelPicker.goAddProvider')}
                </button>
              </div>
            ) : (
              [...grouped.entries()].map(([provName, list]) => (
                <div key={provName} className="space-y-0.5">
                  <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {provName}
                  </div>
                  {list.map(m => {
                    const active = m.compositeId === value
                    return (
                      <button
                        key={m.compositeId}
                        type="button"
                        onClick={() => {
                          onChange(m.compositeId)
                          setOpen(false)
                        }}
                        className={`w-full text-left px-2.5 py-2 rounded-xl text-xs flex items-center justify-between gap-2 transition ${
                          active
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'hover:bg-[var(--bg-elevated)] text-[var(--text-primary)]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            {m.providerType === 'acp' ? (
                              <Zap className="w-3.5 h-3.5 text-[var(--warning)] shrink-0" />
                            ) : (
                              <Sparkles className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                            )}
                            <span className="font-medium truncate">{m.modelId}</span>
                          </div>
                          {m.description && (
                            <div className="text-[11px] text-[var(--text-muted)] truncate pl-5 mt-0.5">
                              {m.description}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0 text-[var(--text-muted)]">
                          {m.capabilities.vision && (
                            <span title={t('modelPicker.capVisionTitle')}>
                              <Eye className="w-3 h-3" />
                            </span>
                          )}
                          {m.capabilities.functionCalling && (
                            <span title={t('modelPicker.capToolsTitle')}>
                              <Wrench className="w-3 h-3" />
                            </span>
                          )}
                          {active && <Check className="w-3.5 h-3.5 text-[var(--accent)] ml-1" />}
                        </div>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== Markdown Code Block with Copy ====================

export function CodeBlockWithCopy({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const raw = String(children || '').replace(/\n$/, '')
  const match = /language-([\w-]+)/.exec(className || '')
  const isMultiline = raw.includes('\n') || Boolean(match)

  if (!isMultiline) {
    return (
      <code className="px-1.5 py-0.5 rounded-md bg-[var(--bg-elevated)] border border-[var(--border-subtle)] font-mono text-[12px] text-[var(--text-primary)]">
        {children}
      </code>
    )
  }

  const handleCopy = () => {
    void navigator.clipboard.writeText(raw)
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-code)]">
      <div className="px-3.5 py-1.5 bg-[var(--bg-surface)] border-b border-[var(--border-subtle)] flex items-center justify-between text-[11px] text-[var(--text-muted)] font-mono">
        <span>{match?.[1] || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] transition"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-[var(--success)]" />
              <span className="text-[var(--success)]">{t('common.copied')}</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>{t('common.copy')}</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3.5 overflow-x-auto text-xs font-mono leading-relaxed text-[var(--text-primary)] m-0">
        <code>{raw}</code>
      </pre>
    </div>
  )
}
