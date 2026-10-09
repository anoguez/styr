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

interface Look {
  palette: RunPalette
  /** One terminal row, in pixels. */
  lineHeight: number
}

/**
 * The Warp-style view of a native session: each command a block (the shell's own prompt with the
 * command as typed, then its output), the running command live below them, and Styr's own input
 * under the current prompt. Finished blocks are logical lines the page wraps and scrolls natively;
 * every character is React text, never markup. A full-screen program is drawn by the grid instead
 * (`NativeTerminalView`), so this view never sees the alternate screen.
 */
export function TerminalBlockList({
  state,
  look,
  font,
  inputRef,
  hint,
  canRetry,
  actions,
  onSubmit,
  onClearBlocks
}: {
  state: BlockListState
  look: Look
  font: CSSProperties
  inputRef: RefObject<HTMLTextAreaElement | null>
  /** Shown in the empty input, e.g. the Ask agent and change directory keys. */
  hint: string
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
  const cols = screen?.cols ?? 80
  const running = active.kind === 'running'

  return (
    <div
      ref={scroller}
      className="h-full w-full overflow-y-auto overscroll-contain px-2 py-2"
      style={font}
      onScroll={(event) => {
        const element = event.currentTarget
        pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 4
      }}
    >
      <div className="flex min-h-full flex-col justify-end gap-1.5">
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
            prompt={active.prompt}
            rows={[...state.history, ...liveRows(state.screen)]}
            cols={cols}
            look={look}
            actions={actions}
          />
        ) : (
          <PromptInput
            key={active.id}
            prompt={liveRows(state.screen)}
            cols={cols}
            look={look}
            inputRef={inputRef}
            history={commandHistory(state)}
            bracketed={screen?.modes.bracketedPaste ?? false}
            hint={hint}
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

  return (
    <section
      tabIndex={-1}
      aria-label={`${block.command}${failed ? `, failed, exit ${block.exitCode}` : ', completed'}`}
      className={`group relative rounded-md border-l-2 py-[3px] pr-2 pl-2 hover:bg-raised/30 focus-within:bg-raised/30 ${
        failed ? 'border-danger' : 'border-transparent hover:border-edge-strong'
      }`}
      style={{ contentVisibility: 'auto' }}
    >
      <div className="relative">
        <Lines rows={block.prompt} cols={block.cols} look={look} />
        <div
          className="absolute top-0 right-0 flex items-center gap-1.5 rounded bg-chrome/90 pl-1"
          style={{ height: look.lineHeight }}
        >
          {actions ? (
            <div
              className={`flex items-center gap-0.5 transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${
                menuOpen ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <button
                type="button"
                title="Copy output"
                className={`${quiet} h-5`}
                onClick={() => actions.copyOutput(action)}
              >
                Copy
              </button>
              <button
                type="button"
                title="Run again"
                disabled={!canRetry || !block.command}
                className={`${quiet} h-5`}
                onClick={() => actions.retry(action)}
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
              </div>
            </div>
          ) : null}
          <BlockStatus block={action} />
        </div>
      </div>
      <Lines rows={block.output} cols={block.cols} look={look} />
      {block.truncated ? (
        <div className="text-faint font-sans text-[11px]">Earlier output was trimmed.</div>
      ) : null}
      {failed && actions ? (
        <div className="mt-1.5 mb-[3px] flex flex-wrap items-center gap-1 font-sans">
          <button
            type="button"
            className="border-accent/40 bg-accent/15 text-accent-ink hover:bg-accent/30 inline-flex h-[22px] items-center rounded-md border px-2 text-[11.5px] font-medium"
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
        </div>
      ) : null}
    </section>
  )
})

function RunningBlock({
  command,
  startedAt,
  prompt,
  rows,
  cols,
  look,
  actions
}: {
  command: string
  startedAt: number
  prompt: EngineFrameLine[]
  rows: EngineFrameLine[]
  cols: number
  look: Look
  actions?: BlockActions
}): ReactNode {
  const block = {
    id: 'running',
    command,
    startedAt,
    startLine: 0,
    endLine: 0,
    open: true
  }
  return (
    <section
      aria-label={`${command}, running`}
      aria-live="off"
      className="border-col-progress relative rounded-md border-l-2 py-[3px] pr-2 pl-2"
    >
      <div className="relative">
        <Lines rows={prompt} cols={cols} look={look} />
        <div
          className="bg-chrome/90 absolute top-0 right-0 flex items-center gap-1.5 rounded pl-1"
          style={{ height: look.lineHeight }}
        >
          {actions ? (
            <button
              type="button"
              className={`${quiet} border-edge-strong h-5 border`}
              onClick={actions.interrupt}
            >
              <svg aria-hidden viewBox="0 0 16 16" width="10" height="10">
                <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
              </svg>
              Interrupt
              <span className="text-faint font-mono text-[10px]">
                {formatAccelerator('ctrl+c')}
              </span>
            </button>
          ) : null}
          <BlockStatus block={block} />
        </div>
      </div>
      <Lines rows={rows} cols={cols} look={look} />
    </section>
  )
}

function PromptInput({
  prompt,
  cols,
  look,
  inputRef,
  history,
  bracketed,
  hint,
  onSubmit,
  onClearBlocks
}: {
  prompt: EngineFrameLine[]
  cols: number
  look: Look
  inputRef: RefObject<HTMLTextAreaElement | null>
  history: string[]
  bracketed: boolean
  hint: string
  onSubmit: (data: string) => void
  onClearBlocks: () => void
}): ReactNode {
  const [text, setText] = useState('')
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
    <section
      aria-label="Prompt"
      className="rounded-md border-l-2 border-transparent py-[3px] pr-2 pl-2"
    >
      <Lines rows={prompt} cols={cols} look={look} />
      <textarea
        ref={inputRef}
        value={text}
        rows={Math.max(1, text.split('\n').length)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Command"
        placeholder={hint}
        className="text-ink placeholder:text-faint block w-full resize-none border-0 bg-transparent p-0 outline-none"
        style={{ font: 'inherit', lineHeight: `${look.lineHeight}px` }}
        onChange={(event) => {
          setText(event.target.value)
          if (cursor.current.index !== null) cursor.current = { ...cursor.current, index: null }
        }}
        onKeyDown={onKeyDown}
      />
    </section>
  )
}
