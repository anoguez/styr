import { describe, expect, it } from 'vitest'
import {
  formatDiagnostics,
  percentile,
  SampleBuffer,
  type DiagnosticsSnapshot
} from './diagnostics.js'

const snapshot: DiagnosticsSnapshot = {
  takenAt: '2026-10-06T10:00:00.000Z',
  appVersion: '0.16.0',
  packaged: false,
  electron: '40.0.0',
  platform: 'darwin',
  processes: [
    { type: 'Browser', cpuPercent: 3.25, memoryMb: 120 },
    { type: 'Tab', cpuPercent: 10, memoryMb: 300 }
  ],
  terminals: 2,
  taskCount: 33,
  notifyMs: [10, 20, 400]
}

describe('SampleBuffer', () => {
  it('keeps only the newest samples', () => {
    const buffer = new SampleBuffer(3)
    for (const value of [1, 2, 3, 4]) buffer.push(value)
    expect(buffer.toArray()).toEqual([2, 3, 4])
  })
})

describe('percentile', () => {
  it('is undefined for no samples and picks from the sorted values', () => {
    expect(percentile([], 0.5)).toBeUndefined()
    expect(percentile([30, 10, 20], 0.5)).toBe(20)
    expect(percentile([30, 10, 20], 1)).toBe(30)
  })
})

describe('formatDiagnostics', () => {
  it('totals the processes and shows a dash for missing values', () => {
    const text = formatDiagnostics(snapshot)
    expect(text).toContain('Total')
    expect(text).toContain('13.3%')
    expect(text).toContain('420 MB')
    expect(text).toContain('p50 –')
    expect(text).toContain('worst 400 ms')
    expect(text).not.toContain('NaN')
  })

  it('adds renderer figures when given', () => {
    expect(formatDiagnostics(snapshot, { heapMb: 80, domNodes: 1200, longTasks: 4 })).toContain(
      'DOM nodes 1200'
    )
  })
})
