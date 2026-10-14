import chokidar, { type FSWatcher } from 'chokidar'
import { pathsInWorkspace } from '@core/config.js'
import { loadSettings, tasksDir } from '@core/settingsStore.js'
import { agentsDir } from '@core/agentStore.js'
import { listWorkspaces } from '@core/workspaces.js'

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

function start(
  entry: Watched,
  dir: string | string[],
  debounceMs: number,
  onChange: () => void,
  depth = 0
): void {
  void close(entry)
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth,
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

/**
 * Every workspace's agents, not just the active one: the menu bar reports a waiting agent in a
 * background workspace, so its status files have to wake the app too. Restart it when a workspace
 * is created or removed.
 */
export function startWatchingAgents(onChange: () => void): void {
  const settings = loadSettings()
  const dirs = listWorkspaces(settings).map(({ id }) => agentsDir(pathsInWorkspace(settings, id)))
  // Depth 1 reaches each task's `<id>.subagents/` folder of subagent events.
  start(agents, dirs, 60, onChange, 1)
}

export async function stopWatching(): Promise<void> {
  await Promise.all([close(tasks), close(agents)])
}
