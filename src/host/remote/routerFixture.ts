import type { AgentStatus } from '@core/agentState.js'
import type {
  Settings,
  TerminalOutput,
  TerminalSessionInfo,
  WorkspaceInfo,
  WorkspaceOverview
} from '@core/types.js'
import { RemoteConnection } from './connection.js'
import {
  HELLO,
  fakeClock,
  fakeServer,
  remoteSettings,
  remoteTask,
  settle
} from './remoteFixture.js'
import { createRemoteRouter } from './router.js'

/**
 * The remote router over two fake hosts (`devbox` with two workspaces, `vm` with one) and a
 * local board, with every port recorded: shared by `router.test.ts` and `router.hostile.test.ts`.
 */

/** One host's fake server: its workspaces, active one, tasks, sessions and settings. */
/** `sessionPrefix` keeps session ids apart across hosts, as `nanoid` does on real servers. */
export function hostServer(names: Record<string, string>, sessionPrefix = 's') {
  const state = {
    active: Object.keys(names)[0]!,
    tasks: {} as Record<string, { id: string; title: string; filePath: string }[]>,
    sessions: [] as TerminalSessionInfo[],
    backlog: {} as Record<string, TerminalOutput>,
    settings: {} as Record<string, Partial<Settings>>
  }
  const overview = (): WorkspaceOverview => ({
    activeId: state.active,
    workspaces: Object.entries(names).map(([id, name]) => ({
      id,
      name,
      taskCount: state.tasks[id]?.length ?? 0,
      liveSessions: 0
    }))
  })
  const server = fakeServer({
    'workspaces:list': () => overview(),
    'workspaces:switch': ([id]) => {
      if (!(String(id) in names)) throw new Error('That workspace no longer exists.')
      state.active = String(id)
      return overview()
    },
    'workspaces:activity': () => ({ activeId: state.active, byWorkspace: {} }),
    'workspaces:boardSummary': () => ({}),
    'server:tray': () => ({ statuses: [], titles: {} }),
    'tasks:list': () => (state.tasks[state.active] ?? []).map(remoteTask),
    'tasks:get': ([id]) => {
      const task = (state.tasks[state.active] ?? []).find((t) => t.id === id)
      return task ? remoteTask(task) : null
    },
    'tasks:create': ([draft]) => {
      const task = {
        id: 'TASK-0009',
        title: String((draft as { title: string }).title),
        filePath: ''
      }
      ;(state.tasks[state.active] ??= []).push(task)
      return remoteTask(task)
    },
    'agents:list': () => [],
    'orchestrate:autoState': () => ({ on: false }),
    'terminal:list': () => state.sessions,
    'terminal:attach': ([id]) => state.backlog[String(id)] ?? { data: '', sequence: 0, marks: [] },
    'terminal:launchAgent': ([taskId]) => {
      const session = {
        id: `${sessionPrefix}-${String(taskId)}`,
        title: 'Agent',
        cwd: '/home/me/repo',
        taskId: String(taskId),
        workspaceId: state.active
      }
      state.sessions.push(session)
      return session
    },
    'settings:get': ([id]) =>
      remoteSettings({
        activeWorkspaceId: state.active,
        openFilesWith: 'Visual Studio Code',
        ...state.settings[String(id ?? state.active)]
      }),
    'settings:save': ([change]) => {
      const { workspaceId, workspace } = change as { workspaceId: string; workspace: object }
      state.settings[workspaceId] = { ...state.settings[workspaceId], ...workspace }
      return {}
    }
  })
  return { server, state }
}

export const AT = '2026-10-19T10:00:00.000Z'
export const COUNTS = { ready: 0, working: 0, waiting: 1, idle: 0, exited: 0 }

export const LOCAL_SETTINGS = {
  storageDir: '/Users/me/Styr',
  activeWorkspaceId: 'default',
  shortcuts: { local: true },
  experimental: { remoteWorkspaces: true },
  updates: { checkAutomatically: true },
  shell: '/bin/zsh',
  openFilesWith: ''
} as unknown as Settings

export function setup(options: { enabled?: boolean; active?: string } = {}) {
  const clock = fakeClock()
  const devbox = hostServer({ default: 'Main board', client: 'Client work' })
  const vm = hostServer({ default: 'VM board' }, 'vm')
  const servers: Record<string, ReturnType<typeof hostServer>> = { devbox, vm }
  const spawned: string[] = []
  let enabled = options.enabled ?? true
  let active = options.active ?? 'default'
  let workspaces: WorkspaceInfo[] = [
    { id: 'default', name: 'Default' },
    { id: 'remote-main', name: 'Devbox main', remote: { host: 'devbox', workspaceId: 'default' } },
    {
      id: 'remote-client',
      name: 'Devbox client',
      remote: { host: 'devbox', workspaceId: 'client' }
    },
    { id: 'remote-vm', name: 'VM', remote: { host: 'vm', workspaceId: 'default' } }
  ]
  const broadcasts: [string, unknown][] = []
  const notified: string[] = []
  const opened: string[] = []
  const trays: { statuses: AgentStatus[]; quiet: string[] }[] = []
  const savedGlobal: unknown[] = []
  const localSessions = new Set<string>(['local-1'])

  const router = createRemoteRouter({
    enabled: () => enabled,
    workspaces: () => workspaces,
    activeWorkspaceId: () => active,
    connect: (host, _link, events) => {
      spawned.push(host)
      return new RemoteConnection(
        host,
        { spawn: () => servers[host]!.server.spawn(), ...clock.ports },
        events
      )
    },
    broadcast: (channel, payload) => void broadcasts.push([channel, payload]),
    notify: (title, body) => void notified.push(`${title}: ${body}`),
    updateTray: (statuses, _titles, quiet) => void trays.push({ statuses, quiet: [...quiet] }),
    openExternal: (url) => void opened.push(url),
    isLocalSession: (id) => localSessions.has(id),
    saveGlobalSettings: (global) => void savedGlobal.push(global),
    clientVersion: HELLO.version
  })
  router.bindSettings(() => ({ ...LOCAL_SETTINGS, activeWorkspaceId: active }))

  /** What the in-process host would answer, so a test sees which side answered. */
  const local = (channel: string) => () => {
    if (channel === 'workspaces:switch') return { activeId: active, workspaces: [] }
    if (channel === 'settings:get') return { ...LOCAL_SETTINGS, activeWorkspaceId: active }
    if (channel === 'terminal:list') return [{ id: 'local-1', title: 'Shell', cwd: '/Users/me' }]
    return `local ${channel}`
  }
  const call = (channel: string, ...args: unknown[]) =>
    Promise.resolve(router.invoke(channel, args, local(channel)))
  /** Switches the way the renderer does: the local switch, then the router's follow-up. */
  const switchTo = async (id: string) => {
    const result = router.invoke('workspaces:switch', [id], () => {
      active = id
      return { activeId: id, workspaces: [] }
    })
    await settle()
    return result
  }
  const connectAll = async () => {
    devbox.server.hello()
    vm.server.hello()
    await settle()
  }
  const channels = () => broadcasts.map(([channel]) => channel)

  return {
    router,
    clock,
    devbox,
    vm,
    spawned,
    broadcasts,
    channels,
    notified,
    opened,
    trays,
    savedGlobal,
    localSessions,
    call,
    switchTo,
    connectAll,
    setEnabled: (on: boolean) => (enabled = on),
    setActive: (id: string) => (active = id),
    setWorkspaces: (next: WorkspaceInfo[]) => (workspaces = next)
  }
}
