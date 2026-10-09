import { useState, type ReactNode } from 'react'
import { CloseIcon, PlusIcon } from '../icons.js'

export const SECTION_LABEL = 'text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint'
export const GHOST_BTN =
  'inline-flex items-center gap-1.5 rounded-[7px] border border-transparent px-2 text-[12px] font-medium text-dim transition-colors hover:bg-raised/70 hover:text-ink disabled:pointer-events-none disabled:opacity-40'
export const BOXED_CONTROL =
  'h-[30px] w-full rounded-[7px] border border-edge-strong bg-chrome px-2.5 text-[12.5px] text-ink outline-none focus:border-accent'
export const INPUT_TEXT =
  'rounded-lg border bg-transparent text-ink outline-none placeholder:text-faint'

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
      className="inline-flex size-[18px] shrink-0 items-center justify-center rounded text-faint hover:bg-red-400/10 hover:text-red-300"
      onClick={onClick}
    >
      <CloseIcon size={10} />
    </button>
  )
}

/** One row of the Details list: a label and a select dressed as plain text with a status dot. */
export function PropertySelect<T extends string>({
  label,
  value,
  options,
  dots,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  dots: Record<T, string>
  onChange: (value: T) => void
}): ReactNode {
  const current = options.find((option) => option.value === value) ?? options[0]!
  return (
    <div className="grid h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12px] text-dim">{label}</span>
      <span className="relative block">
        <span
          aria-hidden
          className="pointer-events-none absolute left-[9px] top-1/2 z-[1] size-[7px] -translate-y-1/2 rounded-full"
          style={{ background: dots[current.value] }}
        />
        <span className="pointer-events-none absolute left-[23px] right-[26px] top-1/2 z-[1] -translate-y-1/2 truncate text-[12.5px] text-ink">
          {current.label}
        </span>
        <select
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          className="h-7 w-full cursor-pointer appearance-none rounded-[7px] border border-transparent bg-transparent pl-[23px] pr-[26px] text-[12.5px] text-transparent outline-none hover:border-edge hover:bg-card focus:border-accent"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} className="bg-chrome text-ink">
              {option.label}
            </option>
          ))}
        </select>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-faint"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </span>
    </div>
  )
}

/** A switch row with a label and a hint under it, sized for the task dialog's sidebar. */
export function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-start gap-2.5 text-left"
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-[12.5px] text-ink">{label}</span>
        <span className="text-[11px] leading-[1.4] text-faint">{hint}</span>
      </span>
      <span
        className={`relative mt-px block h-4 w-7 rounded-full transition-colors duration-150 ${checked ? 'bg-accent' : 'bg-edge-strong'}`}
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
    <div className="grid min-h-8 grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
      <span className="text-[12px] text-dim">Tags</span>
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
