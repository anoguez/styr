import { describe, expect, it } from 'vitest'
import type { TerminalMark, TerminalOutput } from '@core/types.js'
import { TerminalOutputSynchronizer, writeOutput } from './terminalOutput.js'

function recorder(): {
  log: string[]
  sink: { write: (data: string) => void; mark: (mark: TerminalMark) => void }
} {
  const log: string[] = []
  return {
    log,
    sink: {
      write: (data) => {
        if (data) log.push(data)
      },
      mark: (mark) => log.push(`<${mark.kind}:${mark.id}>`)
    }
  }
}

const out = (sequence: number, data: string, marks: TerminalMark[] = []): TerminalOutput => ({
  sequence,
  data,
  marks
})
const mark = (offset: number, kind: 'start' | 'end', id = 'c1'): TerminalMark => ({
  offset,
  kind,
  id,
  at: 0
})

describe('TerminalOutputSynchronizer', () => {
  it('does not replay live output that is already present in the initial backlog', () => {
    const { log, sink } = recorder()
    const output = new TerminalOutputSynchronizer(sink)

    output.writeLive(out(4, 'codex resume task-id\r\n'))
    output.writeBacklog(out(4, 'codex resume task-id\r\n'))

    expect(log).toEqual(['codex resume task-id\r\n'])
  })

  it('keeps output received after the snapshot', () => {
    const { log, sink } = recorder()
    const output = new TerminalOutputSynchronizer(sink)

    output.writeLive(out(5, 'still working\r\n'))
    output.writeBacklog(out(4, 'started\r\n'))

    expect(log).toEqual(['started\r\n', 'still working\r\n'])
  })

  it('replays the marks of a backlog in place', () => {
    const { log, sink } = recorder()
    new TerminalOutputSynchronizer(sink).writeBacklog(
      out(2, '$ ls\r\nfile\r\n', [mark(6, 'start'), mark(12, 'end')])
    )
    expect(log).toEqual(['$ ls\r\n', '<start:c1>', 'file\r\n', '<end:c1>'])
  })
})

describe('writeOutput', () => {
  it('puts each mark between the right two pieces of data', () => {
    const { log, sink } = recorder()
    writeOutput(sink, { data: 'abcdef', marks: [mark(4, 'end'), mark(2, 'start')] })
    expect(log).toEqual(['ab', '<start:c1>', 'cd', '<end:c1>', 'ef'])
  })

  it('handles a mark at either edge and clamps a stray offset', () => {
    const { log, sink } = recorder()
    writeOutput(sink, { data: 'ab', marks: [mark(0, 'start'), mark(99, 'end')] })
    expect(log).toEqual(['<start:c1>', 'ab', '<end:c1>'])
  })
})
