import { monitorEventLoopDelay } from 'node:perf_hooks'
import { app } from 'electron'
import { SampleBuffer, type DiagnosticsSnapshot } from '@core/diagnostics.js'

const notifyDurations = new SampleBuffer(20)
const RESOLUTION_MS = 10
const loopDelay = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
let sampling = false

/** Times one `notifyTasksChanged` run. Cheap enough to leave on: one clock read per change. */
export function recordNotifyDuration(ms: number): void {
  notifyDurations.push(ms)
}

/**
 * One reading of what the app costs right now. The event-loop histogram only runs between
 * snapshots (started by the first, reset by each), so a closed panel costs nothing.
 */
export function takeSnapshot(counts: {
  terminals: number
  taskCount: number
  terminalEngine?: DiagnosticsSnapshot['terminalEngine']
}): DiagnosticsSnapshot {
  // The histogram samples a timer every RESOLUTION_MS, so an idle loop reads about that; the excess is real delay.
  const nanos = (value: number): number => Math.max(0, value / 1e6 - RESOLUTION_MS)
  const eventLoopMs =
    sampling && loopDelay.count > 0
      ? {
          p50: nanos(loopDelay.percentile(50)),
          p99: nanos(loopDelay.percentile(99)),
          max: nanos(loopDelay.max)
        }
      : undefined
  loopDelay.reset()
  if (!sampling) {
    loopDelay.enable()
    sampling = true
  }
  return {
    takenAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron ?? '',
    platform: `${process.platform} ${process.arch}`,
    processes: app.getAppMetrics().map((metric) => ({
      type: metric.type,
      ...(metric.name ? { name: metric.name } : {}),
      cpuPercent: metric.cpu.percentCPUUsage,
      // workingSetSize is in KB
      memoryMb: metric.memory.workingSetSize / 1024
    })),
    eventLoopMs,
    ...counts,
    notifyMs: notifyDurations.toArray()
  }
}

/** Stops sampling when the panel closes. */
export function stopSampling(): void {
  if (!sampling) return
  loopDelay.disable()
  sampling = false
}
