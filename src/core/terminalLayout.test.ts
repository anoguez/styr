import { describe, expect, it } from 'vitest'
import {
  agentSkip,
  composeLayout,
  inTabOrder,
  layoutEntry,
  offerFor,
  offerText,
  parseLayoutFile,
  restoreSummary,
  shellSkip,
  splitPending,
  type LayoutEntry
} from './terminalLayout.js'
import type { TerminalSessionInfo } from './types.js'

const info = (extra: Partial<TerminalSessionInfo> & { id: string }): TerminalSessionInfo => ({
  title: 'Terminal',
  cwd: '/start',
  ...extra
})

const shell = (cwd = '/home'): LayoutEntry => ({ kind: 'shell', cwd, title: 'Terminal' })
const agent = (taskId: string, workspaceId = 'default'): LayoutEntry => ({
  kind: 'agent',
  cwd: '/repo',
  title: taskId,
  taskId,
  workspaceId,
  provider: 'claude'
})

describe('layoutEntry', () => {
  it('saves a shell where it is now', () => {
    expect(layoutEntry(info({ id: 'a', title: 'Zsh' }), '/now')).toEqual({
      kind: 'shell',
      cwd: '/now',
      title: 'Zsh'
    })
  })

  it('saves an agent tab with its task, workspace and provider', () => {
    const entry = layoutEntry(
      info({ id: 'a', taskId: 'TASK-1', workspaceId: 'w', provider: 'codex' }),
      '/now'
    )
    expect(entry).toEqual({
      kind: 'agent',
      cwd: '/start',
      title: 'Terminal',
      taskId: 'TASK-1',
      workspaceId: 'w',
      provider: 'codex'
    })
  })

  it('leaves out remote sessions, replays and chats that belong to no task', () => {
    expect(layoutEntry(info({ id: 'a', host: 'box' }), '/x')).toBeUndefined()
    expect(
      layoutEntry(
        info({ id: 'a', taskId: 'T', workspaceId: 'w', provider: 'claude', replay: true }),
        '/x'
      )
    ).toBeUndefined()
    expect(layoutEntry(info({ id: 'a', taskId: 'T' }), '/x')).toBeUndefined()
  })
})

describe('inTabOrder', () => {
  it('follows the reported order, then the sessions not reported yet', () => {
    const sessions = [info({ id: 'a' }), info({ id: 'b' }), info({ id: 'c' })]
    expect(inTabOrder(sessions, ['c', 'gone', 'a']).map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('composeLayout', () => {
  it('puts the pending entries before the live ones and offsets the active index', () => {
    const pending = [shell('/old')]
    const file = composeLayout(pending, undefined, [shell('/new'), agent('T')], 1, 't')
    expect(file.tabs.map((entry) => entry.cwd)).toEqual(['/old', '/new', '/repo'])
    expect(file.active).toBe(2)
  })

  it('keeps the pending active tab while no live tab is active', () => {
    const pending = [shell('/a'), shell('/b')]
    expect(composeLayout(pending, pending[1], [], undefined, 't').active).toBe(1)
    expect(composeLayout([], undefined, [], undefined, 't')).not.toHaveProperty('active')
  })
})

describe('splitPending', () => {
  it('offers shells and the active workspace’s agents now, other agents later', () => {
    const entries = [shell(), agent('T1', 'a'), agent('T2', 'b')]
    const { now, later } = splitPending(entries, 'a')
    expect(now).toEqual([entries[0], entries[1]])
    expect(later).toEqual([entries[2]])
  })
})

describe('offers', () => {
  it('counts tabs and agents, and offers nothing for nothing', () => {
    expect(offerFor([shell(), agent('T')], false)).toEqual({ tabs: 2, agents: 1, auto: false })
    expect(offerFor([], true)).toBeNull()
  })

  it('words the banner', () => {
    expect(offerText({ tabs: 4, agents: 2 })).toBe(
      'Restore 4 terminal tabs from your last session (2 agents)'
    )
    expect(offerText({ tabs: 1, agents: 0 })).toBe('Restore 1 terminal tab from your last session')
    expect(offerText({ tabs: 2, agents: 2 })).toBe('Restore 2 agent tabs from your last session')
  })

  it('lists what was skipped', () => {
    expect(restoreSummary(4, [])).toBe('4 restored')
    expect(restoreSummary(3, ['TASK-42 has no saved chat', '~/old no longer exists'])).toBe(
      '3 restored · 2 not restored: TASK-42 has no saved chat; ~/old no longer exists'
    )
  })
})

describe('skips', () => {
  it('skips a shell whose folder is gone', () => {
    expect(shellSkip(shell('/old'), true)).toBeUndefined()
    expect(shellSkip(shell('/old'), false)).toBe('/old no longer exists')
  })

  it('skips a deleted, done or archived task and one with no chat', () => {
    expect(agentSkip('T', null, true)).toBe('T no longer exists')
    expect(agentSkip('T', { status: 'done' }, true)).toBe('T is done or archived')
    expect(agentSkip('T', { status: 'backlog', archivedAt: 'x' }, true)).toBe(
      'T is done or archived'
    )
    expect(agentSkip('T', { status: 'in_review' }, false)).toBe('T has no saved chat')
    expect(agentSkip('T', { status: 'in_review' }, true)).toBeUndefined()
  })
})

describe('parseLayoutFile', () => {
  it('reads a saved file and ignores a broken one or another version', () => {
    const file = composeLayout([], undefined, [shell()], 0, 't')
    expect(parseLayoutFile(JSON.stringify(file))).toEqual(file)
    expect(parseLayoutFile('{not json')).toBeUndefined()
    expect(parseLayoutFile(JSON.stringify({ ...file, version: 2 }))).toBeUndefined()
    expect(parseLayoutFile(JSON.stringify({ version: 1, tabs: 'x' }))).toBeUndefined()
  })
})
