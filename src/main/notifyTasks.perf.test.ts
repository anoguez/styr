import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { percentile } from '@core/diagnostics.js'
import { TASK_STATUSES, type TerminalSessionInfo } from '@core/types.js'

/**
 * The `notifyTasksChanged` baseline for a board of 200 tasks: the duration `ipc.ts` hands to
 * `recordNotifyDuration`, which is what the Performance panel shows. The real SQLite index,
 * landing pass and source observer run; only Electron, the terminals and the tray are faked.
 *
 * Skipped unless `STYR_BENCH=1`: CI installs without native modules, and timings are only
 * comparable on one machine. Run it before and after a main-process change:
 *
 *   STYR_BENCH=1 yarn vitest run src/main/notifyTasks.perf.test.ts
 *
 * and compare with the baseline in `docs/architecture/tasks.md` (Diagnostics).
 */

const TASKS = 200
const RUNS = 200

const durations: number[] = []

vi.mock('./diagnostics.js', () => ({
  recordNotifyDuration: (ms: number) => durations.push(ms),
  stopSampling: () => {},
  takeSnapshot: () => ({})
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {}, on: () => {} },
  Notification: { isSupported: () => false },
  shell: {}
}))
vi.mock('./tray.js', () => ({ updateTray: () => {} }))
vi.mock('./terminal/terminalEngines.js', () => ({ terminalEngineDiagnostics: () => undefined }))
vi.mock('./terminal/ptyManager.js', () => ({
  createSession: () => ({}) as TerminalSessionInfo,
  findSessionByTask: () => undefined,
  killSession: () => {},
  listSessions: () => [],
  resizeSession: () => {},
  sessionBacklog: () => '',
  terminalRuntimeState: () => undefined,
  writeToSession: () => {}
}))
vi.mock('./codexMonitor.js', () => ({
  CodexMonitor: class {
    release(): void {}
  },
  prepareCodex: async () => undefined
}))
vi.mock('./usage.js', () => ({ publishAgentConversation: () => {} }))
vi.mock('./agentCli.js', () => ({ agentCliStatus: () => ({}), ensureAgentCli: async () => {} }))
vi.mock('./mcpEntry.js', () => ({ mcpEntry: () => '/mcp.mjs' }))

/** Times `RUNS` notifies, each after `before`, as the panel would report them. */
function measure(notify: () => void, before: () => void = () => {}) {
  durations.length = 0
  for (let i = 0; i < RUNS; i += 1) {
    before()
    notify()
  }
  const round = (value: number | undefined): number => Math.round((value ?? NaN) * 100) / 100
  return {
    p50: round(percentile(durations, 0.5)),
    p95: round(percentile(durations, 0.95)),
    max: round(Math.max(...durations))
  }
}

describe.runIf(process.env.STYR_BENCH === '1')(`notifyTasksChanged, ${TASKS} tasks`, () => {
  const home = mkdtempSync(join(tmpdir(), 'styr-notify-perf-'))
  let ipc: typeof import('./ipc.js')
  let store: typeof import('@core/taskStore.js')
  let index: typeof import('./taskIndex.js')
  let settings: typeof import('@core/settingsStore.js')

  beforeAll(async () => {
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'config.json'),
      JSON.stringify({ storageDir: join(home, 'Styr') })
    )
    process.env.STYR_HOME = join(home, 'config')
    settings = await import('@core/settingsStore.js')
    store = await import('@core/taskStore.js')
    index = await import('./taskIndex.js')
    ipc = await import('./ipc.js')
    for (let i = 0; i < TASKS; i += 1) {
      const task = store.createTask({
        title: `Task ${i}`,
        description: 'A description long enough to look like a real one. '.repeat(8),
        tags: ['bench', `group-${i % 7}`],
        orchestrate: false
      })
      store.updateTask(task.id, { status: TASK_STATUSES[i % TASK_STATUSES.length]! })
      for (let note = 0; note < 3; note += 1) store.addNote(task.id, 'bench', `Note ${note}`)
    }
    ipc.notifyTasksChanged()
  })

  afterAll(() => {
    index.closeIndex()
    delete process.env.STYR_HOME
    rmSync(home, { recursive: true, force: true })
  })

  it('reports the baseline', () => {
    let edits = 0
    const results = {
      'cold: index file deleted (first start)': measure(ipc.notifyTasksChanged, () => {
        index.closeIndex()
        rmSync(settings.indexDbPath(), { force: true })
      }),
      'reopen: index closed (workspace switch)': measure(ipc.notifyTasksChanged, index.closeIndex),
      'warm: nothing changed on disk': measure(ipc.notifyTasksChanged),
      'warm: one task file written': measure(ipc.notifyTasksChanged, () => {
        edits += 1
        store.updateTask('TASK-0001', { title: `Edited ${edits}` })
      })
    }
    // The report is the point of this file.
    // eslint-disable-next-line no-console
    console.table(results)
    expect(index.queryTasks()).toHaveLength(TASKS)
  })
})
