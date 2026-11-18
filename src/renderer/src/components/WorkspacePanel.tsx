import React, { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  GitBranch,
  RefreshCw,
  X
} from 'lucide-react'
import type { WorkspaceGitStatusDto, WorkspaceTreeEntryDto } from '@shared/schemas'
import { apiFetch } from '../lib/api'

export function WorkspacePanel({
  threadId,
  workspacePath,
  onClose
}: {
  threadId: string
  workspacePath: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'files' | 'git'>('files')
  const [currentDir, setCurrentDir] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  useEffect(() => {
    setCurrentDir('')
    setSelectedFile(null)
  }, [threadId, workspacePath])

  const {
    data: treeData,
    refetch: refetchTree
  } = useQuery<{
    workspacePath: string
    dir: string
    entries: WorkspaceTreeEntryDto[]
  }>({
    queryKey: ['workspace-tree', threadId, currentDir],
    queryFn: () =>
      apiFetch(
        `/api/threads/${threadId}/workspace/tree?dir=${encodeURIComponent(currentDir)}`
      ),
    enabled: Boolean(threadId && workspacePath && tab === 'files')
  })

  const { data: fileData } = useQuery<{
    path: string
    size: number
    truncated: boolean
    binary: boolean
    content: string
  }>({
    queryKey: ['workspace-file', threadId, selectedFile],
    queryFn: () =>
      apiFetch(
        `/api/threads/${threadId}/workspace/file?path=${encodeURIComponent(selectedFile || '')}`
      ),
    enabled: Boolean(threadId && workspacePath && selectedFile && tab === 'files')
  })

  const {
    data: gitData,
    refetch: refetchGit
  } = useQuery<WorkspaceGitStatusDto>({
    queryKey: ['workspace-git', threadId],
    queryFn: () => apiFetch(`/api/threads/${threadId}/workspace/git`),
    enabled: Boolean(threadId && workspacePath && tab === 'git')
  })

  const segments = currentDir ? currentDir.split('/').filter(Boolean) : []

  return (
    <aside className="w-88 bg-[var(--bg-sidebar)] border-l border-[var(--border-subtle)] flex flex-col shrink-0 text-xs overflow-hidden">
      <div className="h-11 px-3.5 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2 shrink-0">
        <span className="font-semibold truncate">{t('chat.workspacePanelTitle')}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (tab === 'files') void refetchTree()
              else void refetchGit()
            }}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            title={t('common.refresh')}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--bg-elevated)] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {!workspacePath ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-[var(--text-muted)]">
          {t('chat.workspaceNoFolder')}
        </div>
      ) : (
        <>
          <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setTab('files')}
              className={`px-2.5 py-1 rounded-lg font-medium inline-flex items-center gap-1.5 transition ${
                tab === 'files'
                  ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-subtle)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{t('chat.workspaceFilesTab')}</span>
            </button>
            <button
              type="button"
              onClick={() => setTab('git')}
              className={`px-2.5 py-1 rounded-lg font-medium inline-flex items-center gap-1.5 transition ${
                tab === 'git'
                  ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] border border-[var(--border-subtle)]'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" />
              <span>{t('chat.workspaceGitTab')}</span>
            </button>
          </div>

          {tab === 'files' ? (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="px-3 py-1.5 border-b border-[var(--border-subtle)] flex flex-wrap items-center gap-1 font-mono text-[11px] text-[var(--text-muted)] bg-[var(--bg-canvas)]/40">
                <button
                  type="button"
                  onClick={() => setCurrentDir('')}
                  className="hover:text-[var(--accent)]"
                >
                  .
                </button>
                {segments.map((seg, i) => {
                  const target = segments.slice(0, i + 1).join('/')
                  return (
                    <React.Fragment key={target}>
                      <ChevronRight className="w-3 h-3" />
                      <button
                        type="button"
                        onClick={() => setCurrentDir(target)}
                        className="hover:text-[var(--accent)] truncate max-w-[100px]"
                      >
                        {seg}
                      </button>
                    </React.Fragment>
                  )
                })}
              </div>

              <div className="max-h-60 overflow-y-auto divide-y divide-[var(--border-subtle)]/50 border-b border-[var(--border-subtle)]">
                {(treeData?.entries || []).map(entry => (
                  <button
                    key={entry.relPath}
                    type="button"
                    onClick={() => {
                      if (entry.isDir) {
                        setCurrentDir(entry.relPath)
                      } else {
                        setSelectedFile(entry.relPath)
                      }
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center justify-between gap-2 hover:bg-[var(--bg-elevated)] transition ${
                      selectedFile === entry.relPath ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : ''
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      {entry.isDir ? (
                        <Folder className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                      ) : (
                        <FileText className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                      )}
                      <span className="font-mono truncate">{entry.name}</span>
                    </span>
                    {!entry.isDir && (
                      <span className="text-[10px] font-mono text-[var(--text-muted)] shrink-0">
                        {entry.size < 1024 ? `${entry.size}B` : `${Math.round(entry.size / 1024)}K`}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-h-0 overflow-auto p-3 bg-[var(--bg-code)] font-mono text-[11px] select-text">
                {!selectedFile ? (
                  <div className="text-[var(--text-muted)]">{t('chat.workspaceSelectFile')}</div>
                ) : fileData?.binary ? (
                  <div className="text-[var(--text-muted)]">Binary ({fileData.size} bytes)</div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words text-[var(--text-secondary)]">
                    {fileData?.content || ''}
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-3 space-y-3 select-text">
              {!gitData?.isGitRepo ? (
                <div className="text-[var(--text-muted)] p-3 rounded-xl bg-[var(--bg-surface)]">
                  {t('chat.workspaceNotGit')}
                </div>
              ) : (
                <>
                  {gitData.branch && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] font-mono text-[11px]">
                      <GitBranch className="w-3 h-3" />
                      <span>{gitData.branch}</span>
                    </div>
                  )}

                  {gitData.files.length === 0 ? (
                    <div className="text-[var(--text-muted)] p-3 rounded-xl bg-[var(--bg-surface)]">
                      {t('chat.workspaceClean')}
                    </div>
                  ) : (
                    <div className="rounded-xl bg-[var(--bg-surface)] border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)] overflow-hidden">
                      {gitData.files.map((f, idx) => (
                        <div
                          key={idx}
                          className="px-3 py-1.5 flex items-center gap-2 font-mono text-[11px]"
                        >
                          <span className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--warning)] font-semibold shrink-0">
                            {f.status}
                          </span>
                          <span className="truncate text-[var(--text-primary)]">{f.path}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {gitData.diff && (
                    <div className="rounded-xl bg-[var(--bg-code)] border border-[var(--border-subtle)] p-2.5 font-mono text-[11px] overflow-x-auto space-y-0.5">
                      {gitData.diff.split(/\r?\n/).map((line, i) => (
                        <div
                          key={i}
                          className={
                            line.startsWith('+') && !line.startsWith('+++')
                              ? 'text-[var(--success)]'
                              : line.startsWith('-') && !line.startsWith('---')
                                ? 'text-[var(--danger)]'
                                : line.startsWith('@@')
                                  ? 'text-[var(--accent)]'
                                  : 'text-[var(--text-secondary)]'
                          }
                        >
                          {line || ' '}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  )
}
