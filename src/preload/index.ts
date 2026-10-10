import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { AgentStatus } from '../core/agentState.js'
import type { DiagnosticsSnapshot } from '../core/diagnostics.js'
import type { ContextUsage, ProviderUsage } from '../core/usage.js'
import type { AgentConversation } from '../core/agentConversation.js'
import type { DiffResult, DiffStat, PatchResult } from '../core/diff.js'
import type {
  AgentCliReport,
  AppInfo,
  AutoDispatchState,
  BrokenSettingsFile,
  CliStatus,
  OrchestrationSummary,
  Settings,
  SettingsChange,
  SourceSyncState,
  SourceTarget,
  Task,
  TaskDraft,
  TaskFilter,
  TaskPatch,
  TaskStatus,
  NativeAttachResult,
  NativeEngineFailure,
  NativeBlockEvent,
  NativeFrameEvent,
  TerminalEngineAvailability,
  TerminalEngineDiagnostic,
  TerminalEngineEnvironment,
  TerminalSessionInfo,
  TerminalOutput,
  TerminalRuntimeState,
  UpdateState,
  WorkspaceBoardSummary,
  WorkspaceOverview,
  WorkspacesActivity
} from '../core/types.js'

export interface TerminalSpawnRequest {
  cwd?: string
  title?: string
  taskId?: string
  command?: string
}

function subscribe(channel: string, handler: (...args: never[]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void =>
    handler(...(args as never[]))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  tasks: {
    list: (filter?: TaskFilter): Promise<Task[]> => ipcRenderer.invoke('tasks:list', filter ?? {}),
    get: (id: string): Promise<Task | null> => ipcRenderer.invoke('tasks:get', id),
    problems: (): Promise<{ filePath: string; reason: string }[]> =>
      ipcRenderer.invoke('tasks:problems'),
    create: (draft: TaskDraft): Promise<Task> => ipcRenderer.invoke('tasks:create', draft),
    update: (id: string, patch: TaskPatch): Promise<Task> =>
      ipcRenderer.invoke('tasks:update', id, patch),
    addNote: (id: string, author: string, message: string): Promise<Task> =>
      ipcRenderer.invoke('tasks:note', id, author, message),
    reorder: (status: TaskStatus, orderedIds: string[]): Promise<Task[]> =>
      ipcRenderer.invoke('tasks:reorder', status, orderedIds),
    archive: (id: string, archived: boolean): Promise<Task> =>
      ipcRenderer.invoke('tasks:archive', id, archived),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('tasks:delete', id),
    forgetSession: (id: string): Promise<Task> => ipcRenderer.invoke('tasks:forgetSession', id),
    removeWorktree: (id: string): Promise<Task | null> =>
      ipcRenderer.invoke('tasks:removeWorktree', id),
    reveal: (id: string): Promise<void> => ipcRenderer.invoke('tasks:reveal', id),
    openInEditor: (id: string): Promise<void> => ipcRenderer.invoke('tasks:openInEditor', id),
    onChanged: (handler: () => void): (() => void) => subscribe('tasks:changed', handler),
    onActivateRequested: (handler: (taskId: string) => void): (() => void) =>
      subscribe('tasks:activate', handler as (...args: never[]) => void)
  },
  diagnostics: {
    snapshot: (): Promise<DiagnosticsSnapshot> => ipcRenderer.invoke('diagnostics:snapshot'),
    stop: (): Promise<void> => ipcRenderer.invoke('diagnostics:stop')
  },
  app: {
    /** Read once at load; the renderer has no `process`. */
    platform: process.platform,
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    /** Colours the native window controls drawn over the title bar (Windows only; a no-op elsewhere). */
    setTitleBarColors: (background: string, symbols: string): void =>
      ipcRenderer.send('app:titleBarColors', background, symbols),
    mcpCommand: (provider?: 'claude' | 'codex'): Promise<string> =>
      ipcRenderer.invoke('app:mcpCommand', provider)
  },
  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke('updates:state'),
    check: (): Promise<UpdateState> => ipcRenderer.invoke('updates:check'),
    /** Resolves false when the user chose to wait for the next quit instead. */
    install: (): Promise<boolean> => ipcRenderer.invoke('updates:install'),
    onState: (handler: (state: UpdateState) => void): (() => void) =>
      subscribe('updates:state', handler as (...args: never[]) => void)
  },
  usage: {
    claude: (): Promise<ProviderUsage | null> => ipcRenderer.invoke('usage:claude'),
    context: (terminalId: string): Promise<ContextUsage | null> =>
      ipcRenderer.invoke('usage:context', terminalId),
    onContext: (
      handler: (update: { terminalId: string; context: ContextUsage | null }) => void
    ): (() => void) => subscribe('usage:context', handler as (...args: never[]) => void),
    codex: (
      terminalId: string
    ): Promise<{ usage: ProviderUsage | null; context: ContextUsage | null } | null> =>
      ipcRenderer.invoke('usage:codex', terminalId),
    onClaude: (handler: (usage: ProviderUsage | null) => void): (() => void) =>
      subscribe('usage:claude', handler as (...args: never[]) => void),
    /** The conversation of the agent CLI in a terminal, in Styr's neutral shape. */
    conversation: (terminalId: string): Promise<AgentConversation | null> =>
      ipcRenderer.invoke('agent:conversation', terminalId),
    /** Hands a prompt to the agent's side, which submits it as the person's own words. */
    sendPrompt: (terminalId: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke('agent:prompt', terminalId, text),
    onConversation: (
      handler: (update: { terminalId: string; conversation: AgentConversation }) => void
    ): (() => void) => subscribe('agent:conversation', handler as (...args: never[]) => void)
  },
  orchestrate: {
    plan: (): Promise<OrchestrationSummary> => ipcRenderer.invoke('orchestrate:plan'),
    run: (
      taskIds?: string[]
    ): Promise<{ taskId: string; lane: string; session: TerminalSessionInfo }[]> =>
      ipcRenderer.invoke('orchestrate:run', taskIds),
    autoState: (): Promise<AutoDispatchState> => ipcRenderer.invoke('orchestrate:autoState'),
    setAuto: (on: boolean): Promise<AutoDispatchState> =>
      ipcRenderer.invoke('orchestrate:autoSet', on),
    onAutoStarted: (handler: (session: TerminalSessionInfo) => void): (() => void) =>
      subscribe('orchestrate:autoStarted', handler as (...args: never[]) => void),
    onAutoState: (handler: (state: AutoDispatchState) => void): (() => void) =>
      subscribe('orchestrate:autoState', handler as (...args: never[]) => void)
  },
  agents: {
    list: (): Promise<AgentStatus[]> => ipcRenderer.invoke('agents:list'),
    remove: (taskId: string): Promise<void> => ipcRenderer.invoke('agents:remove', taskId),
    onChanged: (handler: (statuses: AgentStatus[]) => void): (() => void) =>
      subscribe('agents:changed', handler as (...args: never[]) => void)
  },
  git: {
    branches: (repoPath: string): Promise<{ branches: string[]; current?: string }> =>
      ipcRenderer.invoke('git:branches', repoPath),
    diffStats: (): Promise<Record<string, DiffStat>> => ipcRenderer.invoke('git:diffStats'),
    taskDiff: (taskId: string): Promise<DiffResult> => ipcRenderer.invoke('git:taskDiff', taskId),
    filePatch: (taskId: string, path: string, full = false): Promise<PatchResult> =>
      ipcRenderer.invoke('git:filePatch', taskId, path, full)
  },
  sources: {
    providers: (): Promise<{ provider: string; label: string }[]> =>
      ipcRenderer.invoke('sources:providers'),
    ghStatus: (): Promise<CliStatus> => ipcRenderer.invoke('sources:ghStatus'),
    state: (): Promise<Record<string, SourceSyncState>> => ipcRenderer.invoke('sources:state'),
    targets: (sourceId: string): Promise<SourceTarget[]> =>
      ipcRenderer.invoke('sources:targets', sourceId),
    sync: (sourceId: string): Promise<SourceSyncState> =>
      ipcRenderer.invoke('sources:sync', sourceId),
    link: (taskId: string, text: string): Promise<Task> =>
      ipcRenderer.invoke('sources:link', taskId, text),
    unlink: (taskId: string): Promise<Task> => ipcRenderer.invoke('sources:unlink', taskId),
    refresh: (taskId: string): Promise<Task> => ipcRenderer.invoke('sources:refresh', taskId),
    onState: (handler: (states: Record<string, SourceSyncState>) => void): (() => void) =>
      subscribe('sources:state', handler as (...args: never[]) => void)
  },
  workspaces: {
    list: (): Promise<WorkspaceOverview> => ipcRenderer.invoke('workspaces:list'),
    switch: (id: string): Promise<WorkspaceOverview> => ipcRenderer.invoke('workspaces:switch', id),
    create: (name: string): Promise<WorkspaceOverview> =>
      ipcRenderer.invoke('workspaces:create', name),
    rename: (id: string, name: string): Promise<WorkspaceOverview> =>
      ipcRenderer.invoke('workspaces:rename', id, name),
    remove: (id: string): Promise<WorkspaceOverview> => ipcRenderer.invoke('workspaces:delete', id),
    onChanged: (handler: () => void): (() => void) => subscribe('workspaces:changed', handler),
    activity: (): Promise<WorkspacesActivity> => ipcRenderer.invoke('workspaces:activity'),
    onActivity: (handler: (activity: WorkspacesActivity) => void): (() => void) =>
      subscribe('workspaces:activity', handler as (...args: never[]) => void),
    boardSummary: (): Promise<Record<string, WorkspaceBoardSummary>> =>
      ipcRenderer.invoke('workspaces:boardSummary')
  },
  settings: {
    get: (workspaceId?: string): Promise<Settings> =>
      ipcRenderer.invoke('settings:get', workspaceId),
    save: (change: SettingsChange): Promise<Settings> =>
      ipcRenderer.invoke('settings:save', change),
    brokenFiles: (): Promise<BrokenSettingsFile[]> => ipcRenderer.invoke('settings:brokenFiles'),
    pickDirectory: (current?: string): Promise<string | null> =>
      ipcRenderer.invoke('settings:pickDirectory', current),
    pickFiles: (startIn?: string): Promise<string[]> =>
      ipcRenderer.invoke('settings:pickFiles', startIn),
    listApps: (): Promise<string[]> => ipcRenderer.invoke('settings:listApps'),
    /** Checks an agent CLI against a shell and command as typed, not yet saved. */
    agentCliStatus: (
      provider: 'claude' | 'codex',
      command: string,
      shell: string
    ): Promise<AgentCliReport> => ipcRenderer.invoke('agents:cliStatus', provider, command, shell),
    pickApp: (): Promise<string | null> => ipcRenderer.invoke('settings:pickApp'),
    onChanged: (handler: (settings: Settings) => void): (() => void) =>
      subscribe('settings:changed', handler as (...args: never[]) => void)
  },
  terminal: {
    create: (request: TerminalSpawnRequest): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke('terminal:create', request),
    launchAgent: (
      taskId: string,
      templateId?: string,
      provider?: 'claude' | 'codex'
    ): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke('terminal:launchAgent', taskId, templateId, provider),
    resumeSession: (taskId: string, sessionId: string): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke('terminal:resumeSession', taskId, sessionId),
    previewPrompt: (taskId: string, templateId?: string): Promise<string> =>
      ipcRenderer.invoke('terminal:previewPrompt', taskId, templateId),
    list: (): Promise<TerminalSessionInfo[]> => ipcRenderer.invoke('terminal:list'),
    backlog: (id: string): Promise<TerminalOutput> => ipcRenderer.invoke('terminal:backlog', id),
    runtimeState: (id: string): Promise<TerminalRuntimeState | undefined> =>
      ipcRenderer.invoke('terminal:runtimeState', id),
    createPr: (taskId: string): Promise<void> => ipcRenderer.invoke('terminal:createPr', taskId),
    askReview: (taskId: string): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke('terminal:askReview', taskId),
    askFork: (sessionId: string, question: string): Promise<TerminalSessionInfo | null> =>
      ipcRenderer.invoke('terminal:askFork', sessionId, question),
    handOff: (
      sessionId: string,
      output: string
    ): Promise<{ taskId: string; path: string; agentAsked: boolean }> =>
      ipcRenderer.invoke('terminal:handOff', sessionId, output),
    gitContext: (path: string): Promise<{ root: string | null; branch: string | null }> =>
      ipcRenderer.invoke('terminal:gitContext', path),
    openInCode: (path: string): Promise<'code' | 'folder' | 'failed'> =>
      ipcRenderer.invoke('terminal:openInCode', path),
    revealDirectory: (path: string): Promise<string> =>
      ipcRenderer.invoke('terminal:revealDirectory', path),
    openLink: (url: string): Promise<void> => ipcRenderer.invoke('terminal:openLink', url),
    pathsForFiles: (files: File[]): string[] =>
      files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    listDirectories: (
      path: string
    ): Promise<{ path: string; parent: string | null; names: string[] }> =>
      ipcRenderer.invoke('terminal:listDirectories', path),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('terminal:kill', id),
    onData: (handler: (payload: { id: string } & TerminalOutput) => void): (() => void) =>
      subscribe('terminal:data', handler as (...args: never[]) => void),
    onExit: (handler: (payload: { id: string; exitCode: number }) => void): (() => void) =>
      subscribe('terminal:exit', handler as (...args: never[]) => void),
    onRuntimeState: (handler: (state: TerminalRuntimeState) => void): (() => void) =>
      subscribe('terminal:runtimeState', handler as (...args: never[]) => void),
    /** Whether Styr Terminal is bundled here; does not load it. */
    engineAvailability: (): Promise<TerminalEngineAvailability> =>
      ipcRenderer.invoke('terminal:engineAvailability'),
    /** Loads Styr Terminal (once per run) and reports whether it is usable. */
    engineEnvironment: (): Promise<TerminalEngineEnvironment> =>
      ipcRenderer.invoke('terminal:engineEnvironment'),
    reportEngine: (
      entry: Pick<
        TerminalEngineDiagnostic,
        'sessionId' | 'requested' | 'selected' | 'fallbackReason' | 'detail'
      >
    ): void => ipcRenderer.send('terminal:engineSelected', entry),
    native: {
      attach: (id: string, cols: number, rows: number): Promise<NativeAttachResult> =>
        ipcRenderer.invoke('terminal:nativeAttach', id, cols, rows),
      resize: (id: string, cols: number, rows: number): void =>
        ipcRenderer.send('terminal:nativeResize', id, cols, rows),
      scroll: (id: string, lines: number | 'bottom'): void =>
        ipcRenderer.send('terminal:nativeScroll', id, lines),
      text: (id: string): Promise<string> => ipcRenderer.invoke('terminal:nativeText', id),
      lines: (id: string, from: number, to: number): Promise<string> =>
        ipcRenderer.invoke('terminal:nativeLines', id, from, to),
      detach: (id: string): void => ipcRenderer.send('terminal:nativeDetach', id),
      clearBlocks: (id: string): void => ipcRenderer.send('terminal:nativeClearBlocks', id),
      onBlocks: (handler: (event: NativeBlockEvent) => void): (() => void) =>
        subscribe('terminal:nativeBlocks', handler as (...args: never[]) => void),
      onFrame: (handler: (event: NativeFrameEvent) => void): (() => void) =>
        subscribe('terminal:nativeFrame', handler as (...args: never[]) => void),
      onFailed: (handler: (failure: NativeEngineFailure) => void): (() => void) =>
        subscribe('terminal:nativeFailed', handler as (...args: never[]) => void)
    }
  }
}

export type DashboardApi = typeof api

contextBridge.exposeInMainWorld('api', api)
