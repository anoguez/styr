import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { shownAgents, type AgentState } from '@core/agentState.js'
import { planDraft, terminalDraft } from '@core/derivedTask.js'
import { planningPrompt, planTitle } from '@core/planning.js'
import { sortColumn } from '@core/boardOrder.js'
import { openBlockers } from '@core/blocking.js'
import { resolveTemplateFor } from '@core/prompt.js'
import { commandForEvent, shortcutHint } from '@core/shortcuts.js'
import { IS_MAC } from './lib/platform.js'
import {
  DEFAULT_DONE_CAP,
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  TASK_STATUS_LABELS,
  globalSettingsFor,
  workspaceSettingsFor,
  type AppInfo,
  type OrchestrationSummary,
  type ShortcutCommand,
  type Task,
  type TaskPreset,
  type ThemeSettings
} from '@core/types.js'
import { AgentsSidebar } from './components/AgentsSidebar.js'
import { agentRowsFor, boardSummary } from './lib/agentRows.js'
import { ArchiveDialog } from './components/ArchiveDialog.js'
import { PerformanceDialog } from './components/PerformanceDialog.js'
import { ChangesDialog } from './components/ChangesDialog.js'
import { Board } from './components/Board.js'
import { Inbox } from './components/Inbox.js'
import type { TerminalTaskRequest } from './components/TerminalSurface.js'
import { buildInbox } from '@core/inbox.js'
import { useAutoDispatch } from './hooks/useAutoDispatch.js'
import { OrchestrateDialog, StopAutoRunDialog } from './components/OrchestrateDialog.js'
import { CommandPalette } from './components/CommandPalette.js'
import { StatusBar } from './components/StatusBar.js'
import { useUpdates } from './hooks/useUpdates.js'
import { isTerminalTarget } from './lib/terminalKeys.js'
import { dispatchTerminalCommand } from './lib/terminalCommands.js'
import { SettingsDialog } from './components/SettingsDialog.js'
import { QuickTaskDialog } from './components/QuickTaskDialog.js'
import { TaskDialog } from './components/TaskDialog.js'
import { TerminalPanel } from './components/TerminalPanel.js'
import {
  appShellReducer,
  initialAppShell,
  runShortcutCommand,
  type Toggle,
  type View
} from './lib/appShell.js'
import type { SectionId } from './components/settings/sections.js'
import { buildCommandEntries } from './lib/commandEntries.js'
import { dispatchButton } from './lib/orchestrateHint.js'
import { DispatchingContext, dispatchingIds } from './lib/dispatchRun.js'
import { useTerminalSessions } from './hooks/useTerminalSessions.js'
import { useTerminalHeight } from './hooks/useTerminalHeight.js'
import { Button, Chip, Modal, inputClass } from './components/ui.js'
import { useSettings } from './hooks/useSettings.js'
import { useTheme } from './hooks/useTheme.js'
import { useDiffStats } from './hooks/useDiffStats.js'
import { useTasks } from './hooks/useTasks.js'
import { describeBlockers, taskLookup, TaskLookupContext } from './lib/blockerContext.js'
import { useAgents } from './hooks/useAgents.js'
import { useWorkspaces } from './hooks/useWorkspaces.js'
import {
  NewWorkspaceDialog,
  WorkspaceSwitcher,
  ipcMessage
} from './components/WorkspaceSwitcher.js'
import { fileName } from './lib/terminalPath.js'

const VIEW_KEY = 'styr:view'

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'inbox' ? 'inbox' : 'board'
  } catch {
    return 'board'
  }
}

export default function App(): ReactNode {
  const [query, setQuery] = useState('')
  const [showAllDone, setShowAllDone] = useState(false)
  const { settings, save } = useSettings()
  const {
    board: rawBoard,
    hiddenDone,
    allTasks,
    archived,
    problems,
    loading
  } = useTasks(query, settings?.doneCap ?? DEFAULT_DONE_CAP, showAllDone)
  const agents = useAgents()
  const lookup = useMemo(() => taskLookup(allTasks), [allTasks])
  // What the views label each agent; Dispatch and the PR/review buttons keep the hook's `agents`.
  const shown = useMemo(() => shownAgents(agents, allTasks), [agents, allTasks])
  // Done keeps its recency order; the other columns sort by priority, then working agents.
  const board = useMemo(() => {
    const state = (id: string): AgentState | undefined => agents.get(id)?.state
    return {
      ...rawBoard,
      backlog: sortColumn(rawBoard.backlog, state),
      in_progress: sortColumn(rawBoard.in_progress, state),
      in_review: sortColumn(rawBoard.in_review, state)
    }
  }, [rawBoard, agents])
  const workspaces = useWorkspaces()
  const {
    overview,
    names: workspaceNames,
    activity: workspaceActivity,
    apply: applyWorkspaces
  } = workspaces
  const activeWorkspaceId = settings?.activeWorkspaceId ?? overview.activeId
  const diffStats = useDiffStats(activeWorkspaceId)
  const [pendingActivation, setPendingActivation] = useState<string | null>(null)
  const bindings = settings?.shortcuts ?? DEFAULT_SHORTCUTS
  const [previewTheme, setPreviewTheme] = useState<ThemeSettings | null>(null)
  const activeTheme = previewTheme ?? settings?.theme ?? DEFAULT_THEME
  useTheme(activeTheme)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const update = useUpdates()
  const newVersion =
    update?.kind === 'ready' || update?.kind === 'downloading' ? update.version : undefined
  const [orchestration, setOrchestration] = useState<OrchestrationSummary | null>(null)
  /** Task ids the last Dispatch run started. */
  const [dispatchRun, setDispatchRun] = useState<string[]>([])

  const [shell, dispatch] = useReducer(appShellReducer, undefined, () =>
    initialAppShell(savedView())
  )
  const { view, agentsOpen, taskDialog, changes: changesTask, removingAgent } = shell
  const taskOpen = taskDialog.mode !== 'closed'
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      // Remembering the view is a convenience; a blocked store just means it resets.
    }
  }, [view])

  const {
    sessions,
    activeSession,
    terminalOpen,
    adopt: adoptSession,
    select: setActiveSession,
    reorder: reorderSessions,
    toggleTerminal,
    close: closeSession,
    activateForTask
  } = useTerminalSessions()
  const [terminalExpanded, setTerminalExpanded] = useState(false)
  const { height: terminalHeight, startResize } = useTerminalHeight(terminalOpen)
  const searchRef = useRef<HTMLInputElement>(null)

  const taskTitles = useMemo(
    () =>
      new Map(
        Object.values(board)
          .flat()
          .map((task) => [task.id, task.title])
      ),
    [board]
  )

  const taskStates = useMemo(
    () =>
      new Map(
        Object.values(board)
          .flat()
          .map((task) => [task.id, { status: task.status, prUrl: task.prUrl }] as const)
      ),
    [board]
  )

  const agentRows = useMemo(
    () => agentRowsFor(Object.values(board).flat(), shown, sessions, activeWorkspaceId),
    [board, shown, sessions, activeWorkspaceId]
  )
  const waitingCount = agentRows.filter((row) => row.agent?.state === 'waiting').length

  useEffect(() => {
    void window.api.app.info().then(setAppInfo)
  }, [])

  const newShell = useCallback(
    async (cwd?: string) => {
      adoptSession(
        await window.api.terminal.create({
          cwd: cwd || settings?.defaultRepoPath || settings?.storageDir,
          title: 'shell'
        })
      )
    },
    [adoptSession, settings]
  )

  const askReview = useCallback(
    async (taskId: string) => adoptSession(await window.api.terminal.askReview(taskId)),
    [adoptSession]
  )

  /** Ask in a copy of a task session's chat; false when that session has no saved chat to copy. */
  const askFork = useCallback(
    async (sessionId: string, question: string): Promise<boolean> => {
      const session = await window.api.terminal.askFork(sessionId, question)
      if (!session) return false
      adoptSession(session)
      return true
    },
    [adoptSession]
  )

  const launchAgent = useCallback(
    async (taskId: string, templateId?: string, provider?: 'claude' | 'codex') => {
      // Warn, never refuse: the user may know a blocker is as good as done. A task that already has
      // a chat is being resumed, not started, so it never asks.
      const task = lookup.get(taskId)
      const blockers = task && !task.agentSession ? openBlockers(task, lookup) : []
      if (
        blockers.length > 0 &&
        !window.confirm(
          `${taskId} is blocked by ${describeBlockers(blockers, (blocker) => TASK_STATUS_LABELS[blocker.status])}. Start anyway?`
        )
      ) {
        return
      }
      try {
        adoptSession(await window.api.terminal.launchAgent(taskId, templateId, provider))
      } catch (error) {
        // A refused launch (an unsupported Codex install, a disabled provider) says what to fix.
        const message = error instanceof Error ? error.message : String(error)
        window.alert(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      }
    },
    [adoptSession, lookup]
  )

  /** Output the user wants an agent to look at becomes a Backlog task that carries it. */
  const createTaskFromTerminal = useCallback(
    async (request: TerminalTaskRequest): Promise<string> => {
      if (!settings) throw new Error('Settings have not loaded yet')
      const task = await window.api.tasks.create(terminalDraft(request, settings))
      if (request.launch) await launchAgent(task.id)
      return task.id
    },
    [settings, launchAgent]
  )

  /** ⌘↵ in Quick add: an agent splits the request into tasks; the throwaway task is archived after. */
  const planTasks = useCallback(
    async (request: string, preset?: TaskPreset): Promise<void> => {
      if (!settings) throw new Error('Settings have not loaded yet')
      const task = await window.api.tasks.create(
        planDraft(
          { title: planTitle(request), description: planningPrompt(request, preset) },
          settings
        )
      )
      await launchAgent(task.id)
    },
    [settings, launchAgent]
  )

  const activateTask = useCallback(
    (taskId: string) => {
      if (!activateForTask(taskId, activeWorkspaceId)) void launchAgent(taskId)
    },
    [activateForTask, launchAgent, activeWorkspaceId]
  )

  // A request can name a task of a workspace that is still loading (the menu bar switches first),
  // so it waits for the board to hold the task. If it never does — a search can hide it — it runs
  // anyway, because the main process finds tasks in the index, not on the board.
  useEffect(() => window.api.tasks.onActivateRequested(setPendingActivation), [])
  useEffect(() => {
    if (!pendingActivation) return
    const onBoard = Object.values(board)
      .flat()
      .some((task) => task.id === pendingActivation)
    const run = (): void => {
      setPendingActivation(null)
      activateTask(pendingActivation)
    }
    if (onBoard) return run()
    const timer = setTimeout(run, 1500)
    return () => clearTimeout(timer)
  }, [pendingActivation, board, activateTask])

  const switchWorkspace = useCallback(
    async (id: string) => {
      if (id === activeWorkspaceId) return
      if (taskOpen && !window.confirm('Discard the open task and switch workspace?')) {
        return
      }
      try {
        applyWorkspaces(await window.api.workspaces.switch(id))
      } catch (error) {
        window.alert(ipcMessage(error))
      }
    },
    [activeWorkspaceId, applyWorkspaces, taskOpen]
  )

  // Nothing carries over from one workspace to the next: not an open task, not a search.
  useEffect(() => {
    dispatch({ type: 'workspaceChanged' })
    setQuery('')
  }, [activeWorkspaceId])

  const refreshOrchestration = useCallback(() => {
    void window.api.orchestrate.plan().then(setOrchestration)
  }, [])

  useEffect(refreshOrchestration, [refreshOrchestration, board, sessions, agents])

  const runOrchestrate = useCallback(
    async (taskIds: string[]) => {
      dispatch({ type: 'set', toggle: 'confirmDispatch', open: false })
      const started = await window.api.orchestrate.run(taskIds)
      for (const entry of started) adoptSession(entry.session)
      setDispatchRun(started.map((entry) => entry.taskId))
      refreshOrchestration()
    },
    [adoptSession, refreshOrchestration]
  )

  // Task ids repeat across workspaces, so a run belongs to the workspace it started in.
  useEffect(() => setDispatchRun([]), [activeWorkspaceId])
  const dispatching = useMemo(
    () => dispatchingIds(dispatchRun, agents, sessions, activeWorkspaceId),
    [dispatchRun, agents, sessions, activeWorkspaceId]
  )
  const isDispatching = dispatching.size > 0

  const autoDispatch = useAutoDispatch(activeWorkspaceId)
  const { state: autoDispatchState, setOn: setAutoDispatch } = autoDispatch
  // Start the listed tasks before switching Auto-run on, so its first pass does not race them.
  const confirmOrchestrate = useCallback(
    async (summary: OrchestrationSummary, autoOn: boolean) => {
      dispatch({ type: 'set', toggle: 'confirmDispatch', open: false })
      if (summary.dispatch.length > 0)
        await runOrchestrate(summary.dispatch.map((entry) => entry.taskId))
      if (autoOn !== autoDispatchState.on) setAutoDispatch(autoOn)
    },
    [runOrchestrate, autoDispatchState.on, setAutoDispatch]
  )
  useEffect(() => window.api.orchestrate.onAutoStarted(adoptSession), [adoptSession])
  const dispatchState = useMemo(
    () => dispatchButton(orchestration, autoDispatch.state, isDispatching),
    [orchestration, autoDispatch.state, isDispatching]
  )
  // A manual run and Auto-run both light the button and the header's sweep.
  const dispatchLive = dispatchState.mode === 'dispatching' || dispatchState.mode === 'auto'
  const { setOn: setAutoOn } = autoDispatch

  const runCommand = useCallback(
    (command: ShortcutCommand) =>
      runShortcutCommand(command, {
        dispatch,
        focusSearch: () => {
          searchRef.current?.focus()
          searchRef.current?.select()
        },
        toggleTerminal,
        autoRunOn: autoDispatch.state.on,
        startAutoRun: () => setAutoOn(true),
        newShell: () => void newShell(),
        sessions,
        activeSession,
        selectSession: setActiveSession,
        closeSession: (id) => void closeSession(id),
        terminal: dispatchTerminalCommand
      }),
    [
      autoDispatch.state.on,
      setAutoOn,
      newShell,
      closeSession,
      activeSession,
      sessions,
      toggleTerminal,
      setActiveSession
    ]
  )

  const commandEntries = useMemo(
    () =>
      buildCommandEntries(
        {
          tasks: Object.values(board).flat(),
          agentRows,
          sessions,
          taskTitles,
          withChanges: diffStats,
          archivedCount: archived.length,
          presets: settings?.taskPresets ?? [],
          experimental: settings?.experimental,
          bindings,
          workspaces: overview.workspaces,
          activeWorkspaceId,
          workspaceNames,
          terminalOpen,
          agentsOpen,
          autoRunOn: autoDispatch.state.on
        },
        {
          dispatch,
          runCommand,
          switchWorkspace: (id) => void switchWorkspace(id),
          archiveTask: (taskId) => void window.api.tasks.archive(taskId, true),
          launchAgent: (taskId) => void launchAgent(taskId),
          activateTask,
          selectSession: setActiveSession
        }
      ),
    [
      board,
      autoDispatch.state.on,
      settings?.experimental,
      settings?.taskPresets,
      archived.length,
      diffStats,
      agentRows,
      sessions,
      taskTitles,
      terminalOpen,
      agentsOpen,
      bindings,
      runCommand,
      setActiveSession,
      launchAgent,
      activateTask,
      overview,
      activeWorkspaceId,
      workspaceNames,
      switchWorkspace
    ]
  )

  const queued = useMemo(
    () =>
      new Map(
        (orchestration?.dispatch ?? []).map((entry, index) => [
          entry.taskId,
          { position: index + 1, lane: entry.lane }
        ])
      ),
    [orchestration]
  )

  const queuedPositions = useMemo(
    () => new Map([...queued].map(([id, entry]) => [id, entry.position])),
    [queued]
  )
  const needsYou = useMemo(
    () => buildInbox(Object.values(board).flat(), agents, queuedPositions, allTasks).needs.length,
    [board, agents, queuedPositions, allTasks]
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') return dispatch({ type: 'escape' })
      // The Changes viewer is modal: its own keys (J/K, arrows) and ⌘ combos must not reach the board.
      if (changesTask) return
      const command = commandForEvent(bindings, event, {
        terminalFocused: isTerminalTarget(event.target as Element | null)
      })
      if (!command) return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bindings, runCommand, changesTask])

  if (!settings) return <div className="p-6 text-muted">Loading…</div>

  const toggle = (name: Toggle, open: boolean): void =>
    dispatch({ type: 'set', toggle: name, open })
  const openSettings = (section?: SectionId): void => dispatch({ type: 'openSettings', section })
  const editTask = (task: Task): void => dispatch({ type: 'editTask', task })
  const showChanges = (task: Task): void => dispatch({ type: 'showChanges', task })

  return (
    <TaskLookupContext.Provider value={lookup}>
      <DispatchingContext.Provider value={dispatching}>
        <div className="flex h-full flex-col">
          <header
            // Styr is laid out for macOS, where the window controls sit on the left beside the brand.
            // Windows and Linux draw them on the right, so the bar is mirrored there: the brand moves
            // next to the controls and New task to the far edge. Positions mirror; the insides of a
            // control (the logo and wordmark, Board | Inbox, text) never do.
            className={`relative flex h-[44px] shrink-0 items-center gap-3 border-b border-edge bg-chrome [-webkit-app-region:drag] ${IS_MAC ? 'pl-[86px] pr-3' : 'flex-row-reverse pl-3 pr-[150px]'}`}
          >
            {/* On macOS these wrappers are `contents`: no box, so the bar lays out exactly as before. */}
            <div
              className={IS_MAC ? 'contents' : 'flex min-w-0 flex-row-reverse items-center gap-3'}
            >
              <span className={IS_MAC ? 'contents' : 'flex shrink-0 items-center gap-3'}>
                <span
                  aria-hidden
                  className="grid size-[22px] shrink-0 place-items-center rounded-[6px] bg-accent/15"
                >
                  {/* The app icon's rune. Its gradient runs between theme colours rather than the icon's
              fixed ones, which match them at the default theme, so it follows a re-theme. */}
                  <svg viewBox="0 0 16 16" className="size-[15px]">
                    <defs>
                      <linearGradient id="styr-mark" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" style={{ stopColor: 'var(--color-accent-text)' }} />
                        <stop offset="1" style={{ stopColor: 'var(--color-col-progress)' }} />
                      </linearGradient>
                    </defs>
                    <polyline
                      points="5.6,2.6 5.6,8.4 10.4,7 10.4,13.4"
                      transform="rotate(30 8 8)"
                      fill="none"
                      stroke="url(#styr-mark)"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="font-wordmark -ml-1 text-[13.5px] font-semibold tracking-[0.02em] text-ink">
                  Styr
                </span>
              </span>
              {appInfo ? (
                <button
                  type="button"
                  className={`text-[11px] [-webkit-app-region:no-drag] ${
                    newVersion
                      ? 'font-medium text-accent hover:underline'
                      : 'text-faint hover:text-dim'
                  }`}
                  title={
                    newVersion
                      ? `Styr ${newVersion} is ${update?.kind === 'ready' ? 'ready to install' : 'downloading'} — open Settings`
                      : 'Updates'
                  }
                  onClick={() => openSettings('updates')}
                >
                  v{appInfo.version}
                </button>
              ) : null}
              {appInfo && !appInfo.isPackaged ? (
                <Chip tone="warn" title={`Running from source · v${appInfo.version}`}>
                  DEV
                </Chip>
              ) : null}

              <WorkspaceSwitcher
                overview={overview}
                activity={workspaceActivity}
                open={shell.switcher}
                onOpenChange={(open) => toggle('switcher', open)}
                onSwitch={(id) => void switchWorkspace(id)}
                onNew={() => toggle('newWorkspace', true)}
                onManage={() => openSettings('workspaces')}
              />
            </div>

            <div className="flex flex-1 justify-center">
              <div className="relative w-full max-w-md [-webkit-app-region:no-drag]">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
                  ⌕
                </span>
                <input
                  ref={searchRef}
                  className={`${inputClass} h-7 py-0 pl-8 pr-12`}
                  value={query}
                  placeholder="Search tasks"
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-ink"
                    onClick={() => setQuery('')}
                  >
                    ✕
                  </button>
                ) : (
                  <kbd className="pointer-events-none absolute right-2 top-1/2 inline-flex h-[18px] -translate-y-1/2 items-center rounded border border-edge-strong px-[5px] font-mono text-[10.5px] text-faint">
                    {shortcutHint(bindings, 'focusSearch')}
                  </kbd>
                )}
              </div>
            </div>

            <div
              className={`flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag] ${IS_MAC ? '' : 'flex-row-reverse'}`}
            >
              <div
                role="tablist"
                aria-label="View"
                className="flex h-7 items-center gap-0.5 rounded-lg border border-edge-strong bg-chrome p-0.5"
              >
                {(
                  [
                    { id: 'board', label: 'Board', command: 'viewBoard' },
                    { id: 'inbox', label: 'Inbox', command: 'viewInbox' }
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={view === tab.id}
                    title={`${tab.label} view ${shortcutHint(bindings, tab.command)}`.trim()}
                    onClick={() => dispatch({ type: 'setView', view: tab.id })}
                    className={`inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium transition-colors ${
                      view === tab.id
                        ? 'border-edge-strong bg-raised text-ink'
                        : 'border-transparent text-dim hover:text-ink'
                    }`}
                  >
                    {tab.label}
                    {tab.id === 'inbox' && needsYou > 0 ? (
                      <span className="rounded-[5px] bg-[var(--color-col-review)]/15 px-[5px] font-mono text-[10.5px] font-semibold leading-4 text-[var(--color-col-review-text)]">
                        {needsYou}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
              <span aria-hidden className="h-[18px] w-px bg-edge" />
              <Button
                onClick={() => toggle('confirmDispatch', true)}
                disabled={orchestration === null}
                title={dispatchState.title}
                className={dispatchLive ? 'dispatch-running disabled:opacity-100' : ''}
              >
                {dispatchLive ? (
                  <span
                    aria-hidden
                    className="size-[7px] shrink-0 animate-pulse rounded-full bg-[var(--color-accent-text)]"
                  />
                ) : dispatchState.mode === 'paused' ? (
                  <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-danger" />
                ) : (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M13.5 2.5 2.5 7l4.5 2 2 4.5z" />
                    <path d="M13.5 2.5 7 9" />
                  </svg>
                )}
                {dispatchState.label}
                {dispatchState.badge > 0 ? (
                  <span className="inline-flex h-[18px] items-center rounded-md bg-accent/20 px-1.5 font-mono text-[10.5px] font-semibold text-[var(--color-accent-text)]">
                    {dispatchState.mode === 'auto'
                      ? `${dispatchState.badge} running`
                      : dispatchState.badge}
                  </span>
                ) : null}
              </Button>
              <Button variant="primary" onClick={() => dispatch({ type: 'newTask' })}>
                New task
              </Button>
            </div>
            {dispatchLive ? (
              <span
                aria-hidden
                className="dispatch-sweep pointer-events-none absolute inset-x-0 -bottom-px h-0.5"
              />
            ) : null}
          </header>

          {problems.length > 0 ? (
            <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
              <p className="text-[12px] text-amber-200">
                {problems.length} task file{problems.length === 1 ? '' : 's'} could not be read and{' '}
                {problems.length === 1 ? 'is' : 'are'} hidden from the board. Nothing was changed on
                disk — fix the frontmatter and {problems.length === 1 ? 'it' : 'they'} will
                reappear.
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {problems.map((problem) => (
                  <li key={problem.filePath} className="font-mono text-[10px] text-amber-200/70">
                    {fileName(problem.filePath)} — {problem.reason.split('\n')[0]}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <main
                className="flex min-h-0 flex-1 flex-col"
                hidden={terminalOpen && terminalExpanded}
              >
                {loading ? (
                  <p className="p-6 text-dim">Loading board…</p>
                ) : view === 'inbox' ? (
                  <Inbox
                    tasks={Object.values(board).flat()}
                    allTasks={allTasks}
                    agents={agents}
                    queued={queuedPositions}
                    diffStats={diffStats}
                    onOpen={editTask}
                    onLaunch={(task) => void launchAgent(task.id)}
                    onActivate={(task) => activateTask(task.id)}
                    onShowChanges={showChanges}
                    onMove={(task, status) => void window.api.tasks.update(task.id, { status })}
                    onArchive={(task) => void window.api.tasks.archive(task.id, !task.archivedAt)}
                  />
                ) : (
                  <Board
                    board={board}
                    agents={shown}
                    queued={queued}
                    onOpen={editTask}
                    onLaunch={(task) => void launchAgent(task.id)}
                    onArchive={(task) => void window.api.tasks.archive(task.id, !task.archivedAt)}
                    onShowChanges={showChanges}
                    onOpenTerminal={(task) =>
                      void window.api.terminal
                        .create({ cwd: task.worktreePath || task.repoPath, title: task.id })
                        .then(adoptSession)
                    }
                    diffStats={diffStats}
                    onQuickAdd={() => toggle('quickAdd', true)}
                    doneFooter={
                      hiddenDone > 0 || showAllDone || archived.length > 0 ? (
                        <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-1 text-[11px] text-faint">
                          {hiddenDone > 0 || showAllDone ? (
                            <button
                              type="button"
                              className="hover:text-ink"
                              onClick={() => setShowAllDone((open) => !open)}
                            >
                              {showAllDone ? 'Show fewer' : `${hiddenDone} older hidden — Show all`}
                            </button>
                          ) : null}
                          {archived.length > 0 ? (
                            <button
                              type="button"
                              className="hover:text-ink"
                              onClick={() => toggle('archive', true)}
                            >
                              {archived.length} archived — View
                            </button>
                          ) : null}
                        </div>
                      ) : undefined
                    }
                    templateNameFor={(task) => resolveTemplateFor(settings, task).name}
                  />
                )}
              </main>

              {terminalOpen ? (
                <>
                  {terminalExpanded ? null : (
                    <div
                      className="h-1 shrink-0 cursor-row-resize bg-edge/60 hover:bg-accent/60"
                      onMouseDown={startResize}
                    />
                  )}
                  <div
                    className={terminalExpanded ? 'min-h-0 flex-1' : 'shrink-0'}
                    style={terminalExpanded ? undefined : { height: terminalHeight }}
                  >
                    <TerminalPanel
                      sessions={sessions}
                      agents={agents}
                      shownAgents={shown}
                      activeId={activeSession}
                      expanded={terminalExpanded}
                      theme={activeTheme}
                      bindings={bindings}
                      taskTitles={taskTitles}
                      taskStates={taskStates}
                      diffStats={diffStats}
                      onShowChanges={(taskId) => {
                        const task = allTasks.find((candidate) => candidate.id === taskId)
                        if (task) showChanges(task)
                      }}
                      onAskReview={askReview}
                      onAskFork={askFork}
                      workspaces={{ activeId: activeWorkspaceId, names: workspaceNames }}
                      onToggleExpand={() => setTerminalExpanded((open) => !open)}
                      onSelect={setActiveSession}
                      onReorder={reorderSessions}
                      onNewSession={(cwd) => void newShell(cwd)}
                      onCreateTask={createTaskFromTerminal}
                      onCloseSession={(id) => void closeSession(id)}
                    />
                  </div>
                </>
              ) : null}
            </div>

            {agentsOpen ? (
              <AgentsSidebar
                rows={agentRows}
                diffStats={diffStats}
                onShowChanges={showChanges}
                onOpenTask={editTask}
                onRemove={(row) => dispatch({ type: 'confirmRemoveAgent', row })}
                onClose={() => dispatch({ type: 'closeAgents' })}
                onActivate={(row) => activateTask(row.task.id)}
              />
            ) : null}
          </div>

          <StatusBar
            agentsOpen={agentsOpen}
            terminalOpen={terminalOpen}
            agentCount={agentRows.length}
            waitingCount={waitingCount}
            sessionCount={sessions.length}
            summary={boardSummary(board, agentRows)}
            bindings={bindings}
            readyUpdate={update?.kind === 'ready' ? update.version : undefined}
            onToggleAgents={() => runCommand('toggleAgents')}
            onToggleTerminal={() => runCommand('toggleTerminal')}
            onOpenSettings={() => openSettings()}
            onInstallUpdate={() => void window.api.updates.install()}
          />

          {shell.newWorkspace ? (
            <NewWorkspaceDialog
              onCreate={async (name) => applyWorkspaces(await window.api.workspaces.create(name))}
              onClose={() => toggle('newWorkspace', false)}
            />
          ) : null}

          {shell.palette ? (
            <CommandPalette
              // a different mode is a fresh palette, so the query starts empty
              key={shell.palette}
              entries={commandEntries}
              initialMode={shell.palette}
              onClose={() => dispatch({ type: 'closePalette' })}
            />
          ) : null}

          {shell.performance ? (
            <PerformanceDialog onClose={() => toggle('performance', false)} />
          ) : null}

          {shell.archive ? (
            <ArchiveDialog
              tasks={archived}
              onOpen={(task) => dispatch({ type: 'openArchived', task })}
              onClose={() => toggle('archive', false)}
            />
          ) : null}

          {shell.confirmDispatch && orchestration ? (
            <OrchestrateDialog
              summary={orchestration}
              auto={autoDispatch.state}
              onAutoStop={() => setAutoDispatch(false)}
              onClose={() => toggle('confirmDispatch', false)}
              onConfirm={(autoOn) => void confirmOrchestrate(orchestration, autoOn)}
            />
          ) : null}

          {shell.confirmAutoStop ? (
            <StopAutoRunDialog
              onClose={() => toggle('confirmAutoStop', false)}
              onConfirm={() => {
                toggle('confirmAutoStop', false)
                setAutoOn(false)
              }}
            />
          ) : null}

          {removingAgent ? (
            <Modal
              title="Remove this agent?"
              subtitle={`${removingAgent.task.id} · ${removingAgent.task.title}`}
              onClose={() => dispatch({ type: 'confirmRemoveAgent', row: null })}
              footer={
                <>
                  <Button onClick={() => dispatch({ type: 'confirmRemoveAgent', row: null })}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      const { task } = removingAgent
                      dispatch({ type: 'confirmRemoveAgent', row: null })
                      void window.api.agents.remove(task.id)
                    }}
                  >
                    Remove
                  </Button>
                </>
              }
            >
              <p className="text-[12.5px] text-dim">
                {removingAgent.session
                  ? 'Its terminal is closed and the chat is forgotten. '
                  : 'The chat is forgotten. '}
                The task and its worktree are kept, and you can start a new agent on it later.
              </p>
            </Modal>
          ) : null}

          {shell.quickAdd ? (
            <QuickTaskDialog
              settings={settings}
              onPlan={planTasks}
              onClose={() => toggle('quickAdd', false)}
            />
          ) : null}

          {taskDialog.mode !== 'closed' ? (
            <TaskDialog
              task={taskDialog.mode === 'edit' ? taskDialog.task : null}
              allTasks={allTasks}
              settings={settings}
              presetId={taskDialog.mode === 'new' ? taskDialog.presetId : undefined}
              onSavePresets={(taskPresets) =>
                save({
                  workspaceId: settings.activeWorkspaceId,
                  workspace: { ...workspaceSettingsFor(settings), taskPresets },
                  global: globalSettingsFor(settings)
                })
              }
              onClose={() => dispatch({ type: 'closeTask' })}
              onLaunch={(taskId, templateId, provider) =>
                void launchAgent(taskId, templateId, provider)
              }
              onResumeSession={(taskId, sessionId) => {
                void window.api.terminal.resumeSession(taskId, sessionId).then(adoptSession)
              }}
              onShowChanges={showChanges}
            />
          ) : null}

          {changesTask ? (
            <ChangesDialog
              task={changesTask}
              onClose={() => dispatch({ type: 'showChanges', task: null })}
            />
          ) : null}

          {shell.settings ? (
            <SettingsDialog
              settings={settings}
              workspaces={workspaces}
              initialSection={shell.settings.section}
              onSave={save}
              onPreviewTheme={setPreviewTheme}
              onClose={() => {
                setPreviewTheme(null)
                dispatch({ type: 'closeSettings' })
              }}
            />
          ) : null}
        </div>
      </DispatchingContext.Provider>
    </TaskLookupContext.Provider>
  )
}
