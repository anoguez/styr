import { app } from 'electron'
import { createDiagnostics } from '@host/diagnostics.js'
import { electronHost } from './electronHost.js'

/**
 * The host's diagnostics (`src/host/diagnostics.ts`), reading Electron's process metrics. `ipc.ts`
 * imports them through this path, which is the one the main-process ordering tests mock.
 */
export const { recordNotifyDuration, takeSnapshot, stopSampling } = createDiagnostics({
  appPaths: electronHost.appPaths,
  processMetrics: () =>
    app.getAppMetrics().map((metric) => ({
      type: metric.type,
      ...(metric.name ? { name: metric.name } : {}),
      cpuPercent: metric.cpu.percentCPUUsage,
      // workingSetSize is in KB
      memoryMb: metric.memory.workingSetSize / 1024
    }))
})
