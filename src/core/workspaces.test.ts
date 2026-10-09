import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shippedWorkspaceSettings } from './config.js'
import { importSettingsModules, writeTestConfig } from './settingsFixture.js'
import { worktreeKey } from './types.js'

let home: string

const SEED = shippedWorkspaceSettings()

async function modules() {
  const config = await importSettingsModules(home)
  const workspaces = await import('./workspaces.js')
  const agentStore = await import('./agentStore.js')
  return { config, workspaces, agentStore }
}

function settingsFor(storageDir: string, activeWorkspaceId = 'default') {
  return { storageDir, activeWorkspaceId } as never
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'styr-workspaces-test-'))
})

afterEach(() => {
  delete process.env.STYR_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('worktreeKey', () => {
  it('keeps the bare id for Default so existing worktrees still resolve', () => {
    expect(worktreeKey('default', 'TASK-0001')).toBe('TASK-0001')
    expect(worktreeKey(undefined, 'TASK-0001')).toBe('TASK-0001')
  })

  it('separates the same task id in different workspaces', () => {
    expect(worktreeKey('client-a', 'TASK-0001')).toBe('client-a-TASK-0001')
    expect(worktreeKey('client-b', 'TASK-0001')).not.toBe(worktreeKey('client-a', 'TASK-0001'))
  })
})

describe('workspace paths', () => {
  it('puts Default at the storage root and others beneath it', async () => {
    const { config } = await modules()
    const storage = join(home, 'Styr')
    expect(config.workspaceDir(settingsFor(storage))).toBe(storage)
    expect(config.workspaceDir(settingsFor(storage, 'client-a'))).toBe(
      join(storage, 'workspaces', 'client-a')
    )
    expect(config.tasksDir(settingsFor(storage, 'default'))).toBe(join(storage, 'tasks'))
  })

  it('migrates the old workspaceDir key and falls back from a dangling workspace', async () => {
    const { config } = await modules()
    const storage = join(home, 'Old')
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'config.json'),
      JSON.stringify({ workspaceDir: storage, activeWorkspaceId: 'gone' })
    )
    const settings = config.loadSettings()
    expect(settings.storageDir).toBe(storage)
    expect(settings.activeWorkspaceId).toBe('default')
    expect('workspaceDir' in settings).toBe(false)
  })

  it('pins a process to one workspace, as the MCP server does for its agent', async () => {
    const { config, workspaces } = await modules()
    const storage = join(home, 'Styr')
    writeTestConfig(home, { storageDir: storage })
    const created = workspaces.createWorkspace(settingsFor(storage), 'Client A', SEED)
    expect(config.loadSettings().activeWorkspaceId).toBe('default')
    config.pinWorkspace(created.id)
    expect(config.loadSettings().activeWorkspaceId).toBe(created.id)
    config.pinWorkspace(undefined)
    expect(config.loadSettings().activeWorkspaceId).toBe('default')
  })
})

describe('workspaces', () => {
  it('lists Default first, then the rest by name, reading names from workspace.json', async () => {
    const { workspaces } = await modules()
    const settings = settingsFor(join(home, 'Styr'))
    workspaces.createWorkspace(settings, 'Zeta', SEED)
    workspaces.createWorkspace(settings, 'Alpha', SEED)
    expect(workspaces.listWorkspaces(settings).map((w) => w.name)).toEqual([
      'Default',
      'Alpha',
      'Zeta'
    ])
  })

  it('creates a folder with its own tasks directory', async () => {
    const { workspaces } = await modules()
    const storage = join(home, 'Styr')
    const created = workspaces.createWorkspace(settingsFor(storage), 'Client A', SEED)
    expect(created).toEqual({ id: 'client-a', name: 'Client A' })
    expect(existsSync(join(storage, 'workspaces', 'client-a', 'tasks'))).toBe(true)
  })

  it('rejects empty and duplicate names without regard to case, Default included', async () => {
    const { workspaces } = await modules()
    const settings = settingsFor(join(home, 'Styr'))
    workspaces.createWorkspace(settings, 'Client A', SEED)
    expect(() => workspaces.createWorkspace(settings, '   ', SEED)).toThrow(
      'Give the workspace a name'
    )
    expect(() => workspaces.createWorkspace(settings, 'client a', SEED)).toThrow('already exists')
    expect(() => workspaces.createWorkspace(settings, 'default', SEED)).toThrow('already exists')
  })

  it('gives colliding slugs distinct ids and keeps both names', async () => {
    const { workspaces } = await modules()
    const settings = settingsFor(join(home, 'Styr'))
    const first = workspaces.createWorkspace(settings, 'A B', SEED)
    const second = workspaces.createWorkspace(settings, 'a-b', SEED)
    expect(second.id).not.toBe(first.id)
    expect(workspaces.listWorkspaces(settings).map((w) => w.name)).toContain('a-b')
  })

  it('renames by name only and refuses to rename Default', async () => {
    const { workspaces } = await modules()
    const settings = settingsFor(join(home, 'Styr'))
    const created = workspaces.createWorkspace(settings, 'Client A', SEED)
    workspaces.renameWorkspace(settings, created.id, 'Client B')
    expect(workspaces.listWorkspaces(settings)).toContainEqual({ id: 'client-a', name: 'Client B' })
    expect(() => workspaces.renameWorkspace(settings, 'default', 'Other')).toThrow('Default')
  })

  it('still lists a folder whose workspace.json is missing, named after its folder', async () => {
    const { workspaces } = await modules()
    const storage = join(home, 'Styr')
    mkdirSync(join(storage, 'workspaces', 'orphan', 'tasks'), { recursive: true })
    expect(workspaces.listWorkspaces(settingsFor(storage))).toContainEqual({
      id: 'orphan',
      name: 'orphan'
    })
  })

  it('keeps task ids and agent records apart between workspaces', async () => {
    const { workspaces, agentStore, config } = await modules()
    const storage = join(home, 'Styr')
    const settings = settingsFor(storage)
    const other = workspaces.createWorkspace(settings, 'Client A', SEED)
    agentStore.recordAgentEvent(
      config.pathsInWorkspace(settings, other.id),
      'TASK-0001',
      'Notification'
    )
    expect(agentStore.readAllAgentStatuses(settings)).toEqual([])
    expect(
      agentStore.readAllAgentStatuses(config.pathsInWorkspace(settings, other.id))
    ).toHaveLength(1)
  })
})

describe('background agents', () => {
  it('reads agents of other workspaces only, tagged and titled, skipping Done tasks', async () => {
    const { workspaces, agentStore, config } = await modules()
    const storage = join(home, 'Styr')
    const settings = settingsFor(storage)
    const other = workspaces.createWorkspace(settings, 'Client A', SEED)
    const scoped = config.pathsInWorkspace(settings, other.id)
    const task = (id: string, title: string, status: string) =>
      writeFileSync(
        join(config.tasksDir(scoped), `${id}.md`),
        `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\npriority: medium\nreadiness: ready\ntags: []\norchestrate: false\nuseWorktree: false\norder: 1\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n---\nbody\n`
      )
    task('TASK-0001', 'Needs me', 'in_progress')
    task('TASK-0002', 'Finished', 'done')
    task('TASK-0003', 'Review me', 'in_review')
    agentStore.recordAgentEvent(scoped, 'TASK-0001', 'Notification')
    agentStore.recordAgentEvent(scoped, 'TASK-0002', 'Notification')
    agentStore.recordAgentEvent(scoped, 'TASK-0003', 'Stop')
    agentStore.recordAgentEvent(settings, 'TASK-0009', 'Notification')

    const { statuses, titles, awaitingReview } = workspaces.readBackgroundAgents(
      settings,
      'default'
    )
    expect(statuses.map((s) => s.taskId).sort()).toEqual(['TASK-0001', 'TASK-0003'])
    expect([...awaitingReview]).toEqual(['client-a:TASK-0003'])
    expect(statuses.find((s) => s.taskId === 'TASK-0001')).toMatchObject({
      workspaceId: 'client-a',
      workspaceName: 'Client A'
    })
    expect(titles.get('client-a:TASK-0001')).toBe('Needs me')
    expect(workspaces.readBackgroundAgents(settings, 'client-a').statuses[0]?.taskId).toBe(
      'TASK-0009'
    )
  })
})

describe('readWorkspaceTasks', () => {
  it('parses task files without writing to any of them, skipping the ones that do not parse', async () => {
    const { workspaces, config } = await modules()
    const storage = join(home, 'Styr')
    const settings = settingsFor(storage)
    const other = workspaces.createWorkspace(settings, 'Client A', SEED)
    const dir = config.tasksDir(config.pathsInWorkspace(settings, other.id))
    const files = {
      'TASK-0001.md': `---\nid: TASK-0001\ntitle: Valid\nstatus: in_review\npriority: medium\nreadiness: ready\ntags: []\norchestrate: false\nuseWorktree: false\norder: 1\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n---\nbody\n`,
      'plain.md': '# Just a note\n\nNo frontmatter here.\n',
      'broken.md': '---\nid: TASK-0002\nstatus: not-a-status\n---\nbody\n',
      'notes.txt': 'ignored'
    }
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    const before = Object.keys(files).map((name) => statSync(join(dir, name)).mtimeMs)

    const tasks = workspaces.readWorkspaceTasks(settings, other.id)

    expect(tasks.map((task) => [task.id, task.title, task.status])).toEqual([
      ['TASK-0001', 'Valid', 'in_review']
    ])
    expect(readdirSync(dir).sort()).toEqual(Object.keys(files).sort())
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(join(dir, name), 'utf8')).toBe(content)
    }
    expect(Object.keys(files).map((name) => statSync(join(dir, name)).mtimeMs)).toEqual(before)
  })

  it('returns nothing for a workspace without a tasks folder', async () => {
    const { workspaces } = await modules()
    expect(workspaces.readWorkspaceTasks(settingsFor(join(home, 'Empty')), 'default')).toEqual([])
  })
})
