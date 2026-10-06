/** What the Performance panel shows. Memory-only: never written to a task file, config or the index. */

export interface ProcessMetric {
  /** Electron's process type: Browser (main), Tab (renderer), GPU, Utility … */
  type: string
  name?: string
  cpuPercent: number
  memoryMb: number
}

export interface DiagnosticsSnapshot {
  takenAt: string
  appVersion: string
  packaged: boolean
  electron: string
  platform: string
  processes: ProcessMetric[]
  /** Main-process event-loop delay since the previous snapshot; undefined before one has been sampled. */
  eventLoopMs?: { p50: number; p99: number; max: number }
  terminals: number
  taskCount: number
  /** Recent durations of `notifyTasksChanged` (re-index plus landing check), newest last. */
  notifyMs: number[]
}

/** The last `size` numbers, oldest dropped first. */
export class SampleBuffer {
  private readonly values: number[] = []

  constructor(private readonly size: number) {}

  push(value: number): void {
    this.values.push(value)
    if (this.values.length > this.size) this.values.shift()
  }

  toArray(): number[] {
    return [...this.values]
  }
}

export function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

const num = (value: number | undefined, unit: string, digits = 0): string =>
  value === undefined || !Number.isFinite(value) ? '–' : `${value.toFixed(digits)}${unit}`

export interface RendererMetrics {
  heapMb?: number
  domNodes: number
  longTasks: number
}

/** Plain text for "Copy report", so a slow moment can be pasted into an issue. */
export function formatDiagnostics(
  snapshot: DiagnosticsSnapshot,
  renderer?: RendererMetrics
): string {
  const total = snapshot.processes.reduce(
    (sum, process) => ({
      cpu: sum.cpu + process.cpuPercent,
      memory: sum.memory + process.memoryMb
    }),
    { cpu: 0, memory: 0 }
  )
  const lines = [
    `Styr ${snapshot.appVersion} (${snapshot.packaged ? 'packaged' : 'dev build'}) · Electron ${snapshot.electron} · ${snapshot.platform}`,
    `Taken ${snapshot.takenAt}`,
    '',
    'Processes',
    ...snapshot.processes.map(
      (process) =>
        `  ${(process.name ?? process.type).padEnd(22)} ${num(process.cpuPercent, '%', 1).padStart(7)} ${num(process.memoryMb, ' MB').padStart(9)}`
    ),
    `  ${'Total'.padEnd(22)} ${num(total.cpu, '%', 1).padStart(7)} ${num(total.memory, ' MB').padStart(9)}`,
    '',
    `Main event loop delay: p50 ${num(snapshot.eventLoopMs?.p50, ' ms', 1)}, p99 ${num(snapshot.eventLoopMs?.p99, ' ms', 1)}, max ${num(snapshot.eventLoopMs?.max, ' ms', 1)}`,
    `Task change handling (last ${snapshot.notifyMs.length}): median ${num(percentile(snapshot.notifyMs, 0.5), ' ms')}, worst ${num(percentile(snapshot.notifyMs, 1), ' ms')}`,
    `Tasks ${snapshot.taskCount} · open terminals ${snapshot.terminals}`
  ]
  if (renderer) {
    lines.push(
      `Renderer: heap ${num(renderer.heapMb, ' MB')} · DOM nodes ${renderer.domNodes} · long tasks (>50 ms) since opened ${renderer.longTasks}`
    )
  }
  return lines.join('\n')
}
