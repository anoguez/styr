import type { ReactNode } from 'react'

const GLYPHS = {
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.5V5h-2.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.8" />
      <circle cx="4.5" cy="12.5" r="1.8" />
      <circle cx="11.5" cy="3.5" r="1.8" />
      <path d="M4.5 5.3v5.4M11.5 5.3c0 3-2.8 3.4-5.2 4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3.25 3.25" />
    </>
  ),
  file: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M9 2.5v3h3" />
    </>
  ),
  chevron: <path d="M4 6l4 4 4-4" />,
  up: <path d="M4 10l4-4 4 4" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </>
  ),
  wrap: (
    <>
      <path d="M2.5 4h11" />
      <path d="M2.5 8h9a2 2 0 0 1 0 4H8" />
      <path d="M9.5 10.5 8 12l1.5 1.5" />
      <path d="M2.5 12h3" />
    </>
  ),
  diff: (
    <>
      <path d="M4 2.5h5l3 3v8H4z" />
      <path d="M6.25 7h3.5M8 5.25v3.5M6.25 11h3.5" />
    </>
  )
}

export type GlyphName = keyof typeof GLYPHS

export function Glyph({ name, size = 13 }: { name: GlyphName; size?: number }): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPHS[name]}
    </svg>
  )
}

export function Spinner({ label }: { label: string }): ReactNode {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2.5">
      <svg
        aria-hidden
        width="20"
        height="20"
        viewBox="0 0 20 20"
        className="animate-spin text-dim motion-reduce:[animation-duration:3s]"
      >
        <circle
          cx="10"
          cy="10"
          r="7.5"
          fill="none"
          stroke="var(--color-edge-strong)"
          strokeWidth="2"
        />
        <path
          d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-[11.5px] text-faint">{label}</span>
    </div>
  )
}

/** Centred icon, title and body, for placeholders in the diff pane and whole-dialog states. */
export function PaneMessage({
  title,
  body,
  glyph,
  tone = 'faint',
  detail,
  mono = false,
  action,
  onAction
}: {
  title: string
  body: string
  glyph?: string
  tone?: 'faint' | 'done' | 'danger'
  detail?: string
  mono?: boolean
  action?: string
  onAction?: () => void
}): ReactNode {
  const colour =
    tone === 'danger'
      ? 'text-danger'
      : tone === 'done'
        ? 'text-[var(--color-col-done-text)]'
        : 'text-faint'
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex max-w-[440px] flex-col items-center gap-2.5 text-center">
        <span
          className={`grid size-[34px] place-items-center rounded-[9px] border border-edge bg-panel text-[15px] font-semibold ${colour}`}
        >
          {glyph ?? <Glyph name="file" size={16} />}
        </span>
        <h3
          className={`mt-1 text-[13px] font-semibold ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}
        >
          {title}
        </h3>
        <p
          className="m-0 text-[12px] leading-[1.55] text-dim [text-wrap:pretty]"
          style={mono ? { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace' } : undefined}
        >
          {body}
        </p>
        {detail ? (
          <pre
            className="mt-1 max-w-full overflow-x-auto rounded-lg border border-[color-mix(in_oklab,var(--color-danger)_30%,var(--color-edge))] bg-[color-mix(in_oklab,var(--color-danger)_7%,var(--color-chrome))] px-3 py-2.5 text-left text-[11.5px] leading-[1.6] text-danger"
            style={{ fontFamily: 'var(--font-terminal)' }}
          >
            {detail}
          </pre>
        ) : null}
        {action ? (
          <button
            type="button"
            onClick={onAction}
            className="mt-1.5 inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge-strong bg-raised/70 px-3 text-[12px] font-medium text-dim hover:bg-raised hover:text-ink"
          >
            <Glyph name="refresh" />
            {action}
          </button>
        ) : null}
      </div>
    </div>
  )
}
