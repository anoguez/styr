import type { ReactNode } from 'react'
import type { DiffFile, PatchResult } from '@core/diff.js'
import type { DiffRow } from '@core/diffView.js'
import { Glyph, PaneMessage, Spinner } from './changesParts.js'

const ROW_STYLE = {
  ctx: {
    bg: 'transparent',
    gutter: 'var(--color-chrome)',
    mark: '',
    markColor: 'var(--color-faint)'
  },
  add: {
    bg: 'var(--color-diff-add)',
    gutter: 'var(--color-diff-add-gutter)',
    mark: '+',
    markColor: 'var(--color-col-done-text)'
  },
  del: {
    bg: 'var(--color-diff-del)',
    gutter: 'var(--color-diff-del-gutter)',
    mark: '−',
    markColor: 'var(--color-danger)'
  }
} as const

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** What the right-hand pane shows for the selected file. Header and toolbar live in the dialog. */
export function DiffPane({
  file,
  patch,
  rows,
  wrap,
  stale,
  onFold,
  onRefresh
}: {
  file: DiffFile
  /** Undefined while the patch is loading. */
  patch: PatchResult | undefined
  rows: DiffRow[]
  wrap: boolean
  stale: boolean
  onFold: () => void
  onRefresh: () => void
}): ReactNode {
  if (!patch) return <Spinner label="Loading patch…" />
  if ('error' in patch) {
    return (
      <PaneMessage
        glyph="!"
        tone="danger"
        title="Couldn’t read this file’s patch"
        body={patch.error}
      />
    )
  }
  if ('placeholder' in patch) {
    switch (patch.placeholder) {
      case 'binary':
        return (
          <PaneMessage
            title="Binary file not shown"
            body={`Binary files have no line diff.${patch.bytes === undefined ? '' : ` ${formatBytes(patch.bytes)}.`}`}
          />
        )
      case 'too-large':
        return (
          <PaneMessage
            title={`Diff too large to display${patch.bytes === undefined ? '' : ` (${formatBytes(patch.bytes)})`}`}
            body={`+${file.additions} −${file.deletions} by line count. Open the file in your editor to review it.`}
          />
        )
      case 'submodule':
        return (
          <div
            className="m-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-edge bg-panel px-3.5 py-2.5 text-[12px] leading-5"
            style={{ fontFamily: 'var(--font-terminal)' }}
          >
            <span className="text-faint">Submodule</span>
            <span className="text-ink">{file.path}</span>
            {patch.from && patch.to ? (
              <>
                <span className="text-danger">{patch.from}</span>
                <span className="text-faint">→</span>
                <span className="text-[var(--color-col-done-text)]">{patch.to}</span>
              </>
            ) : null}
          </div>
        )
      case 'unchanged':
        return (
          <PaneMessage
            title="File no longer changed"
            body="It is not in the current change list. Refresh to update."
            action="Refresh"
            onAction={onRefresh}
          />
        )
    }
  }
  if (rows.length === 0) {
    return file.status === 'renamed' ? (
      <PaneMessage
        title="Renamed, no content changes"
        body={`${file.oldPath ?? ''} → ${file.path}`}
        mono
      />
    ) : (
      <PaneMessage title="No content changes" body="Only the file’s mode or metadata changed." />
    )
  }
  return (
    <>
      {stale ? (
        <div className="sticky left-0 top-0 z-[3] flex items-center gap-2.5 border-b border-[color-mix(in_oklab,var(--color-col-review)_30%,var(--color-edge))] bg-[color-mix(in_oklab,var(--color-col-review)_9%,var(--color-chrome))] px-3.5 py-[9px]">
          <span className="min-w-0 flex-1 text-[12px] leading-[1.45] text-ink [text-wrap:pretty]">
            <span className="font-semibold text-[var(--color-col-review-text)]">
              No longer changed.
            </span>{' '}
            This file changed on disk after the list loaded. What follows is the last patch Styr
            read.
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[7px] border border-edge-strong bg-raised/70 px-2.5 text-[12px] font-medium text-ink"
          >
            <Glyph name="refresh" size={12} />
            Refresh
          </button>
        </div>
      ) : null}
      <div
        className="min-w-full pb-3 text-[12px] leading-5"
        style={{
          width: wrap ? '100%' : 'max-content',
          fontFamily: 'var(--font-terminal)',
          opacity: stale ? 0.45 : 1
        }}
      >
        {rows.map((row, index) => {
          if (row.kind === 'hunk') {
            return (
              <div key={index} className="flex min-h-5 bg-[var(--color-diff-hunk)]">
                <span
                  aria-hidden
                  className="sticky left-0 z-[1] flex shrink-0 bg-[var(--color-diff-hunk)]"
                >
                  <span className="w-[106px]" />
                </span>
                <span
                  className="flex-1 px-1 pr-5 text-dim"
                  style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}
                >
                  {row.text}
                </span>
              </div>
            )
          }
          if (row.kind === 'fold') {
            return (
              <button
                key={index}
                type="button"
                onClick={onFold}
                className="flex min-h-5 w-full cursor-pointer bg-[color-mix(in_oklab,var(--color-raised)_55%,transparent)] text-left text-dim hover:text-ink"
                style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
              >
                <span
                  aria-hidden
                  className="sticky left-0 z-[1] flex shrink-0 bg-[color-mix(in_oklab,var(--color-raised)_55%,var(--color-chrome))]"
                >
                  <span className="w-[88px]" />
                  <span className="w-[18px] text-center">↕</span>
                </span>
                <span className="px-1 pr-5">Show {row.count} unchanged lines</span>
              </button>
            )
          }
          const style = ROW_STYLE[row.kind]
          const wordBg =
            row.kind === 'add' ? 'var(--color-diff-add-word)' : 'var(--color-diff-del-word)'
          return (
            <div key={index} className="flex min-h-5" style={{ background: style.bg }}>
              <span
                aria-hidden
                className="sticky left-0 z-[1] flex shrink-0 select-none"
                style={{
                  background: style.gutter,
                  color: row.kind === 'ctx' ? 'var(--color-faint)' : 'var(--color-dim)'
                }}
              >
                <span className="w-11 box-border pr-1.5 text-right">{row.oldLine ?? ''}</span>
                <span className="w-11 box-border pr-1.5 text-right">{row.newLine ?? ''}</span>
                <span
                  className="w-[18px] text-center font-medium"
                  style={{ color: style.markColor }}
                >
                  {style.mark}
                </span>
              </span>
              <span
                className="flex-1 px-1 pr-5 text-ink"
                style={{
                  whiteSpace: wrap ? 'pre-wrap' : 'pre',
                  overflowWrap: wrap ? 'anywhere' : 'normal'
                }}
              >
                {row.segments.map((segment, at) => (
                  <span
                    key={at}
                    className="rounded-sm"
                    style={{ background: segment.em ? wordBg : 'transparent' }}
                  >
                    {segment.text || ' '}
                  </span>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
