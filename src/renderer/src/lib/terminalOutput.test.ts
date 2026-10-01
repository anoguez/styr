import { describe, expect, it } from 'vitest'
import { TerminalOutputSynchronizer } from './terminalOutput.js'

describe('TerminalOutputSynchronizer', () => {
  it('does not replay live output that is already present in the initial backlog', () => {
    const writes: string[] = []
    const output = new TerminalOutputSynchronizer((data) => writes.push(data))

    output.writeLive({ sequence: 4, data: 'codex resume task-id\r\n' })
    output.writeBacklog({ sequence: 4, data: 'codex resume task-id\r\n' })

    expect(writes).toEqual(['codex resume task-id\r\n'])
  })

  it('keeps output received after the snapshot', () => {
    const writes: string[] = []
    const output = new TerminalOutputSynchronizer((data) => writes.push(data))

    output.writeLive({ sequence: 5, data: 'still working\r\n' })
    output.writeBacklog({ sequence: 4, data: 'started\r\n' })

    expect(writes).toEqual(['started\r\n', 'still working\r\n'])
  })
})
