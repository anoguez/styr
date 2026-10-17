import { describe, expect, it } from 'vitest'
import { createDiagnostics } from './diagnostics.js'

const ports = {
  appPaths: { isPackaged: true, version: '1.2.3' },
  processMetrics: () => [{ type: 'Browser', cpuPercent: 1, memoryMb: 100 }]
}

describe('diagnostics', () => {
  it('reports the app, its processes, the counts given and the recent notify durations', () => {
    const diagnostics = createDiagnostics(ports)
    for (let ms = 1; ms <= 25; ms++) diagnostics.recordNotifyDuration(ms)
    const snapshot = diagnostics.takeSnapshot({ terminals: 2, taskCount: 7 })
    expect(snapshot).toMatchObject({
      appVersion: '1.2.3',
      packaged: true,
      platform: `${process.platform} ${process.arch}`,
      processes: [{ type: 'Browser', cpuPercent: 1, memoryMb: 100 }],
      terminals: 2,
      taskCount: 7
    })
    expect(snapshot.notifyMs).toEqual(Array.from({ length: 20 }, (_, i) => i + 6))
    diagnostics.stopSampling()
  })

  it('samples the event loop only between snapshots', async () => {
    const diagnostics = createDiagnostics(ports)
    expect(diagnostics.takeSnapshot({ terminals: 0, taskCount: 0 }).eventLoopMs).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const loop = diagnostics.takeSnapshot({ terminals: 0, taskCount: 0 }).eventLoopMs
    expect(loop).toBeDefined()
    expect(loop!.max).toBeGreaterThanOrEqual(0)
    diagnostics.stopSampling()
    diagnostics.stopSampling()
    expect(diagnostics.takeSnapshot({ terminals: 0, taskCount: 0 }).eventLoopMs).toBeUndefined()
    diagnostics.stopSampling()
  })
})
