import { describe, expect, it } from 'vitest'
import { LandingCache, isRepeatNote, settleTasks, type LandingTask } from './landing.js'
import type { CheckoutGit } from './taskCheckout.js'

describe('LandingCache', () => {
  it('is fresh only for the same fingerprint', () => {
    const cache = new LandingCache(1000, () => 0)
    cache.remember('a', 'x')
    expect(cache.isFresh('a', 'x')).toBe(true)
    expect(cache.isFresh('a', 'y')).toBe(false)
    expect(cache.isFresh('b', 'x')).toBe(false)
  })

  it('expires after the ttl', () => {
    let now = 0
    const cache = new LandingCache(1000, () => now)
    cache.remember('a', 'x')
    now = 999
    expect(cache.isFresh('a', 'x')).toBe(true)
    now = 1000
    expect(cache.isFresh('a', 'x')).toBe(false)
  })

  it('forgets', () => {
    const cache = new LandingCache(1000, () => 0)
    cache.remember('a', 'x')
    cache.forget('a')
    expect(cache.isFresh('a', 'x')).toBe(false)
  })
})

const task = (over: Partial<LandingTask> = {}): LandingTask => ({
  id: 'TASK-0001',
  status: 'in_review',
  useWorktree: true,
  repoPath: '/repo',
  worktreePath: '/repo.worktrees/TASK-0001',
  activity: [],
  ...over
})

function ports(over: Partial<CheckoutGit> = {}, cache = new LandingCache(1000, () => 0)) {
  const calls = { listing: 0, landing: 0, cleanup: 0 }
  const git: CheckoutGit = {
    refListing: () => {
      calls.listing++
      return 'refs/heads/styr/TASK-0001 aaa'
    },
    branchLanding: () => {
      calls.landing++
      return { branch: 'styr/TASK-0001', base: 'main', ahead: 0, landed: true }
    },
    cleanupLandedTask: () => {
      calls.cleanup++
      return { worktreeRemoved: true, notes: ['Removed worktree.'] }
    },
    ...over
  }
  return { calls, ports: { git, cache, workspaceId: 'default' } }
}

describe('settleTasks', () => {
  it('moves a landed in_review task to done and cleans it up', () => {
    const { ports: p, calls } = ports()
    const { writes, errors } = settleTasks([task()], p)
    expect(errors).toEqual([])
    expect(calls.cleanup).toBe(1)
    expect(writes).toEqual([
      { kind: 'status', taskId: 'TASK-0001', status: 'done' },
      { kind: 'note', taskId: 'TASK-0001', message: 'Work landed on main; moved to done.' },
      { kind: 'clearWorktree', taskId: 'TASK-0001' },
      { kind: 'note', taskId: 'TASK-0001', message: 'Removed worktree.' }
    ])
  })

  it('leaves an unlanded in_review task alone and does not clean up', () => {
    const { ports: p, calls } = ports({
      branchLanding: () => ({ branch: 'b', base: 'main', ahead: 2, landed: false })
    })
    expect(settleTasks([task()], p).writes).toEqual([])
    expect(calls.cleanup).toBe(0)
  })

  it('skips tasks that are not worktree tasks or have nothing to settle', () => {
    const { ports: p, calls } = ports()
    const tasks = [
      task({ useWorktree: false }),
      task({ repoPath: undefined }),
      task({ status: 'in_progress' }),
      task({ status: 'done', worktreePath: undefined })
    ]
    expect(settleTasks(tasks, p).writes).toEqual([])
    expect(calls.listing).toBe(0)
  })

  it('reports a refusal once: the repeat is deduped against the task activity', () => {
    const refusal = 'Left worktree in place: it has uncommitted or untracked changes.'
    const { ports: p } = ports({
      cleanupLandedTask: () => ({ worktreeRemoved: false, notes: [refusal] })
    })
    const first = settleTasks([task({ status: 'done' })], p)
    expect(first.writes).toEqual([{ kind: 'note', taskId: 'TASK-0001', message: refusal }])

    const second = settleTasks(
      [task({ status: 'done', activity: [{ at: '', author: 'styr', message: refusal }] })],
      ports({ cleanupLandedTask: () => ({ worktreeRemoved: false, notes: [refusal] }) }).ports
    )
    expect(second.writes).toEqual([])
  })

  it('skips a task checked with the same fingerprint, until the ttl passes', () => {
    let now = 0
    const cache = new LandingCache(1000, () => now)
    const calls = { landing: 0 }
    const { ports: p } = ports(
      {
        branchLanding: () => {
          calls.landing++
          return { branch: 'b', base: 'main', ahead: 1, landed: false }
        }
      },
      cache
    )
    settleTasks([task()], p)
    settleTasks([task()], p)
    expect(calls.landing).toBe(1)
    now = 1000
    settleTasks([task()], p)
    expect(calls.landing).toBe(2)
  })

  it('rechecks when the refs change, and lists refs once per repository', () => {
    let tip = 'a'
    const calls = { listing: 0, landing: 0 }
    const { ports: p } = ports({
      refListing: () => {
        calls.listing++
        return `refs/heads/styr/TASK-0001 ${tip}\nrefs/heads/styr/TASK-0002 ${tip}`
      },
      branchLanding: () => {
        calls.landing++
        return { branch: 'b', base: 'main', ahead: 1, landed: false }
      }
    })
    const two = [task(), task({ id: 'TASK-0002' })]
    settleTasks(two, p)
    expect(calls).toEqual({ listing: 1, landing: 2 })
    settleTasks(two, p)
    expect(calls.landing).toBe(2)
    tip = 'b'
    settleTasks(two, p)
    expect(calls.landing).toBe(4)
  })

  it('returns an error instead of swallowing it, and retries next pass', () => {
    const boom = new Error('git exploded')
    const { ports: p } = ports({
      branchLanding: () => {
        throw boom
      }
    })
    const first = settleTasks([task()], p)
    expect(first.errors).toEqual([{ taskId: 'TASK-0001', error: boom }])
    expect(settleTasks([task()], p).errors).toHaveLength(1)
  })

  it('keeps the done move when cleanup throws', () => {
    const { ports: p } = ports({
      cleanupLandedTask: () => {
        throw new Error('push failed')
      }
    })
    const { writes, errors } = settleTasks([task()], p)
    expect(writes[0]).toEqual({ kind: 'status', taskId: 'TASK-0001', status: 'done' })
    expect(errors).toHaveLength(1)
  })
})

describe('isRepeatNote', () => {
  it('recognises a repeated note', () => {
    const log = [
      { author: 'styr', message: 'a' },
      { author: 'me', message: 'b' }
    ]
    expect(isRepeatNote(log, 'styr', 'a')).toBe(true)
    expect(isRepeatNote(log, 'styr', 'c')).toBe(false)
  })
})
