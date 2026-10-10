import {
  useEffect,
  useLayoutEffect,
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
import type { AgentCommand } from '@core/agentConversation.js'
import { quiet } from './TerminalBlocks.js'

/** Lines of a diff shown before "Show all". */
const DIFF_PREVIEW = 12

/**
 * An agent CLI's session drawn by Styr, in place of its TUI: the person's prompts, the agent's
 * messages, each tool call with how it went and an edit's diff, an approval when the agent waits on
 * the person, and Styr's `❯` input. Provider-neutral: it draws blocks (`agentConversation.ts`) and
 * names the agent by `label`; what it sends — a prompt, Enter or Escape — goes to the CLI's PTY as
 * if typed, so the CLI itself still decides everything. Every character is React text.
 */
export function AgentBlockList({
  blocks,
  working,
  label,
  waiting,
  look,
  font,
  inputRef,
  history,
  commands,
  onSubmit,
  onInterrupt,
  onAllow,
  onDeny,
  onShowTui
}: {
  blocks: StyrBlock[]
  working: boolean
  /** The agent CLI's name, e.g. "Claude Code". */
  label: string
  /** The agent waits on the person (a permission, a question), with what it said. */
  waiting: string | null
  look: Look
  font: CSSProperties
  inputRef: RefObject<HTMLTextAreaElement | null>
  history: string[]
  /** The CLI's slash commands, for the input's menu. */
  commands?: AgentCommand[]
  /** A prompt (or `/command`) as typed. */
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onAllow: () => void
  onDeny: () => void
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
        {waiting ? (
          <Approval
            message={waiting}
            label={label}
            onAllow={onAllow}
            onDeny={onDeny}
            onShowTui={onShowTui}
          />
        ) : working ? (
          <Working label={label} onInterrupt={onInterrupt} />
        ) : null}
        <CommandInput
          look={look}
          inputRef={inputRef}
          history={history}
          commands={commands}
          hints={[]}
          label={`Message ${label}`}
          onSubmit={onSubmit}
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
  const lines = block.payload.text.split('\n')
  const long = lines.length > MESSAGE_PREVIEW
  const text = long && !open ? lines.slice(0, MESSAGE_PREVIEW).join('\n') : block.payload.text
  return (
    <section
      aria-label={user ? 'Your message' : `${label}'s message`}
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

function ToolCall({
  block,
  diff,
  look
}: {
  block: AgentToolCallBlock
  diff?: DiffBlock
  look: Look
}): ReactNode {
  const { tool, summary, result } = block.payload
  const tone =
    block.state === 'failed'
      ? 'text-danger'
      : block.state === 'streaming'
        ? 'text-col-progress wd-pulse'
        : block.state === 'cancelled'
          ? 'text-faint'
          : 'text-col-done'
  return (
    <section
      aria-label={`${tool} ${summary}, ${block.state === 'streaming' ? 'running' : block.state}`}
      className="-mx-0.5 shrink-0 px-2 py-[3px]"
    >
      <div className="flex min-h-[22px] items-center gap-2">
        <span aria-hidden className={tone}>
          ⏺
        </span>
        <span className="text-ink shrink-0 font-medium">{tool}</span>
        <span className="text-dim min-w-0 flex-1 truncate">{summary}</span>
        <span
          title={result}
          className={`max-w-[45%] min-w-0 shrink truncate font-mono text-[10.5px] ${block.state === 'failed' ? 'text-danger' : 'text-faint'}`}
        >
          {block.state === 'streaming'
            ? 'running'
            : block.state === 'cancelled'
              ? 'interrupted'
              : (result ?? '')}
        </span>
      </div>
      {diff ? <Diff block={diff} look={look} /> : null}
    </section>
  )
}

function Diff({ block, look }: { block: DiffBlock; look: Look }): ReactNode {
  const [open, setOpen] = useState(false)
  const { patch, additions, deletions } = block.payload
  const lines = patch.split('\n')
  const shown = open ? lines : lines.slice(0, DIFF_PREVIEW)
  return (
    <div className="mt-1 ml-[18px] overflow-hidden rounded-md border border-edge">
      <div className="text-faint flex items-center gap-2 border-b border-edge px-2 font-mono text-[10.5px]">
        <span className="text-col-done">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
      </div>
      <div className="overflow-x-auto" style={{ lineHeight: `${look.lineHeight}px` }}>
        {shown.map((line, index) => (
          <div
            key={index}
            className={`px-2 whitespace-pre ${
              line.startsWith('+')
                ? 'bg-diff-add'
                : line.startsWith('-')
                  ? 'bg-diff-del'
                  : 'text-faint'
            }`}
          >
            {line === '@@' ? '⋯' : line || ' '}
          </div>
        ))}
      </div>
      {lines.length > DIFF_PREVIEW ? (
        <button
          type="button"
          className={`${quiet} h-6 w-full justify-center rounded-none font-sans`}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : `Show all ${lines.length} lines`}
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
  message,
  label,
  onAllow,
  onDeny,
  onShowTui
}: {
  message: string
  label: string
  onAllow: () => void
  onDeny: () => void
  onShowTui: () => void
}): ReactNode {
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
        <span className="min-w-0 flex-1">{message}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-5">
        <button
          type="button"
          className="border-accent/40 bg-accent/15 text-accent-ink hover:bg-accent/30 inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium"
          onClick={onAllow}
        >
          Allow <span className="text-faint font-mono text-[10px]">↵</span>
        </button>
        <button
          type="button"
          className="border-edge-strong text-dim hover:bg-raised/70 hover:text-ink inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium"
          onClick={onDeny}
        >
          Deny <span className="text-faint font-mono text-[10px]">esc</span>
        </button>
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
