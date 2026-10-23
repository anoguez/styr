import { describe, expect, it } from 'vitest'
import { composeLayout, type LayoutEntry } from '@core/terminalLayout.js'
import type { RestoreTabsMode, TerminalSessionInfo } from '@core/types.js'
import { createTerminalTabsService, type TerminalTabsPorts } from './terminalTabs.js'

const shellEntry = (cwd: string): LayoutEntry => ({ kind: 'shell', cwd, title: 'Terminal' })
const agentEntry = (taskId: string, workspaceId = 'default'): LayoutEntry => ({
  kind: 'agent',
  cwd: '/repo',
  title: taskId,
  taskId,
  workspaceId,
  provider: 'claude'
})

function harness(saved?: { tabs: LayoutEntry[]; active?: number }) {
  const h = {
    file: saved
      ? JSON.stringify(
          composeLayout([], undefined, saved.tabs, saved.active, '2026-01-01T00:00:00Z')
        )
      : (undefined as string | undefined),
    writes: 0,
    mode: 'ask' as RestoreTabsMode,
    workspace: 'default',
    workspaces: ['default', 'other'],
    sessions: [] as TerminalSessionInfo[],
    cwds: new Map<string, string>(),
    folders: new Set(['/home', '/work']),
    agentFailures: new Map<string, string>(),
    opened: [] as string[],
    next: 0
  }
  const add = (extra: Partial<TerminalSessionInfo>): TerminalSessionInfo => {
    const created = { id: `s${++h.next}`, title: 'Terminal', cwd: '/home', ...extra }
    h.sessions.push(created)
    return created
  }
  const ports: TerminalTabsPorts = {
    store: {
      read: () => h.file,
      write: (text) => {
        h.file = text
        h.writes++
      }
    },
    settings: () => ({ restoreTabs: h.mode, activeWorkspaceId: h.workspace }),
    workspaceIds: () => h.workspaces,
    terminals: {
      listSessions: () => h.sessions,
      currentDirectory: (id) => h.cwds.get(id),
      createShell: ({ cwd, title }) => (h.opened.push(`shell ${cwd}`), add({ cwd, title }))
    },
    agents: {
      restoreAgent: async (taskId) => {
        const failure = h.agentFailures.get(taskId)
        if (failure) throw new Error(`${taskId} ${failure}`)
        h.opened.push(`agent ${taskId}`)
        return add({ taskId, title: taskId, workspaceId: h.workspace, provider: 'claude' })
      }
    },
    directoryExists: (path) => h.folders.has(path),
    now: () => '2026-01-02T00:00:00Z'
  }
  const service = createTerminalTabsService(ports)
  const saved_ = () => (h.file ? (JSON.parse(h.file).tabs as LayoutEntry[]) : undefined)
  return { h, add, service, tabs: saved_ }
}

describe('saving', () => {
  it('writes on a tab change, with the shell where it is now', () => {
    const { h, add, service, tabs } = harness()
    const shell = add({ cwd: '/home' })
    h.cwds.set(shell.id, '/work')
    add({ taskId: 'T1', workspaceId: 'default', provider: 'claude', title: 'T1' })
    service.changed()
    expect(tabs()?.map((entry) => [entry.kind, entry.cwd])).toEqual([
      ['shell', '/work'],
      ['agent', '/home']
    ])
  })

  it('follows the order and active tab the renderer reports', () => {
    const { h, add, service } = harness()
    const a = add({})
    const b = add({})
    service.setLayout([b.id, a.id], a.id)
    const file = JSON.parse(h.file!)
    expect(file.active).toBe(1)
    expect(file.version).toBe(1)
  })

  it('leaves out remote sessions and writes nothing when nothing changed', () => {
    const { h, add, service, tabs } = harness()
    add({ host: 'box' })
    service.changed()
    expect(tabs()).toEqual([])
    const writes = h.writes
    service.changed()
    expect(h.writes).toBe(writes)
  })

  it('drops a tab that exited', () => {
    const { h, add, service, tabs } = harness()
    add({})
    const second = add({ cwd: '/work' })
    service.changed()
    h.sessions.splice(0, 1)
    service.changed()
    expect(tabs()?.map((entry) => entry.cwd)).toEqual([second.cwd])
  })

  it('freezes on quit: killing the tabs does not save an empty layout', () => {
    const { h, add, service, tabs } = harness()
    add({})
    service.changed()
    service.freeze()
    h.sessions.length = 0
    service.changed()
    service.setLayout([], null)
    expect(tabs()).toHaveLength(1)
  })

  it('keeps an empty layout when every tab was closed by hand', () => {
    const { h, add, service, tabs } = harness()
    add({})
    service.changed()
    h.sessions.length = 0
    service.changed()
    expect(tabs()).toEqual([])
    expect(harness({ tabs: [] }).service.offer()).toBeNull()
  })

  it('with never, neither saves nor offers', () => {
    const { h, add, service } = harness({ tabs: [shellEntry('/home')] })
    h.mode = 'never'
    add({})
    service.changed()
    expect(h.writes).toBe(0)
    expect(service.offer()).toBeNull()
  })
})

describe('the offer', () => {
  it('counts the shells and the active workspace’s agents, and leaves the rest pending', () => {
    const { h, service } = harness({
      tabs: [shellEntry('/home'), agentEntry('T1'), agentEntry('T2', 'other')],
      active: 1
    })
    expect(service.offer()).toEqual({ tabs: 2, agents: 1, auto: false })
    h.workspace = 'other'
    expect(service.offer()).toEqual({ tabs: 2, agents: 1, auto: false })
  })

  it('is automatic with always, and empty for a broken file', () => {
    const { h, service } = harness({ tabs: [shellEntry('/home')] })
    h.mode = 'always'
    expect(service.offer()?.auto).toBe(true)
    const broken = harness()
    broken.h.file = '{oops'
    expect(broken.service.offer()).toBeNull()
  })

  it('drops an agent tab of a deleted workspace silently', () => {
    const { service } = harness({ tabs: [agentEntry('T1', 'deleted')] })
    expect(service.offer()).toBeNull()
  })

  it('keeps the old tabs in the file, before new ones, until the user answers', () => {
    const { add, service, tabs } = harness({ tabs: [shellEntry('/home'), agentEntry('T1')] })
    expect(service.offer()).not.toBeNull()
    add({ cwd: '/work' })
    service.changed()
    expect(tabs()?.map((entry) => entry.cwd)).toEqual(['/home', '/repo', '/work'])
  })
})

describe('restoring', () => {
  it('reopens the tabs in order, resumes agents and focuses the saved active tab', async () => {
    const { h, service, tabs } = harness({
      tabs: [shellEntry('/home'), agentEntry('T1'), shellEntry('/work')],
      active: 1
    })
    const result = await service.restore()
    expect(h.opened).toEqual(['shell /home', 'agent T1', 'shell /work'])
    expect(result.sessions.map((session) => session.id)).toEqual(['s1', 's2', 's3'])
    expect(result.activeId).toBe('s2')
    expect(result.skipped).toEqual([])
    expect(tabs()).toHaveLength(3)
    expect(service.offer()).toBeNull()
  })

  it('skips what cannot come back, reports it and still restores the rest', async () => {
    const { h, service } = harness({
      tabs: [shellEntry('/gone'), agentEntry('T1'), agentEntry('T2'), shellEntry('/work')]
    })
    h.agentFailures.set('T1', 'has no saved chat')
    const result = await service.restore()
    expect(result.skipped).toEqual(['/gone no longer exists', 'T1 has no saved chat'])
    expect(h.opened).toEqual(['agent T2', 'shell /work'])
  })

  it('leaves another workspace’s agent tabs pending until it is the active one', async () => {
    const { h, service, tabs } = harness({ tabs: [shellEntry('/home'), agentEntry('T9', 'other')] })
    await service.restore()
    expect(h.opened).toEqual(['shell /home'])
    expect(tabs()?.map((entry) => entry.cwd)).toEqual(['/repo', '/home'])
    h.workspace = 'other'
    expect(service.offer()).toEqual({ tabs: 1, agents: 1, auto: false })
    await service.restore()
    expect(h.opened).toEqual(['shell /home', 'agent T9'])
  })
})

describe('dismissing', () => {
  it('forgets the shells and this workspace’s tabs for good, and keeps the other workspace’s', () => {
    const { service, tabs } = harness({
      tabs: [shellEntry('/home'), agentEntry('T1'), agentEntry('T2', 'other')]
    })
    service.dismiss()
    expect(service.offer()).toBeNull()
    expect(tabs()?.map((entry) => entry.taskId)).toEqual(['T2'])
  })
})
