import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENT_STATE_LABELS, isAgentArchived, type AgentState } from '@core/agentState.js'
import { terminalDraft } from '@core/derivedTask.js'
import { openTaskCounts } from '@core/boardCounts.js'
import { sortColumn } from '@core/boardOrder.js'
import { openBlockers } from '@core/blocking.js'
import { resolveTemplateFor } from '@core/prompt.js'
import { commandForEvent, SHORTCUT_LABELS, shortcutHint } from '@core/shortcuts.js'
import {
  DEFAULT_DONE_CAP,
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  SHORTCUT_COMMANDS,
  TASK_STATUS_LABELS,
  globalSettingsFor,
  workspaceSettingsFor,
  type AppInfo,
  type OrchestrationSummary,
  type ShortcutCommand,
  type Task,
  type ThemeSettings
} from '@core/types.js'
import { AgentsSidebar, sortAgentRows, type AgentRow } from './components/AgentsSidebar.js'
import { ArchiveDialog } from './components/ArchiveDialog.js'
import { PerformanceDialog } from './components/PerformanceDialog.js'
import { ChangesDialog } from './components/ChangesDialog.js'
import { Board } from './components/Board.js'
import { Inbox } from './components/Inbox.js'
import type { TerminalTaskRequest } from './components/TerminalSurface.js'
import { buildInbox } from '@core/inbox.js'
import { OrchestrateDialog } from './components/OrchestrateDialog.js'
import { CommandPalette, type CommandEntry, type PaletteMode } from './components/CommandPalette.js'
import { StatusBar } from './components/StatusBar.js'
import { useUpdates } from './hooks/useUpdates.js'
import { isTerminalTarget } from './lib/terminalKeys.js'
import { dispatchTerminalCommand } from './lib/terminalCommands.js'
import { SECTIONS, SettingsDialog, type SectionId } from './components/SettingsDialog.js'
import { QuickTaskDialog } from './components/QuickTaskDialog.js'
import { TaskDialog } from './components/TaskDialog.js'
import { TerminalPanel } from './components/TerminalPanel.js'
import { sessionLabel } from './lib/sessionLabel.js'
import { orchestrateHint } from './lib/orchestrateHint.js'
import { DispatchingContext, dispatchingIds } from './lib/dispatchRun.js'
import { useTerminalSessions } from './hooks/useTerminalSessions.js'
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

const VIEW_KEY = 'styr:view'

type View = 'board' | 'inbox'

function savedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'inbox' ? 'inbox' : 'board'
  } catch {
    return 'board'
  }
}

const MIN_TERMINAL_HEIGHT = 140
const MIN_BOARD_HEIGHT = 220
const TERMINAL_OPEN_RATIO = 0.45

function preferredTerminalHeight(): number {
  return Math.round(window.innerHeight * TERMINAL_OPEN_RATIO)
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
  const { overview, names: workspaceNames, apply: applyWorkspaces } = workspaces
  const activeWorkspaceId = settings?.activeWorkspaceId ?? overview.activeId
  const diffStats = useDiffStats(activeWorkspaceId)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
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
  const [confirmingOrchestrate, setConfirmingOrchestrate] = useState(false)
  /** Task ids the last Dispatch run started. */
  const [dispatchRun, setDispatchRun] = useState<string[]>([])
  const [removingAgent, setRemovingAgent] = useState<AgentRow | null>(null)

  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)
  /** The preset the New task dialog opens with, when it was started from the palette. */
  const [creatingPreset, setCreatingPreset] = useState<string | undefined>()
  const [quickAdding, setQuickAdding] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined)
  const [paletteMode, setPaletteMode] = useState<PaletteMode | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [performanceOpen, setPerformanceOpen] = useState(false)
  const [view, setView] = useState<View>(savedView)
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view)
    } catch {
      // Remembering the view is a convenience; a blocked store just means it resets.
    }
  }, [view])
  const [changesTask, setChangesTask] = useState<Task | null>(null)

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
  const [agentsOpen, setAgentsOpen] = useState(true)
  const [terminalExpanded, setTerminalExpanded] = useState(false)
  const [terminalHeight, setTerminalHeight] = useState(preferredTerminalHeight)
  const dragging = useRef(false)
  const manuallyResized = useRef(false)
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

  const agentRows = useMemo<AgentRow[]>(() => {
    const tasks = Object.values(board).flat()
    return sortAgentRows(
      tasks
        .filter((task) => agents.has(task.id) || task.agentSession)
        .filter((task) => !isAgentArchived(task))
        .map((task) => ({
          task,
          agent: agents.get(task.id),
          session: sessions.find(
            (session) => session.taskId === task.id && session.workspaceId === activeWorkspaceId
          )
        }))
    )
  }, [board, agents, sessions, activeWorkspaceId])

  const counts = useMemo(
    () => ({
      ...openTaskCounts(board),
      waiting: agentRows.filter((row) => row.agent?.state === 'waiting').length,
      working: agentRows.filter((row) => row.agent?.state === 'working').length
    }),
    [board, agentRows]
  )

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
      if ((creating || editing) && !window.confirm('Discard the open task and switch workspace?')) {
        return
      }
      try {
        applyWorkspaces(await window.api.workspaces.switch(id))
      } catch (error) {
        window.alert(ipcMessage(error))
      }
    },
    [activeWorkspaceId, applyWorkspaces, creating, editing]
  )

  // Nothing carries over from one workspace to the next: not an open task, not a search.
  useEffect(() => {
    setEditing(null)
    setCreating(false)
    setQuery('')
  }, [activeWorkspaceId])

  const refreshOrchestration = useCallback(() => {
    void window.api.orchestrate.plan().then(setOrchestration)
  }, [])

  useEffect(refreshOrchestration, [refreshOrchestration, board, sessions, agents])

  const runOrchestrate = useCallback(
    async (taskIds: string[]) => {
      setConfirmingOrchestrate(false)
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

  const orchestrateTitle = useMemo(() => orchestrateHint(orchestration), [orchestration])

  const openSettings = useCallback((section?: SectionId) => {
    setSettingsSection(section)
    setShowSettings(true)
  }, [])

  const runCommand = useCallback(
    (command: ShortcutCommand) => {
      switch (command) {
        case 'newTask':
          setCreatingPreset(undefined)
          return setCreating(true)
        case 'quickTask':
          return setQuickAdding(true)
        case 'quickOpen':
          return setPaletteMode((mode) => (mode === 'go' ? null : 'go'))
        case 'commandPalette':
          return setPaletteMode((mode) => (mode === 'command' ? null : 'command'))
        case 'focusSearch':
          searchRef.current?.focus()
          return searchRef.current?.select()
        case 'viewBoard':
          return setView('board')
        case 'viewInbox':
          return setView('inbox')
        case 'settings':
          return openSettings()
        case 'toggleTerminal':
          return toggleTerminal()
        case 'toggleAgents':
          return setAgentsOpen((open) => !open)
        case 'orchestrate':
          return setConfirmingOrchestrate(true)
        case 'newShell':
          return void newShell()
        case 'closeShell':
          return activeSession ? void closeSession(activeSession) : undefined
        case 'switchWorkspace':
          return setSwitcherOpen(true)
        case 'newWorkspace':
          return setCreatingWorkspace(true)
        case 'terminalTab1':
        case 'terminalTab2':
        case 'terminalTab3':
        case 'terminalTab4':
        case 'terminalTab5':
        case 'terminalTab6':
        case 'terminalTab7':
        case 'terminalTab8':
        case 'terminalTab9': {
          // Tab N, as in a browser; with no such tab the key does nothing.
          const target = sessions[Number(command.slice('terminalTab'.length)) - 1]
          if (!target) return
          return setActiveSession(target.id)
        }
        case 'terminalDirectory':
        case 'terminalAskAgent':
        case 'terminalCopyOutput':
        case 'terminalRetry':
        case 'terminalSplit':
        case 'terminalAskReview':
        case 'terminalHandOff':
        case 'terminalCreatePr':
          // The active terminal owns what these act on; it answers the event.
          return dispatchTerminalCommand(command)
      }
    },
    [
      openSettings,
      newShell,
      closeSession,
      activeSession,
      sessions,
      toggleTerminal,
      setActiveSession
    ]
  )

  const commandEntries = useMemo<CommandEntry[]>(() => {
    const tasks = Object.values(board).flat()
    const dynamicLabels: Partial<Record<ShortcutCommand, string>> = {
      toggleTerminal: terminalOpen ? 'Hide terminal' : 'Show terminal',
      toggleAgents: agentsOpen ? 'Hide agents sidebar' : 'Show agents sidebar',
      orchestrate: 'Dispatch — start waiting work'
    }
    const keywords: Partial<Record<ShortcutCommand, string>> = {
      orchestrate: 'orchestrate run agents',
      newShell: 'terminal session',
      closeShell: 'terminal session kill',
      settings: 'preferences options',
      quickTask: 'new capture backlog idea'
    }
    const entries: CommandEntry[] = SHORTCUT_COMMANDS.map((command) => ({
      id: `cmd:${command}`,
      label: dynamicLabels[command] ?? SHORTCUT_LABELS[command],
      group: 'Actions',
      mode: 'command',
      hint: shortcutHint(bindings, command),
      keywords: keywords[command],
      run: () => runCommand(command)
    }))

    for (const preset of settings?.taskPresets ?? []) {
      entries.push({
        id: `preset:${preset.id}`,
        mode: 'command',
        label: `New task from preset: ${preset.name}`,
        group: 'Actions',
        keywords: 'new task template preset',
        run: () => {
          setCreatingPreset(preset.id)
          setCreating(true)
        }
      })
    }

    for (const workspace of overview.workspaces) {
      if (workspace.id === activeWorkspaceId) continue
      entries.push({
        id: `workspace:${workspace.id}`,
        label: `Switch to ${workspace.name}`,
        group: 'Workspaces',
        mode: 'command',
        hint: `${workspace.taskCount} task${workspace.taskCount === 1 ? '' : 's'}`,
        keywords: 'workspace board switch',
        run: () => void switchWorkspace(workspace.id)
      })
    }
    entries.push({
      id: 'view:performance',
      label: 'Show performance',
      group: 'Actions',
      mode: 'command',
      keywords: 'slow cpu memory profile diagnostics usage lag',
      run: () => setPerformanceOpen(true)
    })
    entries.push({
      id: 'view:archive',
      label: `View archive (${archived.length})`,
      group: 'Actions',
      mode: 'command',
      keywords: 'archived unarchive restore',
      run: () => setArchiveOpen(true)
    })

    for (const task of tasks) {
      if (task.status === 'done') {
        entries.push({
          id: `archive:${task.id}`,
          label: `Archive — ${task.title}`,
          group: 'Tasks',
          mode: 'command',
          hint: task.id,
          keywords: 'archive hide done',
          run: () => void window.api.tasks.archive(task.id, true)
        })
      }
      if (diffStats.has(task.id)) {
        entries.push({
          id: `changes:${task.id}`,
          label: `View changes — ${task.title}`,
          group: 'Tasks',
          mode: 'command',
          hint: task.id,
          keywords: 'diff changes git files review',
          run: () => setChangesTask(task)
        })
      }
      entries.push({
        id: `task:${task.id}`,
        label: task.title,
        group: 'Tasks',
        mode: 'go',
        hint: task.id,
        keywords: `${task.status} ${task.project ?? ''} ${task.tags.join(' ')}`,
        run: () => setEditing(task),
        altLabel: 'start Claude',
        runAlt: () => void launchAgent(task.id)
      })
    }

    for (const row of agentRows) {
      const state = row.agent ? AGENT_STATE_LABELS[row.agent.state] : 'No status'
      entries.push({
        id: `agent:${row.task.id}`,
        label: `${state} — ${row.task.title}`,
        group: 'Agents',
        mode: 'go',
        hint: row.task.id,
        keywords: 'agent claude session',
        run: () => activateTask(row.task.id)
      })
    }

    for (const session of sessions) {
      const { name, detail } = sessionLabel(session, taskTitles, {
        activeId: activeWorkspaceId,
        names: workspaceNames
      })
      entries.push({
        id: `term:${session.id}`,
        label: name,
        hint: detail || undefined,
        group: 'Terminals',
        mode: 'go',
        keywords: 'terminal tab session',
        run: () => setActiveSession(session.id)
      })
    }

    for (const section of SECTIONS) {
      if ('flag' in section && !settings?.experimental[section.flag]) continue
      entries.push({
        id: `settings:${section.id}`,
        label: `Settings — ${section.label}`,
        group: 'Settings',
        mode: 'command',
        keywords: section.blurb,
        run: () => openSettings(section.id)
      })
    }

    return entries
  }, [
    board,
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
    openSettings,
    overview,
    activeWorkspaceId,
    workspaceNames,
    switchWorkspace
  ])

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
      if (event.key === 'Escape') {
        setCreating(false)
        setEditing(null)
        setShowSettings(false)
        setConfirmingOrchestrate(false)
        setPaletteMode(null)
        setSwitcherOpen(false)
        setCreatingWorkspace(false)
        setArchiveOpen(false)
        setChangesTask(null)
        return
      }
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

  useEffect(() => {
    if (terminalOpen && !manuallyResized.current) setTerminalHeight(preferredTerminalHeight())
  }, [terminalOpen])

  useEffect(() => {
    function onMove(event: MouseEvent): void {
      if (!dragging.current) return
      manuallyResized.current = true
      const height = window.innerHeight - event.clientY
      const ceiling = Math.max(MIN_TERMINAL_HEIGHT, window.innerHeight - MIN_BOARD_HEIGHT)
      setTerminalHeight(Math.min(Math.max(height, MIN_TERMINAL_HEIGHT), ceiling))
    }
    function onUp(): void {
      dragging.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  if (!settings) return <div className="p-6 text-muted">Loading…</div>

  return (
    <TaskLookupContext.Provider value={lookup}>
      <DispatchingContext.Provider value={dispatching}>
        <div className="flex h-full flex-col">
          <header className="relative flex h-[44px] shrink-0 items-center gap-3 border-b border-edge bg-chrome pl-[86px] pr-3 [-webkit-app-region:drag]">
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
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
              onSwitch={(id) => void switchWorkspace(id)}
              onNew={() => setCreatingWorkspace(true)}
              onManage={() => openSettings('workspaces')}
            />

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
                    ⌘F
                  </kbd>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
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
                    onClick={() => setView(tab.id)}
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
                onClick={() => setConfirmingOrchestrate(true)}
                disabled={orchestration === null || orchestration.dispatch.length === 0}
                title={isDispatching ? 'Dispatch is running' : orchestrateTitle}
                className={isDispatching ? 'dispatch-running' : ''}
              >
                {isDispatching ? (
                  <span
                    aria-hidden
                    className="size-[7px] shrink-0 animate-pulse rounded-full bg-[var(--color-accent-text)]"
                  />
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
                {isDispatching ? 'Dispatching' : 'Dispatch'}
                {!isDispatching && orchestration && orchestration.dispatch.length > 0 ? (
                  <span className="inline-flex h-[18px] items-center rounded-md bg-accent/20 px-1.5 font-mono text-[10.5px] font-semibold text-[var(--color-accent-text)]">
                    {orchestration.dispatch.length}
                  </span>
                ) : null}
              </Button>
              <Button variant="primary" onClick={() => setCreating(true)}>
                New task
              </Button>
            </div>
            {isDispatching ? (
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
                    {problem.filePath.split('/').pop()} — {problem.reason.split('\n')[0]}
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
                    onOpen={setEditing}
                    onLaunch={(task) => void launchAgent(task.id)}
                    onActivate={(task) => activateTask(task.id)}
                    onShowChanges={setChangesTask}
                    onMove={(task, status) => void window.api.tasks.update(task.id, { status })}
                    onArchive={(task) => void window.api.tasks.archive(task.id, !task.archivedAt)}
                  />
                ) : (
                  <Board
                    board={board}
                    agents={agents}
                    queued={queued}
                    onOpen={setEditing}
                    onLaunch={(task) => void launchAgent(task.id)}
                    onArchive={(task) => void window.api.tasks.archive(task.id, !task.archivedAt)}
                    onShowChanges={setChangesTask}
                    onOpenTerminal={(task) =>
                      void window.api.terminal
                        .create({ cwd: task.worktreePath || task.repoPath, title: task.id })
                        .then(adoptSession)
                    }
                    diffStats={diffStats}
                    onQuickAdd={() => setQuickAdding(true)}
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
                              onClick={() => setArchiveOpen(true)}
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
                      onMouseDown={() => {
                        dragging.current = true
                      }}
                    />
                  )}
                  <div
                    className={terminalExpanded ? 'min-h-0 flex-1' : 'shrink-0'}
                    style={terminalExpanded ? undefined : { height: terminalHeight }}
                  >
                    <TerminalPanel
                      sessions={sessions}
                      agents={agents}
                      activeId={activeSession}
                      expanded={terminalExpanded}
                      theme={activeTheme}
                      bindings={bindings}
                      taskTitles={taskTitles}
                      taskStates={taskStates}
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
                onShowChanges={setChangesTask}
                onOpenTask={setEditing}
                onRemove={setRemovingAgent}
                onClose={() => setAgentsOpen(false)}
                onActivate={(row) => activateTask(row.task.id)}
              />
            ) : null}
          </div>

          <StatusBar
            agentsOpen={agentsOpen}
            terminalOpen={terminalOpen}
            agentCount={agentRows.length}
            waitingCount={counts.waiting}
            sessionCount={sessions.length}
            summary={`${counts.total} task${counts.total === 1 ? '' : 's'}${
              counts.needsSpec > 0
                ? ` · ${counts.needsSpec} need${counts.needsSpec === 1 ? 's' : ''} a spec`
                : ''
            }${counts.working > 0 ? ` · ${counts.working} running` : ''}`}
            bindings={bindings}
            readyUpdate={update?.kind === 'ready' ? update.version : undefined}
            onToggleAgents={() => runCommand('toggleAgents')}
            onToggleTerminal={() => runCommand('toggleTerminal')}
            onOpenSettings={() => openSettings()}
            onInstallUpdate={() => void window.api.updates.install()}
          />

          {creatingWorkspace ? (
            <NewWorkspaceDialog
              onCreate={async (name) => applyWorkspaces(await window.api.workspaces.create(name))}
              onClose={() => setCreatingWorkspace(false)}
            />
          ) : null}

          {paletteMode ? (
            <CommandPalette
              // a different mode is a fresh palette, so the query starts empty
              key={paletteMode}
              entries={commandEntries}
              initialMode={paletteMode}
              onClose={() => setPaletteMode(null)}
            />
          ) : null}

          {performanceOpen ? <PerformanceDialog onClose={() => setPerformanceOpen(false)} /> : null}

          {archiveOpen ? (
            <ArchiveDialog
              tasks={archived}
              onOpen={(task) => {
                setArchiveOpen(false)
                setEditing(task)
              }}
              onClose={() => setArchiveOpen(false)}
            />
          ) : null}

          {confirmingOrchestrate && orchestration && orchestration.dispatch.length > 0 ? (
            <OrchestrateDialog
              summary={orchestration}
              onClose={() => setConfirmingOrchestrate(false)}
              onConfirm={() =>
                void runOrchestrate(orchestration.dispatch.map((entry) => entry.taskId))
              }
            />
          ) : null}

          {removingAgent ? (
            <Modal
              title="Remove this agent?"
              subtitle={`${removingAgent.task.id} · ${removingAgent.task.title}`}
              onClose={() => setRemovingAgent(null)}
              footer={
                <>
                  <Button onClick={() => setRemovingAgent(null)}>Cancel</Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      const { task } = removingAgent
                      setRemovingAgent(null)
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

          {quickAdding && settings ? (
            <QuickTaskDialog settings={settings} onClose={() => setQuickAdding(false)} />
          ) : null}

          {creating || editing ? (
            <TaskDialog
              task={editing}
              allTasks={allTasks}
              settings={settings}
              presetId={creatingPreset}
              onSavePresets={(taskPresets) =>
                save({
                  workspaceId: settings.activeWorkspaceId,
                  workspace: { ...workspaceSettingsFor(settings), taskPresets },
                  global: globalSettingsFor(settings)
                })
              }
              onClose={() => {
                setCreating(false)
                setCreatingPreset(undefined)
                setEditing(null)
              }}
              onLaunch={(taskId, templateId, provider) =>
                void launchAgent(taskId, templateId, provider)
              }
              onResumeSession={(taskId, sessionId) => {
                void window.api.terminal.resumeSession(taskId, sessionId).then(adoptSession)
              }}
              onShowChanges={setChangesTask}
            />
          ) : null}

          {changesTask ? (
            <ChangesDialog task={changesTask} onClose={() => setChangesTask(null)} />
          ) : null}

          {showSettings ? (
            <SettingsDialog
              settings={settings}
              workspaces={workspaces}
              initialSection={settingsSection}
              onSave={save}
              onPreviewTheme={setPreviewTheme}
              onClose={() => {
                setPreviewTheme(null)
                setShowSettings(false)
              }}
            />
          ) : null}
        </div>
      </DispatchingContext.Provider>
    </TaskLookupContext.Provider>
  )
}
