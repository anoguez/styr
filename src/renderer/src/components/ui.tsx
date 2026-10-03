import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from 'react'
import { hexToHsl, hslToHex } from '../lib/palette.js'

type Variant = 'primary' | 'ghost' | 'subtle' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent text-[var(--color-on-accent)] border-accent hover:bg-accent/90 font-semibold shadow-[0_1px_0_rgba(255,255,255,0.12)_inset]',
  ghost: 'bg-raised/70 text-dim border-edge-strong hover:bg-raised hover:text-ink',
  subtle: 'bg-transparent text-dim border-transparent hover:bg-raised/70 hover:text-ink',
  danger: 'bg-transparent text-red-300/90 border-red-500/25 hover:bg-red-500/10 hover:text-red-200'
}

export function Button({
  variant = 'ghost',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): ReactNode {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition-[background-color,color,border-color] duration-150 disabled:pointer-events-none disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}

/**
 * Deliberately a div, not a label: a label activates the first control inside it, so a group that
 * holds several controls — or a button — fires the wrong one on any click in the group.
 */
export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-dim">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-relaxed text-faint">{hint}</span> : null}
    </div>
  )
}

/**
 * Everything about a text control except its size. Compose it with your own padding and font size
 * rather than appending to `inputClass`: two conflicting utilities are resolved by stylesheet
 * order, not by which comes last, so an override can silently lose (or clip the text).
 */
export const inputBase =
  'rounded-lg border border-edge-strong bg-chrome text-ink outline-none transition-colors placeholder:text-faint hover:border-faint/60 focus:border-accent focus:ring-1 focus:ring-accent/40'

export const inputClass = `${inputBase} w-full px-3 py-2 text-[13px]`

/**
 * A native select with the chevron drawn by the app. macOS paints its own flush against the right
 * edge; this one sits inset and uses the theme's text colour. The control stays a real `<select>`,
 * so keyboard handling and the native option menu are unchanged.
 */
export function Select({
  compact = false,
  inset = false,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & {
  /** A shorter control, for tight lists and nav. */
  compact?: boolean
  /** Leave room on the left for a marker the caller draws over the control. */
  inset?: boolean
}): ReactNode {
  const size = compact
    ? `h-[30px] ${inset ? 'pl-6' : 'pl-2.5'} pr-7 text-[12.5px]`
    : 'px-3 py-2 pr-9 text-[13px]'
  return (
    <span className="relative block w-full">
      <select
        {...props}
        className={`${inputBase} w-full appearance-none ${size} ${className ?? ''}`}
      >
        {children}
      </select>
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-dim"
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </span>
  )
}

export function Chip({
  children,
  tone = 'neutral',
  title
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'warn' | 'done'
  title?: string
}): ReactNode {
  const tones = {
    neutral: 'bg-raised text-dim',
    accent: 'bg-accent/12 text-[var(--color-accent-text)]',
    warn: 'bg-[var(--color-col-review)]/15 text-[var(--color-col-review-text)]',
    done: 'bg-[var(--color-col-done)]/12 text-[var(--color-col-done)]'
  }
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-md px-1.5 py-[1px] text-[10.5px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export type FileStatusLetter = 'A' | 'M' | 'D' | 'R'

const STATUS_STYLE: Record<FileStatusLetter, { tone: string; text: string; label: string }> = {
  A: { tone: '--color-col-done', text: '--color-col-done-text', label: 'Added' },
  M: { tone: '--color-col-progress', text: '--color-col-progress-text', label: 'Modified' },
  D: { tone: '--color-danger', text: '--color-danger', label: 'Deleted' },
  R: { tone: '--color-col-review', text: '--color-col-review-text', label: 'Renamed' }
}

/** The A / M / D / R square beside a changed file. The letter carries the meaning; colour repeats it. */
export function StatusBadge({ status }: { status: FileStatusLetter }): ReactNode {
  const style = STATUS_STYLE[status]
  return (
    <span
      aria-label={style.label}
      title={style.label}
      className="grid size-4 shrink-0 place-items-center rounded font-mono text-[10px] font-bold"
      style={{
        background: `color-mix(in oklab, var(${style.tone}) 16%, transparent)`,
        color: `var(${style.text})`
      }}
    >
      {status}
    </span>
  )
}

/** `+N −M`, with an optional file count. One component so the numbers read the same everywhere. */
export function DiffCount({
  added,
  removed,
  files
}: {
  added: number
  removed: number
  files?: number
}): ReactNode {
  return (
    <span className="inline-flex items-center gap-[5px] font-mono text-[10.5px]">
      <span className="text-[var(--color-col-done-text)]">+{added}</span>
      <span className="text-danger">−{removed}</span>
      {files === undefined ? null : (
        <span className="inline-flex h-4 items-center rounded-[5px] bg-raised px-[5px] text-dim">
          {files}
        </span>
      )}
    </span>
  )
}

/** The clickable `+N −M` under a card or agent row; opens the Changes dialog. */
export function DiffStatButton({
  stat,
  onClick
}: {
  stat: { added: number; removed: number; files: number }
  onClick: () => void
}): ReactNode {
  const files = `${stat.files} ${stat.files === 1 ? 'file' : 'files'}`
  return (
    <button
      type="button"
      title={`${files} changed · +${stat.added} −${stat.removed} — view changes`}
      aria-label={`View changes: ${files}, +${stat.added} −${stat.removed}`}
      className="-ml-1 inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[10.5px] text-faint transition-colors hover:bg-raised hover:text-ink"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 2.5h5l3 3v8H4z" />
        <path d="M6.25 7h3.5M8 5.25v3.5M6.25 11h3.5" />
      </svg>
      <DiffCount added={stat.added} removed={stat.removed} />
    </button>
  )
}

export function Modal({
  title,
  subtitle,
  onClose,
  onSubmit,
  children,
  footer,
  wide = false,
  flush = false,
  bare = false,
  xl = false,
  backdropCloses = true
}: {
  title: string
  subtitle?: string
  onClose: () => void
  onSubmit?: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** Hand the body's padding and scrolling to the child, for layouts with their own panes. */
  flush?: boolean
  /** Draw only the overlay and panel. The child brings its own header and footer. */
  bare?: boolean
  /** With `bare`: the large, fixed-height size for two-pane viewers. */
  xl?: boolean
  /** Clicking the dimmed backdrop closes the dialog. Turn off where a stray click would lose edits. */
  backdropCloses?: boolean
}): ReactNode {
  useEffect(() => {
    if (!onSubmit) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        onSubmit?.()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onSubmit])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/65 px-8 py-[6vh] backdrop-blur-[2px]"
      onMouseDown={backdropCloses ? onClose : undefined}
    >
      <div
        aria-label={bare ? title : undefined}
        className={`flex ${bare ? (xl ? 'h-[min(820px,88vh)]' : 'h-[min(700px,88vh)]') : 'max-h-[88vh]'} w-full ${bare ? (xl ? 'max-w-[1320px]' : 'max-w-[960px]') : wide ? 'max-w-3xl' : 'max-w-xl'} flex-col overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {bare ? null : (
          <header className="flex items-start justify-between gap-4 border-b border-edge px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
              {subtitle ? <p className="mt-0.5 text-[12px] text-faint">{subtitle}</p> : null}
            </div>
            <Button variant="subtle" className="shrink-0 px-2" onClick={onClose} aria-label="Close">
              ✕
            </Button>
          </header>
        )}
        {bare ? (
          children
        ) : flush ? (
          <div className="flex min-h-0 flex-1">{children}</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        )}
        {footer && !bare ? (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-edge bg-chrome/40 px-5 py-3.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  )
}

export function DirectoryInput({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (path: string) => void
  placeholder?: string
}): ReactNode {
  async function browse(): Promise<void> {
    const picked = await window.api.settings.pickDirectory(value || undefined)
    if (picked) onChange(picked)
  }

  return (
    <span className="flex h-8 items-center gap-1.5 rounded-[7px] border border-edge-strong bg-chrome py-0 pl-2.5 pr-1 transition-colors focus-within:border-accent hover:border-faint/60">
      <input
        aria-label={placeholder ?? 'Folder'}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[11.5px] text-ink outline-none placeholder:text-faint"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        aria-label="Browse"
        title="Browse"
        onClick={() => void browse()}
        className="grid size-6 shrink-0 place-items-center rounded-[5px] text-dim transition-colors hover:bg-raised hover:text-ink"
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
        </svg>
      </button>
    </span>
  )
}

export function FileListInput({
  files,
  onChange,
  startIn
}: {
  files: string[]
  onChange: (files: string[]) => void
  startIn?: string
}): ReactNode {
  async function browse(): Promise<void> {
    const picked = await window.api.settings.pickFiles(startIn)
    if (picked.length === 0) return
    onChange([...files, ...picked.filter((file) => !files.includes(file))])
  }

  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 ? (
        <ul className="flex flex-col divide-y divide-edge overflow-hidden rounded-lg border border-edge-strong bg-chrome">
          {files.map((file) => (
            <li key={file} className="group flex items-center gap-3 px-3 py-2">
              <span className="shrink-0 text-faint">◎</span>
              <span className="truncate text-[12.5px] text-ink" title={file}>
                {file.split('/').pop()}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-right text-[11px] text-faint"
                title={file}
              >
                {file.replace(/\/[^/]+$/, '')}
              </span>
              <button
                type="button"
                aria-label={`Remove ${file}`}
                className="shrink-0 rounded px-1 text-faint opacity-0 transition-opacity hover:text-red-300 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => onChange(files.filter((current) => current !== file))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2.5">
        <Button onClick={() => void browse()}>Add files…</Button>
        {files.length === 0 ? (
          <span className="text-[11.5px] text-faint">No files attached yet</span>
        ) : null}
      </div>
    </div>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
}): ReactNode {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-[15px] shrink-0 accent-[var(--color-accent)]"
      />
      <span className="flex flex-col gap-1">
        <span className="text-[12.5px] text-ink">{label}</span>
        {hint ? <span className="text-[11px] leading-relaxed text-faint">{hint}</span> : null}
      </span>
    </label>
  )
}

interface EyeDropperResult {
  sRGBHex: string
}

interface EyeDropperLike {
  open: () => Promise<EyeDropperResult>
}

declare global {
  interface Window {
    EyeDropper?: new () => EyeDropperLike
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Saturation across, lightness down — the usual picker field, in the HSL space we already use. */
function ShadeField({
  hue,
  saturation,
  lightness,
  onChange
}: {
  hue: number
  saturation: number
  lightness: number
  onChange: (saturation: number, lightness: number) => void
}): ReactNode {
  const field = useRef<HTMLDivElement>(null)

  function apply(event: { clientX: number; clientY: number }): void {
    const box = field.current?.getBoundingClientRect()
    if (!box) return
    onChange(
      clamp(((event.clientX - box.left) / box.width) * 100, 0, 100),
      clamp(100 - ((event.clientY - box.top) / box.height) * 100, 0, 100)
    )
  }

  return (
    <div
      ref={field}
      role="presentation"
      className="relative h-32 w-full cursor-crosshair overflow-hidden rounded-lg border border-edge-strong"
      style={{
        backgroundImage:
          'linear-gradient(to bottom, #fff 0%, rgba(255,255,255,0) 50%, rgba(0,0,0,0) 50%, #000 100%),' +
          `linear-gradient(to right, hsl(${hue} 0% 50%), hsl(${hue} 100% 50%))`
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        apply(event)
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) apply(event)
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.5)]"
        style={{ left: `${saturation}%`, top: `${100 - lightness}%` }}
      />
    </div>
  )
}

/** The shade field, hue slider and screen sampler, for a value the caller owns. */
function ColorPicker({
  value,
  onChange
}: {
  value: string
  onChange: (hex: string) => void
}): ReactNode {
  const hsl = hexToHsl(value)
  const canSample = typeof window !== 'undefined' && Boolean(window.EyeDropper)

  async function sample(): Promise<void> {
    const Picker = window.EyeDropper
    if (!Picker) return
    try {
      const result = await new Picker().open()
      onChange(result.sRGBHex)
    } catch {
      return
    }
  }

  return (
    <div className="flex w-64 flex-col gap-2.5 rounded-xl border border-edge-strong bg-panel p-3 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.75)]">
      <ShadeField
        hue={hsl.h}
        saturation={hsl.s}
        lightness={hsl.l}
        onChange={(s, l) => onChange(hslToHex({ h: hsl.h, s, l }))}
      />
      <div className="flex items-center gap-2">
        <input
          type="range"
          aria-label="Hue"
          min={0}
          max={359}
          value={Math.round(hsl.h)}
          onChange={(event) => onChange(hslToHex({ ...hsl, h: Number(event.target.value) }))}
          className="h-2.5 flex-1 cursor-pointer appearance-none rounded-full border border-edge-strong [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:bg-transparent"
          style={{
            background:
              'linear-gradient(90deg, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)'
          }}
        />
        {canSample ? (
          <button
            type="button"
            title="Pick a colour from anywhere on screen"
            aria-label="Pick a colour from the screen"
            onClick={() => void sample()}
            className="grid size-7 shrink-0 place-items-center rounded-md border border-edge-strong text-dim hover:text-ink"
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m10.5 2.5 3 3" />
              <path d="M12 4 6.2 9.8 3 13l3.2-.2L12 7" />
              <path d="M9 5.5 10.5 7" />
            </svg>
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Anchors the in-app colour picker under whatever `trigger` renders. Closes on an outside click or
 * Escape — and swallows that Escape, so it does not also close the dialog it sits in.
 */
export function ColorPopover({
  value,
  onChange,
  trigger,
  align = 'start',
  className = ''
}: {
  value: string
  onChange: (hex: string) => void
  trigger: (control: { open: boolean; toggle: () => void }) => ReactNode
  /** Which edge of the trigger the picker lines up with; `end` keeps it inside a right-hand column. */
  align?: 'start' | 'end'
  className?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent): void {
      if (!holder.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  return (
    <div className={`relative ${className}`} ref={holder}>
      {trigger({ open, toggle: () => setOpen((current) => !current) })}
      {open ? (
        <div className={`absolute top-full z-10 mt-1.5 ${align === 'end' ? 'right-0' : 'left-0'}`}>
          <ColorPicker value={value} onChange={onChange} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * An in-app colour picker. Deliberately not `<input type="color">`: that opens the native macOS
 * colour panel, which cannot be dismissed from the page and floats over the app.
 */
export function ColorInput({
  label,
  value,
  onChange
}: {
  label: string
  value: string
  onChange: (hex: string) => void
}): ReactNode {
  return (
    <ColorPopover
      value={value}
      onChange={onChange}
      className="flex items-center gap-2.5"
      trigger={({ open, toggle }) => (
        <>
          <button
            type="button"
            aria-label={`${label} colour`}
            aria-expanded={open}
            onClick={toggle}
            style={{ backgroundColor: value }}
            className="size-7 shrink-0 rounded-md border border-edge-strong transition-transform hover:scale-105"
          />
          <span className="w-28 shrink-0 text-[12.5px] text-ink">{label}</span>
          <span className="w-24 shrink-0">
            <input
              value={value}
              onChange={(event) => onChange(event.target.value)}
              spellCheck={false}
              className={`${inputClass} font-mono text-[11.5px] uppercase`}
            />
          </span>
        </>
      )}
    />
  )
}

/** A colour as a card — swatch, name, hex — that opens the in-app picker. */
export function ColorSwatch({
  label,
  value,
  onChange,
  align
}: {
  label: string
  value: string
  onChange: (hex: string) => void
  align?: 'start' | 'end'
}): ReactNode {
  return (
    <ColorPopover
      value={value}
      onChange={onChange}
      align={align}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-label={`${label} colour`}
          aria-expanded={open}
          onClick={toggle}
          className="flex w-full flex-col gap-1.5 rounded-lg border border-edge bg-chrome p-2 text-left transition-colors hover:border-edge-strong"
        >
          <span
            style={{ backgroundColor: value }}
            className="block h-[22px] rounded-[5px] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
          />
          <span className="text-[11.5px] text-ink">{label}</span>
          <span className="font-mono text-[10px] uppercase text-faint">{value}</span>
        </button>
      )}
    />
  )
}

/** A bordered surface for grouped controls: a list of rows, a provider, a table. */
export function Card({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <div className={`flex flex-col rounded-[10px] border border-edge bg-chrome ${className}`}>
      {children}
    </div>
  )
}

/** One row of a `Card`; every row after the first draws a divider above itself. */
export function CardRow({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): ReactNode {
  return <div className={`border-t border-edge first:border-t-0 ${className}`}>{children}</div>
}

/** The small caps label above a table or group of rows. */
export function Eyebrow({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
      {children}
    </span>
  )
}

/** Quiet explanatory text under a control or card. */
export function Hint({ children }: { children: ReactNode }): ReactNode {
  return <span className="text-[11.5px] leading-[1.5] text-faint text-pretty">{children}</span>
}

/** An on/off switch. Always give it a label, even when the visible one lives beside it. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  title
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
  title?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative block h-4 w-7 shrink-0 rounded-full transition-colors duration-150 disabled:opacity-50 ${
        checked ? 'bg-accent' : 'bg-edge-strong'
      }`}
    >
      <span
        className={`absolute top-0.5 size-3 rounded-full bg-ink transition-[left] duration-150 ${
          checked ? 'left-3.5' : 'left-0.5'
        }`}
      />
    </button>
  )
}

/** A label and hint on the left, a switch on the right. The whole row toggles. */
export function SwitchRow({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
}): ReactNode {
  return (
    <div
      role="presentation"
      onClick={() => onChange(!checked)}
      className="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3"
    >
      <span className="flex flex-col gap-[3px]">
        <span className="text-[12.5px] text-ink">{label}</span>
        {hint ? <Hint>{hint}</Hint> : null}
      </span>
      {/* stopPropagation: the row's own click would toggle a second time. */}
      <span role="presentation" onClick={(event) => event.stopPropagation()}>
        <Switch checked={checked} onChange={onChange} label={label} />
      </span>
    </div>
  )
}

/** A minus / value / plus control for small bounded integers. */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  className = ''
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  label: string
  className?: string
}): ReactNode {
  const step = 'grid size-7 place-items-center text-dim hover:text-ink disabled:opacity-40'
  const glyph = {
    viewBox: '0 0 16 16',
    width: 12,
    height: 12,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const
  }
  return (
    <span
      role="group"
      aria-label={label}
      className={`flex h-7 items-center rounded-[7px] border border-edge-strong bg-panel ${className}`}
    >
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        className={step}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <svg aria-hidden {...glyph}>
          <path d="M3.5 8h9" />
        </svg>
      </button>
      <span className="flex-1 text-center font-mono text-[12px] text-ink">{value}</span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        className={step}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <svg aria-hidden {...glyph}>
          <path d="M8 3.5v9M3.5 8h9" />
        </svg>
      </button>
    </span>
  )
}

/** A short row of mutually exclusive options. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  label: string
}): ReactNode {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-0.5 self-start rounded-lg border border-edge-strong bg-panel p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={`h-6 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
            option.value === value ? 'bg-raised text-ink' : 'text-dim hover:text-ink'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
