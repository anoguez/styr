import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { buildInbox } from '@core/inbox.js'
import { resolveTemplateFor } from '@core/prompt.js'
import {
  DEFAULT_DONE_CAP,
  DEFAULT_SHORTCUTS,
  DEFAULT_THEME,
  globalSettingsFor,
  workspaceSettingsFor,
  type AppInfo,
  type Task,
  type TaskPreset,
  type ThemeSettings
} from '@core/types.js'
import { AgentsSidebar } from './components/AgentsSidebar.js'
import { ArchiveDialog } from './components/ArchiveDialog.js'
import { Board } from './components/Board.js'
import { ChangesDialog } from './components/ChangesDialog.js'
import { CommandPalette } from './components/CommandPalette.js'
import { DoneFooter, hasDoneFooter } from './components/DoneFooter.js'
import { AppHeader, BrandMark } from './components/header/AppHeader.js'
import { DispatchButton } from './components/header/DispatchButton.js'
import { ViewTabs } from './components/header/ViewTabs.js'
import { Inbox } from './components/Inbox.js'
import { OrchestrateDialog, StopAutoRunDialog } from './components/OrchestrateDialog.js'
import { PerformanceDialog } from './components/PerformanceDialog.js'
import { ProblemsBanner } from './components/ProblemsBanner.js'
import { QuickTaskDialog } from './components/QuickTaskDialog.js'
import { RemoveAgentDialog } from './components/RemoveAgentDialog.js'
import { SettingsDialog } from './components/SettingsDialog.js'
import type { SectionId } from './components/settings/sections.js'
import { StatusBar } from './components/StatusBar.js'
import { TaskDialog } from './components/TaskDialog.js'
import { TerminalPanel } from './components/TerminalPanel.js'
import { Button } from './components/ui.js'
import { NewWorkspaceDialog, WorkspaceSwitcher } from './components/WorkspaceSwitcher.js'
import { useCommands } from './hooks/useCommands.js'
import { useAgentLauncher } from './hooks/useAgentLauncher.js'
import { useAgents } from './hooks/useAgents.js'
import { useAppShell } from './hooks/useAppShell.js'
import { useBoardView } from './hooks/useBoardView.js'
import { useDiffStats } from './hooks/useDiffStats.js'
import { useDispatch } from './hooks/useDispatch.js'
import { usePendingActivation } from './hooks/usePendingActivation.js'
import { useSettings } from './hooks/useSettings.js'
import { useTasks } from './hooks/useTasks.js'
import { useTerminalHeight } from './hooks/useTerminalHeight.js'
import { useTerminalSessions } from './hooks/useTerminalSessions.js'
import { useTheme } from './hooks/useTheme.js'
import { useUpdates } from './hooks/useUpdates.js'
import { useWorkspaces } from './hooks/useWorkspaces.js'
import { agentRowsFor, boardSummary } from './lib/agentRows.js'
import type { Toggle } from './lib/appShell.js'
import { TaskLookupContext } from './lib/blockerContext.js'
import { DispatchingContext } from './lib/dispatchRun.js'
import { ipcMessage } from './lib/ipcMessage.js'
import { engineChoice } from './lib/nativeTerminal/engineChoice.js'

/**
 * The window: header, board or inbox, terminal panel, agents sidebar, status bar and dialogs. State
 * and behaviour live in the hooks below and in `lib/`; this component wires them to the views.
 */
const NO_PRESETS: TaskPreset[] = []

export default function App(): ReactNode {
  const [showAllDone, setShowAllDone] = useState(false)
  const { settings, save } = useSettings()
  const tasksState = useTasks(settings?.doneCap ?? DEFAULT_DONE_CAP, showAllDone)
  const { hiddenDone, allTasks, archived, problems, loading } = tasksState
  const agents = useAgents()
  const { board, tasks, shown, lookup, taskTitles, taskStates } = useBoardView(
    tasksState.board,
    allTasks,
    agents
  )
  const workspaces = useWorkspaces()
  const { overview, names: workspaceNames, apply: applyWorkspaces } = workspaces
  const activeWorkspaceId = settings?.activeWorkspaceId ?? overview.activeId
  const diffStats = useDiffStats(activeWorkspaceId)
  const bindings = settings?.shortcuts ?? DEFAULT_SHORTCUTS
  const [previewTheme, setPreviewTheme] = useState<ThemeSettings | null>(null)
  const activeTheme = previewTheme ?? settings?.theme ?? DEFAULT_THEME
  useTheme(activeTheme)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.api.app.info().then(setAppInfo)
    // Whether Styr Terminal is bundled (no loading), so a new terminal can decide without waiting.
    void engineChoice().availability()
  }, [])
  const update = useUpdates()

  const [shell, dispatch] = useAppShell(activeWorkspaceId)
  const { view, agentsOpen, taskDialog, changes: changesTask, removingAgent } = shell
  const taskOpen = taskDialog.mode !== 'closed'
  const terminals = useTerminalSessions()
  const { sessions, activeSession, terminalOpen, adopt: adoptSession } = terminals
  const [terminalExpanded, setTerminalExpanded] = useState(false)
  const { height: terminalHeight, startResize } = useTerminalHeight(terminalOpen)
  const agentRows = useMemo(
    () => agentRowsFor(tasks, shown, sessions, activeWorkspaceId),
    [tasks, shown, sessions, activeWorkspaceId]
  )
  const launcher = useAgentLauncher({
    settings,
    lookup,
    workspaceId: activeWorkspaceId,
    adopt: adoptSession,
    activateForTask: terminals.activateForTask
  })
  const { newShell, launchAgent, activateTask } = launcher
  usePendingActivation(tasks, activateTask)

  const dispatchRun = useDispatch({
    workspaceId: activeWorkspaceId,
    board,
    sessions,
    agents,
    adopt: adoptSession
  })
  const { orchestration, setAutoOn } = dispatchRun
  const needsYou = useMemo(
    () => buildInbox(tasks, agents, dispatchRun.queuedPositions, allTasks).needs.length,
    [tasks, agents, dispatchRun.queuedPositions, allTasks]
  )

  const switchWorkspace = useCallback(
    async (id: string) => {
      if (id === activeWorkspaceId) return
      if (taskOpen && !window.confirm('Discard the open task and switch workspace?')) return
      try {
        applyWorkspaces(await window.api.workspaces.switch(id))
      } catch (error) {
        window.alert(ipcMessage(error))
      }
    },
    [activeWorkspaceId, applyWorkspaces, taskOpen]
  )

  const { select: selectSession, close: closeSession } = terminals
  // Stable wrappers, so the palette's entries rebuild only when what they show changes.
  const switchTo = useCallback((id: string) => void switchWorkspace(id), [switchWorkspace])
  const archiveTask = useCallback(
    (taskId: string) => void window.api.tasks.archive(taskId, true),
    []
  )
  const launch = useCallback((taskId: string) => void launchAgent(taskId), [launchAgent])
  const { runCommand, entries: commandEntries } = useCommands({
    dispatch,
    changesOpen: changesTask !== null,
    terminals,
    newShell,
    autoRun: { on: dispatchRun.auto.on, setOn: setAutoOn },
    palette: {
      tasks,
      agentRows,
      taskTitles,
      withChanges: diffStats,
      archivedCount: archived.length,
      presets: settings?.taskPresets ?? NO_PRESETS,
      experimental: settings?.experimental,
      bindings,
      workspaces: overview.workspaces,
      activeWorkspaceId,
      workspaceNames,
      terminalOpen,
      agentsOpen
    },
    actions: { switchWorkspace: switchTo, archiveTask, launchAgent: launch, activateTask }
  })

  if (!settings) return <div className="p-6 text-muted">Loading…</div>

  const toggle = (name: Toggle, open: boolean): void =>
    dispatch({ type: 'set', toggle: name, open })
  const openSettings = (section?: SectionId): void => dispatch({ type: 'openSettings', section })
  const editTask = (task: Task): void => dispatch({ type: 'editTask', task })
  const showChanges = (task: Task): void => dispatch({ type: 'showChanges', task })
  const toggleArchived = (task: Task): void =>
    void window.api.tasks.archive(task.id, !task.archivedAt)

  return (
    <TaskLookupContext.Provider value={lookup}>
      <DispatchingContext.Provider value={dispatchRun.dispatching}>
        <div className="flex h-full flex-col">
          <AppHeader
            live={dispatchRun.live}
            start={
              <>
                <BrandMark
                  appInfo={appInfo}
                  update={update}
                  onOpenUpdates={() => openSettings('updates')}
                />
                <WorkspaceSwitcher
                  overview={overview}
                  activity={workspaces.activity}
                  open={shell.switcher}
                  onOpenChange={(open) => toggle('switcher', open)}
                  onSwitch={(id) => void switchWorkspace(id)}
                  onNew={() => toggle('newWorkspace', true)}
                  onManage={() => openSettings('workspaces')}
                />
              </>
            }
            center={null}
            end={
              <>
                <ViewTabs
                  view={view}
                  needsYou={needsYou}
                  bindings={bindings}
                  onChange={(next) => dispatch({ type: 'setView', view: next })}
                />
                <span aria-hidden className="h-[18px] w-px bg-edge" />
                <DispatchButton
                  state={dispatchRun.button}
                  disabled={orchestration === null}
                  onClick={() => toggle('confirmDispatch', true)}
                />
                <Button variant="primary" onClick={() => dispatch({ type: 'newTask' })}>
                  New task
                </Button>
              </>
            }
          />

          <ProblemsBanner problems={problems} />

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
                    tasks={tasks}
                    allTasks={allTasks}
                    agents={agents}
                    queued={dispatchRun.queuedPositions}
                    diffStats={diffStats}
                    onOpen={editTask}
                    onLaunch={(task) => void launchAgent(task.id)}
                    onActivate={(task) => activateTask(task.id)}
                    onShowChanges={showChanges}
                    onMove={(task, status) => void window.api.tasks.update(task.id, { status })}
                    onArchive={toggleArchived}
                  />
                ) : (
                  <Board
                    board={board}
                    agents={shown}
                    queued={dispatchRun.queued}
                    onOpen={editTask}
                    onLaunch={(task) => void launchAgent(task.id)}
                    onArchive={toggleArchived}
                    onShowChanges={showChanges}
                    onOpenTerminal={launcher.openTerminalFor}
                    diffStats={diffStats}
                    onQuickAdd={() => toggle('quickAdd', true)}
                    doneFooter={
                      hasDoneFooter(hiddenDone, showAllDone, archived.length) ? (
                        <DoneFooter
                          hiddenDone={hiddenDone}
                          showAll={showAllDone}
                          archivedCount={archived.length}
                          onToggleShowAll={() => setShowAllDone((open) => !open)}
                          onOpenArchive={() => toggle('archive', true)}
                        />
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
                      nativeTerminal={settings?.experimental.nativeTerminal ?? false}
                      taskTitles={taskTitles}
                      taskStates={taskStates}
                      diffStats={diffStats}
                      onShowChanges={(taskId) => {
                        const task = allTasks.find((candidate) => candidate.id === taskId)
                        if (task) showChanges(task)
                      }}
                      onAskReview={launcher.askReview}
                      onAskFork={launcher.askFork}
                      workspaces={{ activeId: activeWorkspaceId, names: workspaceNames }}
                      onToggleExpand={() => setTerminalExpanded((open) => !open)}
                      onSelect={selectSession}
                      onReorder={terminals.reorder}
                      onNewSession={(cwd) => void newShell(cwd)}
                      onCreateTask={launcher.createTaskFromTerminal}
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
            waitingCount={agentRows.filter((row) => row.agent?.state === 'waiting').length}
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
              auto={dispatchRun.auto}
              onAutoStop={() => setAutoOn(false)}
              onClose={() => toggle('confirmDispatch', false)}
              onConfirm={(autoOn) => {
                toggle('confirmDispatch', false)
                void dispatchRun.confirm(orchestration, autoOn)
              }}
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
            <RemoveAgentDialog
              row={removingAgent}
              onClose={() => dispatch({ type: 'confirmRemoveAgent', row: null })}
              onConfirm={() => {
                dispatch({ type: 'confirmRemoveAgent', row: null })
                void window.api.agents.remove(removingAgent.task.id)
              }}
            />
          ) : null}

          {shell.quickAdd ? (
            <QuickTaskDialog
              settings={settings}
              onPlan={launcher.planTasks}
              onClose={() => toggle('quickAdd', false)}
            />
          ) : null}

          {taskOpen ? (
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
              onResumeSession={launcher.resumeSession}
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
