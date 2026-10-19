import { describe, expect, it } from 'vitest'
import type { AgentStatus } from '@core/agentState.js'
import type {
  Settings,
  TerminalOutput,
  TerminalSessionInfo,
  WorkspaceInfo,
  WorkspaceOverview
} from '@core/types.js'
import { RemoteConnection } from './connection.js'
import { fakeClock, fakeServer, settle } from './remoteFixture.js'
import { createRemoteRouter } from './router.js'
import { TERMINAL_RESET } from './terminals.js'

/** One host's fake server: its workspaces, active one, tasks, sessions and settings. */
function hostServer(names: Record<string, string>) {
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
    'tasks:list': () => state.tasks[state.active] ?? [],
    'tasks:get': ([id]) => (state.tasks[state.active] ?? []).find((task) => task.id === id) ?? null,
    'tasks:create': ([draft]) => {
      const task = {
        id: 'TASK-0009',
        title: String((draft as { title: string }).title),
        filePath: ''
      }
      ;(state.tasks[state.active] ??= []).push(task)
      return task
    },
    'agents:list': () => [],
    'orchestrate:autoState': () => ({ on: false }),
    'terminal:list': () => state.sessions,
    'terminal:attach': ([id]) => state.backlog[String(id)] ?? { data: '', sequence: 0, marks: [] },
    'terminal:launchAgent': ([taskId]) => {
      const session = {
        id: `s-${String(taskId)}`,
        title: 'Agent',
        cwd: '/home/me/repo',
        taskId: String(taskId),
        workspaceId: state.active
      }
      state.sessions.push(session)
      return session
    },
    'settings:get': ([id]) => ({
      storageDir: '/home/me/Styr',
      activeWorkspaceId: state.active,
      openFilesWith: 'Visual Studio Code',
      shell: '/bin/bash',
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

const LOCAL_SETTINGS = {
  storageDir: '/Users/me/Styr',
  activeWorkspaceId: 'default',
  shortcuts: { local: true },
  experimental: { remoteWorkspaces: true },
  updates: { checkAutomatically: true },
  shell: '/bin/zsh',
  openFilesWith: ''
} as unknown as Settings

function setup(options: { enabled?: boolean; active?: string } = {}) {
  const clock = fakeClock()
  const devbox = hostServer({ default: 'Main board', client: 'Client work' })
  const vm = hostServer({ default: 'VM board' })
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
    saveGlobalSettings: (global) => void savedGlobal.push(global)
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

describe('remote router: the flag', () => {
  it('with the flag off, starts no ssh and answers every call in-process', async () => {
    const t = setup({ enabled: false })
    t.router.refresh()
    expect(t.spawned).toEqual([])
    expect(await t.call('tasks:list', {})).toBe('local tasks:list')
    expect(t.router.state()).toMatchObject({ enabled: false, hosts: [] })
    expect(Object.keys(t.router.state().workspaces)).toEqual([
      'remote-main',
      'remote-client',
      'remote-vm'
    ])
  })

  it('with the flag off, refuses to open a remote workspace and saying so', async () => {
    const t = setup({ enabled: false })
    t.router.refresh()
    await expect(t.call('workspaces:switch', 'remote-main')).rejects.toThrow(
      /remote workspaces are off/
    )
  })

  it('with no remote workspace at all, is a synchronous pass-through', () => {
    const t = setup({ enabled: false })
    t.setWorkspaces([{ id: 'default', name: 'Default' }])
    t.router.refresh()
    expect(t.router.invoke('tasks:list', [], () => 'sync')).toBe('sync')
    t.router.fromLocal('tasks:changed')
    expect(t.broadcasts).toEqual([['tasks:changed', undefined]])
  })

  it('turning the flag off disconnects every host', async () => {
    const t = setup()
    t.router.refresh()
    await t.connectAll()
    t.setEnabled(false)
    t.router.fromLocal('settings:changed', LOCAL_SETTINGS)
    expect(t.devbox.server.children[0]!.killed).toBe(true)
    expect(t.router.state().hosts).toEqual([])
  })
})

describe('remote router: connections', () => {
  it('opens one ssh child per host, shared by its workspaces', () => {
    const t = setup()
    t.router.refresh()
    expect(t.spawned).toEqual(['devbox', 'vm'])
    t.router.refresh()
    expect(t.spawned).toEqual(['devbox', 'vm'])
  })

  it('reports each host’s state, and Retry now reaches its connection', async () => {
    const t = setup()
    t.router.refresh()
    t.devbox.server.drop('Permission denied (publickey).')
    const host = t.router.state().hosts.find((h) => h.host === 'devbox')!
    expect(host).toMatchObject({
      status: 'reconnecting',
      lastError: 'Permission denied (publickey).'
    })
    t.router.retry('devbox')
    expect(t.router.state().hosts.find((h) => h.host === 'devbox')!.status).toBe('connecting')
    expect(t.channels()).toContain('remote:state')
  })
})

describe('remote router: routing', () => {
  it('sends a local workspace’s calls to the in-process host', async () => {
    const t = setup()
    t.router.refresh()
    await t.connectAll()
    expect(await t.call('tasks:list', {})).toBe('local tasks:list')
    expect(t.devbox.server.methods()).not.toContain('tasks:list')
  })

  it('switching to a remote workspace switches its server and routes the board there', async () => {
    const t = setup()
    t.router.refresh()
    await t.connectAll()
    t.devbox.state.tasks.client = [{ id: 'TASK-0001', title: 'Remote task', filePath: '/x' }]
    await t.switchTo('remote-client')
    expect(t.devbox.server.calls).toContainEqual(['workspaces:switch', ['client']])
    expect(t.router.state().workspaces['remote-client']).toMatchObject({ live: true })
    expect(await t.call('tasks:list', {})).toEqual([
      { id: 'TASK-0001', title: 'Remote task', filePath: '/x' }
    ])
    expect(t.channels()).toContain('tasks:changed')
  })

  it('maps the server’s workspace ids to the stubs, keyed by host and remote id', async () => {
    const t = setup({ active: 'remote-vm' })
    t.router.refresh()
    await t.connectAll()
    // Both hosts call their workspace `default`; each session lands on its own stub.
    const vmSession = (await t.call('terminal:launchAgent', 'TASK-0001')) as TerminalSessionInfo
    expect(vmSession).toMatchObject({ workspaceId: 'remote-vm', host: 'vm' })
    await t.switchTo('remote-main')
    const devSession = (await t.call('terminal:launchAgent', 'TASK-0001')) as TerminalSessionInfo
    expect(devSession).toMatchObject({ workspaceId: 'remote-main', host: 'devbox' })
    // A session in a server workspace no stub links to is not listed.
    t.devbox.state.sessions.push({ id: 'x', title: 'X', cwd: '/', workspaceId: 'unlinked' })
    const listed = (await t.call('terminal:list')) as TerminalSessionInfo[]
    expect(listed.map((session) => session.id).sort()).toEqual([
      'local-1',
      's-TASK-0001',
      's-TASK-0001'
    ])
  })

  it('routes terminal calls by session: a local tab stays local while a remote board is open', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    const sent: string[] = []
    t.router.send('terminal:write', ['local-1', 'ls\r'], () => sent.push('local'))
    await t.call('terminal:launchAgent', 'TASK-0002')
    t.router.send('terminal:write', ['s-TASK-0002', 'y'], () => sent.push('wrong'))
    t.router.send('terminal:resize', ['s-TASK-0002', 120, 40], () => sent.push('wrong'))
    await settle()
    expect(sent).toEqual(['local'])
    expect(t.devbox.server.notifications).toEqual([
      ['terminal:write', ['s-TASK-0002', 'y']],
      ['terminal:resize', ['s-TASK-0002', 120, 40]],
      ['terminal:focus', ['s-TASK-0002']]
    ])
  })

  it('keeps the window’s own channels local', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    const ran: string[] = []
    t.router.send('app:titleBarColors', ['#000', '#fff'], () => ran.push('local'))
    expect(ran).toEqual(['local'])
    expect(await t.call('updates:check')).toBe('local updates:check')
  })
})

describe('remote router: disconnected', () => {
  it('shows the last snapshot read-only, refuses writes and queues nothing', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    t.devbox.state.tasks.default = [{ id: 'TASK-0001', title: 'Kept', filePath: '/a' }]
    const before = await t.call('tasks:list', {})
    t.devbox.server.drop('Connection reset by peer')
    await settle()
    expect(await t.call('tasks:list', {})).toEqual(before)
    await expect(t.call('tasks:create', { title: 'New' })).rejects.toThrow(
      /offline while Styr reconnects to devbox\. Nothing was changed or queued/
    )
    expect(t.router.state().workspaces['remote-main']).toMatchObject({ live: false })
    // Reconnecting sends nothing that was refused meanwhile.
    t.clock.advance(1000)
    t.devbox.server.hello()
    await settle()
    expect(t.devbox.server.methods()).not.toContain('tasks:create')
  })

  it('answers an empty board when there is no snapshot yet', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    expect(await t.call('tasks:list', {})).toEqual([])
    expect(await t.call('agents:list')).toEqual([])
  })

  it('on reconnect refetches the board without switching a server another client moved', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    t.devbox.server.drop()
    await settle()
    t.devbox.state.active = 'client'
    t.broadcasts.length = 0
    t.clock.advance(1000)
    t.devbox.server.hello()
    await settle()
    expect(t.devbox.server.calls.filter(([m]) => m === 'workspaces:switch')).toHaveLength(1)
    expect(t.router.state().workspaces['remote-main']).toMatchObject({
      live: false,
      elsewhere: 'Client work'
    })
    expect(t.router.state().hosts.find((h) => h.host === 'devbox')!.serverWorkspace).toEqual({
      id: 'client',
      name: 'Client work'
    })
    await expect(t.call('tasks:create', { title: 'x' })).rejects.toThrow(
      /devbox is showing “Client work”/
    )
    t.router.switchBack('remote-main')
    await settle()
    expect(t.devbox.state.active).toBe('default')
    expect(t.router.state().workspaces['remote-main']).toMatchObject({ live: true })
    expect(t.channels()).toContain('tasks:changed')
  })

  it('notices another client moving the server while connected', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    t.devbox.state.active = 'client'
    t.devbox.server.push('settings:changed', { activeWorkspaceId: 'client' })
    t.devbox.server.push('workspaces:changed')
    // From the first event on, the board is no longer live.
    expect(t.router.state().workspaces['remote-main']!.live).toBe(false)
    await settle()
    expect(t.router.state().workspaces['remote-main']!.elsewhere).toBe('Client work')
  })
})

describe('remote router: terminals', () => {
  it('attaches on backlog, forwards live data, and reattaches with a reset when output was missed', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    await t.call('terminal:launchAgent', 'TASK-0003')
    t.devbox.state.backlog['s-TASK-0003'] = { data: 'hello', sequence: 4, marks: [] }
    expect(await t.call('terminal:backlog', 's-TASK-0003')).toEqual({
      data: 'hello',
      sequence: 4,
      marks: []
    })
    const seen: string[] = []
    t.router.onTerminalData((id, output) => seen.push(`${id} ${output.data}`))
    t.devbox.server.push('terminal:data', {
      id: 's-TASK-0003',
      data: ' world',
      sequence: 5,
      marks: []
    })
    expect(seen).toEqual(['s-TASK-0003  world'])
    expect(t.router.mirrorBacklog('s-TASK-0003')?.data).toBe('hello world')

    t.devbox.server.drop()
    await settle()
    t.devbox.state.backlog['s-TASK-0003'] = { data: 'hello world, later', sequence: 9, marks: [] }
    t.broadcasts.length = 0
    t.clock.advance(1000)
    t.devbox.server.hello()
    await settle()
    const replay = t.broadcasts.find(([channel]) => channel === 'terminal:data')
    expect(replay?.[1]).toEqual({
      id: 's-TASK-0003',
      data: `${TERMINAL_RESET}hello world, later`,
      sequence: 9,
      marks: []
    })
  })

  it('keeps output that arrives in the same chunk as the reattach’s backlog', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    await t.call('terminal:launchAgent', 'TASK-0007')
    t.devbox.state.backlog['s-TASK-0007'] = { data: 'start', sequence: 1, marks: [] }
    await t.call('terminal:backlog', 's-TASK-0007')
    t.devbox.server.drop()
    await settle()
    t.devbox.state.backlog['s-TASK-0007'] = { data: 'start, reattached', sequence: 5, marks: [] }
    t.clock.advance(1000)
    // The server's next output rides in the same read as the attach reply.
    const child = t.devbox.server.children.at(-1)!
    const deliver = child.stdout
    const live = `${JSON.stringify({
      jsonrpc: '2.0',
      method: 'terminal:data',
      params: [{ id: 's-TASK-0007', data: ' live', sequence: 6, marks: [] }]
    })}\n`
    child.stdout = (text) => deliver(text.includes('start, reattached') ? text + live : text)
    t.broadcasts.length = 0
    t.devbox.server.hello()
    await settle()
    const shown = t.broadcasts
      .filter(([channel]) => channel === 'terminal:data')
      .map(([, payload]) => (payload as TerminalOutput).data)
    expect(shown).toEqual([`${TERMINAL_RESET}start, reattached`, ' live'])
    expect(t.router.mirrorBacklog('s-TASK-0007')?.data).toBe('start, reattached live')
  })

  it('reports a session the restarted server no longer has as exited', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    await t.call('terminal:launchAgent', 'TASK-0004')
    await t.call('terminal:backlog', 's-TASK-0004')
    t.devbox.server.drop()
    await settle()
    t.devbox.state.sessions = []
    t.clock.advance(1000)
    t.devbox.server.hello()
    await settle()
    expect(t.broadcasts).toContainEqual(['terminal:exit', { id: 's-TASK-0004', exitCode: -1 }])
  })
})

describe('remote router: merged events', () => {
  it('merges each server’s tray into the local one, dropping unlinked workspaces, quietly after a connect', async () => {
    const t = setup()
    t.devbox.server.handlers['server:tray'] = () => ({
      statuses: [
        { taskId: 'TASK-0001', state: 'waiting', workspaceId: 'default' },
        { taskId: 'TASK-0002', state: 'working', workspaceId: 'gone' }
      ],
      titles: { 'default:TASK-0001': 'Fix the bug' }
    })
    t.router.refresh()
    t.router.localTrayChanged(
      [{ taskId: 'TASK-0001', state: 'idle', workspaceId: 'default' } as AgentStatus],
      new Map()
    )
    await t.connectAll()
    const last = t.trays.at(-1)!
    expect(last.statuses.map((s) => `${s.workspaceId}:${s.taskId}`)).toEqual([
      'default:TASK-0001',
      'remote-main:TASK-0001'
    ])
    // The model the connect brought in was a baseline: what waited meanwhile is not announced.
    const first = t.trays.find((tray) => tray.statuses.some((s) => s.workspaceId === 'remote-main'))
    expect(first!.quiet).toEqual(['remote-main:TASK-0001'])
    // The next model comes from the live stream: it may notify.
    t.devbox.server.push('server:tray', {
      statuses: [{ taskId: 'TASK-0005', state: 'waiting', workspaceId: 'client' }],
      titles: {}
    })
    expect(t.trays.at(-1)!.quiet).toEqual([])
    expect(t.trays.at(-1)!.statuses.at(-1)).toMatchObject({
      workspaceId: 'remote-client',
      workspaceName: 'Devbox client'
    })
  })

  it('raises the server’s notifications from the live stream', async () => {
    const t = setup()
    t.router.refresh()
    await t.connectAll()
    t.devbox.server.push('server:notify', { title: 'Auto-run paused', body: 'Three failures' })
    expect(t.notified).toEqual(['Auto-run paused: devbox · Three failures'])
  })

  it('merges the switcher rollup under the stubs’ ids', async () => {
    const t = setup()
    t.router.refresh()
    t.router.fromLocal('workspaces:activity', {
      activeId: 'default',
      byWorkspace: { default: { counts: {}, review: 0 } }
    })
    await t.connectAll()
    t.vm.server.push('workspaces:activity', {
      activeId: 'default',
      byWorkspace: { default: { counts: {}, review: 2, top: 'waiting' } }
    })
    const last = t.broadcasts.filter(([c]) => c === 'workspaces:activity').at(-1)![1]
    expect(last).toEqual({
      activeId: 'default',
      byWorkspace: {
        default: { counts: {}, review: 0 },
        'remote-vm': { counts: {}, review: 2, top: 'waiting' }
      }
    })
  })

  it('drops the local board’s events while a live remote board is shown', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    t.broadcasts.length = 0
    t.router.fromLocal('agents:changed', [])
    t.router.fromLocal('tasks:changed')
    t.router.fromLocal('terminal:data', { id: 'local-1' })
    expect(t.channels()).toEqual(['terminal:data'])
    t.devbox.server.push('tasks:changed')
    expect(t.channels()).toEqual(['terminal:data', 'tasks:changed'])
  })
})

describe('remote router: settings and local-only actions', () => {
  it('takes a remote workspace’s own keys from its server and the app-level keys from here', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    const settings = (await t.call('settings:get')) as Settings
    expect(settings).toMatchObject({
      shell: '/bin/bash',
      storageDir: '/Users/me/Styr',
      activeWorkspaceId: 'remote-main',
      shortcuts: { local: true }
    })
  })

  it('saves the app-level part here and the workspace part on the server, with its own globals', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    const global = {
      storageDir: '/Users/me/Styr',
      activeWorkspaceId: 'remote-main',
      updates: { checkAutomatically: false },
      shortcuts: {},
      experimental: { remoteWorkspaces: true }
    }
    await t.call('settings:save', {
      workspaceId: 'remote-main',
      workspace: { shell: '/bin/fish' },
      global
    })
    expect(t.savedGlobal).toEqual([global])
    const save = t.devbox.server.calls.find(([m]) => m === 'settings:save')![1][0] as {
      workspaceId: string
      global: { storageDir: string }
    }
    expect(save.workspaceId).toBe('default')
    expect(save.global.storageDir).toBe('/home/me/Styr')
    expect(t.devbox.state.settings.default).toEqual({ shell: '/bin/fish' })
  })

  it('opens a remote task file in VS Code over ssh, and never in the file manager', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    t.devbox.state.tasks.default = [
      { id: 'TASK-0001', title: 'x', filePath: '/home/me/Styr/tasks/TASK-0001 a.md' }
    ]
    await t.call('tasks:openInEditor', 'TASK-0001')
    expect(t.opened).toEqual([
      'vscode://vscode-remote/ssh-remote+devbox/home/me/Styr/tasks/TASK-0001%20a.md'
    ])
    expect(await t.call('tasks:reveal', 'TASK-0001')).toBeUndefined()
    expect(await t.call('terminal:revealDirectory', '/home/me')).toBe('This folder is on devbox.')
  })
})

describe('remote router: merged workspace views', () => {
  it('takes stubs’ counts and summaries from their servers, and drops them from the local ones', async () => {
    const t = setup()
    t.devbox.state.tasks.client = [{ id: 'TASK-0001', title: 'x', filePath: '/x' }]
    t.devbox.server.handlers['workspaces:boardSummary'] = () => ({ client: { needs: 1 } })
    t.router.refresh()
    await t.connectAll()
    const overview = (await Promise.resolve(
      t.router.invoke('workspaces:list', [], () => ({
        activeId: 'default',
        workspaces: [
          { id: 'default', name: 'Default', taskCount: 3, liveSessions: 0 },
          { id: 'remote-client', name: 'Devbox client', taskCount: 0, liveSessions: 0 }
        ]
      }))
    )) as WorkspaceOverview
    expect(overview.workspaces[1]).toMatchObject({
      taskCount: 1,
      remote: { host: 'devbox', workspaceId: 'client' }
    })
    const summaries = await Promise.resolve(
      t.router.invoke('workspaces:boardSummary', [], () => ({
        default: { needs: 2 },
        'remote-client': { needs: 0 }
      }))
    )
    expect(summaries).toEqual({ default: { needs: 2 }, 'remote-client': { needs: 1 } })
    expect(await t.call('workspaces:activity')).toMatchObject({ byWorkspace: {} })
  })

  it('re-reads the stubs after a workspace is created or removed', async () => {
    const t = setup()
    t.router.refresh()
    t.setWorkspaces([{ id: 'default', name: 'Default' }])
    await Promise.resolve(
      t.router.invoke('workspaces:delete', ['remote-vm'], () => ({
        activeId: 'default',
        workspaces: []
      }))
    )
    expect(t.router.state().hosts).toEqual([])
    expect(t.vm.server.children[0]!.killed).toBe(true)
  })

  it('merges broken settings files under the stubs’ ids', async () => {
    const t = setup()
    t.devbox.server.handlers['settings:brokenFiles'] = () => [
      { workspaceId: 'client', path: '/home/me/Styr/workspaces/client/settings.json' },
      { workspaceId: 'gone', path: '/x' }
    ]
    t.router.refresh()
    await t.connectAll()
    const files = await Promise.resolve(
      t.router.invoke('settings:brokenFiles', [], () => [
        { workspaceId: 'default', path: '/Users/me/Styr/settings.json' },
        { workspaceId: 'remote-main', path: '/stub' }
      ])
    )
    expect(files).toEqual([
      { workspaceId: 'default', path: '/Users/me/Styr/settings.json' },
      { workspaceId: 'remote-client', path: '/home/me/Styr/workspaces/client/settings.json' }
    ])
  })

  it('reports the server’s diagnostics with this machine’s terminal engine', async () => {
    const t = setup({ active: 'remote-main' })
    t.devbox.server.handlers['diagnostics:snapshot'] = () => ({
      taskCount: 7,
      terminalEngine: 'server'
    })
    t.router.refresh()
    await t.connectAll()
    const snapshot = await Promise.resolve(
      t.router.invoke('diagnostics:snapshot', [], () => ({ taskCount: 0, terminalEngine: 'mine' }))
    )
    expect(snapshot).toEqual({ taskCount: 7, terminalEngine: 'mine' })
  })

  it('opens a remote folder in VS Code over ssh', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    expect(await t.call('terminal:openInCode', '/home/me/repo')).toBe('code')
    expect(t.opened).toEqual(['vscode://vscode-remote/ssh-remote+devbox/home/me/repo'])
  })
})

describe('remote router: edge cases', () => {
  it('with the flag off and a stub open, shows an empty board and refuses writes', async () => {
    const t = setup({ enabled: false, active: 'remote-main' })
    t.router.refresh()
    expect(await t.call('tasks:list', {})).toEqual([])
    expect(await t.call('sources:providers')).toBe('local sources:providers')
    await expect(t.call('tasks:create', { title: 'x' })).rejects.toThrow(
      /remote workspaces are off/
    )
    await expect(
      t.call('settings:save', { workspaceId: 'remote-main', workspace: {}, global: {} })
    ).rejects.toThrow(/remote workspaces are off/)
  })

  it('says why a workspace the server does not have cannot be shown', async () => {
    const t = setup()
    t.setWorkspaces([
      { id: 'default', name: 'Default' },
      { id: 'missing', name: 'Missing', remote: { host: 'devbox', workspaceId: 'nope' } }
    ])
    t.router.refresh()
    await t.connectAll()
    await t.switchTo('missing')
    expect(t.router.state().workspaces.missing!.error).toMatch(/no longer exists/)
    await expect(t.call('tasks:create', { title: 'x' })).rejects.toThrow(/cannot be shown/)
    await expect(t.call('orchestrate:plan')).rejects.toThrow(/cannot be shown/)
  })

  it('refuses a terminal write call to a disconnected host, and answers its reads with nothing', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    await t.call('terminal:launchAgent', 'TASK-0001')
    t.devbox.server.drop()
    await settle()
    await expect(t.call('terminal:kill', 's-TASK-0001')).rejects.toThrow(/not connected/)
    expect(await t.call('terminal:runtimeState', 's-TASK-0001')).toBeUndefined()
    expect(await t.call('usage:context', 's-TASK-0001')).toBeNull()
    // A view opened while disconnected gets the mirror (empty here) and is reattached later.
    expect(await t.call('terminal:backlog', 's-TASK-0001')).toEqual({
      data: '',
      sequence: 0,
      marks: []
    })
    const settings = (await t.call('settings:get')) as Settings
    expect(settings.shell).toBe('/bin/bash')
    await expect(
      t.call('settings:save', { workspaceId: 'remote-main', workspace: {}, global: {} })
    ).rejects.toThrow(/were not/)
    expect(t.savedGlobal).toHaveLength(1)
  })

  it('attaches a remote session for the Styr Terminal engine and keeps its mirror', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    await t.call('terminal:launchAgent', 'TASK-0006')
    t.devbox.state.backlog['s-TASK-0006'] = { data: 'abc', sequence: 2, marks: [] }
    expect(t.router.isRemoteSession('s-TASK-0006')).toBe(true)
    expect(t.router.isRemoteSession('local-1')).toBe(false)
    await t.router.ensureAttached('s-TASK-0006')
    expect(t.router.mirrorBacklog('s-TASK-0006')?.data).toBe('abc')
    const exits: string[] = []
    t.router.onTerminalExit((id) => exits.push(id))
    t.devbox.server.push('terminal:exit', { id: 's-TASK-0006', exitCode: 0 })
    expect(exits).toEqual(['s-TASK-0006'])
    expect(t.router.mirrorBacklog('s-TASK-0006')).toBeUndefined()
  })

  it('forwards session events and the live board’s broadcasts, mapped', async () => {
    const t = setup({ active: 'remote-main' })
    t.router.refresh()
    await t.connectAll()
    t.broadcasts.length = 0
    t.devbox.server.push('terminal:runtimeState', { sessionId: 's1', cwd: '/' })
    t.devbox.server.push('orchestrate:autoStarted', {
      id: 's2',
      title: 'x',
      cwd: '/',
      workspaceId: 'default'
    })
    t.devbox.server.push('settings:changed', { activeWorkspaceId: 'default' })
    await settle()
    expect(t.broadcasts[0]).toEqual(['terminal:runtimeState', { sessionId: 's1', cwd: '/' }])
    expect(t.broadcasts[1]).toEqual([
      'orchestrate:autoStarted',
      { id: 's2', title: 'x', cwd: '/', workspaceId: 'remote-main', host: 'devbox' }
    ])
    expect(t.channels()).toContain('settings:changed')
  })

  it('suspends every host while asleep and reconnects on wake', async () => {
    const t = setup()
    t.router.refresh()
    await t.connectAll()
    t.router.suspend()
    expect(t.router.state().hosts.map((h) => h.status)).toEqual(['offline', 'offline'])
    t.router.wake()
    expect(t.router.state().hosts.map((h) => h.status)).toEqual(['connecting', 'connecting'])
    t.router.stopAll()
    expect(t.router.state().hosts).toEqual([])
  })
})
