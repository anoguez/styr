import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentStatus } from '../core/agentState.js'
import type {
  AppInfo,
  BrokenSettingsFile,
  OrchestrationSummary,
  Settings,
  SettingsChange,
  Task,
  TaskDraft,
  TaskFilter,
  TaskPatch,
  TaskStatus,
  TerminalSessionInfo,
  UpdateState,
  WorkspaceOverview
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
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
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
  orchestrate: {
    plan: (): Promise<OrchestrationSummary> => ipcRenderer.invoke('orchestrate:plan'),
    run: (
      taskIds?: string[]
    ): Promise<{ taskId: string; lane: string; session: TerminalSessionInfo }[]> =>
      ipcRenderer.invoke('orchestrate:run', taskIds)
  },
  agents: {
    list: (): Promise<AgentStatus[]> => ipcRenderer.invoke('agents:list'),
    onChanged: (handler: (statuses: AgentStatus[]) => void): (() => void) =>
      subscribe('agents:changed', handler as (...args: never[]) => void)
  },
  workspaces: {
    list: (): Promise<WorkspaceOverview> => ipcRenderer.invoke('workspaces:list'),
    switch: (id: string): Promise<WorkspaceOverview> => ipcRenderer.invoke('workspaces:switch', id),
    create: (name: string): Promise<WorkspaceOverview> =>
      ipcRenderer.invoke('workspaces:create', name),
    rename: (id: string, name: string): Promise<WorkspaceOverview> =>
      ipcRenderer.invoke('workspaces:rename', id, name),
    remove: (id: string): Promise<WorkspaceOverview> => ipcRenderer.invoke('workspaces:delete', id),
    onChanged: (handler: () => void): (() => void) => subscribe('workspaces:changed', handler)
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
    backlog: (id: string): Promise<{ data: string; sequence: number }> =>
      ipcRenderer.invoke('terminal:backlog', id),
    write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id: string): Promise<void> => ipcRenderer.invoke('terminal:kill', id),
    onData: (
      handler: (payload: { id: string; data: string; sequence: number }) => void
    ): (() => void) => subscribe('terminal:data', handler as (...args: never[]) => void),
    onExit: (handler: (payload: { id: string; exitCode: number }) => void): (() => void) =>
      subscribe('terminal:exit', handler as (...args: never[]) => void)
  }
}

export type DashboardApi = typeof api

contextBridge.exposeInMainWorld('api', api)
