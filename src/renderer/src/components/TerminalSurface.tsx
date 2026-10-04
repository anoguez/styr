import { useEffect, useState, type ReactNode } from 'react'
import { shellQuote } from '@core/shell.js'
import type {
  ShortcutBindings,
  TerminalRuntimeState,
  TerminalSessionInfo,
  ThemeSettings
} from '@core/types.js'
import { DirectoryPicker } from './DirectoryPicker.js'
import { TerminalView } from './TerminalView.js'

const INTERRUPT = '\x03'

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

/**
 * The context bar under the terminal: the live directory (a button that opens the chooser), the
 * running command with Interrupt, and the last command's exit status and duration. It sits beside
 * xterm in the layout rather than over it, so it never covers terminal output.
 */
function ContextBar({
  runtime,
  fallbackCwd,
  onChoose,
  onInterrupt,
  children
}: {
  runtime: TerminalRuntimeState
  fallbackCwd: string
  onChoose: (path: string) => void
  onInterrupt: () => void
  children?: ReactNode
}): ReactNode {
  const [picking, setPicking] = useState(false)
  const cwd = runtime.cwd || fallbackCwd
  const running = runtime.runningCommand
  const elapsed = useElapsedSeconds(running?.startedAt)
  const last = runtime.lastCommand
  const failed = !running && runtime.lastExitCode !== undefined && runtime.lastExitCode !== 0
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
        className={`pointer-events-auto inline-flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border py-0 pl-[7px] pr-1.5 font-mono text-[11px] text-ink hover:bg-raised/70 disabled:pointer-events-none disabled:opacity-60 ${
          picking ? 'border-edge-strong bg-raised' : 'border-transparent'
        }`}
        onClick={() => setPicking((open) => !open)}
      >
        <svg aria-hidden viewBox="0 0 16 16" width="13" height="13" className="shrink-0 text-dim">
          <path
            d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
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
      </button>

      <span className="flex-1" />

      {running ? (
        <>
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-col-progress">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current wd-pulse" />
            <span className="max-w-56 truncate">{running.command}</span>
            <span className="shrink-0">· {elapsed}s</span>
          </span>
          <button
            type="button"
            className="pointer-events-auto inline-flex h-5 shrink-0 items-center gap-1.5 rounded-[5px] border border-edge-strong px-1.5 text-[11px] font-medium text-dim hover:bg-raised/70 hover:text-ink"
            onClick={onInterrupt}
          >
            <svg aria-hidden viewBox="0 0 16 16" width="10" height="10">
              <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
            </svg>
            Interrupt
            <span className="font-mono text-[10px] text-faint">⌃C</span>
          </button>
        </>
      ) : runtime.lastExitCode !== undefined ? (
        <span
          className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] ${
            failed ? 'text-danger' : 'text-faint'
          }`}
        >
          {failed ? <span>exit {runtime.lastExitCode}</span> : null}
          {last?.endedAt !== undefined ? (
            <span className="text-faint">
              {failed ? '· ' : ''}
              {formatDuration(last.endedAt - last.startedAt)}
            </span>
          ) : null}
        </span>
      ) : null}

      <div className="pointer-events-auto flex shrink-0 items-center gap-1.5">{children}</div>

      {picking ? (
        <DirectoryPicker
          start={cwd}
          onClose={() => setPicking(false)}
          onChoose={(directory) => {
            setPicking(false)
            onChoose(directory)
          }}
        />
      ) : null}
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
  children
}: {
  session: TerminalSessionInfo
  active: boolean
  theme: ThemeSettings
  bindings: ShortcutBindings
  /** Extension point for future terminal actions and controls. */
  children?: ReactNode
}): ReactNode {
  const [runtime, setRuntime] = useState<TerminalRuntimeState>()

  useEffect(() => {
    let mounted = true
    void window.api.terminal.runtimeState(session.id).then((state) => {
      if (mounted) setRuntime(state)
    })
    const offRuntime = window.api.terminal.onRuntimeState((state) => {
      if (state.sessionId === session.id) setRuntime(state)
    })
    return () => {
      mounted = false
      offRuntime()
    }
  }, [session.id])

  const changeDirectory = (directory: string): void => {
    // The new directory is observed back from the shell integration rather than assumed, and the
    // value is quoted so a path is never interpreted as shell syntax.
    window.api.terminal.write(session.id, `cd -- '${shellQuote(directory)}'\r`)
  }

  // An agent CLI (or any full-screen program) owns the whole panel: no prompt means no bar.
  const showBar = runtime !== undefined && !session.taskId && !runtime.terminated

  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <TerminalView sessionId={session.id} active={active} theme={theme} bindings={bindings} />
      </div>
      {showBar ? (
        <ContextBar
          runtime={runtime}
          fallbackCwd={session.cwd}
          onChoose={changeDirectory}
          onInterrupt={() => window.api.terminal.write(session.id, INTERRUPT)}
        >
          {children}
        </ContextBar>
      ) : null}
    </div>
  )
}
