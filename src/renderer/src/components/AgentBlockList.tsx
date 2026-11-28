import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type {
  AgentMessageBlock,
  AgentToolCallBlock,
  DiffBlock,
  StyrBlock
} from '@core/types/blocks.js'
import { CommandMenu, useCommandInput } from './CommandInput.js'
import type { AgentCommand, ApprovalOption } from '@core/agentConversation.js'
import { quiet } from './quiet.js'
import { editRows } from '@core/diffView.js'
import { ChatMarkdown, chatProse } from './ChatMarkdown.js'
import { ChevronIcon, CopyIcon } from './icons.js'
import { StyrAvatar } from './StyrMark.js'

/** Rows of a diff shown before "Show all". */
const DIFF_PREVIEW = 16
/** How far (px) the person scrolls up before "Jump to latest" shows, as on the phone. */
const PILL_THRESHOLD = 240

/** The conversation's column: the tab's full width (a side-docked panel can be narrow), the phone's gutters. */
const COLUMN = 'w-full px-4'

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
  /** Answered only in the CLI's own interface (a question it asks there); no options are offered. */
  inTui?: boolean
}

/**
 * An agent CLI's session drawn by Styr as the phone app's chat draws it, in place of its TUI: the
 * person's prompts in bubbles on the right, the agent's replies across the column as markdown, each
 * tool call a bordered row that opens to its input, output and diff, "Working…" while a turn runs,
 * the approval the agent waits on pinned under the conversation, and a composer. Both terminal
 * engines draw their chat with it.
 *
 * Provider-neutral: it draws blocks (`agentConversation.ts`) and names the agent by `label`; what it
 * sends goes through the agent's own channel or to the CLI's PTY as if typed, so the CLI itself
 * still decides everything. Every character is React text.
 */
export function AgentBlockList({
  blocks,
  working,
  label,
  approval,
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
  const [away, setAway] = useState(false)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  })
  const diffs = new Map(
    blocks.filter((block): block is DiffBlock => block.kind === 'diff').map((d) => [d.parentId, d])
  )
  const rows = blocks.filter(
    (block): block is ChatRow => block.kind === 'agent-message' || block.kind === 'agent-tool-call'
  )

  return (
    <div
      className="bg-surface text-ink flex h-full w-full flex-col font-sans whitespace-normal"
      style={{ fontFamily: 'var(--font-ui)' }}
    >
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          className="h-full overflow-y-auto overscroll-contain"
          onScroll={(event) => {
            const element = event.currentTarget
            const distance = element.scrollHeight - element.clientHeight - element.scrollTop
            pinned.current = distance <= 4
            setAway(distance > PILL_THRESHOLD)
          }}
        >
          <div className={`${COLUMN} flex min-h-full flex-col justify-end py-3`}>
            {rows.length === 0 && !working ? (
              <p className="text-faint m-auto py-8 text-center text-[14px]">
                Nothing here yet. Send {label} a message to start.
              </p>
            ) : null}
            {rows.map((block, at) =>
              block.kind === 'agent-message' && block.payload.role === 'user' ? (
                <Message key={block.id} block={block} label={label} />
              ) : (
                <AgentRow
                  key={block.id}
                  avatar={startsTurn(rows, at)}
                  pad={block.kind === 'agent-tool-call' ? 'pt-2' : 'pt-1'}
                >
                  {block.kind === 'agent-message' ? (
                    <Message block={block} label={label} />
                  ) : (
                    <ToolCall block={block} diff={diffs.get(block.id)} />
                  )}
                </AgentRow>
              )
            )}
            {working ? (
              <AgentRow avatar={startsTurn(rows, rows.length)} pad="pt-1">
                <Working />
              </AgentRow>
            ) : null}
          </div>
        </div>
        {away ? (
          <button
            type="button"
            className="border-edge-strong bg-raised text-ink hover:bg-card absolute bottom-3 left-1/2 inline-flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border px-4 text-[14px] font-semibold shadow-lg"
            onClick={() => {
              const element = scroller.current
              pinned.current = true
              element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
            }}
          >
            <span aria-hidden>↓</span> Jump to latest
          </button>
        ) : null}
      </div>
      {approval ? (
        // Pinned under the conversation, as on the phone; a long one scrolls inside its own space.
        <div className="max-h-[60%] shrink-0 overflow-y-auto">
          <div className={`${COLUMN} py-2`}>
            <Approval request={approval} label={label} onAnswer={onAnswer} onShowTui={onShowTui} />
          </div>
        </div>
      ) : null}
      <Composer
        label={label}
        working={working}
        question={approval?.inTui ?? false}
        attachedImages={attachedImages}
        inputRef={inputRef}
        history={history}
        commands={commands}
        onSubmit={onSubmit}
        onInterrupt={onInterrupt}
        onPasteImage={onPasteImage}
      />
    </div>
  )
}

type ChatRow = AgentMessageBlock | AgentToolCallBlock

const isUserMessage = (block: ChatRow): boolean =>
  block.kind === 'agent-message' && block.payload.role === 'user'

/** The agent's side starts a turn at `at`: the first row after the person's message, or the first. */
const startsTurn = (rows: ChatRow[], at: number): boolean => {
  const before = rows[at - 1]
  return before === undefined || isUserMessage(before)
}

/**
 * One row of the agent's side: Styr's avatar in a gutter on the first row of each turn, the gutter
 * left empty on the rest so a turn's replies, tool calls and "Working…" line up under it.
 */
function AgentRow({
  avatar,
  pad,
  children
}: {
  avatar: boolean
  /** Lines the avatar up with the row's first line. */
  pad: string
  children: ReactNode
}): ReactNode {
  return (
    <div className="flex shrink-0 gap-3">
      <div className={`w-7 shrink-0 ${pad}`}>{avatar ? <StyrAvatar /> : null}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** The message's own copy button: shown on hover (or keyboard focus), "Copied" once it has. */
function CopyButton({
  text,
  className = 'size-7'
}: {
  text: string
  /** Its size and place; a square of 28px by default. */
  className?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      title="Copy message"
      aria-label="Copy message"
      className={`text-faint hover:bg-raised/70 hover:text-ink inline-flex shrink-0 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ${className}`}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
      onMouseLeave={() => setCopied(false)}
    >
      {copied ? (
        <span className="text-col-done text-[13px]" aria-label="Copied">
          ✓
        </span>
      ) : (
        <CopyIcon size={14} />
      )}
    </button>
  )
}

function Message({ block, label }: { block: AgentMessageBlock; label: string }): ReactNode {
  const { role, text } = block.payload
  const streaming = block.state === 'streaming'
  if (role === 'user') {
    return (
      <section aria-label="Your message" className="group flex shrink-0 justify-end gap-1 py-1">
        <CopyButton text={text} className="size-7 self-end" />
        <div className="border-edge-strong bg-raised max-w-[82%] min-w-0 rounded-[16px] rounded-br-[4px] border px-3 py-2 text-[15px] leading-[1.45] break-words whitespace-pre-wrap">
          {text}
        </div>
      </section>
    )
  }
  return (
    <section
      aria-label={`${label}'s message${streaming ? ', arriving' : ''}`}
      aria-busy={streaming || undefined}
      className={`group shrink-0 py-1 text-[15px] leading-[1.45] break-words ${chatProse}`}
    >
      <ChatMarkdown text={text} />
      {streaming ? (
        <span aria-hidden className="bg-dim wd-pulse mt-1 block h-4 w-2" />
      ) : (
        <CopyButton text={text} className="-mb-1 -ml-1.5 size-6" />
      )}
    </section>
  )
}

/** A call not finished yet: running, about to, or waiting on the person. */
const isRunning = (state: AgentToolCallBlock['state']): boolean =>
  state === 'streaming' || state === 'pending' || state === 'awaiting-input'

/** A tool call's state by a mark of its own shape, so it does not rest on colour. */
function StateMark({ state }: { state: AgentToolCallBlock['state'] }): ReactNode {
  if (isRunning(state)) {
    return (
      <span
        aria-hidden
        className="border-col-progress size-3.5 shrink-0 animate-spin rounded-full border-2 border-t-transparent motion-reduce:animate-none"
      />
    )
  }
  const [mark, tone] =
    state === 'failed'
      ? ['✕', 'text-danger']
      : state === 'cancelled'
        ? ['−', 'text-faint']
        : ['✓', 'text-col-done']
  return (
    <span aria-hidden className={`w-3.5 shrink-0 text-center text-[14px] font-semibold ${tone}`}>
      {mark}
    </span>
  )
}

const stateWord = (state: AgentToolCallBlock['state']): string =>
  isRunning(state) ? 'running' : state

/**
 * A tool call folded to one line (its state, name and what it works on) that opens to its input,
 * how it went and an edit's diff. A failed call is outlined in the danger colour.
 */
function ToolCall({ block, diff }: { block: AgentToolCallBlock; diff?: DiffBlock }): ReactNode {
  const [open, setOpen] = useState(false)
  const { tool, summary, result, output } = block.payload
  const failed = block.state === 'failed'
  const firstLine = summary.split('\n')[0] ?? ''
  return (
    <section
      aria-label={`${tool} ${firstLine}, ${stateWord(block.state)}`}
      className="shrink-0 py-0.5"
    >
      <div
        className={`bg-card overflow-hidden rounded-[10px] border ${failed ? 'border-danger' : 'border-edge'}`}
      >
        <button
          type="button"
          aria-expanded={open}
          className="hover:bg-raised/50 flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <StateMark state={block.state} />
          <span className="text-ink shrink-0 text-[15px] font-semibold">{tool}</span>
          <span className="text-dim min-w-0 flex-1 truncate font-mono text-[12px]">
            {firstLine}
          </span>
          {diff ? (
            <span className="shrink-0 font-mono text-[11px]">
              <span className="text-col-done">+{diff.payload.additions}</span>{' '}
              <span className="text-danger">−{diff.payload.deletions}</span>
            </span>
          ) : null}
          <span className={`text-faint transition-transform ${open ? 'rotate-180' : ''}`}>
            <ChevronIcon size={16} />
          </span>
        </button>
        {open ? (
          <div className="flex flex-col gap-1 px-3 pb-3">
            {summary ? <Detail title="Input" text={summary} /> : null}
            {isRunning(block.state) ? (
              <p className="text-faint wd-pulse text-[13px]">Running…</p>
            ) : output ? (
              <Detail title="Output" text={output} failed={failed} />
            ) : result && !(diff && !failed) ? (
              <Detail title="Result" text={result} failed={failed} />
            ) : block.state === 'cancelled' ? (
              <p className="text-faint text-[13px]">Interrupted</p>
            ) : null}
            {diff ? <Diff patch={diff.payload} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** A heading over a block of a call's text, with a button that copies it. */
function Detail({ title, text, failed }: { title: string; text: string; failed?: boolean }) {
  return (
    <div className="group">
      <div className="flex items-center">
        <span className="text-dim flex-1 text-[12.5px] font-medium">{title}</span>
        <button
          type="button"
          title={`Copy ${title.toLowerCase()}`}
          aria-label={`Copy ${title.toLowerCase()}`}
          className="text-faint hover:bg-raised/70 hover:text-ink inline-flex size-7 items-center justify-center rounded-md"
          onClick={() => void navigator.clipboard.writeText(text)}
        >
          <CopyIcon size={14} />
        </button>
      </div>
      <pre
        className={`bg-surface max-h-80 overflow-y-auto rounded-[8px] p-2 font-mono text-[12px] leading-normal break-words whitespace-pre-wrap ${failed ? 'text-danger' : 'text-ink'}`}
        style={{ overflowWrap: 'anywhere' }}
      >
        {text}
      </pre>
    </div>
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
function Diff({ patch: change }: { patch: Patch }): ReactNode {
  const [open, setOpen] = useState(false)
  const { patch, additions, deletions } = change
  const rows = useMemo(() => editRows(patch), [patch])
  const shown = open ? rows : rows.slice(0, DIFF_PREVIEW)
  return (
    <div className="border-edge bg-surface mt-1 overflow-hidden rounded-[8px] border font-mono text-[12px] leading-[1.5]">
      <div className="border-edge flex items-center justify-end gap-2 border-b px-2 text-[10.5px]">
        <span className="text-col-done">+{additions}</span>
        <span className="text-danger">−{deletions}</span>
      </div>
      <div>
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
                className={`min-w-0 flex-1 pr-2 pl-1.5 whitespace-pre-wrap ${row.kind === 'ctx' ? 'text-dim' : 'text-ink'}`}
                style={{ overflowWrap: 'anywhere' }}
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

/** "• Working…" while the agent runs a turn, as on the phone. */
function Working(): ReactNode {
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 py-2">
      <span aria-hidden className="bg-col-progress wd-pulse size-2 rounded-full" />
      <span className="text-dim wd-pulse text-[14px]">Working…</span>
    </div>
  )
}

/** A card's status line: a dot and its words, in the warning colour. */
function StatusLabel({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--color-col-review-text)]">
      <span aria-hidden className="bg-col-review size-1.5 rounded-full" />
      {children}
    </div>
  )
}

const primaryButton =
  'bg-accent hover:bg-accent/90 inline-flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-[10px] px-3 text-[14px] font-semibold text-[var(--color-on-accent)]'
const keyHint = 'font-mono text-[10.5px] font-normal opacity-70'

/**
 * The permission the agent waits on, as the phone's card has it: "Waiting on you", what it asks,
 * the command or edit, Deny beside the wider Allow, the CLI's other answers under them. A question
 * the CLI asks in its own interface is answered there.
 */
function Approval({
  request,
  label,
  onAnswer,
  onShowTui
}: {
  request: ApprovalRequest
  label: string
  onAnswer: (option: ApprovalOption) => void
  onShowTui: () => void
}): ReactNode {
  const { prompt, summary, edit, options, keys, inTui } = request
  const deny = options.find((option) => option.kind === 'deny')
  const allow = options.find((option) => option.kind !== 'deny')
  const extras = options.filter((option) => option !== deny && option !== allow)
  return (
    <section
      role="alertdialog"
      aria-label={`${label} is waiting on you`}
      className="border-col-review/35 bg-card rounded-[14px] border p-4"
    >
      <StatusLabel>{inTui ? 'Asked you a question' : 'Waiting on you'}</StatusLabel>
      <p className="mt-3 text-[15px] leading-[1.45] break-words">{prompt}</p>
      {inTui ? (
        <>
          <p className="text-dim mt-1 text-[13px]">
            It can only be answered in the terminal for now.
          </p>
          <button type="button" className={`${primaryButton} mt-3 w-full`} onClick={onShowTui}>
            Answer in Terminal
          </button>
        </>
      ) : (
        <>
          {summary ? (
            <pre
              className="border-edge bg-chrome mt-3 max-h-48 overflow-y-auto rounded-[10px] border px-3 py-2.5 font-mono text-[13px] leading-normal whitespace-pre-wrap"
              style={{ overflowWrap: 'anywhere' }}
            >
              {summary}
            </pre>
          ) : null}
          {edit ? <Diff patch={edit} /> : null}
          <div className="mt-3 flex gap-2">
            {deny ? (
              <button
                type="button"
                className="border-edge-strong bg-raised text-danger hover:bg-raised/70 inline-flex h-10 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[10px] border px-3 text-[14px] font-semibold"
                onClick={() => onAnswer(deny)}
              >
                <span className="truncate">{deny.label}</span>
                {keys ? <span className={keyHint}>esc</span> : null}
              </button>
            ) : null}
            {allow ? (
              <button
                type="button"
                className={`${primaryButton} flex-[2]`}
                onClick={() => onAnswer(allow)}
              >
                <span className="truncate">{allow.label}</span>
                {keys ? <span className={keyHint}>↵</span> : null}
              </button>
            ) : null}
          </div>
          {extras.map((option) => (
            <button
              key={option.id}
              type="button"
              className="text-dim hover:text-ink mt-1 flex min-h-9 w-full items-center justify-center rounded-[10px] px-3 text-[14px] font-semibold"
              onClick={() => onAnswer(option)}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className="text-faint hover:text-ink mt-1 flex min-h-8 w-full items-center justify-center rounded-[10px] px-3 text-[12.5px] font-medium"
            onClick={onShowTui}
          >
            Answer in {label}
          </button>
        </>
      )}
    </section>
  )
}

/**
 * The phone's composer: a note on what happens to a message now, a rounded field and a round Send
 * button. Enter sends and Shift+Enter breaks the line; ↑ steps back through history, `/` opens the
 * CLI's commands, Escape interrupts a turn and a pasted image goes to the CLI.
 */
function Composer({
  label,
  working,
  question,
  attachedImages,
  inputRef,
  history,
  commands,
  onSubmit,
  onInterrupt,
  onPasteImage
}: {
  label: string
  working: boolean
  /** The agent asked a question only its own interface answers. */
  question: boolean
  attachedImages: number
  inputRef: RefObject<HTMLTextAreaElement | null>
  history: string[]
  commands?: AgentCommand[]
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onPasteImage?: () => void
}): ReactNode {
  const input = useCommandInput({
    inputRef,
    history,
    commands,
    onSubmit,
    onEscape: working ? onInterrupt : undefined,
    onPasteImage
  })
  const { text, choice, matches } = input
  const canSend = text.trim() !== ''
  const note = question
    ? 'Answer the question above. A message sent now waits until it’s answered.'
    : working
      ? `${label} is working · your message will be queued`
      : null
  return (
    <div className="border-edge bg-chrome shrink-0 border-t">
      <div className={`${COLUMN} pt-2 pb-3`}>
        {/* Only drawn when it has something to say, so an idle composer has no gap above it. */}
        {note || attachedImages > 0 || working ? (
          <div className="text-dim flex min-h-6 items-center gap-1.5 pb-1.5 text-[13px]">
            {note ? (
              <span role="status" className="min-w-0 truncate">
                {note}
              </span>
            ) : null}
            {attachedImages > 0 ? (
              <span className="min-w-0 truncate">
                {note ? '· ' : ''}
                {attachedImages === 1 ? 'An image' : `${attachedImages} images`} in {label}&apos;s
                input, sent with your next prompt
              </span>
            ) : null}
            <span className="flex-1" />
            {working ? (
              <button type="button" className={`${quiet} h-6 shrink-0`} onClick={onInterrupt}>
                Interrupt <span className="text-faint font-mono text-[10px]">esc</span>
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <div className="relative min-w-0 flex-1">
            {choice ? <CommandMenu commands={matches} picked={choice} onPick={input.pick} /> : null}
            <textarea
              ref={inputRef}
              value={text}
              rows={Math.min(8, Math.max(1, text.split('\n').length))}
              placeholder={`Message ${label}…`}
              aria-label={`Message ${label}`}
              aria-expanded={choice ? true : undefined}
              aria-controls={choice ? 'styr-command-menu' : undefined}
              className="border-edge-strong bg-surface text-ink placeholder:text-faint focus:border-accent-soft block w-full resize-none rounded-[14px] border px-4 py-2.5 text-[15px] leading-[1.4]"
              // Inline, because the app's focus ring is an unlayered rule that utilities cannot beat;
              // the field's border shows focus instead.
              style={{ outline: 'none' }}
              onChange={input.onChange}
              onKeyDown={input.onKeyDown}
              onPaste={input.onPaste}
            />
          </div>
          <button
            type="button"
            title="Send (↵)"
            aria-label="Send"
            disabled={!canSend}
            className="bg-accent disabled:bg-raised disabled:text-faint inline-flex size-[44px] shrink-0 items-center justify-center rounded-full text-[var(--color-on-accent)]"
            onClick={() => {
              input.submit()
              inputRef.current?.focus()
            }}
          >
            <svg
              aria-hidden
              viewBox="0 0 16 16"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
