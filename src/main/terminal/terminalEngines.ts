import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { describeNativeStatus, experimentalTerminalOverride } from '@core/terminalEngine.js'
import {
  CommandTimer,
  formatBenchRecord,
  isBenchRecord,
  type BenchProcesses,
  type TerminalBenchRecord
} from '@core/terminalBench.js'
import type {
  NativeUnavailableReason,
  TerminalMark,
  TerminalEngineAvailability,
  TerminalEngineEnvironment,
  TerminalEngineDiagnostic,
  TerminalEngineId
} from '@core/types.js'
import {
  findNativePackage,
  loadNativeEngine,
  type LoaderEnvironment,
  type LoadResult
} from './nativeEngine.js'
import { NativeTerminalHost } from './nativeHost.js'
import { onTerminalData, onTerminalExit, sessionBacklog, writeToSession } from './ptyManager.js'

/**
 * The main-process side of terminal engines: the IPC the renderer's engine views call, the native
 * host fed from `ptyManager`, and the diagnostics record. xterm.js needs none of it — with the
 * experiment off, nothing here loads the native package or creates an engine.
 */

let loaded: LoadResult | undefined

function loaderEnvironment(): LoaderEnvironment {
  const require_ = createRequire(join(app.getAppPath(), 'package.json'))
  return {
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    devPath: app.isPackaged ? undefined : process.env.STYR_TERMINAL_PATH || undefined,
    exists: existsSync,
    load: (specifier) => require_(specifier)
  }
}

/** Loads the package once per run; nothing else loads it. The result holds until the app quits. */
function nativeEngine(): LoadResult {
  loaded ??= loadNativeEngine(loaderEnvironment())
  return loaded
}

const DIAGNOSTIC_LIMIT = 20
const diagnostics: TerminalEngineDiagnostic[] = []

function record(entry: Omit<TerminalEngineDiagnostic, 'platform' | 'arch' | 'at'>): void {
  const status = loaded?.status
  const full: TerminalEngineDiagnostic = {
    ...entry,
    ...(status?.available
      ? { engineVersion: status.info.packageVersion, coreVersion: status.info.coreVersion }
      : {}),
    platform: process.platform,
    arch: process.arch,
    at: Date.now()
  }
  diagnostics.push(full)
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift()
  // One line, no contents: which session, which engine, and why it is not the one asked for.
  if (full.fallbackReason) {
    console.warn(
      `[terminal-engine] session ${full.sessionId}: ${full.requested} → ${full.selected} (${full.fallbackReason}${full.detail ? `: ${full.detail}` : ''})`
    )
  }
}

/** The recent engine choices, newest last, for the Performance panel's report. */
export function terminalEngineDiagnostics(): {
  summary: string
  sessions: TerminalEngineDiagnostic[]
} {
  const status = loaded?.status ?? null
  return { summary: describeNativeStatus(status), sessions: [...diagnostics] }
}

const override = (): boolean | undefined =>
  experimentalTerminalOverride(process.env.STYR_EXPERIMENTAL_TERMINAL)

function environment(): TerminalEngineEnvironment {
  const status = nativeEngine().status
  return { status, override: override(), summary: describeNativeStatus(status) }
}

const ENGINE_IDS: readonly TerminalEngineId[] = ['xterm', 'native']
const REASONS: readonly NativeUnavailableReason[] = [
  'disabled',
  'unsupported-platform',
  'missing-package',
  'load-failed',
  'incompatible-version',
  'init-failed',
  'runtime-error'
]

/** `STYR_TERMINAL_BENCH=1` times commands in each engine; ignored when packaged, like the path. */
const benchmarking = (): boolean => !app.isPackaged && process.env.STYR_TERMINAL_BENCH === '1'

/**
 * Each process's CPU since the previous call (Electron measures it that way) and its working set.
 * Called at every command start too, so a record's CPU covers that command alone — provided the
 * Performance panel, which calls it as well, stays closed while benchmarking.
 */
function benchProcesses(): BenchProcesses {
  const processes: BenchProcesses = {}
  for (const metric of app.getAppMetrics()) {
    const entry = (processes[metric.type] ??= { cpuPercent: 0, memoryMb: 0 })
    entry.cpuPercent += metric.cpu.percentCPUUsage
    // workingSetSize is in KB
    entry.memoryMb += metric.memory.workingSetSize / 1024
  }
  return processes
}

function logBench(record: TerminalBenchRecord): void {
  process.stdout.write(`${formatBenchRecord(record, benchProcesses())}\n`)
}

/** Times native sessions from the marks the host has drawn (`NativeHostPorts.drawn`). */
function nativeBenchTimer(): {
  drawn: (id: string, marks: TerminalMark[]) => void
  forget: (id: string) => void
} {
  const timers = new Map<string, CommandTimer>()
  return {
    drawn: (id, marks) => {
      let timer = timers.get(id)
      if (!timer) timers.set(id, (timer = new CommandTimer('native', id)))
      for (const mark of marks) {
        const end = timer.observe(mark)
        const record = end && timer.finish(end, Date.now())
        if (record) logBench(record)
      }
    },
    forget: (id) => timers.delete(id)
  }
}

export function registerTerminalEngines(
  broadcast: (channel: string, payload: unknown) => void
): NativeTerminalHost {
  const bench = benchmarking() ? nativeBenchTimer() : undefined
  const host = new NativeTerminalHost({
    factory: () => nativeEngine().factory,
    status: () => nativeEngine().status,
    backlog: sessionBacklog,
    writeToPty: writeToSession,
    sendFrame: (event) => broadcast('terminal:nativeFrame', event),
    sendBlocks: (event) => broadcast('terminal:nativeBlocks', event),
    sendFailure: (failure) => {
      record({
        sessionId: failure.id,
        requested: 'native',
        selected: 'xterm',
        fallbackReason: failure.reason,
        detail: failure.detail
      })
      broadcast('terminal:nativeFailed', failure)
    },
    defer: (task) => setImmediate(task),
    ...(bench ? { drawn: bench.drawn } : {})
  })
  onTerminalData((id, output) => {
    host.write(id, output)
    // Starts the CPU window of the command, whichever engine shows it.
    if (bench && output.marks.some((mark) => mark.kind === 'start')) benchProcesses()
  })
  onTerminalExit((id) => {
    host.detach(id)
    bench?.forget(id)
  })

  ipcMain.handle('terminal:benchEnabled', () => bench !== undefined)
  ipcMain.on('terminal:bench', (_event, record: unknown) => {
    if (bench && isBenchRecord(record)) logBench(record)
  })

  ipcMain.handle('terminal:engineAvailability', (): TerminalEngineAvailability => ({
    ...findNativePackage(loaderEnvironment()),
    override: override()
  }))
  ipcMain.handle('terminal:engineEnvironment', () => environment())
  ipcMain.handle('terminal:nativeAttach', (_event, id: string, cols: number, rows: number) => {
    const result = host.attach(String(id), Number(cols), Number(rows))
    if (!result.ok) {
      record({
        sessionId: String(id),
        requested: 'native',
        selected: 'xterm',
        fallbackReason: result.reason,
        detail: result.detail
      })
    }
    return result
  })
  ipcMain.on('terminal:nativeResize', (_event, id: string, cols: number, rows: number) =>
    host.resize(String(id), Number(cols), Number(rows))
  )
  ipcMain.on('terminal:nativeScroll', (_event, id: string, lines: number | 'bottom') =>
    host.scroll(String(id), lines === 'bottom' ? 'bottom' : Number(lines))
  )
  ipcMain.handle('terminal:nativeText', (_event, id: string) => host.text(String(id)))
  ipcMain.handle('terminal:nativeLines', (_event, id: string, from: number, to: number) =>
    host.lines(String(id), Number(from), Number(to))
  )
  ipcMain.handle('terminal:nativeStyledLines', (_event, id: string, from: number, to: number) =>
    host.styledLines(String(id), Number(from), Number(to))
  )
  ipcMain.on('terminal:nativeDetach', (_event, id: string) => host.detach(String(id)))
  ipcMain.on('terminal:nativeClearBlocks', (_event, id: string) => host.clearBlocks(String(id)))
  // The renderer reports what each view ended up with, so the report shows sessions that never
  // asked for the native engine (or were refused before attaching) as well.
  ipcMain.on('terminal:engineSelected', (_event, entry: Partial<TerminalEngineDiagnostic>) => {
    if (typeof entry?.sessionId !== 'string') return
    if (!ENGINE_IDS.includes(entry.requested!) || !ENGINE_IDS.includes(entry.selected!)) return
    record({
      sessionId: entry.sessionId.slice(0, 64),
      requested: entry.requested!,
      selected: entry.selected!,
      ...(entry.fallbackReason && REASONS.includes(entry.fallbackReason)
        ? { fallbackReason: entry.fallbackReason }
        : {}),
      ...(typeof entry.detail === 'string' ? { detail: entry.detail.slice(0, 200) } : {})
    })
  })
  return host
}
