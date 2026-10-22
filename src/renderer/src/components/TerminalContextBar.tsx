import { useEffect, useState, type ReactNode } from 'react'
import { AGENT_STATE_LABELS, subagentCountLabel, type AgentStatus } from '@core/agentState.js'
import { formatAccelerator } from '@core/shortcuts.js'
import { TASK_STATUS_LABELS, type TaskStatus, type TerminalRuntimeState } from '@core/types.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import { STATUS_DOT } from '../lib/statusTone.js'
import { displayPath } from '../lib/terminalPath.js'
import { DirectoryPicker } from './DirectoryPicker.js'

export const quietButton =
  'pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-transparent font-medium text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40'
export const agentButton =
  'pointer-events-auto inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/15 font-medium text-accent-ink hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-accent'

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

export const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/** The bar under a shell: its folder, branch, last command, agent state and the terminal's actions. */
export function ContextBar({
  runtime,
  fallbackCwd,
  isAgent,
  agentState,
  subagents = 0,
  taskStatus,
  blocksOn,
  inputHints,
  branch,
  repoRoot,
  usage,
  diff,
  onOpenBranch,
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
  onCreatePr,
  onHandOff,
  reviewHint,
  children
}: {
  runtime: TerminalRuntimeState
  fallbackCwd: string
  /** An agent CLI is running: it is shown by its state, not as a command with a timer. */
  isAgent?: boolean
  agentState?: AgentStatus['state']
  /** Running subagents of that agent, shown after its state. */
  subagents?: number
  /** The board column of this session's task, so it reads even with the board hidden. */
  taskStatus?: TaskStatus
  /** Commands report themselves in blocks over the terminal, so the bar leaves them out. */
  blocksOn?: boolean
  /** The block list shows the keys beside its own input, so a new shell's bar does not repeat them. */
  inputHints?: boolean
  branch: string | null
  repoRoot: string | null
  /** The usage control, for a Claude session; sits beside Ask agent. */
  usage?: ReactNode
  /** The task's change totals, present only when its branch has changes. */
  diff?: ReactNode
  onOpenBranch: () => void
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
  /** Offered only while an agent is running; a bare shell has no intent to hand over. */
  onHandOff?: () => void
  /** Offered once a task in review has passed and its agent is idle. */
  onCreatePr?: () => void
  reviewHint: string
  children?: ReactNode
}): ReactNode {
  const cwd = runtime.cwd || fallbackCwd
  const running = runtime.runningCommand
  const elapsed = useElapsedSeconds(running?.startedAt)
  const last = runtime.lastCommand
  const failed = !running && runtime.lastExitCode !== undefined && runtime.lastExitCode !== 0
  const fresh = !running && !last && runtime.lastExitCode === undefined
  const path = displayPath(cwd, repoRoot)
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
        <button
          type="button"
          title="Open this checkout in VS Code"
          onClick={onOpenBranch}
          className="pointer-events-auto hidden min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] text-faint hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent @lg:flex"
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
        </button>
      ) : null}

      {usage}

      {diff}

      <span className="flex-1" />

      {fresh && !inputHints ? (
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

      {taskStatus ? (
        <span
          title={`Task column: ${TASK_STATUS_LABELS[taskStatus]}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-edge px-1.5 py-px text-[10.5px] text-dim"
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[taskStatus]}`}
          />
          {TASK_STATUS_LABELS[taskStatus]}
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
          {subagents ? (
            <span title={`${subagentCountLabel(subagents)} running`} className="truncate text-dim">
              · {subagentCountLabel(subagents)}
            </span>
          ) : null}
        </span>
      ) : running && !blocksOn ? (
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
            <Kbd>{formatAccelerator('ctrl+c')}</Kbd>
          </button>
        </>
      ) : runtime.lastExitCode !== undefined && !blocksOn ? (
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

      {onReview ? (
        <button
          type="button"
          title={`Close this session and start a fresh reviewer, as Dispatch would${reviewHint ? ` (${reviewHint})` : ''}`}
          className={`${agentButton} h-[22px] px-2 text-[11.5px]`}
          onClick={onReview}
        >
          ✓ <span className="hidden @md:inline">Ask to review</span>
          <span className="@md:hidden">Review</span>
        </button>
      ) : null}
      {onCreatePr ? (
        <button
          type="button"
          title="Ask the agent to push the branch and open a pull request"
          className={`${agentButton} h-[22px] px-2 text-[11.5px]`}
          onClick={onCreatePr}
        >
          ⎇ <span className="hidden @md:inline">Create PR</span>
          <span className="@md:hidden">PR</span>
        </button>
      ) : null}
      {onHandOff ? (
        <button
          type="button"
          title="Write a handoff document and create a task another agent can pick up"
          className={`${quietButton} hidden h-[22px] px-[7px] text-[11.5px] @lg:inline-flex`}
          onClick={onHandOff}
        >
          Hand off
        </button>
      ) : null}
      <button
        type="button"
        title={`Ask agent about this terminal${askHint ? ` (${askHint})` : ''}`}
        className={`${quietButton} h-[22px] px-[7px] text-[11.5px]`}
        onClick={onAsk}
      >
        <span className="text-accent-soft">✦</span>
        <span className="hidden @md:inline">Ask agent</span>
        {askHint ? (
          <span className="hidden font-mono text-[10px] text-faint @md:inline">{askHint}</span>
        ) : null}
      </button>
      {children ? (
        <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">{children}</div>
      ) : null}
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
