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
    refListing: async () => {
      calls.listing++
      return 'refs/heads/styr/TASK-0001 aaa'
    },
    branchLanding: async () => {
      calls.landing++
      return { branch: 'styr/TASK-0001', base: 'main', ahead: 0, landed: true }
    },
    cleanupLandedTask: async () => {
      calls.cleanup++
      return { worktreeRemoved: true, notes: ['Removed worktree.'] }
    },
    ...over
  }
  return { calls, ports: { git, cache, workspaceId: 'default' } }
}

describe('settleTasks', async () => {
  it('moves a landed in_review task to done and cleans it up', async () => {
    const { ports: p, calls } = ports()
    const { writes, errors } = await settleTasks([task()], p)
    expect(errors).toEqual([])
    expect(calls.cleanup).toBe(1)
    expect(writes).toEqual([
      { kind: 'status', taskId: 'TASK-0001', status: 'done' },
      { kind: 'note', taskId: 'TASK-0001', message: 'Work landed on main; moved to done.' },
      { kind: 'clearWorktree', taskId: 'TASK-0001' },
      { kind: 'note', taskId: 'TASK-0001', message: 'Removed worktree.' }
    ])
  })

  it('leaves an unlanded in_review task alone and does not clean up', async () => {
    const { ports: p, calls } = ports({
      branchLanding: async () => ({ branch: 'b', base: 'main', ahead: 2, landed: false })
    })
    expect((await settleTasks([task()], p)).writes).toEqual([])
    expect(calls.cleanup).toBe(0)
  })

  it('skips tasks that are not worktree tasks or have nothing to settle', async () => {
    const { ports: p, calls } = ports()
    const tasks = [
      task({ useWorktree: false }),
      task({ repoPath: undefined }),
      task({ status: 'in_progress' }),
      task({ status: 'done', worktreePath: undefined })
    ]
    expect((await settleTasks(tasks, p)).writes).toEqual([])
    expect(calls.listing).toBe(0)
  })

  it('reports a refusal once: the repeat is deduped against the task activity', async () => {
    const refusal = 'Left worktree in place: it has uncommitted or untracked changes.'
    const { ports: p } = ports({
      cleanupLandedTask: async () => ({ worktreeRemoved: false, notes: [refusal] })
    })
    const first = await settleTasks([task({ status: 'done' })], p)
    expect(first.writes).toEqual([{ kind: 'note', taskId: 'TASK-0001', message: refusal }])

    const second = await settleTasks(
      [task({ status: 'done', activity: [{ at: '', author: 'styr', message: refusal }] })],
      ports({ cleanupLandedTask: async () => ({ worktreeRemoved: false, notes: [refusal] }) }).ports
    )
    expect(second.writes).toEqual([])
  })

  it('skips a task checked with the same fingerprint, until the ttl passes', async () => {
    let now = 0
    const cache = new LandingCache(1000, () => now)
    const calls = { landing: 0 }
    const { ports: p } = ports(
      {
        branchLanding: async () => {
          calls.landing++
          return { branch: 'b', base: 'main', ahead: 1, landed: false }
        }
      },
      cache
    )
    await settleTasks([task()], p)
    await settleTasks([task()], p)
    expect(calls.landing).toBe(1)
    now = 1000
    await settleTasks([task()], p)
    expect(calls.landing).toBe(2)
  })

  it('rechecks when the refs change, and lists refs once per repository', async () => {
    let tip = 'a'
    const calls = { listing: 0, landing: 0 }
    const { ports: p } = ports({
      refListing: async () => {
        calls.listing++
        return `refs/heads/styr/TASK-0001 ${tip}\nrefs/heads/styr/TASK-0002 ${tip}`
      },
      branchLanding: async () => {
        calls.landing++
        return { branch: 'b', base: 'main', ahead: 1, landed: false }
      }
    })
    const two = [task(), task({ id: 'TASK-0002' })]
    await settleTasks(two, p)
    expect(calls).toEqual({ listing: 1, landing: 2 })
    await settleTasks(two, p)
    expect(calls.landing).toBe(2)
    tip = 'b'
    await settleTasks(two, p)
    expect(calls.landing).toBe(4)
  })

  it('returns an error instead of swallowing it, and retries next pass', async () => {
    const boom = new Error('git exploded')
    const { ports: p } = ports({
      branchLanding: async () => {
        throw boom
      }
    })
    const first = await settleTasks([task()], p)
    expect(first.errors).toEqual([{ taskId: 'TASK-0001', error: boom }])
    expect((await settleTasks([task()], p)).errors).toHaveLength(1)
  })

  it('hands the landing it measured to the cleanup, so the branch is checked once', async () => {
    const { ports: p, calls } = ports()
    const handed: unknown[] = []
    p.git.cleanupLandedTask = async (_checkout, landing) => {
      handed.push(landing)
      return { worktreeRemoved: true, notes: [] }
    }
    await settleTasks([task()], p)
    expect(calls.landing).toBe(1)
    expect(handed).toEqual([{ branch: 'styr/TASK-0001', base: 'main', ahead: 0, landed: true }])
  })

  it('keeps the done move when cleanup throws', async () => {
    const { ports: p } = ports({
      cleanupLandedTask: async () => {
        throw new Error('push failed')
      }
    })
    const { writes, errors } = await settleTasks([task()], p)
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

describe('settleTasks on a multi-repo task', () => {
  type Answer = { landed: boolean; ahead: number } | undefined
  const multi = (over: Partial<LandingTask> = {}): LandingTask =>
    task({
      repoPath: '/w/api',
      worktreePath: '/w/api.worktrees/x',
      extraRepos: [
        { repoPath: '/w/client', baseBranch: 'release/2.x', worktreePath: '/w/client.worktrees/x' }
      ],
      ...over
    })

  /** A fake whose landing answer comes from the repository the checkout is in. */
  function repos(answers: Record<string, Answer>, removed: Record<string, boolean> = {}) {
    const cleaned: string[] = []
    const git: CheckoutGit = {
      refListing: async (repo) => `refs/heads/styr/TASK-0001 ${repo}`,
      branchLanding: async ({ repoPath }) => {
        const answer = answers[repoPath]
        return answer && { branch: 'styr/TASK-0001', base: 'main', ...answer }
      },
      cleanupLandedTask: async ({ repoPath }) => {
        cleaned.push(repoPath)
        return {
          worktreeRemoved: removed[repoPath] ?? true,
          notes: [`Removed ${repoPath}.`]
        }
      }
    }
    return {
      cleaned,
      ports: { git, cache: new LandingCache(1000, () => 0), workspaceId: 'default' }
    }
  }

  it('moves to done and cleans every repository when all have landed', async () => {
    const { ports: p, cleaned } = repos({
      '/w/api': { landed: true, ahead: 0 },
      '/w/client': { landed: true, ahead: 0 }
    })
    const { writes } = await settleTasks([multi()], p)
    expect(writes[0]).toEqual({ kind: 'status', taskId: 'TASK-0001', status: 'done' })
    expect(cleaned).toEqual(['/w/api', '/w/client'])
    expect(writes).toContainEqual({ kind: 'clearWorktree', taskId: 'TASK-0001', extras: true })
  })

  it('stays in review with one note naming both sets when only some landed', async () => {
    const { ports: p, cleaned } = repos({
      '/w/api': { landed: true, ahead: 0 },
      '/w/client': { landed: false, ahead: 3 }
    })
    const { writes } = await settleTasks([multi()], p)
    expect(writes).toEqual([
      {
        kind: 'note',
        taskId: 'TASK-0001',
        message: 'Landed: api. Not landed: client (3 commits ahead of main)'
      }
    ])
    expect(cleaned).toEqual([])
  })

  it('does not repeat the partial note', async () => {
    const message = 'Landed: api. Not landed: client (1 commit ahead of main)'
    const { ports: p } = repos({
      '/w/api': { landed: true, ahead: 0 },
      '/w/client': { landed: false, ahead: 1 }
    })
    const { writes } = await settleTasks(
      [multi({ activity: [{ at: '', author: 'styr', message }] })],
      p
    )
    expect(writes).toEqual([])
  })

  it('writes nothing when none has landed', async () => {
    const { ports: p } = repos({
      '/w/api': { landed: false, ahead: 2 },
      '/w/client': { landed: false, ahead: 1 }
    })
    expect((await settleTasks([multi()], p)).writes).toEqual([])
  })

  it('does not let an untouched repository block Done', async () => {
    const { ports: p } = repos({
      '/w/api': { landed: true, ahead: 0 },
      '/w/client': { landed: false, ahead: 0 }
    })
    const { writes } = await settleTasks([multi()], p)
    expect(writes[0]).toEqual({ kind: 'status', taskId: 'TASK-0001', status: 'done' })
  })

  it('is not Done when no repository has anything landed', async () => {
    const { ports: p } = repos({
      '/w/api': { landed: false, ahead: 0 },
      '/w/client': { landed: false, ahead: 0 }
    })
    expect((await settleTasks([multi()], p)).writes).toEqual([])
  })

  it('treats a missing task branch as not landed', async () => {
    const { ports: p } = repos({ '/w/api': { landed: true, ahead: 0 }, '/w/client': undefined })
    const { writes } = await settleTasks([multi()], p)
    expect(writes).toEqual([
      {
        kind: 'note',
        taskId: 'TASK-0001',
        message: 'Landed: api. Not landed: client (no task branch)'
      }
    ])
  })

  it('skips an extra that fell back to the plain repository', async () => {
    const { ports: p, cleaned } = repos({ '/w/api': { landed: true, ahead: 0 } })
    const fellBack = multi({ extraRepos: [{ repoPath: '/w/client' }] })
    const { writes } = await settleTasks([fellBack], p)
    expect(writes[0]).toEqual({ kind: 'status', taskId: 'TASK-0001', status: 'done' })
    expect(cleaned).toEqual(['/w/api'])
  })

  it('cleans a Done task per repository and keeps worktrees recorded while one is refused', async () => {
    const { ports: p, cleaned } = repos({}, { '/w/client': false })
    const { writes } = await settleTasks([multi({ status: 'done' })], p)
    expect(cleaned).toEqual(['/w/api', '/w/client'])
    expect(writes.some((write) => write.kind === 'clearWorktree')).toBe(false)
    expect(writes).toHaveLength(1)
  })

  it('names the extra repositories in the fetch list', () => {
    expect(reposAwaitingLanding([multi()]).sort()).toEqual(['/w/api', '/w/client'])
  })
})
