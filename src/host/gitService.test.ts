import { describe, expect, it } from 'vitest'
import { shippedSettings } from '@core/config.js'
import { emptyDiff, type TaskDiff } from '@core/diff.js'
import type { TaskCheckout } from '@core/taskCheckout.js'
import type { Settings, Task } from '@core/types.js'
import { createGitService, nextTurn, type GitServicePorts } from './gitService.js'

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'in_progress',
    repoPath: '/repo',
    worktreePath: `/wt/${id}`,
    extraRepos: [],
    ...extra
  } as unknown as Task
}

const changes = (added: number): TaskDiff => ({
  ...emptyDiff('changes'),
  totalAdditions: added,
  totalDeletions: 1,
  totalFiles: 2
})

interface Harness {
  ports: GitServicePorts
  calls: string[]
  rows: Task[]
  diffs: Record<string, TaskDiff | { error: string }>
}

function harness(): Harness {
  const h = { calls: [], rows: [], diffs: {} } as unknown as Harness
  h.ports = {
    loadSettings: () =>
      ({ ...shippedSettings(), activeWorkspaceId: 'ws', worktreeLocation: 'inside' }) as Settings,
    index: { query: () => h.rows, find: (id) => h.rows.find((row) => row.id === id) },
    git: {
      checkout: (workspaceId, t, location) => {
        h.calls.push(`checkout ${workspaceId} ${t.id} ${t.repoPath} ${location}`)
        // One fake repository per path; the primary's answers are keyed by the task id alone.
        const repoOf = (repoPath: string, name: string, key: string) => {
          const diff = (): TaskDiff | { error: string } => h.diffs[key] ?? emptyDiff('empty')
          return {
            repoName: name,
            checkout: { repoPath },
            diff,
            diffStat: async () => {
              const result = diff()
              if ('error' in result || result.kind !== 'changes') return undefined
              return {
                added: result.totalAdditions,
                removed: result.totalDeletions,
                files: result.totalFiles
              }
            },
            filePatch: (path: string, full?: boolean) => ({
              patch: `${repoPath === '/repo' ? '' : `${repoPath} `}${path} full=${full}`
            })
          }
        }
        const repos = [
          repoOf(t.repoPath, 'primary', t.id),
          ...(t.extraRepos ?? []).map((extra) =>
            repoOf(extra.repoPath, extra.repoPath.slice(1), `${t.id}:${extra.repoPath}`)
          )
        ]
        return { ...repos[0], repos } as unknown as TaskCheckout
      },
      listBranches: (repo) => ({ branches: [`${repo}-main`] }),
      findGitRoot: (path) => (path.startsWith('/repo') ? '/repo' : undefined),
      readGitBranch: () => 'main'
    }
  }
  return h
}

describe('gitService', () => {
  it("diffs a task's checkout in the active workspace", () => {
    const h = harness()
    h.rows = [task('TASK-1')]
    h.diffs['TASK-1'] = changes(3)
    expect(createGitService(h.ports).taskDiff('TASK-1')).toEqual(changes(3))
    expect(h.calls).toEqual(['checkout ws TASK-1 /repo inside'])
  })

  it('answers a bad diff request with an error, not a throw', () => {
    const h = harness()
    h.rows = [task('TASK-1', { repoPath: undefined })]
    const git = createGitService(h.ports)
    expect(git.taskDiff(42)).toEqual({ error: 'Invalid task id' })
    expect(git.taskDiff('TASK-9')).toEqual({ error: 'Task not found' })
    expect(git.taskDiff('TASK-1')).toEqual({ error: 'This task has no repository' })
    expect(git.filePatch('TASK-9', 'a.ts')).toEqual({ error: 'Task not found' })
  })

  it("reads one file's patch, whole only when asked for exactly", () => {
    const h = harness()
    h.rows = [task('TASK-1')]
    const git = createGitService(h.ports)
    expect(git.filePatch('TASK-1', 'a.ts')).toEqual({ patch: 'a.ts full=false' })
    expect(git.filePatch('TASK-1', 'a.ts', true)).toEqual({ patch: 'a.ts full=true' })
    expect(git.filePatch('TASK-1', 'a.ts', 'yes')).toEqual({ patch: 'a.ts full=false' })
    expect(git.filePatch('TASK-1', '')).toEqual({ error: 'Invalid path' })
  })

  it('totals the changes of open worktree tasks', async () => {
    const h = harness()
    h.rows = [
      task('TASK-1'),
      task('TASK-2', { status: 'done' }),
      task('TASK-3', { archivedAt: '2026-01-01' }),
      task('TASK-4', { worktreePath: undefined }),
      task('TASK-5'),
      task('TASK-6')
    ]
    h.diffs = { 'TASK-1': changes(3), 'TASK-5': { error: 'gone' }, 'TASK-6': emptyDiff('landed') }
    expect(await createGitService(h.ports).diffStats()).toEqual({
      'TASK-1': { added: 3, removed: 1, files: 2 }
    })
    expect(h.calls).toEqual([
      'checkout ws TASK-1 /repo inside',
      'checkout ws TASK-5 /repo inside',
      'checkout ws TASK-6 /repo inside'
    ])
  })

  it('runs one diff-stats pass at a time', async () => {
    const h = harness()
    h.rows = [task('TASK-1')]
    h.diffs['TASK-1'] = changes(1)
    const git = createGitService(h.ports)
    const first = git.diffStats()
    expect(git.diffStats()).toBe(first)
    await first
    expect(git.diffStats()).not.toBe(first)
  })

  it("lists a repository's branches and a path's git context", () => {
    const git = createGitService(harness().ports)
    expect(git.branches('/repo')).toEqual({ branches: ['/repo-main'] })
    expect(git.gitContext('/repo/src')).toEqual({ root: '/repo', branch: 'main' })
    expect(git.gitContext('/tmp')).toEqual({ root: null, branch: null })
  })

  it('places a checkout by the active workspace', () => {
    const h = harness()
    createGitService(h.ports).checkout({ id: 'TASK-7', repoPath: '/r' })
    expect(h.calls).toEqual(['checkout ws TASK-7 /r inside'])
  })

  it('yields to the next turn of the event loop', async () => {
    let ran = false
    setImmediate(() => (ran = true))
    await nextTurn()
    expect(ran).toBe(true)
  })

  describe('a multi-repo task', () => {
    const multi = (): Harness => {
      const h = harness()
      h.rows = [
        task('TASK-1', {
          extraRepos: [{ repoPath: '/client', worktreePath: '/wt/client' }]
        })
      ]
      h.diffs['TASK-1'] = changes(3)
      h.diffs['TASK-1:/client'] = changes(5)
      return h
    }

    it('diffs the repository it is asked for, the primary by default', () => {
      const git = createGitService(multi().ports)
      expect(git.taskDiff('TASK-1')).toEqual(changes(3))
      expect(git.taskDiff('TASK-1', '/repo')).toEqual(changes(3))
      expect(git.taskDiff('TASK-1', '/client')).toEqual(changes(5))
      expect(git.filePatch('TASK-1', 'a.ts', false, '/client')).toEqual({
        patch: '/client a.ts full=false'
      })
    })

    it("refuses a repository that is not the task's", () => {
      const git = createGitService(multi().ports)
      const refused = { error: 'That repository is not part of this task' }
      expect(git.taskDiff('TASK-1', '/etc')).toEqual(refused)
      expect(git.filePatch('TASK-1', 'a.ts', false, '/other')).toEqual(refused)
      expect(git.taskDiff('TASK-1', 7)).toEqual({ error: 'Invalid repository' })
    })

    it('sums every repository on the card and lists each for the tooltip', async () => {
      const stats = await createGitService(multi().ports).diffStats()
      expect(stats['TASK-1']).toEqual({
        added: 8,
        removed: 2,
        files: 4,
        repos: [
          { name: 'primary', added: 3, removed: 1, files: 2 },
          { name: 'client', added: 5, removed: 1, files: 2 }
        ]
      })
    })
  })
})
