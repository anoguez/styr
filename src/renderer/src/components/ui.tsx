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

export const inputClass =
  'w-full rounded-lg border border-edge-strong bg-chrome px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-faint hover:border-faint/60 focus:border-accent focus:ring-1 focus:ring-accent/40'

/**
 * A native select with the chevron drawn by the app. macOS paints its own flush against the right
 * edge; this one sits inset and uses the theme's text colour. The control stays a real `<select>`,
 * so keyboard handling and the native option menu are unchanged.
 */
export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <span className="relative block w-full">
      <select {...props} className={`${inputClass} appearance-none pr-9 ${className ?? ''}`}>
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
  tone?: 'neutral' | 'accent' | 'warn'
  title?: string
}): ReactNode {
  const tones = {
    neutral: 'bg-raised text-dim',
    accent: 'bg-accent/12 text-[var(--color-accent-text)]',
    warn: 'bg-[var(--color-col-review)]/15 text-[var(--color-col-review-text)]'
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

export function Modal({
  title,
  subtitle,
  onClose,
  onSubmit,
  children,
  footer,
  wide = false,
  flush = false
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
      onMouseDown={onClose}
    >
      <div
        className={`flex max-h-[88vh] w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} flex-col overflow-hidden rounded-2xl border border-edge-strong bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-edge px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
            {subtitle ? <p className="mt-0.5 text-[12px] text-faint">{subtitle}</p> : null}
          </div>
          <Button variant="subtle" className="shrink-0 px-2" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        {flush ? (
          <div className="flex min-h-0 flex-1">{children}</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        )}
        {footer ? (
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
    <div className="flex gap-2">
      <input
        className={inputClass}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <Button className="shrink-0" onClick={() => void browse()}>
        Browse
      </Button>
    </div>
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
  const [open, setOpen] = useState(false)
  const holder = useRef<HTMLDivElement>(null)
  const hsl = hexToHsl(value)
  const canSample = typeof window !== 'undefined' && Boolean(window.EyeDropper)

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
    <div className="relative flex items-center gap-2.5" ref={holder}>
      <button
        type="button"
        aria-label={`${label} colour`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
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

      {open ? (
        <div className="absolute left-0 top-9 z-10 flex w-64 flex-col gap-2.5 rounded-xl border border-edge-strong bg-panel p-3 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.75)]">
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
      ) : null}
    </div>
  )
}
