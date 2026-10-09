import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import type { EngineFrameLine, EngineRun, FinishedCommandBlock } from '@core/types.js'
import { formatAccelerator } from '@core/shortcuts.js'
import {
  commandHistory,
  liveRows,
  logicalLines,
  rowsText,
  type BlockListState
} from '../lib/nativeTerminal/blockList.js'
import {
  inputAction,
  stepHistory,
  submission,
  type HistoryCursor
} from '../lib/nativeTerminal/commandInput.js'
import { runStyle, type RunPalette } from '../lib/nativeTerminal/style.js'
import { ActionsMenu, type MenuItem } from './TerminalMenu.js'
import { BlockStatus, quiet, type ActionBlock, type BlockActions } from './TerminalBlocks.js'

export interface InputHint {
  /** The key, as `shortcutHint` writes it. */
  keys: string
  label: string
}

interface Look {
  palette: RunPalette
  /** One terminal row, in pixels. */
  lineHeight: number
}

/**
 * The Warp-style view of a native session, as the terminal design draws it: each command a block
 * (`❯ command`, its result at the end of the row, its output below), the running command live
 * under them, and Styr's own `❯` input at the bottom — the shell's prompt is never shown. Finished
 * blocks are logical lines the page wraps and scrolls natively;
 * every character is React text, never markup. A full-screen program is drawn by the grid instead
 * (`NativeTerminalView`), so this view never sees the alternate screen.
 */
export function TerminalBlockList({
  state,
  look,
  font,
  inputRef,
  hints,
  canRetry,
  actions,
  onSubmit,
  onClearBlocks
}: {
  state: BlockListState
  look: Look
  font: CSSProperties
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** Shown beside the empty input: the surface's keys, e.g. ⌘L ask agent. */
  hints: InputHint[]
  canRetry: boolean
  actions?: BlockActions
  onSubmit: (data: string) => void
  onClearBlocks: () => void
}): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  // Follow new output while the view is at the bottom; leave it alone once the user scrolls up.
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  })

  const active = state.active
  const screen = state.screen.current
  // Fresh until the session's first command; a cleared list is not a new shell.
  const fresh = useRef(true)
  if (state.finished.length > 0 || active.kind === 'running') fresh.current = false
  const cols = screen?.cols ?? 80
  const running = active.kind === 'running'

  return (
    <div
      ref={scroller}
      className="h-full w-full overflow-y-auto overscroll-contain p-2"
      style={font}
      onScroll={(event) => {
        const element = event.currentTarget
        pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4
      }}
    >
      <div className="flex min-h-full flex-col justify-end gap-1.5 whitespace-normal">
        {state.finished.map((block) => (
          <FinishedBlock
            key={block.id}
            block={block}
            look={look}
            canRetry={canRetry}
            actions={actions}
          />
        ))}
        {running ? (
          <RunningBlock
            command={active.command}
            startedAt={active.startedAt}
            rows={[...state.history, ...liveRows(state.screen)]}
            cols={cols}
            look={look}
            actions={actions}
          />
        ) : (
          <PromptInput
            key={active.id}
            look={look}
            inputRef={inputRef}
            history={commandHistory(state)}
            bracketed={screen?.modes.bracketedPaste ?? false}
            // As the design has it: only a new shell shows the hint, until its first keystroke.
            hints={fresh.current ? hints : []}
            onSubmit={onSubmit}
            onClearBlocks={onClearBlocks}
          />
        )}
      </div>
    </div>
  )
}

/** Rows drawn as logical lines the page wraps; empty lines keep a row's height. */
function Lines({
  rows,
  cols,
  look
}: {
  rows: EngineFrameLine[]
  cols: number
  look: Look
}): ReactNode {
  return logicalLines(rows, cols).map((runs, index) => <Line key={index} runs={runs} look={look} />)
}

function Line({ runs, look }: { runs: EngineRun[]; look: Look }): ReactNode {
  return (
    <div
      className="break-all whitespace-pre-wrap"
      style={{ minHeight: look.lineHeight, lineHeight: `${look.lineHeight}px` }}
    >
      {runs.map((run, index) => (
        <span key={index} style={runStyle(run, look.palette)}>
          {run.text}
        </span>
      ))}
    </div>
  )
}

function asAction(block: FinishedCommandBlock): ActionBlock {
  return {
    id: block.id,
    command: block.command,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    ...(block.exitCode !== undefined ? { exitCode: block.exitCode } : {}),
    startLine: 0,
    endLine: 0,
    open: false,
    readOutput: () => rowsText(block.output, block.cols)
  }
}

/** A block's command row: the design's `❯`, the command, its controls and how it went. */
function CommandRow({
  command,
  tone,
  children
}: {
  command: string
  tone: 'muted' | 'failed' | 'running'
  children: ReactNode
}): ReactNode {
  const prompt =
    tone === 'failed' ? 'text-danger' : tone === 'running' ? 'text-col-progress' : 'text-faint'
  return (
    <div className="flex min-h-[22px] items-center gap-2">
      <span aria-hidden className={prompt}>
        ❯
      </span>
      <span className="text-ink min-w-0 flex-1 truncate">{command}</span>
      {children}
    </div>
  )
}

/** The last line of output with text, which says what a failure was about. */
function failNote(block: FinishedCommandBlock): string {
  const lines = rowsText(block.output, block.cols).split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim()
    if (line) return line
  }
  return ''
}

/** Finished blocks never change, so one only re-renders when its own controls do. */
const FinishedBlock = memo(function FinishedBlock({
  block,
  look,
  canRetry,
  actions
}: {
  block: FinishedCommandBlock
  look: Look
  canRetry: boolean
  actions?: BlockActions
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const failed = block.exitCode !== undefined && block.exitCode !== 0
  const action = asAction(block)
  const groups: MenuItem[][] = actions
    ? [
        [
          { label: 'Copy command', run: () => actions.copyCommand(action) },
          { label: 'Copy output', run: () => actions.copyOutput(action) }
        ],
        [
          ...(failed
            ? [{ label: '✦ Fix with agent', agent: true, run: () => actions.fix(action) }]
            : []),
          { label: '✦ Explain output', agent: true, run: () => actions.explain(action) },
          { label: 'Create task from output', run: () => actions.createTask(action) }
        ]
      ]
    : []
  const note = failed ? failNote(block) : ''

  return (
    <section
      tabIndex={0}
      aria-label={`${block.command}${failed ? `, failed, exit ${block.exitCode}` : ', completed'}`}
      className={`group relative -mx-0.5 shrink-0 rounded-md px-2 py-[3px] outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
        menuOpen ? 'bg-raised/30' : 'hover:bg-raised/30 focus-within:bg-raised/30'
      }`}
      style={{ contentVisibility: 'auto' }}
    >
      <CommandRow command={block.command} tone={failed ? 'failed' : 'muted'}>
        {actions ? (
          <span
            className={`flex items-center gap-0.5 font-sans group-hover:flex group-focus-within:flex ${
              menuOpen ? 'flex' : 'hidden'
            }`}
          >
            <button
              type="button"
              title="Copy output"
              className={`${quiet} h-5`}
              onClick={() => actions.copyOutput(action)}
            >
              <CopyIcon />
              Copy
            </button>
            <button
              type="button"
              title="Run again"
              disabled={!canRetry || !block.command}
              className={`${quiet} h-5`}
              onClick={() => actions.retry(action)}
            >
              <RetryIcon />
              Retry
            </button>
            <span className="relative">
              <button
                type="button"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className={`${quiet} size-5 justify-center px-0`}
                onClick={() => setMenuOpen(!menuOpen)}
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
                  className="top-full right-0 mt-1"
                  onClose={() => setMenuOpen(false)}
                />
              ) : null}
            </span>
          </span>
        ) : null}
        <span className="shrink-0">
          <BlockStatus block={action} />
        </span>
      </CommandRow>
      <div className="pl-[18px]">
        <Lines rows={block.output} cols={block.cols} look={look} />
        {block.truncated ? (
          <div className="text-faint font-sans text-[11px]">Earlier output was trimmed.</div>
        ) : null}
        {failed && actions ? (
          <div className="mt-1.5 mb-[3px] flex flex-wrap items-center gap-1 font-sans">
            <button
              type="button"
              className="border-accent/40 bg-accent/15 text-accent-ink hover:bg-accent/30 focus-visible:outline-accent inline-flex h-[22px] items-center rounded-md border px-2 text-[11.5px] font-medium"
              onClick={() => actions.fix(action)}
            >
              ✦ Fix with agent
            </button>
            <button
              type="button"
              className="border-edge-strong text-dim hover:bg-raised/70 hover:text-ink inline-flex h-[22px] items-center rounded-md border px-2 text-[11.5px] font-medium"
              onClick={() => actions.explain(action)}
            >
              Explain
            </button>
            <button
              type="button"
              className="text-dim hover:bg-raised/70 hover:text-ink inline-flex h-[22px] items-center rounded-md px-2 text-[11.5px] font-medium"
              onClick={() => actions.createTask(action)}
            >
              Create task
            </button>
            {note ? (
              <span className="text-faint ml-1.5 min-w-0 truncate text-[11px]">{note}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
})

function RunningBlock({
  command,
  startedAt,
  rows,
  cols,
  look,
  actions
}: {
  command: string
  startedAt: number
  rows: EngineFrameLine[]
  cols: number
  look: Look
  actions?: BlockActions
}): ReactNode {
  const block = { id: 'running', command, startedAt, startLine: 0, endLine: 0, open: true }
  return (
    <section
      aria-label={`${command}, running`}
      className="relative -mx-0.5 shrink-0 rounded-md px-2 py-[3px]"
    >
      <CommandRow command={command} tone="running">
        {actions ? (
          <button
            type="button"
            className={`${quiet} border-edge-strong h-5 border font-sans`}
            onClick={actions.interrupt}
          >
            <svg aria-hidden viewBox="0 0 16 16" width="10" height="10">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
            </svg>
            Interrupt
            <span className="text-faint font-mono text-[10px]">{formatAccelerator('ctrl+c')}</span>
          </button>
        ) : null}
        <span className="shrink-0">
          <BlockStatus block={block} />
        </span>
      </CommandRow>
      <div className="pl-[18px]">
        <Lines rows={rows} cols={cols} look={look} />
      </div>
    </section>
  )
}

function PromptInput({
  look,
  inputRef,
  history,
  bracketed,
  hints,
  onSubmit,
  onClearBlocks
}: {
  look: Look
  inputRef: RefObject<HTMLTextAreaElement | null>
  history: string[]
  bracketed: boolean
  hints: InputHint[]
  onSubmit: (data: string) => void
  onClearBlocks: () => void
}): ReactNode {
  const [text, setText] = useState('')
  const [typed, setTyped] = useState(false)
  const cursor = useRef<HistoryCursor>({ index: null, draft: '' })

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const element = event.currentTarget
    const action = inputAction(
      { ...event, key: event.key, isComposing: event.nativeEvent.isComposing },
      { text, start: element.selectionStart, end: element.selectionEnd }
    )
    if (action.kind === 'default') return
    event.preventDefault()
    // The surface's own keys (Ask agent, change directory…) must not reach the shell either.
    event.stopPropagation()
    if (action.kind === 'submit') {
      if (!text.trim()) return
      onSubmit(submission(text, bracketed))
      setText('')
      cursor.current = { index: null, draft: '' }
    } else if (action.kind === 'discard') {
      setText('')
      cursor.current = { index: null, draft: '' }
    } else if (action.kind === 'clearBlocks') {
      onClearBlocks()
    } else if (action.kind === 'history') {
      const next = stepHistory(history, cursor.current, text, action.step)
      if (!next) return
      cursor.current = next.cursor
      setText(next.text)
      requestAnimationFrame(() => {
        const end = next.text.length
        inputRef.current?.setSelectionRange(end, end)
      })
    }
  }

  return (
    <section aria-label="Prompt" className="-mx-0.5 shrink-0 px-2 py-[3px]">
      <div className="flex min-h-[22px] items-start gap-2">
        <span aria-hidden className="text-accent" style={{ lineHeight: `${look.lineHeight}px` }}>
          ❯
        </span>
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={inputRef}
            value={text}
            rows={Math.max(1, text.split('\n').length)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Command"
            className="text-ink caret-accent block w-full resize-none border-0 bg-transparent p-0 outline-none focus-visible:outline-none"
            // Inline, because the app's focus ring is an unlayered rule that utilities cannot beat.
            style={{ font: 'inherit', lineHeight: `${look.lineHeight}px`, outline: 'none' }}
            onChange={(event) => {
              setText(event.target.value)
              setTyped(true)
              if (cursor.current.index !== null) cursor.current = { ...cursor.current, index: null }
            }}
            onKeyDown={onKeyDown}
          />
          {!typed && text === '' && hints.length > 0 ? (
            <span
              aria-hidden
              className="text-faint pointer-events-none absolute top-0 right-0 flex items-center gap-2.5 font-sans text-[11.5px]"
              style={{ height: look.lineHeight }}
            >
              {hints.map((hint) => (
                <span key={hint.label}>
                  <span className="font-mono text-[10.5px]">{hint.keys}</span> {hint.label}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function CopyIcon(): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.5 3.5V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h.5" />
    </svg>
  )
}

function RetryIcon(): ReactNode {
  return (
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
      <path d="M12.8 8A4.8 4.8 0 1 1 11.4 4.6" />
      <path d="M12.5 2.5v2.6H9.9" />
    </svg>
  )
}
