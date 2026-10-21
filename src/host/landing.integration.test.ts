import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shippedSettings } from '@core/config.js'
import {
  GIT_TEST_TIMEOUT_MS,
  removeTemporaryDirectories,
  runGit,
  temporaryRepository
} from '@core/gitFixture.js'
import { checkoutGit, taskCheckout } from '@core/taskCheckout.js'
import { DEFAULT_WORKSPACE_ID, type Settings, type Task } from '@core/types.js'
import { ensureWorktree } from '@core/worktree.js'
import { createLanding } from './landing.js'

vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS * 2 })
afterEach(removeTemporaryDirectories)

/**
 * The longest the event loop went without running a turn while `work` ran: what a user would feel
 * as a frozen window. A synchronous git call shows up as its whole duration.
 */
async function longestStall<T>(work: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
  let last = performance.now()
  let stallMs = 0
  let running = true
  const tick = (): void => {
    const now = performance.now()
    stallMs = Math.max(stallMs, now - last)
    last = now
    if (running) setImmediate(tick)
  }
  setImmediate(tick)
  try {
    const result = await work()
    // A stall that lasted until the end never reached a tick: count it too.
    return { result, stallMs: Math.max(stallMs, performance.now() - last) }
  } finally {
    running = false
  }
}

describe('landing pass responsiveness', () => {
  it('settles a merged PR among ten In Review tasks without stalling the main thread', async () => {
    const repository = temporaryRepository()
    const tasks: Task[] = []
    for (let n = 1; n <= 10; n++) {
      const id = `TASK-${String(n).padStart(4, '0')}`
      const { checkout } = taskCheckout(DEFAULT_WORKSPACE_ID, { id, repoPath: repository })
      const { path } = ensureWorktree(checkout)
      writeFileSync(join(path, `${id}.txt`), `${id}\n`)
      runGit(['add', '.'], path)
      runGit(['commit', '-m', id], path)
      tasks.push({
        id,
        title: id,
        status: 'in_review',
        useWorktree: true,
        repoPath: repository,
        worktreePath: path,
        activity: []
      } as unknown as Task)
    }
    // The merged task's worktree is heavy, like one holding node_modules: its removal is the slow part.
    const merged = tasks[0]!
    const heavy = join(merged.worktreePath!, 'node_modules')
    for (let dir = 0; dir < 50; dir++) {
      mkdirSync(join(heavy, `pkg-${dir}`), { recursive: true })
      for (let file = 0; file < 100; file++) {
        writeFileSync(join(heavy, `pkg-${dir}`, `f${file}.js`), 'module.exports = 1\n')
      }
    }
    writeFileSync(join(merged.worktreePath!, '.gitignore'), 'node_modules/\n')
    runGit(['add', '.gitignore'], merged.worktreePath!)
    runGit(['commit', '-m', 'Ignore deps'], merged.worktreePath!)
    runGit(['merge', '--ff-only', `styr/${merged.id}`], repository)

    const writes: string[] = []
    const landing = createLanding({
      loadSettings: () =>
        ({ ...shippedSettings(), activeWorkspaceId: DEFAULT_WORKSPACE_ID }) as Settings,
      query: () => tasks,
      find: (id) => tasks.find((task) => task.id === id),
      updateTask: (id, patch) => writes.push(`update ${id} ${JSON.stringify(patch)}`),
      addNote: () => undefined,
      git: checkoutGit,
      fetchOrigin: async () => undefined,
      warn: (message, error) => writes.push(`warn ${message} ${String(error)}`),
      now: () => Date.now()
    })

    const { result, stallMs } = await longestStall(() => landing.settleLandedTasks())

    expect(result).toBe(true)
    expect(writes).toEqual([`update ${merged.id} {"status":"done"}`, `update ${merged.id} {}`])
    expect(existsSync(merged.worktreePath!)).toBe(false)
    for (const task of tasks.slice(1)) expect(existsSync(task.worktreePath!)).toBe(true)
    expect(stallMs).toBeLessThan(100)
  })
})
