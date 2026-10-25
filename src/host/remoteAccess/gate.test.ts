import { describe, expect, it } from 'vitest'
import { RPC_ERRORS, RpcError } from '@host/rpc/jsonRpc.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  CLASSIFIED_CHANNELS,
  HIDDEN,
  createNetworkPolicy,
  redactSettings,
  type GatePorts
} from './gate.js'

function setup(overrides: Partial<{ shared: string[]; active: string }> = {}) {
  const state = {
    shared: new Set(overrides.shared ?? ['open']),
    active: overrides.active ?? 'open',
    sessions: new Map<string, string | undefined>([
      ['t-open', 'open'],
      ['t-closed', 'closed'],
      ['t-shell', undefined]
    ]),
    global: { storageDir: '/Styr', activeWorkspaceId: 'open' }
  }
  const ports: GatePorts = {
    isOpen: (id) => state.shared.has(id),
    activeId: () => state.active,
    sessionWorkspace: (id) => ({
      exists: state.sessions.has(id),
      workspaceId: state.sessions.get(id)
    }),
    currentGlobal: () => state.global,
    sourcesOf: () => []
  }
  return { state, policy: createNetworkPolicy(ports) }
}

function refused(run: () => void): boolean {
  try {
    run()
    return false
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError)
    expect((error as RpcError).code).toBe(RPC_ERRORS.FORBIDDEN)
    return true
  }
}

describe('network policy: calls', () => {
  it('lets a shared active workspace use the board', () => {
    const { policy } = setup()
    for (const method of [
      'tasks:list',
      'tasks:create',
      'orchestrate:run',
      'terminal:launchAgent'
    ]) {
      expect(refused(() => policy.check(method, []))).toBe(false)
    }
  })

  it('refuses every board channel while the active workspace is not shared', () => {
    const { policy } = setup({ shared: [] })
    for (const method of [
      'tasks:list',
      'tasks:create',
      'agents:list',
      'git:diffStats',
      'worklog:load',
      'terminal:list',
      'terminal:create',
      'terminal:listDirectories',
      'orchestrate:autoSet',
      'sources:sync',
      'review:get',
      'usage:claude'
    ]) {
      expect(refused(() => policy.check(method, [{}]))).toBe(true)
    }
  })

  it('keeps the switcher working with nothing shared, listing nothing', () => {
    const { policy } = setup({ shared: [] })
    expect(refused(() => policy.check('workspaces:list', []))).toBe(false)
    expect(refused(() => policy.check('server:info', []))).toBe(false)
    const overview = { activeId: 'open', workspaces: [{ id: 'open' }, { id: 'closed' }] }
    expect(policy.result('workspaces:list', [], overview)).toEqual({ activeId: '', workspaces: [] })
  })

  it('switches, renames and deletes only shared workspaces; never creates', () => {
    const { policy } = setup()
    for (const method of ['workspaces:switch', 'workspaces:rename', 'workspaces:delete']) {
      expect(refused(() => policy.check(method, ['open', 'x']))).toBe(false)
      expect(refused(() => policy.check(method, ['closed', 'x']))).toBe(true)
      expect(refused(() => policy.check(method, [42]))).toBe(true)
      expect(refused(() => policy.check(method, []))).toBe(true)
    }
    expect(refused(() => policy.check('workspaces:create', ['new']))).toBe(true)
  })

  it('reads settings only of shared workspaces', () => {
    const { policy, state } = setup()
    expect(refused(() => policy.check('settings:get', []))).toBe(false)
    expect(refused(() => policy.check('settings:get', ['open']))).toBe(false)
    expect(refused(() => policy.check('settings:get', ['closed']))).toBe(true)
    state.shared.clear()
    expect(refused(() => policy.check('settings:get', []))).toBe(true)
  })

  it('saves workspace keys of a shared workspace and nothing app-level', () => {
    const { policy, state } = setup()
    const change = (workspaceId: string, global: unknown) => ({
      workspaceId,
      workspace: {},
      global
    })
    expect(refused(() => policy.check('settings:save', [change('open', state.global)]))).toBe(false)
    expect(refused(() => policy.check('settings:save', [change('closed', state.global)]))).toBe(
      true
    )
    expect(
      refused(() =>
        policy.check('settings:save', [change('open', { ...state.global, storageDir: '/etc' })])
      )
    ).toBe(true)
    expect(refused(() => policy.check('settings:save', [undefined]))).toBe(true)
  })

  it('refuses desktop-only families and the experimental switches', () => {
    const { policy } = setup()
    for (const method of [
      'remote:connect',
      'remote:state',
      'updates:install',
      'access:revoke',
      'access:pair',
      'server:experimental',
      'settings:pickDirectory',
      'terminal:nativeText',
      'app:takeCommand'
    ]) {
      expect(refused(() => policy.check(method, []))).toBe(true)
    }
  })

  it('checks the workspace of a terminal a call names', () => {
    const { policy } = setup()
    for (const method of [
      'terminal:attach',
      'terminal:kill',
      'terminal:write',
      'terminal:resize'
    ]) {
      expect(refused(() => policy.check(method, ['t-open']))).toBe(false)
      expect(refused(() => policy.check(method, ['t-closed']))).toBe(true)
      expect(refused(() => policy.check(method, ['t-missing']))).toBe(true)
      expect(refused(() => policy.check(method, []))).toBe(true)
    }
    for (const method of ['agent:prompt', 'agent:approval', 'usage:context', 'terminal:handOff']) {
      expect(refused(() => policy.check(method, ['t-closed']))).toBe(true)
    }
    // A plain shell is open on the desktop; a device may not touch it.
    expect(refused(() => policy.check('terminal:attach', ['t-shell']))).toBe(true)
    expect(refused(() => policy.check('terminal:write', ['t-shell']))).toBe(true)
  })

  it('lets a client detach from a terminal whose workspace stopped being shared', () => {
    const { policy } = setup()
    expect(refused(() => policy.check('terminal:detach', ['t-closed']))).toBe(false)
  })

  it('checks the workspace a new terminal asks for', () => {
    const { policy, state } = setup()
    expect(refused(() => policy.check('terminal:create', [{ workspaceId: 'closed' }]))).toBe(true)
    expect(refused(() => policy.check('terminal:create', [{ workspaceId: 'open' }]))).toBe(false)
    expect(refused(() => policy.check('terminal:create', [{}]))).toBe(false)
    state.shared.clear()
    expect(refused(() => policy.check('terminal:create', [{}]))).toBe(true)
  })
})

describe('network policy: answers', () => {
  it('lists only shared workspaces and hides an active one that is not shared', () => {
    const { policy } = setup({ shared: ['open'], active: 'closed' })
    const overview = { activeId: 'closed', workspaces: [{ id: 'open', n: 1 }, { id: 'closed' }] }
    expect(policy.result('workspaces:switch', ['open'], overview)).toEqual({
      activeId: '',
      workspaces: [{ id: 'open', n: 1 }]
    })
  })

  it('filters the rollups, the summaries and the terminal list', () => {
    const { policy } = setup()
    expect(
      policy.result('workspaces:activity', [], {
        activeId: 'closed',
        byWorkspace: { open: { review: 1 }, closed: { review: 9 } }
      })
    ).toEqual({ activeId: 'open', byWorkspace: { open: { review: 1 } } })
    expect(policy.result('workspaces:boardSummary', [], { open: {}, closed: {} })).toEqual({
      open: {}
    })
    expect(
      policy.result('terminal:list', [], [{ id: 't-open' }, { id: 't-closed' }, { id: 't-shell' }])
    ).toEqual([{ id: 't-open' }])
    expect(policy.result('tasks:list', [], [1])).toEqual([1])
  })

  it('filters the tray to shared workspaces, titles included', () => {
    const { policy } = setup()
    const tray = {
      statuses: [
        { taskId: 'TASK-1', workspaceId: 'open' },
        { taskId: 'TASK-2', workspaceId: 'closed' },
        { taskId: 'TASK-3' }
      ],
      titles: { 'open:TASK-1': 'Shared', 'closed:TASK-2': 'Secret', 'TASK-3': 'Active' }
    }
    expect(policy.result('server:tray', [], tray)).toEqual({
      statuses: [tray.statuses[0], tray.statuses[2]],
      titles: { 'open:TASK-1': 'Shared', 'TASK-3': 'Active' }
    })
    expect(policy.result('server:tray', [], 'garbage')).toEqual({ statuses: [], titles: {} })
  })
})

describe('network policy: broadcasts', () => {
  const BOARD = [
    'tasks:changed',
    'agents:changed',
    'review:changed',
    'sources:state',
    'orchestrate:autoState',
    'orchestrate:autoStarted',
    'usage:claude',
    'tasks:activate'
  ]

  it('passes the board events of a shared active workspace', () => {
    const { policy } = setup()
    for (const channel of BOARD)
      expect(policy.broadcast(channel, { a: 1 })).toEqual({ payload: { a: 1 } })
  })

  it('drops every board event while the active workspace is not shared', () => {
    const { policy } = setup({ shared: [] })
    for (const channel of BOARD) expect(policy.broadcast(channel, { a: 1 })).toBeNull()
    expect(policy.broadcast('some:newChannel', {})).toBeNull()
  })

  it('never forwards notifications for the desktop', () => {
    const { policy } = setup()
    expect(policy.broadcast('server:notify', { title: 't', body: 'b' })).toBeNull()
    for (const channel of [
      'remote:state',
      'remote:setupProgress',
      'updates:state',
      'access:changed',
      'app:command',
      'terminal:nativeFrame'
    ]) {
      expect(policy.broadcast(channel, {})).toBeNull()
    }
  })

  it('filters terminal events by the terminal’s workspace', () => {
    const { policy } = setup()
    for (const channel of ['terminal:runtimeState', 'terminal:exit']) {
      expect(policy.broadcast(channel, { id: 't-open' })).toEqual({ payload: { id: 't-open' } })
      expect(policy.broadcast(channel, { id: 't-closed' })).toBeNull()
      expect(policy.broadcast(channel, { id: 't-missing' })).toBeNull()
      expect(policy.broadcast(channel, undefined)).toBeNull()
    }
    expect(policy.terminal('t-open')).toBe(true)
    expect(policy.terminal('t-closed')).toBe(false)
  })

  it('filters conversations and context by the terminal they belong to', () => {
    const { policy } = setup()
    for (const channel of ['agent:conversation', 'usage:context']) {
      const open = { terminalId: 't-open', x: 1 }
      expect(policy.broadcast(channel, open)).toEqual({ payload: open })
      expect(policy.broadcast(channel, { terminalId: 't-closed' })).toBeNull()
      expect(policy.broadcast(channel, { terminalId: 't-shell' })).toBeNull()
      expect(policy.broadcast(channel, { terminalId: 't-missing' })).toBeNull()
      expect(policy.broadcast(channel, {})).toBeNull()
    }
  })

  it('sends nothing it has not been told about', () => {
    const { policy } = setup()
    expect(policy.broadcast('some:newEvent', { secret: 1 })).toBeNull()
  })

  it('filters the switcher’s broadcasts', () => {
    const { policy } = setup({ shared: ['open'], active: 'closed' })
    expect(
      policy.broadcast('workspaces:changed', {
        activeId: 'closed',
        workspaces: [{ id: 'open' }, { id: 'closed' }]
      })
    ).toEqual({ payload: { activeId: '', workspaces: [{ id: 'open' }] } })
    expect(
      policy.broadcast('workspaces:activity', {
        activeId: 'closed',
        byWorkspace: { open: {}, closed: {} }
      })
    ).toEqual({ payload: { activeId: '', byWorkspace: { open: {} } } })
    expect(
      policy.broadcast('server:tray', {
        statuses: [{ taskId: 'x', workspaceId: 'closed' }],
        titles: {}
      })
    ).toEqual({
      payload: { statuses: [], titles: {} }
    })
  })

  it('tells the client its workspace stopped being shared, without describing it', () => {
    const { policy, state } = setup()
    const settings = { remoteAccess: true, shell: '/bin/zsh', sources: [{ token: 'secret' }] }
    expect(policy.broadcast('settings:changed', settings)).toEqual({ payload: settings })
    state.shared.clear()
    expect(policy.broadcast('settings:changed', settings)).toEqual({
      payload: { remoteAccess: false }
    })
  })
})

describe('network policy: shells and secrets', () => {
  it('lets a device use the plain shells it opened, and only those', () => {
    const { policy, state } = setup()
    state.sessions.set('t-mine', undefined)
    expect(refused(() => policy.check('terminal:write', ['t-mine']))).toBe(true)
    policy.result('terminal:create', [{ shell: '/bin/sh' }], { id: 't-mine' })
    expect(refused(() => policy.check('terminal:write', ['t-mine']))).toBe(false)
    expect(policy.terminal('t-mine')).toBe(true)
    // Another device has its own policy, and does not inherit it.
    const other = createNetworkPolicy({
      isOpen: (id) => state.shared.has(id),
      activeId: () => state.active,
      sessionWorkspace: (id) => ({ exists: state.sessions.has(id), workspaceId: undefined }),
      currentGlobal: () => state.global,
      sourcesOf: () => []
    })
    expect(other.terminal('t-mine')).toBe(false)
    expect(policy.result('terminal:list', [], [{ id: 't-mine' }, { id: 't-shell' }])).toEqual([
      { id: 't-mine' }
    ])
    state.shared.clear()
    expect(policy.terminal('t-mine')).toBe(false)
  })

  const rest = {
    id: 'rest1',
    rest: {
      request: {
        method: 'GET',
        url: 'https://x.test',
        headers: [
          { name: 'Authorization', value: 'Bearer sk-secret', enabled: true },
          { name: 'Empty', value: '', enabled: true }
        ],
        body: '{"key":"sk-secret"}'
      }
    }
  }

  it('hides REST header values and bodies from settings answers and broadcasts', () => {
    const { policy } = setup()
    const settings = { shell: '/bin/zsh', sources: [rest] }
    for (const shown of [
      policy.result('settings:get', [], settings),
      policy.result('settings:save', [], settings),
      policy.broadcast('settings:changed', settings)?.payload
    ]) {
      const text = JSON.stringify(shown)
      expect(text).not.toContain('sk-secret')
      expect(text).toContain(HIDDEN)
      expect(text).toContain('Authorization')
    }
    expect(redactSettings({ shell: 'x' })).toEqual({ shell: 'x' })
  })

  it('puts the stored secrets back when a device saves the settings it was shown', () => {
    const state = { sources: [rest] as unknown[] }
    const { policy } = setup()
    const withSources = createNetworkPolicy({
      isOpen: () => true,
      activeId: () => 'open',
      sessionWorkspace: () => ({ exists: false }),
      currentGlobal: () => ({}),
      sourcesOf: () => state.sources
    })
    void policy
    const shown = redactSettings({ sources: [rest] }) as { sources: unknown[] }
    const [change] = withSources.params('settings:save', [
      { workspaceId: 'open', workspace: { sources: shown.sources }, global: {} }
    ]) as [{ workspace: { sources: (typeof rest)[] } }]
    expect(change.workspace.sources[0]).toEqual(rest)
    // A header the device added itself cannot name a hidden value it never had.
    const [forged] = withSources.params('settings:save', [
      {
        workspaceId: 'open',
        workspace: {
          sources: [
            {
              ...rest,
              rest: {
                request: {
                  ...rest.rest.request,
                  headers: [{ name: 'X-New', value: HIDDEN }],
                  body: ''
                }
              }
            }
          ]
        },
        global: {}
      }
    ]) as [{ workspace: { sources: (typeof rest)[] } }]
    expect(forged.workspace.sources[0]?.rest.request.headers[0]?.value).toBe('')
    // Pointing the source at another URL must not carry its stored secrets there.
    const [moved] = withSources.params('settings:save', [
      {
        workspaceId: 'open',
        workspace: {
          sources: [
            {
              ...rest,
              rest: {
                request: {
                  ...(shown.sources[0] as typeof rest).rest.request,
                  url: 'https://attacker.test'
                }
              }
            }
          ]
        },
        global: {}
      }
    ]) as [{ workspace: { sources: (typeof rest)[] } }]
    expect(JSON.stringify(moved)).not.toContain('sk-secret')
    expect(withSources.params('tasks:list', ['x'])).toEqual(['x'])
  })
})

describe('network policy: every channel is classified', () => {
  it('names each channel of the shared table and the hub, so a new one is refused until decided', () => {
    const table = readFileSync(
      fileURLToPath(new URL('../channelTable.ts', import.meta.url)),
      'utf8'
    )
    const channels = [...table.matchAll(/^\s+'([a-z]+:[A-Za-z]+)': channel\(/gm)].map((m) => m[1]!)
    const hub = [
      'server:info',
      'server:tray',
      'terminal:attach',
      'terminal:detach',
      'terminal:focus',
      'terminal:resize'
    ]
    expect(channels.length).toBeGreaterThan(60)
    expect([...channels, ...hub].filter((name) => !CLASSIFIED_CHANNELS.has(name))).toEqual([])
  })

  it('refuses a channel nobody classified', () => {
    const { policy } = setup()
    expect(refused(() => policy.check('brand:new', []))).toBe(true)
    expect(refused(() => policy.check('constructor', []))).toBe(true)
  })
})
