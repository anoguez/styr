import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import type {
  AgentMessageBlock,
  AgentToolCallBlock,
  DiffBlock,
  StyrBlock
} from '@core/types/blocks.js'
import { CommandInput, type Look } from './TerminalBlockList.js'
import type { AgentCommand, ApprovalOption } from '@core/agentConversation.js'
import { quiet } from './TerminalBlocks.js'
import { editRows } from '@core/diffView.js'

/** Rows of a diff shown before "Show all". */
const DIFF_PREVIEW = 16

type Patch = Pick<DiffBlock['payload'], 'patch' | 'additions' | 'deletions'>

/** What the agent waits on the person for, as the view shows it. */
export interface ApprovalRequest {
  /** What the agent asks, in a line. */
  prompt: string
  /** The tool it wants to run and what that works on (a command, a file), when known. */
  tool?: string
  summary?: string
  /** An edit's change, when the request is one. */
  edit?: Patch
  /** The answers, in the CLI's order. */
  options: readonly ApprovalOption[]
  /**
   * Answered by keys in the CLI's TUI (Enter, Escape) rather than through its own channel: the
   * dialog's default option, so the keys are shown on the buttons.
   */
  keys: boolean
}

/**
 * An agent CLI's session drawn by Styr, in place of its TUI: the person's prompts, the agent's
 * messages (the reply as it streams in), each tool call with how it went and an edit's diff, an
 * approval with the CLI's own options when the agent waits on the person, and Styr's `❯` input.
 * Provider-neutral: it draws blocks (`agentConversation.ts`) and names the agent by `label`; what it
 * sends goes through the agent's own channel or to the CLI's PTY as if typed, so the CLI itself
 * still decides everything. Every character is React text.
 */
export function AgentBlockList({
  blocks,
  working,
  label,
  approval,
  look,
  font,
  inputRef,
  history,
  commands,
  attachedImages = 0,
  onSubmit,
  onInterrupt,
  onAnswer,
  onPasteImage,
  onShowTui
}: {
  blocks: StyrBlock[]
  working: boolean
  /** The agent CLI's name, e.g. "Claude Code". */
  label: string
  /** The agent waits on the person (a permission, a question). */
  approval: ApprovalRequest | null
  look: Look
  font: CSSProperties
  inputRef: RefObject<HTMLTextAreaElement | null>
  history: string[]
  /** The CLI's slash commands, for the input's menu. */
  commands?: AgentCommand[]
  /** Images pasted into the CLI's own input, which go with the next prompt. */
  attachedImages?: number
  /** A prompt (or `/command`) as typed. */
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onAnswer: (option: ApprovalOption) => void
  /** An image was pasted into the input; absent when the CLI cannot take one. */
  onPasteImage?: () => void
  /** Shows the CLI's own interface instead (for its menus and dialogs). */
  onShowTui: () => void
}): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  })
  const diffs = new Map(
    blocks.filter((block): block is DiffBlock => block.kind === 'diff').map((d) => [d.parentId, d])
  )

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
        {blocks.map((block) =>
          block.kind === 'agent-message' ? (
            <Message key={block.id} block={block} label={label} look={look} />
          ) : block.kind === 'agent-tool-call' ? (
            <ToolCall key={block.id} block={block} diff={diffs.get(block.id)} look={look} />
          ) : null
        )}
        {approval ? (
          <Approval
            request={approval}
            label={label}
            look={look}
            onAnswer={onAnswer}
            onShowTui={onShowTui}
          />
        ) : working ? (
          <Working label={label} onInterrupt={onInterrupt} />
        ) : null}
        {attachedImages > 0 ? (
          <div className="text-faint -mx-0.5 shrink-0 px-2 font-sans text-[11.5px]">
            {attachedImages === 1 ? 'An image' : `${attachedImages} images`} in {label}&apos;s
            input, sent with your next prompt
          </div>
        ) : null}
        <CommandInput
          look={look}
          inputRef={inputRef}
          history={history}
          commands={commands}
          hints={[]}
          label={`Message ${label}`}
          onSubmit={onSubmit}
          onPasteImage={onPasteImage}
          onEscape={working ? onInterrupt : undefined}
          trailing={
            <button
              type="button"
              title={`Show ${label}'s own interface`}
              className={`${quiet} h-5 shrink-0 font-sans`}
              onClick={onShowTui}
            >
              {label} view
            </button>
          }
        />
      </div>
    </div>
  )
}

/** Lines of a message shown before "Show more". */
const MESSAGE_PREVIEW = 8

function Message({
  block,
  label,
  look
}: {
  block: AgentMessageBlock
  label: string
  look: Look
}): ReactNode {
  const [open, setOpen] = useState(false)
  const user = block.payload.role === 'user'
  // A reply streaming in shows whole, as it grows; it folds once the agent has recorded it.
  const streaming = block.state === 'streaming'
  const lines = block.payload.text.split('\n')
  const long = !streaming && lines.length > MESSAGE_PREVIEW
  const text = long && !open ? lines.slice(0, MESSAGE_PREVIEW).join('\n') : block.payload.text
  return (
    <section
      aria-label={user ? 'Your message' : `${label}'s message${streaming ? ', arriving' : ''}`}
      aria-busy={streaming || undefined}
      className="-mx-0.5 flex shrink-0 gap-2 px-2 py-[3px]"
      style={{ lineHeight: `${look.lineHeight}px` }}
    >
      <span aria-hidden className={user ? 'text-accent' : 'text-accent-ink'}>
        {user ? '❯' : '✦'}
      </span>
      <div
        className={`min-w-0 flex-1 break-words whitespace-pre-wrap ${user ? 'text-ink' : 'text-ink/90'}`}
      >
        {text}
        {streaming ? (
          <span aria-hidden className="text-accent-ink wd-pulse">
            {' ▍'}
          </span>
        ) : null}
        {long ? (
          <button
            type="button"
            className={`${quiet} mt-0.5 h-5 font-sans`}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Show less' : `Show ${lines.length - MESSAGE_PREVIEW} more lines`}
          </button>
        ) : null}
      </div>
    </section>
  )
}

/** Lines of a call's summary (a long command) shown before "more". */
const SUMMARY_PREVIEW = 3
/** Lines of a call's output shown under it before "+N lines". */
const OUTPUT_PREVIEW = 4

const wrapped: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

/**
 * A tool call as Claude Code's own view draws it: `⏺ Tool what it works on`, wrapped rather than
 * cut, then `⎿` and how it went — the first lines of its output, an edit's diff.
 */
function ToolCall({
  block,
  diff,
  look
}: {
  block: AgentToolCallBlock
  diff?: DiffBlock
  look: Look
}): ReactNode {
  const [open, setOpen] = useState(false)
  const { tool, summary, result, output } = block.payload
  const failed = block.state === 'failed'
  const tone = failed
    ? 'text-danger'
    : block.state === 'streaming'
      ? 'text-col-progress wd-pulse'
      : block.state === 'cancelled'
        ? 'text-faint'
        : 'text-col-done'
  const summaryLines = summary.split('\n')
  const longSummary = summaryLines.length > SUMMARY_PREVIEW || summary.length > 360
  const shownSummary =
    longSummary && !open
      ? `${summaryLines.slice(0, SUMMARY_PREVIEW).join('\n').slice(0, 360)} …`
      : summary
  const outcome =
    block.state === 'streaming'
      ? 'running…'
      : block.state === 'cancelled'
        ? 'interrupted'
        : // An edit's diff says how it went; its "updated" line adds nothing.
          diff && !failed
          ? undefined
          : result
  return (
    <section
      aria-label={`${tool} ${summaryLines[0] ?? ''}, ${block.state === 'streaming' ? 'running' : block.state}`}
      className="-mx-0.5 shrink-0 px-2 py-[3px]"
      style={{ lineHeight: `${look.lineHeight}px` }}
    >
      <div className="flex gap-2">
        <span aria-hidden className={tone}>
          ⏺
        </span>
        <div className="min-w-0 flex-1" style={wrapped}>
          <span className="text-ink font-medium">{tool}</span>
          {summary ? <span className="text-dim"> {shownSummary}</span> : null}
          {longSummary ? (
            <button
              type="button"
              className={`${quiet} ml-1 h-5 align-middle font-sans`}
              onClick={() => setOpen(!open)}
            >
              {open ? 'less' : 'more'}
            </button>
          ) : null}
        </div>
      </div>
      {output && block.state !== 'streaming' ? (
        <Output text={output} failed={failed} />
      ) : outcome ? (
        <Elbow>
          <span
            className={`${failed ? 'text-danger' : 'text-faint'} ${block.state === 'streaming' ? 'wd-pulse' : ''}`}
            style={wrapped}
          >
            {outcome}
          </span>
        </Elbow>
      ) : null}
      {diff ? (
        <div className="ml-[18px]">
          <Diff patch={diff.payload} look={look} />
        </div>
      ) : null}
    </section>
  )
}

/** The `⎿` that hangs what a call returned under it. */
function Elbow({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-2 pl-[18px]">
      <span aria-hidden className="text-faint shrink-0">
        ⎿
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Output({ text, failed }: { text: string; failed: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n')
  const hidden = lines.length - OUTPUT_PREVIEW
  // Hiding a single line saves nothing over its "+1 line" button.
  const long = hidden > 1
  return (
    <Elbow>
      <div className={failed ? 'text-danger' : 'text-dim'} style={wrapped}>
        {long && !open ? lines.slice(0, OUTPUT_PREVIEW).join('\n') : text}
      </div>
      {long ? (
        <button
          type="button"
          className={`${quiet} -ml-1.5 h-5 font-sans`}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : `+${hidden} lines`}
        </button>
      ) : null}
    </Elbow>
  )
}

/** How each kind of diff row is tinted and marked. */
const ROW_STYLE = {
  ctx: { bg: 'transparent', gutter: 'transparent', mark: ' ', color: 'text-faint' },
  add: {
    bg: 'var(--color-diff-add)',
    gutter: 'var(--color-diff-add-gutter)',
    mark: '+',
    color: 'text-col-done'
  },
  del: {
    bg: 'var(--color-diff-del)',
    gutter: 'var(--color-diff-del-gutter)',
    mark: '−',
    color: 'text-danger'
  }
} as const

/** An edit's change: each line wrapped under its `+`/`−`, the words that changed highlighted. */
function Diff({ patch: change, look }: { patch: Patch; look: Look }): ReactNode {
  const [open, setOpen] = useState(false)
  const { patch, additions, deletions } = change
  const rows = useMemo(() => editRows(patch), [patch])
  const shown = open ? rows : rows.slice(0, DIFF_PREVIEW)
  return (
    <div className="mt-1 overflow-hidden rounded-md border border-edge">
      <div className="flex items-center justify-end gap-2 border-b border-edge px-2 font-mono text-[10.5px]">
        <span className="text-col-done">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
      </div>
      <div style={{ lineHeight: `${look.lineHeight}px` }}>
        {shown.map((row, index) => {
          if (row.kind === 'hunk' || row.kind === 'fold') {
            return (
              <div key={index} className="text-faint flex">
                <span aria-hidden className="w-5 shrink-0 text-center">
                  ⋯
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {row.kind === 'hunk' ? row.text : ''}
                </span>
              </div>
            )
          }
          const style = ROW_STYLE[row.kind]
          const wordBg =
            row.kind === 'add' ? 'var(--color-diff-add-word)' : 'var(--color-diff-del-word)'
          return (
            <div key={index} className="flex" style={{ background: style.bg }}>
              <span
                aria-hidden
                className={`w-5 shrink-0 text-center select-none ${style.color}`}
                style={{ background: style.gutter }}
              >
                {style.mark}
              </span>
              <span
                className={`min-w-0 flex-1 pr-2 pl-1.5 ${row.kind === 'ctx' ? 'text-dim' : 'text-ink'}`}
                style={wrapped}
              >
                {row.segments.every((segment) => segment.text === '')
                  ? // A blank line keeps its row.
                    ' '
                  : row.segments.map((segment, at) => (
                      <span
                        key={at}
                        className="rounded-sm"
                        style={segment.em ? { background: wordBg } : undefined}
                      >
                        {segment.text}
                      </span>
                    ))}
              </span>
            </div>
          )
        })}
      </div>
      {rows.length > DIFF_PREVIEW ? (
        <button
          type="button"
          className={`${quiet} h-6 w-full justify-center rounded-none font-sans`}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : `Show all ${rows.length} lines`}
        </button>
      ) : null}
    </div>
  )
}

function useElapsed(running: boolean): string {
  const [since, setSince] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const start = Date.now()
    setSince(start)
    setNow(start)
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [running])
  return (Math.max(0, now - since) / 1000).toFixed(1)
}

function Working({ label, onInterrupt }: { label: string; onInterrupt: () => void }): ReactNode {
  const elapsed = useElapsed(true)
  return (
    <div className="-mx-0.5 flex min-h-[22px] shrink-0 items-center gap-2 px-2 py-[3px]">
      <span aria-hidden className="text-col-progress wd-pulse">
        ✶
      </span>
      <span className="text-col-progress flex-1 font-mono text-[10.5px]">
        {label} is working · {elapsed}s
      </span>
      <button
        type="button"
        className={`${quiet} border-edge-strong h-5 border font-sans`}
        onClick={onInterrupt}
      >
        <svg aria-hidden viewBox="0 0 16 16" width="10" height="10">
          <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
        </svg>
        Interrupt
        <span className="text-faint font-mono text-[10px]">esc</span>
      </button>
    </div>
  )
}

function Approval({
  request,
  label,
  look,
  onAnswer,
  onShowTui
}: {
  request: ApprovalRequest
  label: string
  look: Look
  onAnswer: (option: ApprovalOption) => void
  onShowTui: () => void
}): ReactNode {
  const { prompt, tool, summary, edit, options, keys } = request
  const firstAllow = options.find((option) => option.kind !== 'deny')
  return (
    <section
      role="alertdialog"
      aria-label={`${label} is waiting on you`}
      className="border-accent/40 bg-accent/10 -mx-0.5 shrink-0 rounded-md border px-2 py-2 font-sans"
    >
      <div className="text-ink flex items-start gap-2 text-[12px]">
        <span aria-hidden className="text-accent-ink">
          ✦
        </span>
        <span className="min-w-0 flex-1">{prompt}</span>
      </div>
      {tool && summary ? (
        <div className="mt-1 flex min-w-0 gap-2 pl-5 font-mono text-[11px]">
          <span className="text-ink shrink-0 font-medium">{tool}</span>
          <span className="text-dim min-w-0 flex-1 break-all whitespace-pre-wrap">{summary}</span>
        </div>
      ) : null}
      {edit ? (
        <div className="font-mono text-[11px]">
          <Diff patch={edit} look={look} />
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={
              option.kind === 'deny'
                ? 'border-edge-strong text-dim hover:bg-raised/70 hover:text-ink inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium'
                : 'border-accent/40 bg-accent/15 text-accent-ink hover:bg-accent/30 inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium'
            }
            onClick={() => onAnswer(option)}
          >
            <span className="truncate">{option.label}</span>
            {keys && option === firstAllow ? (
              <span className="text-faint font-mono text-[10px]">↵</span>
            ) : keys && option.kind === 'deny' ? (
              <span className="text-faint font-mono text-[10px]">esc</span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          className="text-dim hover:bg-raised/70 hover:text-ink inline-flex h-[22px] items-center rounded-md px-2 text-[11.5px] font-medium"
          onClick={onShowTui}
        >
          Answer in {label}
        </button>
      </div>
    </section>
  )
}
