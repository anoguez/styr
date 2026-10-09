import { beforeEach, describe, expect, it } from 'vitest'
import type { BlockListEvent, EngineFrameLine, TerminalMark } from '@core/types.js'
import { BlockSession, MAX_FINISHED_BLOCKS, supportsBlockList } from './blockSession.js'
import { FakeEngine } from './nativeEngineFixture.js'

const prompt = (id: string, at = 0): TerminalMark => ({
  offset: 0,
  kind: 'prompt',
  id,
  cwd: '/repo',
  at
})
const start = (id: string, command: string, at = 10): TerminalMark => ({
  offset: 0,
  kind: 'start',
  id,
  command,
  at
})
const end = (id: string, exitCode = 0, at = 30): TerminalMark => ({
  offset: 0,
  kind: 'end',
  id,
  exitCode,
  at
})

const text = (rows: EngineFrameLine[]): string[] =>
  rows.map((row) => row.runs.map((run) => run.text).join(''))

function session(rows = 5): BlockSession {
  return new BlockSession((options) => new FakeEngine(options), { cols: 40, rows }, prompt('p1'))
}

/** A session whose opening announcement has been taken. */
function quiet(rows = 5): BlockSession {
  const list = session(rows)
  list.takeEvents()
  return list
}

/** Runs one command the way zsh reports it: prompt drawn, line echoed, output, exit. */
function run(list: BlockSession, id: string, command: string, output: string, exitCode = 0): void {
  list.write(`➜ repo ${command}\r\n`)
  list.mark(start(id, command))
  list.write(output)
  list.mark(end(id, exitCode))
  list.mark(prompt(`p-${id}`))
}

const kinds = (events: BlockListEvent[]): string[] => events.map((event) => event.kind)

beforeEach(() => {
  FakeEngine.instances = []
})

describe('BlockSession', () => {
  it('needs an engine with styled lines and marks', () => {
    expect(supportsBlockList(new FakeEngine({ cols: 2, rows: 1, scrollback: 0 }))).toBe(true)
    const old = Object.assign(new FakeEngine({ cols: 2, rows: 1, scrollback: 0 }), {
      styledLines: undefined
    })
    expect(supportsBlockList(old)).toBe(false)
  })

  it('turns a command into a finished block with its prompt, output and result', () => {
    const list = quiet()
    run(list, 'c1', 'ls', 'a\r\nb\r\n', 2)
    const events = list.takeEvents()
    expect(kinds(events)).toEqual(['segment', 'finished', 'segment'])
    const finished = events.find((event) => event.kind === 'finished')
    if (finished?.kind !== 'finished') throw new Error('no finished block')
    expect(finished.block).toMatchObject({
      id: 'c1',
      command: 'ls',
      startedAt: 10,
      endedAt: 30,
      exitCode: 2,
      cols: 40,
      truncated: false
    })
    // The shell's prompt and its echo of the command stay out of the block.
    expect(text(finished.block.output)).toEqual(['a', 'b'])
    expect(finished.block).not.toHaveProperty('prompt')
  })

  it('reports the running command, then the prompt that follows it', () => {
    const list = quiet()
    list.write('➜ repo make\r\n')
    list.mark(start('c1', 'make'))
    const running = list.takeEvents()[0]
    expect(running).toMatchObject({
      kind: 'segment',
      segment: { kind: 'running', id: 'c1', command: 'make', startedAt: 10 }
    })
    list.write('building\r\n')
    expect(kinds(list.takeEvents())).toEqual(['frame'])
    list.mark(end('c1'))
    list.mark(prompt('p2'))
    const after = list.takeEvents()
    expect(after[1]).toMatchObject({ kind: 'segment', segment: { kind: 'prompt' } })
    // The prompt mark lands in the segment the end opened; it does not replace it again.
    expect(kinds(after)).toEqual(['finished', 'segment'])
    expect(list.snapshot().active).toEqual({ kind: 'prompt', id: 'p2', cwd: '/repo' })
  })

  it('drops a prompt that is replaced without running anything', () => {
    const list = session()
    list.write('➜ repo \r\n')
    list.mark(prompt('p2'))
    expect(list.snapshot().finished).toEqual([])
    expect(list.snapshot().active).toMatchObject({ kind: 'prompt', id: 'p2' })
  })

  it('keeps what a command showed if the next prompt comes without its end', () => {
    const list = session()
    list.mark(start('c1', 'exec zsh'))
    list.write('bye\r\n')
    list.mark(prompt('p2'))
    expect(list.snapshot().finished).toMatchObject([{ id: 'c1', command: 'exec zsh' }])
    expect(list.snapshot().finished[0]!.exitCode).toBeUndefined()
  })

  it('empties the list for clear, and on request', () => {
    const list = quiet()
    run(list, 'c1', 'ls', 'a\r\n')
    run(list, 'c2', 'clear', '\x1b[H\x1b[2J')
    expect(list.snapshot().finished).toEqual([])
    run(list, 'c3', 'pwd', '/repo\r\n')
    list.takeEvents()
    list.clear()
    expect(kinds(list.takeEvents())).toEqual(['cleared'])
    expect(list.snapshot().finished).toEqual([])
  })

  it('sends rows that scroll off the running screen once each', () => {
    const list = session(3)
    list.mark(start('c1', 'seq 10'))
    list.takeEvents()
    list.write('1\r\n2\r\n3\r\n4\r\n5\r\n')
    const first = list.takeEvents().find((event) => event.kind === 'history')
    expect(first?.kind === 'history' && text(first.rows)).toEqual(['1', '2', '3'])
    expect(list.takeEvents().some((event) => event.kind === 'history')).toBe(false)
    list.write('6\r\n')
    const next = list.takeEvents().find((event) => event.kind === 'history')
    expect(next?.kind === 'history' && text(next.rows)).toEqual(['4'])
  })

  it('gives a view attaching mid-command the history so far', () => {
    const list = session(3)
    list.mark(start('c1', 'seq 10'))
    list.write('1\r\n2\r\n3\r\n4\r\n')
    const snapshot = list.snapshot()
    expect(snapshot.active).toMatchObject({ kind: 'running', id: 'c1' })
    expect(text(snapshot.history)).toEqual(['1', '2'])
    expect(list.takeEvents().some((event) => event.kind === 'history')).toBe(false)
  })

  it('keeps a bounded number of finished blocks, dropping the oldest', () => {
    const list = session()
    for (let index = 0; index < MAX_FINISHED_BLOCKS + 5; index++) {
      run(list, `c${index}`, 'true', '')
    }
    const { finished } = list.snapshot()
    expect(finished).toHaveLength(MAX_FINISHED_BLOCKS)
    expect(finished[0]!.id).toBe('c5')
  })

  it('answers queries from the live segment and frees each engine it replaces', () => {
    const list = session()
    list.mark(start('c1', 'tput u7'))
    list.write('\x1b[6n')
    expect(list.takeResponses()).toBe('\x1b[1;1R')
    list.mark(end('c1'))
    list.mark(prompt('p2'))
    const live = FakeEngine.instances.filter((engine) => !engine.disposed)
    expect(live).toHaveLength(1)
    list.dispose()
    expect(FakeEngine.instances.every((engine) => engine.disposed)).toBe(true)
  })

  it('resizes the live segment and opens the next one at the new size', () => {
    const list = session()
    list.resize(100, 30)
    expect(FakeEngine.instances.at(-1)).toMatchObject({ cols: 100, rows: 30 })
    list.mark(start('c1', 'ls'))
    expect(FakeEngine.instances.at(-1)).toMatchObject({ cols: 100, rows: 30 })
  })
})

describe('BlockSession start', () => {
  it('announces its first prompt, so a view showing the grid can switch', () => {
    const list = session()
    expect(list.takeEvents()).toMatchObject([
      { kind: 'segment', segment: { kind: 'prompt', id: 'p1', cwd: '/repo' } }
    ])
  })
})
