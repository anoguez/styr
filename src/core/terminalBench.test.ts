import { describe, expect, it } from 'vitest'
import type { TerminalMark } from './types.js'
import { CommandTimer, formatBenchRecord, isBenchRecord } from './terminalBench.js'

const mark = (kind: TerminalMark['kind'], id: string, at: number): TerminalMark => ({
  offset: 0,
  kind,
  id,
  at,
  ...(kind === 'start' ? { command: 'cat secret.txt' } : {})
})

describe('CommandTimer', () => {
  it('times a command from its start mark to when it was drawn', () => {
    const timer = new CommandTimer('xterm', 's1')
    expect(timer.observe(mark('start', 'c1', 1000))).toBeUndefined()
    const end = timer.observe(mark('end', 'c1', 1500))
    expect(end).toBeDefined()
    expect(timer.finish(end!, 1800)).toEqual({
      engine: 'xterm',
      sessionId: 's1',
      startAt: 1000,
      endAt: 1500,
      drawnAt: 1800,
      totalMs: 800,
      lagMs: 300
    })
  })

  it('ignores an end without its start (a backlog that began mid-command) and prompt marks', () => {
    const timer = new CommandTimer('native', 's1')
    expect(timer.observe(mark('end', 'c1', 1500))).toBeUndefined()
    expect(timer.observe(mark('prompt', 'p1', 1600))).toBeUndefined()
  })

  it('reports each command once', () => {
    const timer = new CommandTimer('native', 's1')
    timer.observe(mark('start', 'c1', 1000))
    const end = timer.observe(mark('end', 'c1', 1500))!
    expect(timer.finish(end, 1600)).toBeDefined()
    expect(timer.finish(end, 1700)).toBeUndefined()
  })

  it('never carries the command line', () => {
    const timer = new CommandTimer('xterm', 's1')
    timer.observe(mark('start', 'c1', 1000))
    const record = timer.finish(timer.observe(mark('end', 'c1', 1500))!, 1600)!
    expect(formatBenchRecord(record)).not.toContain('secret')
    expect(formatBenchRecord(record)).toMatch(/^\[terminal-bench\] \{/)
  })
})

describe('isBenchRecord', () => {
  it('accepts a record and rejects anything else', () => {
    const timer = new CommandTimer('xterm', 's1')
    timer.observe(mark('start', 'c1', 1000))
    expect(isBenchRecord(timer.finish(timer.observe(mark('end', 'c1', 1500))!, 1600))).toBe(true)
    expect(isBenchRecord(null)).toBe(false)
    expect(isBenchRecord({ engine: 'other', sessionId: 's1' })).toBe(false)
    expect(
      isBenchRecord({
        engine: 'xterm',
        sessionId: 's1',
        startAt: 1,
        endAt: 2,
        drawnAt: Number.NaN,
        totalMs: 1,
        lagMs: 1
      })
    ).toBe(false)
  })
})

describe('formatBenchRecord', () => {
  it('adds the process figures when given', () => {
    const timer = new CommandTimer('native', 's1')
    timer.observe(mark('start', 'c1', 1000))
    const record = timer.finish(timer.observe(mark('end', 'c1', 1500))!, 1600)!
    const line = formatBenchRecord(record, { Browser: { cpuPercent: 12.5, memoryMb: 200 } })
    expect(JSON.parse(line.replace('[terminal-bench] ', ''))).toMatchObject({
      engine: 'native',
      totalMs: 600,
      processes: { Browser: { cpuPercent: 12.5, memoryMb: 200 } }
    })
  })
})
