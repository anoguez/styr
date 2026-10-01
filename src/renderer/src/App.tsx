import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AGENT_STATE_LABELS, isAgentArchived } from '@core/agentState.js'
import { resolveTemplateFor } from '@core/prompt.js'
import { commandForEvent, SHORTCUT_LABELS, shortcutHint } from '@core/shortcuts.js'
import {
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  ORCHESTRATION_LANES,
  SHORTCUT_COMMANDS,
  type AppInfo,
  type OrchestrationSummary,
  type ShortcutCommand,
  type Task,
  type TerminalSessionInfo,
  type ThemeSettings
} from '@core/types.js'
import { AgentsSidebar, sortAgentRows, type AgentRow } from './components/AgentsSidebar.js'
import { Board } from './components/Board.js'
import { OrchestrateDialog } from './components/OrchestrateDialog.js'
import { CommandPalette, type CommandEntry } from './components/CommandPalette.js'
import { StatusBar } from './components/StatusBar.js'
import { useUpdates } from './hooks/useUpdates.js'
import { SECTIONS, SettingsDialog, type SectionId } from './components/SettingsDialog.js'
import { TaskDialog } from './components/TaskDialog.js'
import { TerminalPanel } from './components/TerminalPanel.js'
import { sessionLabel } from './lib/sessionLabel.js'
import { Button, Chip, inputClass } from './components/ui.js'
import { useSettings } from './hooks/useSettings.js'
import { useTheme } from './hooks/useTheme.js'
import { useTasks } from './hooks/useTasks.js'
import { useAgents } from './hooks/useAgents.js'

const MIN_TERMINAL_HEIGHT = 140
const MIN_BOARD_HEIGHT = 220
const TERMINAL_OPEN_RATIO = 0.45

function preferredTerminalHeight(): number {
  return Math.round(window.innerHeight * TERMINAL_OPEN_RATIO)
}

export default function App(): ReactNode {
  const [query, setQuery] = useState('')
  const { board, problems, loading } = useTasks(query)
  const { settings, save } = useSettings()
  const agents = useAgents()
  const bindings = settings?.shortcuts ?? DEFAULT_SHORTCUTS
  const [previewTheme, setPreviewTheme] = useState<ThemeSettings | null>(null)
  const activeTheme = previewTheme ?? settings?.theme ?? DEFAULT_THEME
  useTheme(activeTheme)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const update = useUpdates()
  const [orchestration, setOrchestration] = useState<OrchestrationSummary | null>(null)
  const [confirmingOrchestrate, setConfirmingOrchestrate] = useState(false)

  const [editing, setEditing] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SectionId | undefined>(undefined)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [terminalOpen, setTerminalOpen] = useState(false)
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

  const agentRows = useMemo<AgentRow[]>(() => {
    const tasks = Object.values(board).flat()
    return sortAgentRows(
      tasks
        .filter((task) => agents.has(task.id) || task.claudeSessionId)
        .filter((task) => !isAgentArchived(task.status))
        .map((task) => ({
          task,
          agent: agents.get(task.id),
          session: sessions.find((session) => session.taskId === task.id)
        }))
    )
  }, [board, agents, sessions])

  const counts = useMemo(
    () => ({
      total: Object.values(board).reduce((sum, list) => sum + list.length, 0),
      needsSpec: Object.values(board)
        .flat()
        .filter((task) => task.readiness === 'needs_spec').length,
      waiting: agentRows.filter((row) => row.agent?.state === 'waiting').length,
      working: agentRows.filter((row) => row.agent?.state === 'working').length
    }),
    [board, agentRows]
  )

  useEffect(() => {
    void window.api.app.info().then(setAppInfo)
  }, [])

  useEffect(() => {
    void window.api.terminal.list().then((existing) => {
      setSessions(existing)
      setActiveSession((current) => current ?? existing[0]?.id ?? null)
    })
    return window.api.terminal.onExit(({ id }) => {
      setSessions((current) => current.filter((session) => session.id !== id))
      setActiveSession((current) => (current === id ? null : current))
    })
  }, [])

  const adoptSession = useCallback((session: TerminalSessionInfo) => {
    setSessions((current) =>
      current.some((existing) => existing.id === session.id) ? current : [...current, session]
    )
    setActiveSession(session.id)
    setTerminalOpen(true)
  }, [])

  const newShell = useCallback(async () => {
    adoptSession(
      await window.api.terminal.create({
        cwd: settings?.defaultRepoPath || settings?.workspaceDir,
        title: 'shell'
      })
    )
  }, [adoptSession, settings])

  const launchClaude = useCallback(
    async (taskId: string, templateId?: string) => {
      adoptSession(await window.api.terminal.launchClaude(taskId, templateId))
    },
    [adoptSession]
  )

  const activateTask = useCallback(
    (taskId: string) => {
      const session = sessions.find((current) => current.taskId === taskId)
      if (session) {
        setActiveSession(session.id)
        setTerminalOpen(true)
        return
      }
      void launchClaude(taskId)
    },
    [sessions, launchClaude]
  )

  useEffect(() => window.api.tasks.onActivateRequested(activateTask), [activateTask])

  const refreshOrchestration = useCallback(() => {
    void window.api.orchestrate.plan().then(setOrchestration)
  }, [])

  useEffect(refreshOrchestration, [refreshOrchestration, board, sessions, agents])

  const runOrchestrate = useCallback(
    async (taskIds: string[]) => {
      setConfirmingOrchestrate(false)
      const started = await window.api.orchestrate.run(taskIds)
      for (const entry of started) adoptSession(entry.session)
      refreshOrchestration()
    },
    [adoptSession, refreshOrchestration]
  )

  const orchestrateHint = useMemo(() => {
    if (!orchestration) return 'Orchestrate'
    const { dispatch, occupied, capacity, optedOut, missingWorkingDir } = orchestration
    if (dispatch.length > 0) {
      return `Start ${dispatch.length}: ${dispatch.map((d) => `${d.taskId} (${d.lane})`).join(', ')}`
    }
    const full = ORCHESTRATION_LANES.filter(
      (lane) => occupied[lane] >= capacity[lane] && capacity[lane] > 0
    )
    if (full.length > 0) return `No free slots in: ${full.join(', ')}`
    const notes = [
      orchestration.idleSessions > 0
        ? `${orchestration.idleSessions} already have a terminal tab open — close it to hand the task back`
        : '',
      optedOut > 0 ? `${optedOut} opted out` : '',
      missingWorkingDir > 0 ? `${missingWorkingDir} without a working directory` : ''
    ].filter(Boolean)
    return notes.length > 0 ? `Nothing to start — ${notes.join(', ')}` : 'Nothing ready to start'
  }, [orchestration])

  const openSettings = useCallback((section?: SectionId) => {
    setSettingsSection(section)
    setShowSettings(true)
  }, [])

  const runCommand = useCallback(
    (command: ShortcutCommand) => {
      switch (command) {
        case 'newTask':
          return setCreating(true)
        case 'commandPalette':
          return setPaletteOpen((open) => !open)
        case 'focusSearch':
          searchRef.current?.focus()
          return searchRef.current?.select()
        case 'settings':
          return openSettings()
        case 'toggleTerminal':
          return setTerminalOpen((open) => !open)
        case 'toggleAgents':
          return setAgentsOpen((open) => !open)
        case 'orchestrate':
          return setConfirmingOrchestrate(true)
        case 'newShell':
          return void newShell()
      }
    },
    [openSettings, newShell]
  )

  const commandEntries = useMemo<CommandEntry[]>(() => {
    const tasks = Object.values(board).flat()
    const dynamicLabels: Partial<Record<ShortcutCommand, string>> = {
      toggleTerminal: terminalOpen ? 'Hide terminal' : 'Show terminal',
      toggleAgents: agentsOpen ? 'Hide agents sidebar' : 'Show agents sidebar',
      orchestrate: 'Orchestrate — start waiting work'
    }
    const keywords: Partial<Record<ShortcutCommand, string>> = {
      orchestrate: 'dispatch run agents',
      newShell: 'terminal session',
      settings: 'preferences options'
    }
    const entries: CommandEntry[] = SHORTCUT_COMMANDS.map((command) => ({
      id: `cmd:${command}`,
      label: dynamicLabels[command] ?? SHORTCUT_LABELS[command],
      group: 'Actions',
      hint: shortcutHint(bindings, command),
      keywords: keywords[command],
      run: () => runCommand(command)
    }))

    for (const task of tasks) {
      entries.push({
        id: `task:${task.id}`,
        label: task.title,
        group: 'Tasks',
        hint: task.id,
        keywords: `${task.status} ${task.project ?? ''} ${task.tags.join(' ')}`,
        run: () => setEditing(task),
        altLabel: 'start Claude',
        runAlt: () => void launchClaude(task.id)
      })
    }

    for (const row of agentRows) {
      const state = row.agent ? AGENT_STATE_LABELS[row.agent.state] : 'No status'
      entries.push({
        id: `agent:${row.task.id}`,
        label: `${state} — ${row.task.title}`,
        group: 'Agents',
        hint: row.task.id,
        keywords: 'agent claude session',
        run: () => activateTask(row.task.id)
      })
    }

    for (const session of sessions) {
      const { name, detail } = sessionLabel(session, taskTitles)
      entries.push({
        id: `term:${session.id}`,
        label: name,
        hint: detail || undefined,
        group: 'Terminals',
        keywords: 'terminal tab session',
        run: () => {
          setActiveSession(session.id)
          setTerminalOpen(true)
        }
      })
    }

    for (const section of SECTIONS) {
      entries.push({
        id: `settings:${section.id}`,
        label: `Settings — ${section.label}`,
        group: 'Settings',
        keywords: section.blurb,
        run: () => openSettings(section.id)
      })
    }

    return entries
  }, [
    board,
    agentRows,
    sessions,
    taskTitles,
    terminalOpen,
    agentsOpen,
    bindings,
    runCommand,
    launchClaude,
    activateTask,
    openSettings
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

  const reorderSessions = useCallback((orderedIds: string[]) => {
    setSessions((current) => {
      const byId = new Map(current.map((session) => [session.id, session]))
      return orderedIds
        .map((id) => byId.get(id))
        .filter((session): session is TerminalSessionInfo => session !== undefined)
    })
  }, [])

  const closeSession = useCallback(async (id: string) => {
    await window.api.terminal.kill(id)
    setSessions((current) => current.filter((session) => session.id !== id))
    setActiveSession((current) => (current === id ? null : current))
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setCreating(false)
        setEditing(null)
        setShowSettings(false)
        setConfirmingOrchestrate(false)
        setPaletteOpen(false)
        return
      }
      const command = commandForEvent(bindings, event)
      if (!command) return
      event.preventDefault()
      runCommand(command)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bindings, runCommand])

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
    <div className="flex h-full flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-3 border-b border-edge bg-chrome pl-[86px] pr-3 [-webkit-app-region:drag]">
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
        {appInfo && !appInfo.isPackaged ? (
          <Chip tone="warn" title={`Running from source · v${appInfo.version}`}>
            DEV
          </Chip>
        ) : null}

        <div className="flex flex-1 justify-center">
          <div className="relative w-full max-w-md [-webkit-app-region:no-drag]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint">
              ⌕
            </span>
            <input
              ref={searchRef}
              className={`${inputClass} py-1.5 pl-8 pr-12`}
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
              <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded border border-edge-strong px-1 py-[1px] font-mono text-[10px] text-faint">
                ⌘F
              </kbd>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
          <Button
            onClick={() => setConfirmingOrchestrate(true)}
            disabled={orchestration === null || orchestration.dispatch.length === 0}
            title={orchestrateHint}
          >
            Orchestrate
            {orchestration && orchestration.dispatch.length > 0 ? (
              <span className="rounded bg-accent/20 px-1 text-[10px] font-semibold text-[var(--color-accent-text)]">
                {orchestration.dispatch.length}
              </span>
            ) : null}
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            New task
          </Button>
        </div>
      </header>

      {problems.length > 0 ? (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
          <p className="text-[12px] text-amber-200">
            {problems.length} task file{problems.length === 1 ? '' : 's'} could not be read and{' '}
            {problems.length === 1 ? 'is' : 'are'} hidden from the board. Nothing was changed on
            disk — fix the frontmatter and {problems.length === 1 ? 'it' : 'they'} will reappear.
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
          <main className="flex min-h-0 flex-1 flex-col" hidden={terminalOpen && terminalExpanded}>
            {loading ? (
              <p className="p-6 text-dim">Loading board…</p>
            ) : (
              <Board
                board={board}
                agents={agents}
                queued={queued}
                onOpen={setEditing}
                onLaunch={(task) => void launchClaude(task.id)}
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
                  onToggleExpand={() => setTerminalExpanded((open) => !open)}
                  onSelect={setActiveSession}
                  onReorder={reorderSessions}
                  onNewSession={() => void newShell()}
                  onCloseSession={(id) => void closeSession(id)}
                />
              </div>
            </>
          ) : null}
        </div>

        {agentsOpen ? (
          <AgentsSidebar
            rows={agentRows}
            onOpenTask={setEditing}
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

      {paletteOpen ? (
        <CommandPalette entries={commandEntries} onClose={() => setPaletteOpen(false)} />
      ) : null}

      {confirmingOrchestrate && orchestration && orchestration.dispatch.length > 0 ? (
        <OrchestrateDialog
          summary={orchestration}
          onClose={() => setConfirmingOrchestrate(false)}
          onConfirm={() => void runOrchestrate(orchestration.dispatch.map((entry) => entry.taskId))}
        />
      ) : null}

      {creating || editing ? (
        <TaskDialog
          task={editing}
          settings={settings}
          onClose={() => {
            setCreating(false)
            setEditing(null)
          }}
          onLaunch={(taskId, templateId) => void launchClaude(taskId, templateId)}
          onResumeSession={(taskId, sessionId) => {
            void window.api.terminal.resumeSession(taskId, sessionId).then(adoptSession)
          }}
        />
      ) : null}

      {showSettings ? (
        <SettingsDialog
          settings={settings}
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
  )
}
