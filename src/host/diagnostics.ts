import { monitorEventLoopDelay } from 'node:perf_hooks'
import { SampleBuffer, type DiagnosticsSnapshot, type ProcessMetric } from '@core/diagnostics.js'
import type { AppPaths } from './ports.js'

export interface DiagnosticsPorts {
  appPaths: Pick<AppPaths, 'isPackaged' | 'version'>
  /** The app's processes and what each costs (Electron's `app.getAppMetrics()`). */
  processMetrics(): ProcessMetric[]
}

const RESOLUTION_MS = 10

/**
 * What the Performance panel shows: the app's processes, the main thread's event-loop delay and
 * recent `notifyTasksChanged` durations. Memory-only, and cheap enough to leave on.
 */
export function createDiagnostics(ports: DiagnosticsPorts) {
  const notifyDurations = new SampleBuffer(20)
  const loopDelay = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  let sampling = false

  /** Times one `notifyTasksChanged` run: one clock read per change. */
  function recordNotifyDuration(ms: number): void {
    notifyDurations.push(ms)
  }

  /**
   * One reading of what the app costs right now. The event-loop histogram only runs between
   * snapshots (started by the first, reset by each), so a closed panel costs nothing.
   */
  function takeSnapshot(counts: {
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
      appVersion: ports.appPaths.version,
      packaged: ports.appPaths.isPackaged,
      electron: process.versions.electron ?? '',
      platform: `${process.platform} ${process.arch}`,
      processes: ports.processMetrics(),
      eventLoopMs,
      ...counts,
      notifyMs: notifyDurations.toArray()
    }
  }

  /** Stops sampling when the panel closes. */
  function stopSampling(): void {
    if (!sampling) return
    loopDelay.disable()
    sampling = false
  }

  return { recordNotifyDuration, takeSnapshot, stopSampling }
}
