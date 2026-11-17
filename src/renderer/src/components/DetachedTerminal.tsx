import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AGENT_STATE_LABELS, shownAgentState } from '@core/agentState.js'
import { commandForEvent, shortcutHint } from '@core/shortcuts.js'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  type Task,
  type TerminalSessionInfo,
  type WorkspaceInfo
} from '@core/types.js'
import { useAgents } from '../hooks/useAgents.js'
import { useSettings } from '../hooks/useSettings.js'
import { useTheme } from '../hooks/useTheme.js'
import { AGENT_TONE } from '../lib/agentTone.js'
import { detachedAction } from '../lib/detachedWindow.js'
import { engineChoice } from '../lib/nativeTerminal/engineChoice.js'
import { IS_MAC } from '../lib/platform.js'
import { sessionLabel } from '../lib/sessionLabel.js'
import { dispatchTerminalCommand } from '../lib/terminalCommands.js'
import { isTerminalTarget } from '../lib/terminalKeys.js'
import { useFullscreen } from '../lib/useFullscreen.js'
import { useTerminalRuntimes } from '../lib/useTerminalRuntimes.js'
import { TerminalSurface } from './TerminalSurface.js'
import { Button } from './ui.js'

/**
 * A detached window (`docs/architecture/ui.md`, Detached terminals): one terminal tab, popped out
 * of the main window. The PTY, the agent and the task stay where they were; this window only draws
 * the session, rebuilding its scrollback from the backlog the way any newly mounted view does.
 * Board actions (new tasks, Ask agent, reviews) stay in the main window.
 */
export function DetachedTerminal({ sessionId }: { sessionId: string }): ReactNode {
  const { settings } = useSettings()
  const theme = settings?.theme ?? DEFAULT_THEME
  const bindings = settings?.shortcuts ?? DEFAULT_SHORTCUTS
  useTheme(theme)
  const fullscreen = useFullscreen()
  const agents = useAgents()

  // The engine is picked once, at mount, from the setting and the run's override: both must be in.
  const [engineKnown, setEngineKnown] = useState(false)
  useEffect(() => {
    void engineChoice()
      .availability()
      .then(() => setEngineKnown(true))
  }, [])

  const [session, setSession] = useState<TerminalSessionInfo | null | 'loading'>('loading')
  const [exited, setExited] = useState(false)
  useEffect(() => {
    void window.api.terminal
      .list()
      .then((sessions) => setSession(sessions.find((each) => each.id === sessionId) ?? null))
    return window.api.terminal.onExit(({ id }) => {
      if (id === sessionId) setExited(true)
    })
  }, [sessionId])
  const live = session !== 'loading' && session !== null ? session : null
  const sessions = useMemo(() => (live ? [live] : []), [live])
  const runtime = useTerminalRuntimes(sessions).get(sessionId)

  // Task ids repeat across workspaces: only the active workspace's board describes this task.
  const activeId = settings?.activeWorkspaceId ?? ''
  const ownTask = Boolean(live?.taskId && live.workspaceId === activeId)
  const taskId = ownTask ? live?.taskId : undefined
  const [task, setTask] = useState<Task | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  useEffect(() => {
    const read = (): void =>
      void window.api.workspaces.list().then((overview) => setWorkspaces(overview.workspaces))
    read()
    return window.api.workspaces.onChanged(read)
  }, [])
  useEffect(() => {
    if (!taskId) return setTask(null)
    const read = (): void => void window.api.tasks.get(taskId).then(setTask)
    read()
    return window.api.tasks.onChanged(read)
  }, [taskId])

  const label = live
    ? sessionLabel(live, new Map(task ? [[task.id, task.title]] : []), {
        activeId,
        names: new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
      })
    : null
  const agent = taskId ? agents.get(taskId) : undefined
  // Labelled as the main window labels it (`shownAgentState`).
  const shown = agent ? (task ? shownAgentState(agent.state, task) : agent.state) : undefined

  const name = label?.name
  useEffect(() => {
    document.title = name ? `${name} — Styr` : 'Styr'
  }, [name])

  const dock = useCallback(() => void window.api.terminal.dock(sessionId), [sessionId])
  const close = useCallback(async () => {
    await window.api.terminal.kill(sessionId)
    void window.api.terminal.dock(sessionId)
  }, [sessionId])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const action = detachedAction(
        commandForEvent(bindings, event, {
          terminalFocused: isTerminalTarget(event.target as Element | null)
        })
      )
      if (!action) return
      event.preventDefault()
      if (action === 'dock') return dock()
      if (action === 'close') return void close()
      dispatchTerminalCommand(action.terminal)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bindings, dock, close])

  const dockHint = shortcutHint(bindings, 'terminalDetach')

  return (
    <div className="flex h-full flex-col bg-chrome">
      <header
        className={`flex h-[44px] shrink-0 items-center gap-2.5 border-b border-edge bg-chrome [-webkit-app-region:drag] ${
          IS_MAC ? `${fullscreen ? 'pl-3' : 'pl-[86px]'} pr-3` : 'pl-3 pr-[150px]'
        }`}
      >
        <span
          aria-hidden
          title={agent && shown ? AGENT_STATE_LABELS[shown] : undefined}
          className={`size-[7px] shrink-0 rounded-full bg-current ${
            shown ? AGENT_TONE[shown] : exited ? 'text-faint' : 'text-edge-strong'
          } ${shown === 'working' ? 'wd-pulse' : ''}`}
        />
        <span className="min-w-0 truncate text-[12.5px] font-medium text-ink">
          {label?.name ?? 'Terminal'}
        </span>
        {label?.detail ? (
          <span className="shrink-0 font-mono text-[10.5px] text-dim">{label.detail}</span>
        ) : null}
        {exited ? <span className="shrink-0 text-[11px] text-faint">· exited</span> : null}
        <span className="flex-1" />
        <Button
          variant="subtle"
          className="[-webkit-app-region:no-drag]"
          title={`Dock back into the main window${dockHint ? `  (${dockHint})` : ''}`}
          onClick={dock}
        >
          Dock to main window
        </Button>
      </header>

      <div className="relative min-h-0 flex-1 p-2">
        {session === 'loading' || !settings || !engineKnown ? null : live ? (
          <TerminalSurface
            // Keyed by session: the view is never remounted, so its scrollback stays.
            key={live.id}
            session={live}
            active
            theme={theme}
            bindings={bindings}
            nativeTerminal={settings.experimental.nativeTerminal}
            runtime={runtime}
            agentStatus={agent}
            shownState={shown}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-[12.5px] text-dim">This terminal is no longer running.</p>
            <Button onClick={dock}>Close window</Button>
          </div>
        )}
      </div>
    </div>
  )
}
