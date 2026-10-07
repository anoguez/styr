import { useMemo, useRef, useState, type ReactNode } from 'react'
import { formatAccelerator } from '@core/shortcuts.js'
import { filterPresets, leadingPreset, parseSlashQuery, quickTaskDraft } from '@core/taskPreset.js'
import { TASK_READINESS_LABELS, type Settings, type TaskPreset } from '@core/types.js'
import { Button, inputBase } from './ui.js'

const ENTER = formatAccelerator('enter')
const MOD_ENTER = formatAccelerator('mod+enter')
const PROVIDER_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const

/**
 * A single-input overlay for capturing a task without filling in the full form. Plain text lands in
 * Backlog as `needs_spec`; a leading `/` picks a task preset that seeds everything but the title.
 * ⌘↵ skips the card and has the default agent plan the typed request into tasks (`onPlan`).
 */
export function QuickTaskDialog({
  settings,
  onPlan,
  onClose
}: {
  settings: Settings
  onPlan: (request: string) => Promise<void>
  onClose: () => void
}): ReactNode {
  const [title, setTitle] = useState('')
  const [preset, setPreset] = useState<TaskPreset | undefined>()
  const [highlight, setHighlight] = useState(0)
  // Esc closes the picker first; typing re-opens it.
  const [pickerDismissed, setPickerDismissed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const query = preset ? null : parseSlashQuery(title)
  const matches = useMemo(
    () => (query === null ? [] : filterPresets(settings.taskPresets, query)),
    [query, settings.taskPresets]
  )
  const pickerOpen = query !== null && !pickerDismissed && settings.taskPresets.length > 0
  const active = Math.min(highlight, Math.max(matches.length - 1, 0))

  function change(value: string): void {
    setError('')
    setPickerDismissed(false)
    setHighlight(0)
    const lead = preset ? null : leadingPreset(settings.taskPresets, value)
    if (lead) {
      setPreset(lead.preset)
      setTitle(lead.rest)
    } else {
      setTitle(value)
    }
  }

  function choose(next: TaskPreset): void {
    setPreset(next)
    setTitle('')
    setPickerDismissed(false)
    inputRef.current?.focus()
  }

  async function run(work: () => Promise<void>, failure: string): Promise<void> {
    setSaving(true)
    try {
      await work()
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : failure)
      setSaving(false)
    }
  }

  async function submit(): Promise<void> {
    if (saving) return
    const draft = quickTaskDraft(preset, title, settings)
    if (!draft) {
      if (preset) setError('Add a title')
      return
    }
    await run(async () => void (await window.api.tasks.create(draft)), 'Could not add the task')
  }

  async function plan(): Promise<void> {
    const request = title.trim()
    if (!request || saving) return
    await run(() => onPlan(request), 'Could not start the planning run')
  }

  const canSubmit = !saving && Boolean(title.trim() || preset?.title.trim())
  const provider = PROVIDER_NAMES[settings.defaultProvider]
  const hint =
    error ||
    (preset
      ? `${preset.name} preset · Added to Backlog as ${TASK_READINESS_LABELS[preset.readiness]}`
      : `Added to Backlog as Needs spec${settings.taskPresets.length ? ' · type / for presets' : ''}`)

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 px-8 pt-[18vh] backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl border border-edge-strong bg-panel p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div
          className={`${inputBase} flex w-full items-center gap-2 px-3 py-2.5 text-[15px] focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40`}
        >
          {preset ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-2 py-[1px] text-[12px] font-medium text-accent-ink">
              /{preset.name}
              <button
                type="button"
                aria-label={`Remove the ${preset.name} preset`}
                className="text-faint hover:text-ink"
                disabled={saving}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setPreset(undefined)
                  inputRef.current?.focus()
                }}
              >
                ×
              </button>
            </span>
          ) : null}
          <input
            ref={inputRef}
            autoFocus
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
            value={title}
            placeholder={preset ? 'Title…' : 'Quick add a task…'}
            aria-label="Task title"
            role="combobox"
            aria-expanded={pickerOpen}
            aria-controls="quick-task-presets"
            aria-activedescendant={
              pickerOpen && matches.length ? `quick-preset-${active}` : undefined
            }
            disabled={saving}
            onChange={(event) => change(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape') {
                event.preventDefault()
                if (pickerOpen) setPickerDismissed(true)
                else onClose()
              } else if (pickerOpen && event.key === 'ArrowDown') {
                event.preventDefault()
                setHighlight((active + 1) % Math.max(matches.length, 1))
              } else if (pickerOpen && event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlight((active - 1 + matches.length) % Math.max(matches.length, 1))
              } else if (
                pickerOpen &&
                matches.length &&
                (event.key === 'Tab' || event.key === 'Enter') &&
                !event.metaKey &&
                !event.ctrlKey
              ) {
                event.preventDefault()
                choose(matches[active]!)
              } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void plan()
              } else if (event.key === 'Enter') {
                event.preventDefault()
                // With no match, the first Enter only closes the picker; the next one submits.
                if (pickerOpen) setPickerDismissed(true)
                else void submit()
              } else if (
                event.key === 'Backspace' &&
                preset &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0
              ) {
                event.preventDefault()
                setPreset(undefined)
              }
            }}
          />
        </div>
        {pickerOpen ? (
          <ul
            id="quick-task-presets"
            role="listbox"
            aria-label="Task presets"
            className="mt-2 max-h-[212px] overflow-y-auto rounded-lg border border-edge-strong bg-chrome p-1"
          >
            {matches.length ? (
              matches.map((item, index) => (
                <li
                  key={item.id}
                  id={`quick-preset-${index}`}
                  role="option"
                  aria-selected={index === active}
                  ref={(node) => {
                    if (node && index === active) node.scrollIntoView({ block: 'nearest' })
                  }}
                  className={`flex cursor-pointer items-baseline justify-between gap-3 rounded-md px-2.5 py-1.5 text-[13px] ${index === active ? 'bg-accent/15 text-ink' : 'text-dim'}`}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(item)
                  }}
                >
                  <span>{item.name}</span>
                  <span className="truncate text-[11px] text-faint">
                    {[...item.tags, item.priority].join(' · ')}
                  </span>
                </li>
              ))
            ) : (
              <li className="px-2.5 py-1.5 text-[12px] text-faint">No matching preset</li>
            )}
          </ul>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-3">
          <p
            className={`min-w-0 truncate px-1 text-[11.5px] ${error ? 'text-danger' : 'text-faint'}`}
          >
            {hint}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              disabled={saving || !title.trim()}
              title="Have the agent split the request into tasks, without adding a card"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void plan()}
            >
              Plan with {provider} <span className="text-faint">{MOD_ENTER}</span>
            </Button>
            <Button
              variant="primary"
              disabled={!canSubmit}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void submit()}
            >
              Add <span className="opacity-70">{ENTER}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
