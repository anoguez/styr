import { useEffect, useState, type ReactNode } from 'react'
import { shellQuote } from '@core/shell.js'
import type {
  ShortcutBindings,
  TerminalRuntimeState,
  TerminalSessionInfo,
  ThemeSettings
} from '@core/types.js'
import { TerminalView } from './TerminalView.js'

function RuntimeOverlay({
  runtime,
  onChooseDirectory,
  children
}: {
  runtime?: TerminalRuntimeState
  onChooseDirectory: () => void
  children?: ReactNode
}): ReactNode {
  const command = runtime?.runningCommand
  const exitCode = runtime?.lastExitCode

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-2">
      <button
        type="button"
        className="pointer-events-auto max-w-[50%] truncate rounded border border-edge bg-chrome/95 px-2 py-1 font-mono text-[10px] text-dim shadow-sm hover:border-edge-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        title={runtime?.cwd ?? 'Choose a working directory'}
        onClick={onChooseDirectory}
      >
        {runtime?.cwd ?? 'Choose directory'}
      </button>
      <div className="pointer-events-auto flex items-center gap-1.5">
        {command ? (
          <span className="max-w-56 truncate rounded bg-chrome/95 px-2 py-1 font-mono text-[10px] text-dim">
            {command.command}
          </span>
        ) : exitCode !== undefined ? (
          <span
            className={`rounded bg-chrome/95 px-2 py-1 font-mono text-[10px] ${
              exitCode === 0 ? 'text-emerald-400' : 'text-red-300'
            }`}
          >
            exit {exitCode}
          </span>
        ) : null}
        {children}
      </div>
    </div>
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

  const chooseDirectory = async (): Promise<void> => {
    const directory = await window.api.settings.pickDirectory(runtime?.cwd ?? session.cwd)
    if (!directory) return
    // Changing directory must be observed back from the shell integration. The quoted value never
    // interpolates a filesystem path as shell syntax.
    window.api.terminal.write(session.id, `cd -- '${shellQuote(directory)}'\r`)
  }

  return (
    <div className="relative h-full w-full">
      <TerminalView sessionId={session.id} active={active} theme={theme} bindings={bindings} />
      <RuntimeOverlay runtime={runtime} onChooseDirectory={chooseDirectory}>
        {children}
      </RuntimeOverlay>
    </div>
  )
}
