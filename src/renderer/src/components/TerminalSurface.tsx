import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_STATE_LABELS, type AgentStatus } from '@core/agentState.js'
import { shellQuote } from '@core/shell.js'
import { shortcutHint } from '@core/shortcuts.js'
import type {
  ShortcutBindings,
  TaskStatus,
  TerminalRuntimeState,
  TerminalSessionInfo,
  ThemeSettings
} from '@core/types.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import { onTerminalCommand, type TerminalCommand } from '../lib/terminalCommands.js'
import {
  firstLine,
  taskFromTerminal,
  type TerminalContext,
  type TerminalTaskKind
} from '../lib/terminalContext.js'
import { DirectoryPicker } from './DirectoryPicker.js'
import { TerminalView, type TerminalHandle, type TerminalSelection } from './TerminalView.js'

const INTERRUPT = '\x03'
const CLEAR = '\x0c'

const quietButton =
  'pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-transparent font-medium text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40'
const agentButton =
  'pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/15 font-medium text-[#d9b4e0] hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-accent'

export interface TerminalTaskRequest {
  title: string
  description: string
}

/**
 * Agent CLIs run on the alternate screen like vim does, but the bar stays for them: their session
 * is where directory, branch and "ask agent" matter most. A task's session is always one; a shell
 * is one while it is running one of these by hand.
 */
function isAgentCommand(command: string | undefined): boolean {
  if (!command) return false
  const program = command.trim().split(/\s+/)[0] ?? ''
  return ['claude', 'codex'].includes(program.slice(program.lastIndexOf('/') + 1))
}

function splitPath(cwd: string): { name: string; rest: string } {
  const trimmed = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0 || trimmed === '/') return { name: trimmed, rest: '' }
  return { name: trimmed.slice(cut + 1), rest: trimmed.slice(0, cut) }
}

function useElapsedSeconds(startedAt: number | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === undefined ? undefined : (Math.max(0, now - startedAt) / 1000).toFixed(1)
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function Kbd({ children }: { children: ReactNode }): ReactNode {
  return <span className="font-mono text-[10px] text-faint">{children}</span>
}

const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

function CopyIcon(): ReactNode {
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" {...iconProps}>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.5 3.5V3a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.5a1 1 0 0 0 1 1h.5" />
    </svg>
  )
}

interface MenuItem {
  label: string
  kbd?: string
  agent?: boolean
  disabled?: boolean
  run: () => void
}

/** The "⋯" menu: actions on the terminal as a whole. */
function ActionsMenu({
  groups,
  onClose
}: {
  groups: MenuItem[][]
  onClose: () => void
}): ReactNode {
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    root.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
    const close = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])

  return (
    <div
      ref={root}
      role="menu"
      className="pointer-events-auto absolute bottom-full right-1.5 z-20 mb-1 flex w-[232px] flex-col rounded-lg border border-edge-strong bg-panel p-1 shadow-2xl"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const items = [
            ...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
          ]
          const at = items.indexOf(document.activeElement as HTMLElement)
          const step = event.key === 'ArrowDown' ? 1 : -1
          items[(at + step + items.length) % items.length]?.focus()
        }
      }}
    >
      {groups.map((group, index) => (
        <div key={index} className={index > 0 ? 'mt-1 border-t border-edge pt-1' : ''}>
          {group.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] hover:bg-raised focus:bg-raised focus:outline-none disabled:opacity-40 ${
                item.agent ? 'text-[#d9b4e0]' : 'text-ink'
              }`}
              onClick={() => {
                onClose()
                item.run()
              }}
            >
              <span className="flex-1">{item.label}</span>
              {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

function SelectionToolbar({
  selection,
  askHint,
  onCopy,
  onExplain,
  onAsk
}: {
  selection: TerminalSelection
  askHint: string
  onCopy: () => void
  onExplain: () => void
  onAsk: () => void
}): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="pointer-events-auto absolute z-20 flex items-center gap-0.5 whitespace-nowrap rounded-lg border border-edge-strong bg-panel p-[3px] shadow-2xl"
      style={{ left: Math.max(4, selection.x - 40), top: Math.max(4, selection.y - 40) }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className={`${quietButton} h-[22px] px-[7px] text-[11.5px]`}
        onClick={onCopy}
      >
        <CopyIcon />
        Copy
      </button>
      <button
        type="button"
        className={`${quietButton} h-[22px] px-[7px] text-[11.5px]`}
        onClick={onExplain}
      >
        Explain
      </button>
      <span aria-hidden className="mx-0.5 h-3.5 w-px bg-edge-strong" />
      <button
        type="button"
        className={`${agentButton} h-[22px] border-transparent px-[7px] text-[11.5px]`}
        onClick={onAsk}
      >
        ✦ Ask agent
      </button>
      {askHint ? (
        <span className="pl-0.5 pr-1.5 font-mono text-[10px] text-faint">{askHint}</span>
      ) : null}
    </div>
  )
}

/** Shown after a command fails: the design's inline agent actions, without turning output into UI. */
function FailureActions({
  runtime,
  onFix,
  onExplain,
  onCreate
}: {
  runtime: TerminalRuntimeState
  onFix: () => void
  onExplain: () => void
  onCreate: () => void
}): ReactNode {
  const last = runtime.lastCommand
  const note = last?.output ? firstLine(last.output) : ''
  return (
    <div className="pointer-events-none flex shrink-0 flex-wrap items-center gap-1 border-t border-edge px-1.5 py-1">
      <button
        type="button"
        className={`${agentButton} h-[22px] px-2 text-[11.5px]`}
        onClick={onFix}
      >
        ✦ Fix with agent
      </button>
      <button
        type="button"
        className={`${quietButton} h-[22px] border-edge-strong px-2 text-[11.5px]`}
        onClick={onExplain}
      >
        Explain
      </button>
      <button
        type="button"
        className={`${quietButton} hidden h-[22px] px-2 text-[11.5px] @md:inline-flex`}
        onClick={onCreate}
      >
        Create task
      </button>
      <span className="ml-1.5 hidden min-w-0 truncate text-[11px] text-faint @md:block">
        {last ? `exit ${runtime.lastExitCode} · ${last.command}` : ''}
        {note ? ` — ${note}` : ''}
      </span>
    </div>
  )
}

function ContextBar({
  runtime,
  fallbackCwd,
  isAgent,
  agentState,
  branch,
  picking,
  menuOpen,
  askHint,
  directoryHint,
  menu,
  onTogglePicker,
  onClosePicker,
  onToggleMenu,
  onChoose,
  onInterrupt,
  onAsk,
  onReview,
  onHandOff,
  reviewHint,
  children
}: {
  runtime: TerminalRuntimeState
  fallbackCwd: string
  /** An agent CLI is running: it is shown by its state, not as a command with a timer. */
  isAgent?: boolean
  agentState?: AgentStatus['state']
  branch: string | null
  picking: boolean
  menuOpen: boolean
  askHint: string
  directoryHint: string
  menu: ReactNode
  onTogglePicker: () => void
  onClosePicker: () => void
  onToggleMenu: () => void
  onChoose: (path: string) => void
  onInterrupt: () => void
  onAsk: () => void
  /** Offered only when the task is in review and its agent is not mid-turn. */
  onReview?: () => void
  onHandOff: () => void
  reviewHint: string
  children?: ReactNode
}): ReactNode {
  const cwd = runtime.cwd || fallbackCwd
  const running = runtime.runningCommand
  const elapsed = useElapsedSeconds(running?.startedAt)
  const last = runtime.lastCommand
  const failed = !running && runtime.lastExitCode !== undefined && runtime.lastExitCode !== 0
  const fresh = !running && !last && runtime.lastExitCode === undefined
  const path = splitPath(cwd)
  // A cd typed while a command runs would reach that command's stdin, so only offer it at a prompt.
  const canChange = runtime.promptReady && !running

  return (
    <footer className="pointer-events-none relative flex h-[30px] shrink-0 items-center gap-1.5 border-t border-edge px-1.5">
      <button
        type="button"
        title={canChange ? cwd : `${cwd} — available at a prompt`}
        aria-haspopup="dialog"
        aria-expanded={picking}
        disabled={!canChange}
        className={`pointer-events-auto inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border py-0 pl-[7px] pr-1.5 font-mono text-[11px] text-ink hover:bg-raised/70 focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-60 ${
          picking ? 'border-edge-strong bg-raised' : 'border-transparent'
        }`}
        onClick={onTogglePicker}
      >
        <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className="shrink-0 text-dim">
          <path
            d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"
            {...iconProps}
          />
        </svg>
        <span className="shrink-0 font-medium">{path.name}</span>
        {path.rest ? (
          <span
            className="min-w-0 max-w-[280px] truncate text-left text-dim"
            style={{ direction: 'rtl' }}
          >
            <bdi>{path.rest}</bdi>
          </span>
        ) : null}
        <svg aria-hidden viewBox="0 0 16 16" width="12" height="12" className="shrink-0 text-faint">
          <path d="M5 6.5 8 9.5l3-3" {...iconProps} />
        </svg>
      </button>

      {branch ? (
        <span
          title="Branch"
          className="hidden min-w-0 items-center gap-1 font-mono text-[10.5px] text-faint @lg:flex"
        >
          <svg aria-hidden viewBox="0 0 16 16" width="11" height="11" className="shrink-0">
            <g {...iconProps}>
              <circle cx="4.5" cy="3.5" r="1.8" />
              <circle cx="4.5" cy="12.5" r="1.8" />
              <circle cx="11.5" cy="3.5" r="1.8" />
              <path d="M4.5 5.3v5.4M11.5 5.3c0 3-2.8 3.4-5.2 4" />
            </g>
          </svg>
          <span className="truncate">{branch}</span>
        </span>
      ) : null}

      <span className="flex-1" />

      {fresh ? (
        <span className="hidden items-center gap-2.5 text-[11.5px] text-faint @md:flex">
          {askHint ? (
            <span>
              <span className="font-mono text-[10.5px]">{askHint}</span> ask agent
            </span>
          ) : null}
          {directoryHint ? (
            <span>
              <span className="font-mono text-[10.5px]">{directoryHint}</span> change directory
            </span>
          ) : null}
        </span>
      ) : null}

      {running && isAgent ? (
        // The agent process lives as long as the session, so a timer would count idle time as work.
        // Its own state (from its hooks) says what it is actually doing.
        <span
          className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] ${
            agentState ? AGENT_TONE[agentState] : 'text-dim'
          }`}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full bg-current ${agentState === 'working' ? 'wd-pulse' : ''}`}
          />
          {agentState ? <span className="shrink-0">{AGENT_STATE_LABELS[agentState]}</span> : null}
        </span>
      ) : running ? (
        <>
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-col-progress">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current wd-pulse" />
            <span className="max-w-56 truncate">{running.command}</span>
            <span className="shrink-0">· {elapsed}s</span>
          </span>
          <button
            type="button"
            className={`${quietButton} h-5 shrink-0 rounded-[5px] border-edge-strong px-1.5 text-[11px]`}
            onClick={onInterrupt}
          >
            <svg aria-hidden viewBox="0 0 16 16" width="10" height="10">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
            </svg>
            Interrupt
            <Kbd>⌃C</Kbd>
          </button>
        </>
      ) : runtime.lastExitCode !== undefined ? (
        <span
          className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] ${
            failed ? 'text-danger' : 'text-faint'
          }`}
        >
          {failed ? <span>exit {runtime.lastExitCode} ·</span> : null}
          {last?.endedAt !== undefined ? (
            <span>{formatDuration(last.endedAt - last.startedAt)}</span>
          ) : null}
        </span>
      ) : null}

      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">{children}</div>

      {onReview ? (
        <button
          type="button"
          title={`Close this session and start a fresh reviewer, as Orchestrate would${reviewHint ? ` (${reviewHint})` : ''}`}
          className={`${agentButton} h-[22px] px-2 text-[11.5px]`}
          onClick={onReview}
        >
          ✓ <span className="hidden @md:inline">Ask to review</span>
          <span className="@md:hidden">Review</span>
        </button>
      ) : null}
      <button
        type="button"
        title="Write a handoff document and create a task another agent can pick up"
        className={`${quietButton} hidden h-[22px] px-[7px] text-[11.5px] @lg:inline-flex`}
        onClick={onHandOff}
      >
        Hand off
      </button>
      <button
        type="button"
        title={`Ask agent about this terminal${askHint ? ` (${askHint})` : ''}`}
        className={`${quietButton} h-[22px] px-[7px] text-[11.5px]`}
        onClick={onAsk}
      >
        <span className="text-[#aa75b5]">✦</span>
        <span className="hidden @md:inline">Ask agent</span>
        {askHint ? (
          <span className="hidden font-mono text-[10px] text-faint @md:inline">{askHint}</span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label="Terminal actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className={`${quietButton} size-[22px] justify-center ${menuOpen ? 'bg-raised' : ''}`}
        onClick={onToggleMenu}
      >
        <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <circle cx="3.75" cy="8" r="1.15" />
          <circle cx="8" cy="8" r="1.15" />
          <circle cx="12.25" cy="8" r="1.15" />
        </svg>
      </button>

      {picking ? <DirectoryPicker start={cwd} onClose={onClosePicker} onChoose={onChoose} /> : null}
      {menu}
    </footer>
  )
}

/**
 * The native React boundary around xterm. It owns semantic state presentation while TerminalView
 * remains exclusively responsible for terminal emulation and lifecycle.
 */
export function TerminalSurface({
  session,
  active,
  theme,
  bindings,
  runtime,
  agentStatus,
  taskStatus,
  onAskReview,
  onFullscreenChange,
  onSplit,
  onCreateTask,
  children
}: {
  session: TerminalSessionInfo
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  /** The main process's semantic state for this session, once it has reported any. */
  runtime?: TerminalRuntimeState
  /** The hook-reported state of this task's agent, when it is a task session. */
  agentStatus?: AgentStatus
  /** The board status of this session's task, when it has one. */
  taskStatus?: TaskStatus
  /** Start a fresh reviewer on the task (what Orchestrate does for the review lane). */
  onAskReview?: (taskId: string) => Promise<void>
  /** A full-screen program took over (or gave back) the panel. */
  onFullscreenChange?: (sessionId: string, fullscreen: boolean) => void
  /** Open another shell tab starting in this directory. */
  onSplit?: (cwd: string) => void
  /** Hand terminal output to an agent as a new task; resolves to the task id. */
  onCreateTask?: (request: TerminalTaskRequest) => Promise<string>
  /** Extension point for future terminal actions and controls. */
  children?: ReactNode
}): ReactNode {
  const handle = useRef<TerminalHandle | null>(null)
  const [altScreen, setAltScreen] = useState(false)
  const [selection, setSelection] = useState<TerminalSelection | null>(null)
  const [picking, setPicking] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [branch, setBranch] = useState<string | null>(null)
  const [notice, setNotice] = useState<string>()

  const cwd = runtime?.cwd || session.cwd
  const running = runtime?.runningCommand
  const canChange = Boolean(runtime?.promptReady && !running)
  const lastCommandId = runtime?.lastCommand?.id

  useEffect(() => {
    let current = true
    void window.api.terminal.gitBranch(cwd).then((name) => {
      if (current) setBranch(name)
    })
    return () => {
      current = false
    }
    // A finished command may have switched branches, so it re-reads as well as a new directory.
  }, [cwd, lastCommandId])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const write = useCallback(
    (data: string) => window.api.terminal.write(session.id, data),
    [session.id]
  )

  const changeDirectory = (directory: string): void => {
    setPicking(false)
    // The new directory is observed back from the shell integration rather than assumed, and the
    // value is quoted so a path is never interpreted as shell syntax.
    write(`cd -- '${shellQuote(directory)}'\r`)
    handle.current?.focus()
  }

  const copy = useCallback((text: string, what: string) => {
    void navigator.clipboard.writeText(text).then(() => setNotice(`Copied ${what}`))
  }, [])

  const contextFor = useCallback(
    (preferSelection: boolean): TerminalContext => {
      const last = runtime?.lastCommand
      const text =
        (preferSelection ? selection?.text : undefined) ??
        last?.output ??
        handle.current?.text() ??
        ''
      return {
        cwd,
        command: last?.command,
        exitCode: runtime?.lastExitCode,
        text
      }
    },
    [cwd, runtime, selection]
  )

  const sendToAgent = useCallback(
    async (kind: TerminalTaskKind, preferSelection = false): Promise<void> => {
      if (!onCreateTask) return
      const request = taskFromTerminal(kind, contextFor(preferSelection))
      setSelection(null)
      try {
        setNotice(`Created ${await onCreateTask(request)} — find it in Backlog`)
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : 'Could not create the task')
      }
    },
    [contextFor, onCreateTask]
  )

  const reviewable =
    Boolean(session.taskId && onAskReview) &&
    taskStatus === 'in_review' &&
    agentStatus?.state !== 'working' &&
    agentStatus?.state !== 'waiting'

  const askReview = useCallback(async (): Promise<void> => {
    if (!session.taskId || !onAskReview || !reviewable) return
    try {
      await onAskReview(session.taskId)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not start the review')
    }
  }, [session.taskId, onAskReview, reviewable])

  const handOffWork = useCallback(async (): Promise<void> => {
    try {
      const text = handle.current?.text() ?? runtime?.lastCommand?.output ?? ''
      const result = await window.api.terminal.handOff(session.id, text)
      setNotice(`Handed off as ${result.taskId} — find it in Backlog`)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not hand off')
    }
  }, [session.id, runtime])

  const retry = useCallback(() => {
    const command = runtime?.lastCommand?.command
    if (command && canChange) write(`${command}\r`)
  }, [runtime, canChange, write])

  const copyAll = useCallback(() => copy(handle.current?.text() ?? '', 'all output'), [copy])

  useEffect(() => {
    if (!active) return
    return onTerminalCommand((command: TerminalCommand) => {
      switch (command) {
        case 'terminalDirectory':
          if (canChange) setPicking((open) => !open)
          return
        case 'terminalAskAgent':
          return void sendToAgent('ask', true)
        case 'terminalCopyOutput':
          return copyAll()
        case 'terminalRetry':
          return retry()
        case 'terminalSplit':
          return onSplit?.(cwd)
        case 'terminalAskReview':
          return void askReview()
        case 'terminalHandOff':
          return void handOffWork()
      }
    })
  }, [active, canChange, sendToAgent, handOffWork, askReview, copyAll, retry, onSplit, cwd])

  const failed =
    runtime !== undefined &&
    !running &&
    runtime.lastExitCode !== undefined &&
    runtime.lastExitCode !== 0
  // Only a program on the alternate screen (vim, htop) owns the whole panel. Agent CLIs such as
  // Claude Code and Codex draw inline, so their sessions keep the bar.
  const agent = Boolean(session.taskId) || isAgentCommand(runtime?.runningCommand?.command)
  const fullscreen = altScreen && !agent
  const showBar = runtime !== undefined && !runtime.terminated && !fullscreen
  useEffect(() => {
    onFullscreenChange?.(session.id, fullscreen)
  }, [onFullscreenChange, session.id, fullscreen])
  const askHint = shortcutHint(bindings, 'terminalAskAgent')

  const groups: MenuItem[][] = [
    [
      { label: 'Copy all output', kbd: shortcutHint(bindings, 'terminalCopyOutput'), run: copyAll },
      { label: 'Clear', kbd: '⌃L', disabled: !canChange, run: () => write(CLEAR) },
      {
        label: 'Retry last command',
        kbd: shortcutHint(bindings, 'terminalRetry'),
        disabled: !canChange || !runtime?.lastCommand,
        run: retry
      }
    ],
    [
      { label: '✦ Explain last output', agent: true, run: () => void sendToAgent('explain') },
      { label: 'Create task from output', run: () => void sendToAgent('output') },
      ...(reviewable
        ? [{ label: '✓ Ask to review', agent: true, run: () => void askReview() }]
        : []),
      { label: 'Hand off to another agent', agent: true, run: () => void handOffWork() }
    ],
    [
      {
        label: 'Reveal directory in Finder',
        run: () => void window.api.terminal.revealDirectory(cwd)
      },
      {
        label: 'Split terminal',
        kbd: shortcutHint(bindings, 'terminalSplit'),
        run: () => onSplit?.(cwd)
      }
    ]
  ]

  return (
    <div className="@container flex h-full w-full flex-col">
      <div className="relative min-h-0 flex-1">
        <TerminalView
          sessionId={session.id}
          active={active}
          theme={theme}
          bindings={bindings}
          handle={handle}
          onSelection={setSelection}
          onFullscreenChange={setAltScreen}
        />
        {selection && !fullscreen && onCreateTask ? (
          <SelectionToolbar
            selection={selection}
            askHint={askHint}
            onCopy={() => {
              copy(selection.text, 'selection')
              setSelection(null)
            }}
            onExplain={() => void sendToAgent('explain', true)}
            onAsk={() => void sendToAgent('ask', true)}
          />
        ) : null}
        {notice ? (
          <div
            role="status"
            className="pointer-events-none absolute bottom-2 left-1/2 z-20 -translate-x-1/2 rounded-md border border-edge-strong bg-panel px-2.5 py-1 text-[11.5px] text-ink shadow-xl"
          >
            {notice}
          </div>
        ) : null}
      </div>
      {showBar && failed && runtime ? (
        <FailureActions
          runtime={runtime}
          onFix={() => void sendToAgent('fix')}
          onExplain={() => void sendToAgent('explain')}
          onCreate={() => void sendToAgent('output')}
        />
      ) : null}
      {showBar ? (
        <ContextBar
          runtime={runtime}
          fallbackCwd={session.cwd}
          isAgent={agent}
          agentState={agentStatus?.state}
          branch={branch}
          picking={picking}
          menuOpen={menuOpen}
          askHint={askHint}
          directoryHint={shortcutHint(bindings, 'terminalDirectory')}
          menu={
            menuOpen ? <ActionsMenu groups={groups} onClose={() => setMenuOpen(false)} /> : null
          }
          onTogglePicker={() => setPicking((open) => !open)}
          onClosePicker={() => {
            setPicking(false)
            handle.current?.focus()
          }}
          onToggleMenu={() => {
            setPicking(false)
            setMenuOpen((open) => !open)
          }}
          onChoose={changeDirectory}
          onInterrupt={() => write(INTERRUPT)}
          onAsk={() => void sendToAgent('ask')}
          onReview={reviewable ? () => void askReview() : undefined}
          onHandOff={() => void handOffWork()}
          reviewHint={shortcutHint(bindings, 'terminalAskReview')}
        >
          {children}
        </ContextBar>
      ) : null}
    </div>
  )
}
