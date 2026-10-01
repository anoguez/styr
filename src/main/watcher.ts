import chokidar, { type FSWatcher } from 'chokidar'
import { loadSettings, tasksDir } from '@core/config.js'
import { agentsDir } from '@core/agentStore.js'

interface Watched {
  watcher: FSWatcher | null
  timer: NodeJS.Timeout | null
}

const tasks: Watched = { watcher: null, timer: null }
const agents: Watched = { watcher: null, timer: null }

/**
 * Clears the handle synchronously before awaiting the close, so a caller that immediately starts a
 * replacement watcher cannot have it torn down when this resumes.
 */
function close(entry: Watched): Promise<void> {
  const { watcher, timer } = entry
  if (timer) clearTimeout(timer)
  entry.timer = null
  entry.watcher = null
  return watcher ? watcher.close() : Promise.resolve()
}

function start(entry: Watched, dir: string, debounceMs: number, onChange: () => void): void {
  void close(entry)
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: Math.max(debounceMs / 3, 40), pollInterval: 15 }
  })
  entry.watcher = watcher

  const schedule = (): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(onChange, debounceMs)
  }

  watcher.on('add', schedule).on('change', schedule).on('unlink', schedule)
}

export function startWatching(onChange: () => void): void {
  start(tasks, tasksDir(), 150, onChange)
}

export function startWatchingAgents(onChange: () => void): void {
  start(agents, agentsDir(loadSettings()), 60, onChange)
}

export async function stopWatching(): Promise<void> {
  await Promise.all([close(tasks), close(agents)])
}
