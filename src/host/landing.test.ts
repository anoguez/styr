import { describe, expect, it, vi } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { CheckoutGit } from '@core/taskCheckout.js'
import type { Settings, Task } from '@core/types.js'
import { createLanding, mergedWorkCheck, type LandingPorts } from './landing.js'

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: 'in_review',
    useWorktree: true,
    repoPath: '/repo',
    worktreePath: `/repo.worktrees/${id}`,
    activity: [],
    ...extra
  } as unknown as Task
}

interface Harness {
  ports: LandingPorts
  calls: string[]
  rows: Task[]
  /** Repositories whose fetch updated refs; the rest find nothing. */
  fetched: Set<string>
  landed: Set<string>
}

function harness(): Harness {
  const h = {
    calls: [],
    rows: [task('TASK-1')],
    fetched: new Set(),
    landed: new Set()
  } as unknown as Harness
  const git: CheckoutGit = {
    refListing: (repo) => `refs/heads/styr/${repo}`,
    branchLanding: (checkout) => {
      if (checkout.key.endsWith('BROKEN')) throw new Error('git broke')
      return {
        branch: `styr/${checkout.key}`,
        base: 'main',
        ahead: 0,
        landed: [...h.landed].some((id) => checkout.key.endsWith(id))
      }
    },
    cleanupLandedTask: () => ({ worktreeRemoved: true, notes: ['Removed worktree.'] })
  }
  h.ports = {
    loadSettings: () => ({ ...shippedSettings(), activeWorkspaceId: 'default' }) as Settings,
    query: () => h.rows,
    updateTask: (id, patch) => h.calls.push(`update ${id} ${JSON.stringify(patch)}`),
    addNote: (id, author, message) => h.calls.push(`note ${id} ${author}: ${message}`),
    git,
    fetchOrigin: async (repo) => {
      h.calls.push(`fetch ${repo}`)
      if (!h.fetched.has(repo)) throw new Error('offline')
    },
    warn: (message) => h.calls.push(`warn ${message}`),
    now: () => 0
  }
  return h
}

describe('landing', () => {
  it('moves a landed In Review task to Done through the task files, and says it wrote', () => {
    const h = harness()
    h.landed.add('TASK-1')
    const landing = createLanding(h.ports)
    expect(landing.settleLandedTasks()).toBe(true)
    expect(h.calls).toEqual([
      'update TASK-1 {"status":"done"}',
      'note TASK-1 styr: Work landed on main; moved to done.',
      'update TASK-1 {}',
      'note TASK-1 styr: Removed worktree.'
    ])
  })

  it('writes nothing for work that has not landed', () => {
    const h = harness()
    expect(createLanding(h.ports).settleLandedTasks()).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('warns about a task whose check failed and settles the rest', () => {
    const h = harness()
    h.rows = [task('TASK-BROKEN'), task('TASK-1')]
    h.landed.add('TASK-1')
    expect(createLanding(h.ports).settleLandedTasks()).toBe(true)
    expect(h.calls[0]).toBe('warn landing: could not settle TASK-BROKEN:')
    expect(h.calls).toContain('update TASK-1 {"status":"done"}')
  })

  it('limits a pass to the repositories given', () => {
    const h = harness()
    h.rows = [task('TASK-1', { repoPath: '/other' })]
    h.landed.add('TASK-1')
    expect(createLanding(h.ports).settleLandedTasks(new Set(['/repo']))).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('settles only the repositories a fetch updated', async () => {
    const h = harness()
    h.rows = [task('TASK-1'), task('TASK-2', { repoPath: '/offline' })]
    h.landed = new Set(['TASK-1', 'TASK-2'])
    h.fetched.add('/repo')
    expect(await createLanding(h.ports).fetchAndSettle()).toBe(true)
    expect(h.calls.filter((call) => call.startsWith('update'))).toEqual([
      'update TASK-1 {"status":"done"}',
      'update TASK-1 {}'
    ])
    expect(h.calls).toContain(
      'warn landing: could not fetch origin in /offline; merged PRs there show once it can:'
    )
  })

  it('does not settle when no fetch updated anything', async () => {
    const h = harness()
    h.landed.add('TASK-1')
    expect(await createLanding(h.ports).fetchAndSettle()).toBe(false)
    expect(h.calls).toEqual([
      'fetch /repo',
      'warn landing: could not fetch origin in /repo; merged PRs there show once it can:'
    ])
  })
})

describe('mergedWorkCheck', () => {
  it('re-indexes only when the check wrote a task file', async () => {
    const notifyTasks = vi.fn()
    await mergedWorkCheck({ fetchAndSettle: async () => false, notifyTasks })()
    expect(notifyTasks).not.toHaveBeenCalled()
    await mergedWorkCheck({ fetchAndSettle: async () => true, notifyTasks })()
    expect(notifyTasks).toHaveBeenCalledOnce()
  })

  it('never rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifyTasks = vi.fn()
    await expect(
      mergedWorkCheck({
        fetchAndSettle: async () => {
          throw new Error('boom')
        },
        notifyTasks
      })()
    ).resolves.toBeUndefined()
    expect(notifyTasks).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'landing: checking for merged work failed:',
      expect.any(Error)
    )
    warn.mockRestore()
  })
})
