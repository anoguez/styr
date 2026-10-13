import { describe, expect, it } from 'vitest'
import type { TerminalMark } from '@core/types.js'
import { CommandBlockTracker } from './commandBlockTracker.js'
import { FakeEngine } from './nativeEngineFixture.js'

const at = 1_000

const start = (id = 'c1', command = 'ls'): TerminalMark => ({
  offset: 0,
  kind: 'start',
  id,
  command,
  at
})

const end = (id = 'c1', exitCode = 0): TerminalMark => ({
  offset: 0,
  kind: 'end',
  id,
  exitCode,
  at: at + 250
})

function createTracker(): { engine: FakeEngine; tracker: CommandBlockTracker } {
  const engine = new FakeEngine({ cols: 80, rows: 24, scrollback: 10_000 })
  const tracker = CommandBlockTracker.create(engine)
  if (!tracker) throw new Error('FakeEngine supports command marks')
  return { engine, tracker }
}

describe('CommandBlockTracker', () => {
  it('returns no tracker for an engine without command mark support', () => {
    const engine = new FakeEngine({ cols: 80, rows: 24, scrollback: 10_000 })
    Object.assign(engine, {
      markLine: undefined,
      markedLines: undefined,
      cursorPosition: undefined
    })

    expect(CommandBlockTracker.create(engine)).toBeUndefined()
  })

  it('turns a completed command into a block with its exit code and fixed span', () => {
    const { engine, tracker } = createTracker()
    engine.write('$ ls\r\n')
    tracker.observe(start())
    engine.write('a\r\nb\r\n')
    tracker.observe(end())
    engine.write('$ ')

    expect(tracker.snapshot()).toEqual([
      {
        id: 'c1',
        command: 'ls',
        startedAt: at,
        endedAt: at + 250,
        exitCode: 0,
        startLine: 0,
        endLine: 3,
        open: false
      }
    ])
    engine.write('next prompt\r\n')
    expect(tracker.snapshot()[0]).toMatchObject({ endLine: 3, open: false })
  })

  it('keeps an incomplete command open and follows the cursor', () => {
    const { engine, tracker } = createTracker()
    engine.write('$ build\r\n')
    tracker.observe(start('c1', 'build'))
    expect(tracker.snapshot()).toMatchObject([{ startLine: 0, endLine: 1, open: true }])

    engine.write('step 1\r\nstep 2')
    expect(tracker.snapshot()).toMatchObject([{ startLine: 0, endLine: 3, open: true }])
  })

  it('ignores unmatched marks and forgets commands whose marked line left the buffer', () => {
    const { engine, tracker } = createTracker()
    tracker.observe(end('unknown'))
    engine.write('$ ls\r\n')
    tracker.observe(start())
    engine.marks.delete('c1')

    expect(tracker.snapshot()).toEqual([])
    tracker.observe(end())
    expect(tracker.snapshot()).toEqual([])
  })

  it('sorts snapshots by buffer position', () => {
    const { engine, tracker } = createTracker()
    engine.write('$ first\r\n')
    tracker.observe(start('first', 'first'))
    engine.write('$ second\r\n')
    tracker.observe(start('second', 'second'))

    expect(tracker.snapshot().map((block) => block.id)).toEqual(['first', 'second'])
  })
})
