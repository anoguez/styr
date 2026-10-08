import { useEffect, useState, type ReactNode } from 'react'
import type { BlockLayout, TrackedBlock } from '../lib/blockTracker.js'
import { ActionsMenu, type MenuItem } from './TerminalMenu.js'
import { formatAccelerator } from '@core/shortcuts.js'

export interface BlockActions {
  copyOutput: (block: TrackedBlock) => void
  copyCommand: (block: TrackedBlock) => void
  retry: (block: TrackedBlock) => void
  fix: (block: TrackedBlock) => void
  explain: (block: TrackedBlock) => void
  createTask: (block: TrackedBlock) => void
  interrupt: () => void
}

const quiet =
  'inline-flex items-center gap-1 rounded-[5px] px-1.5 text-[11px] font-medium text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40'

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function useElapsed(startedAt: number, running: boolean): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [running])
  return (Math.max(0, now - startedAt) / 1000).toFixed(1)
}

/** What a block says about itself on its command row: how it is going, then how it went. */
function BlockStatus({ block }: { block: TrackedBlock }): ReactNode {
  const elapsed = useElapsed(block.startedAt, block.open)
  if (block.open) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-col-progress">
        <span aria-hidden className="size-1.5 rounded-full bg-current wd-pulse" />
        running · {elapsed}s
      </span>
    )
  }
  const failed = block.exitCode !== undefined && block.exitCode !== 0
  const took = block.endedAt === undefined ? '' : formatDuration(block.endedAt - block.startedAt)
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] ${failed ? 'text-danger' : 'text-faint'}`}
    >
      {failed ? <span>exit {block.exitCode} ·</span> : null}
      {took ? <span>{took}</span> : null}
    </span>
  )
}

function Block({
  block,
  layout,
  hovered,
  menuOpen,
  canRetry,
  actions,
  onEnter,
  onLeave,
  onMenu
}: {
  block: TrackedBlock
  layout: BlockLayout
  hovered: boolean
  menuOpen: boolean
  canRetry: boolean
  actions: BlockActions
  onEnter: () => void
  onLeave: () => void
  onMenu: (open: boolean) => void
}): ReactNode {
  const failed = !block.open && block.exitCode !== undefined && block.exitCode !== 0
  const rowTop = layout.top + (block.startLine - layout.viewportY) * layout.cellHeight
  const height = (block.endLine - block.startLine) * layout.cellHeight
  const shown = hovered || menuOpen

  const groups: MenuItem[][] = [
    [
      { label: 'Copy command', run: () => actions.copyCommand(block) },
      { label: 'Copy output', run: () => actions.copyOutput(block) }
    ],
    [
      ...(failed
        ? [{ label: '✦ Fix with agent', agent: true, run: () => actions.fix(block) }]
        : []),
      { label: '✦ Explain output', agent: true, run: () => actions.explain(block) },
      { label: 'Create task from output', run: () => actions.createTask(block) }
    ]
  ]

  return (
    <div
      className="pointer-events-none absolute inset-x-0"
      style={{ top: rowTop, height }}
      data-block={block.id}
    >
      <div
        aria-hidden
        className={`absolute inset-0 transition-colors ${shown ? 'bg-raised/30' : ''}`}
      />
      <div
        aria-hidden
        className={`absolute inset-y-0 left-0 w-0.5 ${
          failed
            ? 'bg-danger'
            : block.open
              ? 'bg-col-progress'
              : shown
                ? 'bg-edge-strong'
                : 'bg-transparent'
        }`}
      />
      <div
        role="group"
        aria-label={`${block.command}${failed ? `, failed, exit ${block.exitCode}` : block.open ? ', running' : ', completed'}`}
        className="pointer-events-auto absolute right-2 top-0 flex items-center gap-1.5 rounded bg-chrome/90 px-1"
        style={{ height: layout.cellHeight }}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        <div
          className={`flex items-center gap-0.5 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 ${
            shown && !block.open
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0'
          }`}
        >
          <button
            type="button"
            title="Copy output"
            className={`${quiet} h-5`}
            onClick={() => actions.copyOutput(block)}
          >
            Copy
          </button>
          <button
            type="button"
            title="Run again"
            disabled={!canRetry}
            className={`${quiet} h-5`}
            onClick={() => actions.retry(block)}
          >
            Retry
          </button>
          <div className="relative">
            <button
              type="button"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={`${quiet} size-5 justify-center px-0`}
              onClick={() => onMenu(!menuOpen)}
            >
              <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
                <circle cx="3.75" cy="8" r="1.15" />
                <circle cx="8" cy="8" r="1.15" />
                <circle cx="12.25" cy="8" r="1.15" />
              </svg>
            </button>
            {menuOpen ? (
              <ActionsMenu
                groups={groups}
                className="right-0 top-full mt-1"
                onClose={() => onMenu(false)}
              />
            ) : null}
          </div>
        </div>
        {block.open ? (
          <button
            type="button"
            className={`${quiet} pointer-events-auto h-5 border border-edge-strong`}
            onClick={actions.interrupt}
          >
            <svg aria-hidden viewBox="0 0 16 16" width="10" height="10">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
            </svg>
            Interrupt
            <span className="font-mono text-[10px] text-faint">{formatAccelerator('ctrl+c')}</span>
          </button>
        ) : null}
        <BlockStatus block={block} />
      </div>
    </div>
  )
}

/**
 * Draws the commands of a shell over xterm: a tint and an edge on each command's rows, and on its
 * own row the controls and result. xterm still draws every character; this layer only sits on top
 * of it, takes no pointer events except on its buttons, and is positioned from the buffer lines the
 * tracker reports, so selection, scrollback and TUIs behave exactly as before.
 */
export function TerminalBlocks({
  layout,
  hoveredId,
  menuId,
  canRetry,
  actions,
  onHover,
  onMenu
}: {
  layout: BlockLayout
  hoveredId: string | null
  menuId: string | null
  canRetry: boolean
  actions: BlockActions
  /** The pointer entered (id) or left (null) a block's own controls. */
  onHover: (id: string | null) => void
  onMenu: (id: string | null) => void
}): ReactNode {
  if (layout.alternate || layout.cellHeight <= 0) return null
  const bottom = layout.top + layout.rows * layout.cellHeight
  const visible = layout.blocks.filter((block) => {
    const top = layout.top + (block.startLine - layout.viewportY) * layout.cellHeight
    return top + layout.cellHeight > layout.top && top < bottom
  })
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {visible.map((block) => (
        <Block
          key={block.id}
          block={block}
          layout={layout}
          hovered={hoveredId === block.id}
          menuOpen={menuId === block.id}
          canRetry={canRetry}
          actions={actions}
          onEnter={() => onHover(block.id)}
          onLeave={() => onHover(null)}
          onMenu={(open) => onMenu(open ? block.id : null)}
        />
      ))}
    </div>
  )
}
