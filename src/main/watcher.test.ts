import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Characterises the close race: a watcher's `close()` resolves later, and a replacement started in
 * the meantime must survive it. This is the bug where the agents watcher died while the tasks
 * watcher kept going.
 */

class FakeWatcher extends EventEmitter {
  closed = false
  private release!: () => void
  /** Resolves only when the test says so, so the test controls when the close finishes. */
  readonly closing = new Promise<void>((resolve) => (this.release = resolve))

  constructor(readonly dir: string | string[]) {
    super()
  }

  close(): Promise<void> {
    this.closed = true
    return this.closing
  }

  finishClose(): void {
    this.release()
  }
}

const watchers: FakeWatcher[] = []

vi.mock('chokidar', () => ({
  default: {
    watch: (dir: string | string[]) => {
      const watcher = new FakeWatcher(dir)
      watchers.push(watcher)
      return watcher
    }
  }
}))
vi.mock('@core/settingsStore.js', () => ({
  loadSettings: () => ({ storageDir: '/storage', activeWorkspaceId: 'default' }),
  tasksDir: () => '/storage/tasks'
}))
vi.mock('@core/workspaces.js', () => ({ listWorkspaces: () => [{ id: 'default' }] }))
vi.mock('@core/agentStore.js', () => ({ agentsDir: () => '/storage/.styr/agents' }))

const { startWatching, startWatchingAgents, stopWatching } = await import('./watcher.js')

/** Lets the pending close promises and their continuations run. */
async function settle(): Promise<void> {
  for (const watcher of watchers) watcher.finishClose()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  watchers.length = 0
})

afterEach(async () => {
  await stopWatching()
  vi.useRealTimers()
})

describe('watcher close race', () => {
  it('restarting a watcher leaves the new one running once the old close resolves', async () => {
    const onChange = vi.fn()
    startWatchingAgents(onChange)
    startWatchingAgents(onChange)
    const [first, second] = watchers
    expect(first!.closed).toBe(true)

    await settle()
    expect(second!.closed).toBe(false)
    second!.emit('change')
    await vi.advanceTimersByTimeAsync(60)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('a watcher started straight after stopWatching survives the stop', async () => {
    const onTasks = vi.fn()
    const onAgents = vi.fn()
    startWatching(onTasks)
    startWatchingAgents(onAgents)
    const stopped = stopWatching()
    startWatching(onTasks)
    startWatchingAgents(onAgents)
    const [, , tasks, agents] = watchers

    await settle()
    await stopped
    expect(tasks!.closed).toBe(false)
    expect(agents!.closed).toBe(false)

    tasks!.emit('add')
    agents!.emit('unlink')
    await vi.advanceTimersByTimeAsync(150)
    expect(onTasks).toHaveBeenCalledTimes(1)
    expect(onAgents).toHaveBeenCalledTimes(1)
  })

  it('restarting one watcher never touches the other', async () => {
    const onTasks = vi.fn()
    startWatching(onTasks)
    startWatchingAgents(() => {})
    startWatchingAgents(() => {})
    const [tasks] = watchers

    await settle()
    expect(tasks!.closed).toBe(false)
    tasks!.emit('change')
    await vi.advanceTimersByTimeAsync(150)
    expect(onTasks).toHaveBeenCalledTimes(1)
  })

  it('a change pending on the old watcher does not fire after the restart', async () => {
    const onChange = vi.fn()
    startWatching(onChange)
    watchers[0]!.emit('change')
    startWatching(onChange)

    await settle()
    await vi.advanceTimersByTimeAsync(150)
    expect(onChange).not.toHaveBeenCalled()
  })
})
