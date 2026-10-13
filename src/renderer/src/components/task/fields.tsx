import { useState, type ReactNode } from 'react'
import type { TaskStatus } from '@core/types.js'
import { ChevronIcon, CloseIcon, PlusIcon } from '../icons.js'

/** Each column's identity colour, for the dot beside a status. */
export const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: 'var(--color-col-backlog)',
  in_progress: 'var(--color-col-progress)',
  in_review: 'var(--color-col-review)',
  done: 'var(--color-col-done)'
}

export const SECTION_LABEL = 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint'
export const GHOST_BTN =
  'inline-flex items-center gap-1.5 rounded-[7px] border border-transparent px-2 text-[12px] font-medium text-dim transition-colors hover:bg-raised/70 hover:text-ink disabled:pointer-events-none disabled:opacity-40'
export const INPUT_TEXT =
  'rounded-lg border bg-transparent text-ink outline-none placeholder:text-faint'

/** A sidebar row: an 84px label column, then the control. */
export const PROP_ROW = 'grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2'
export const PROP_LABEL = 'text-[12px] text-dim'
/** A text field dressed as plain text until hovered or focused. */
export const PROP_INPUT =
  'h-7 w-full rounded-[7px] border border-transparent bg-transparent px-2 text-[12.5px] text-ink outline-none placeholder:text-faint hover:border-edge hover:bg-card focus:border-accent focus:bg-chrome'
/** A hint under a sidebar row, aligned with the control rather than the label. */
export const PROP_HINT = 'pb-1 pl-[101px] text-[11px] leading-[1.4] text-faint'

/** The ✕ at the end of a removable chip (a context file, a blocker). */
export function RemoveButton({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex size-[18px] shrink-0 items-center justify-center rounded text-faint hover:bg-danger/10 hover:text-danger"
      onClick={onClick}
    >
      <CloseIcon size={10} />
    </button>
  )
}

/**
 * One sidebar row: a label and a select dressed as plain text, with an optional dot (a status,
 * a priority) and an optional hint under it. It stays a real `<select>` for the native menu.
 */
export function PropertySelect<T extends string>({
  label,
  ariaLabel,
  value,
  options,
  dots,
  hint,
  onChange
}: {
  label: string
  ariaLabel?: string
  value: T
  options: { value: T; label: string }[]
  dots?: Partial<Record<T, string>>
  hint?: string
  onChange: (value: T) => void
}): ReactNode {
  const current = options.find((option) => option.value === value) ?? options[0]
  const dot = current ? dots?.[current.value] : undefined
  const inset = dot ? 'pl-[23px]' : 'pl-[9px]'
  return (
    <div className="flex flex-col">
      <div className={`${PROP_ROW} h-8`}>
        <span className={PROP_LABEL}>{label}</span>
        <span className="relative block">
          {dot ? (
            <span
              aria-hidden
              className="pointer-events-none absolute left-[9px] top-1/2 z-[1] size-[7px] -translate-y-1/2 rounded-full"
              style={{ background: dot }}
            />
          ) : null}
          <span
            className={`pointer-events-none absolute right-[26px] top-1/2 z-[1] -translate-y-1/2 truncate text-[12.5px] text-ink ${dot ? 'left-[23px]' : 'left-[9px]'}`}
          >
            {current?.label}
          </span>
          <select
            aria-label={ariaLabel ?? label}
            value={value}
            onChange={(event) => onChange(event.target.value as T)}
            className={`h-7 w-full cursor-pointer appearance-none rounded-[7px] border border-transparent bg-transparent pr-[26px] text-[12.5px] text-transparent outline-none hover:border-edge hover:bg-card focus:border-accent ${inset}`}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value} className="bg-chrome text-ink">
                {option.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint">
            <ChevronIcon size={12} />
          </span>
        </span>
      </div>
      {hint ? <span className={PROP_HINT}>{hint}</span> : null}
    </div>
  )
}

/** A sidebar row that is a switch: the label, what the current setting means, and the switch. */
export function RowToggle({
  checked,
  onChange,
  label,
  state,
  title
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  /** What the current setting means, in a few words. */
  state: string
  title?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      onClick={() => onChange(!checked)}
      className="grid min-h-8 w-full cursor-pointer grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-2 pr-px text-left"
    >
      <span className={PROP_LABEL}>{label}</span>
      <span className="truncate pl-[9px] text-[12.5px] text-ink">{state}</span>
      <span
        className={`relative block h-4 w-7 rounded-full transition-colors duration-150 ${checked ? 'bg-accent' : 'bg-edge-strong'}`}
      >
        <span
          className={`absolute top-0.5 size-3 rounded-full bg-ink transition-[left] duration-150 ${checked ? 'left-3.5' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

export function TagsEditor({
  tags,
  onChange
}: {
  tags: string[]
  onChange: (tags: string[]) => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  function commit(): void {
    const tag = draft.trim()
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
    setAdding(false)
  }

  return (
    <div className={`${PROP_ROW} min-h-8`}>
      <span className={PROP_LABEL}>Tags</span>
      <div className="flex flex-wrap items-center gap-1 px-2 py-[5px]">
        {tags.map((tag) => (
          <span
            key={tag}
            className="group inline-flex h-[18px] items-center gap-1 rounded-md bg-raised px-1.5 text-[10.5px] font-medium text-dim"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              className="hidden text-faint hover:text-ink group-hover:inline-flex"
              onClick={() => onChange(tags.filter((current) => current !== tag))}
            >
              <CloseIcon size={9} />
            </button>
          </span>
        ))}
        {adding ? (
          <input
            autoFocus
            value={draft}
            aria-label="New tag"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                commit()
              } else if (event.key === 'Escape') {
                event.stopPropagation()
                setDraft('')
                setAdding(false)
              }
            }}
            className="h-[18px] w-20 rounded-md border border-accent bg-chrome px-1.5 text-[10.5px] text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            aria-label="Add tag"
            onClick={() => setAdding(true)}
            className="inline-flex size-[18px] items-center justify-center rounded-[5px] border border-dashed border-edge-strong text-faint hover:border-faint hover:text-ink"
          >
            <PlusIcon size={10} />
          </button>
        )}
      </div>
    </div>
  )
}
