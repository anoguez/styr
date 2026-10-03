import { useState, type ReactNode } from 'react'
import type { Settings } from '@core/types.js'
import { inputClass } from './ui.js'

/**
 * A single-input overlay for capturing a task without filling in the full form. The task lands in
 * Backlog as `needs_spec`, so it is specced before anyone builds it. Everything else seeds from the
 * same defaults as the New task form.
 */
export function QuickTaskDialog({
  settings,
  onClose
}: {
  settings: Settings
  onClose: () => void
}): ReactNode {
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await window.api.tasks.create({
        title: trimmed,
        status: 'backlog',
        priority: 'medium',
        readiness: 'needs_spec',
        tags: [],
        repoPath: settings.defaultRepoPath.trim() || undefined,
        useWorktree: settings.taskDefaults.useWorktree,
        orchestrate: settings.taskDefaults.orchestrate,
        contextFiles: [],
        provider: settings.defaultProvider,
        description: ''
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add the task')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 px-8 pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-edge-strong bg-panel p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          className={`${inputClass} py-2.5 text-[15px]`}
          value={title}
          placeholder="Quick add a task…"
          aria-label="Task title"
          disabled={saving}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <p className="mt-2 px-1 text-[11.5px] text-faint">
          {error || 'Added to Backlog as Needs spec · ↵ to add · Esc to cancel'}
        </p>
      </div>
    </div>
  )
}
