import { describe, expect, it } from 'vitest'
import {
  LandingCache,
  RemoteFetcher,
  isRepeatNote,
  reposAwaitingLanding,
  settleTasks,
  type LandingTask
} from './landing.js'
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

describe('reposAwaitingLanding', () => {
  it('names each repository with an In Review worktree task once', () => {
    expect(
      reposAwaitingLanding([
        task(),
        task({ id: 'TASK-0002' }),
        task({ id: 'TASK-0003', repoPath: '/other' }),
        task({ id: 'TASK-0004', repoPath: '/plain', useWorktree: false }),
        task({ id: 'TASK-0005', repoPath: '/done', status: 'done' }),
        task({ id: 'TASK-0006', repoPath: '/backlog', status: 'backlog' }),
        task({ id: 'TASK-0007', repoPath: undefined })
      ])
    ).toEqual(['/repo', '/other'])
  })
})

describe('RemoteFetcher', () => {
  function fetcher(fail?: (repo: string) => unknown) {
    let now = 0
    const started: string[] = []
    const warned: string[] = []
    const release = new Map<string, () => void>()
    const instance = new RemoteFetcher(
      {
        fetch: (repo) => {
          started.push(repo)
          return new Promise<void>((resolve, reject) => {
            release.set(repo, () => {
              const error = fail?.(repo)
              if (error) reject(error)
              else resolve()
            })
          })
        },
        warn: (repo) => warned.push(repo),
        now: () => now
      },
      60_000
    )
    const finish = (repo: string): void => release.get(repo)?.()
    return { instance, started, warned, finish, advance: (ms: number) => (now += ms) }
  }

  it('reports the repositories it fetched', async () => {
    const f = fetcher()
    const pending = f.instance.refresh(['/a', '/b'])
    f.finish('/a')
    f.finish('/b')
    expect(await pending).toEqual(['/a', '/b'])
  })

  it('coalesces triggers that arrive while a fetch is in flight', async () => {
    const f = fetcher()
    const first = f.instance.refresh(['/a'])
    const second = f.instance.refresh(['/a'])
    expect(f.started).toEqual(['/a'])
    f.finish('/a')
    expect(await first).toEqual(['/a'])
    expect(await second).toEqual(['/a'])
  })

  it('fetches a repository at most once per throttle window', async () => {
    const f = fetcher()
    const first = f.instance.refresh(['/a'])
    f.finish('/a')
    await first
    f.advance(59_999)
    expect(await f.instance.refresh(['/a'])).toEqual([])
    expect(f.started).toEqual(['/a'])
    f.advance(1)
    const later = f.instance.refresh(['/a'])
    f.finish('/a')
    expect(await later).toEqual(['/a'])
    expect(f.started).toEqual(['/a', '/a'])
  })

  it('throttles each repository on its own', async () => {
    const f = fetcher()
    const first = f.instance.refresh(['/a'])
    f.finish('/a')
    await first
    const next = f.instance.refresh(['/a', '/b'])
    f.finish('/b')
    expect(await next).toEqual(['/b'])
  })

  it('resolves quietly on failure and warns once per repository', async () => {
    const f = fetcher(() => new Error('offline'))
    const first = f.instance.refresh(['/a'])
    f.finish('/a')
    expect(await first).toEqual([])
    f.advance(60_000)
    const second = f.instance.refresh(['/a'])
    f.finish('/a')
    expect(await second).toEqual([])
    expect(f.started).toEqual(['/a', '/a'])
    expect(f.warned).toEqual(['/a'])
  })

  it('survives a fetch port that throws synchronously', async () => {
    const warned: unknown[] = []
    const instance = new RemoteFetcher({
      fetch: () => {
        throw new Error('spawn failed')
      },
      warn: (_repo, error) => warned.push(error),
      now: () => 0
    })
    expect(await instance.refresh(['/a'])).toEqual([])
    expect(warned).toHaveLength(1)
  })
})
