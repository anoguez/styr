import { beforeEach, describe, expect, it } from 'vitest'
import type {
  NativeEngineFailure,
  NativeEngineStatus,
  NativeFrameEvent,
  TerminalMark,
  TerminalOutput
} from '@core/types.js'
import { TerminalOutputSynchronizer } from '../../renderer/src/lib/terminalOutput.js'
import { NativeTerminalHost, WRITE_CHUNK, type NativeHostPorts } from './nativeHost.js'
import { FakeEngine } from './nativeEngineFixture.js'
import type { NativeEngineFactory } from './nativeEngine.js'

const info = {
  apiVersion: 1,
  packageVersion: '0.1.0-test',
  coreVersion: '0.1.0 (fixture)',
  target: 'aarch64-apple-darwin'
}
const available: NativeEngineStatus = { available: true, info, path: '/pkg' }

/** A PTY session as `ptyManager` keeps it: a backlog and a sequence number per chunk. */
class FakeSession {
  backlog = ''
  sequence = 0
  readonly listeners: ((output: TerminalOutput) => void)[] = []

  emit(data: string): TerminalOutput {
    this.sequence += 1
    this.backlog += data
    const output = { data, sequence: this.sequence, marks: [] }
    for (const listener of this.listeners) listener(output)
    return output
  }

  snapshot(): TerminalOutput {
    return { data: this.backlog, sequence: this.sequence, marks: [] }
  }
}

function setup(overrides: Partial<NativeHostPorts> = {}) {
  const session = new FakeSession()
  const frames: NativeFrameEvent[] = []
  const failures: NativeEngineFailure[] = []
  const ptyWrites: string[] = []
  const deferred: (() => void)[] = []
  const factory: NativeEngineFactory = { info, create: (options) => new FakeEngine(options) }
  const host = new NativeTerminalHost({
    factory: () => factory,
    status: () => available,
    backlog: () => session.snapshot(),
    writeToPty: (_id, data) => ptyWrites.push(data),
    sendFrame: (event) => frames.push(event),
    sendFailure: (failure) => failures.push(failure),
    defer: (task) => deferred.push(task),
    ...overrides
  })
  session.listeners.push((output) => host.write('s1', output))
  const flush = (): void => {
    while (deferred.length > 0) deferred.shift()!()
  }
  return { session, host, frames, failures, ptyWrites, flush }
}

beforeEach(() => {
  FakeEngine.instances = []
})

describe('NativeTerminalHost', () => {
  it('seeds a new engine with the backlog and returns its snapshot', () => {
    const { session, host } = setup()
    session.emit('$ echo hi\r\nhi\r\n')
    const result = host.attach('s1', 80, 24)
    expect(result).toMatchObject({ ok: true, attachId: 1, info })
    expect(FakeEngine.instances[0]!.written).toBe('$ echo hi\r\nhi\r\n')
    expect(result.ok && result.frame.lines.map((line) => line.runs[0]?.text)).toContain('hi')
  })

  it('does not answer device queries found in old output', () => {
    const { session, host, ptyWrites, flush } = setup()
    session.emit('\x1b[6n')
    host.attach('s1', 80, 24)
    flush()
    expect(ptyWrites).toEqual([])
  })

  it('answers device queries in live output by writing to the PTY', () => {
    const { session, host, ptyWrites, flush } = setup()
    host.attach('s1', 80, 24)
    session.emit('\x1b[6n')
    flush()
    expect(ptyWrites).toEqual(['\x1b[1;1R'])
  })

  it('coalesces a burst of PTY chunks into one frame', () => {
    const { session, host, frames, flush } = setup()
    host.attach('s1', 80, 24)
    for (let index = 0; index < 50; index++) session.emit(`line ${index}\r\n`)
    flush()
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ id: 's1', attachId: 1 })
    flush()
    expect(frames).toHaveLength(1)
  })

  it('ignores output for sessions it has no engine for', () => {
    const { session, frames, flush } = setup()
    session.emit('nobody is watching')
    flush()
    expect(frames).toEqual([])
    expect(FakeEngine.instances).toHaveLength(0)
  })

  it('splits large output under the engine limit without breaking a surrogate pair', () => {
    const { session, host } = setup()
    host.attach('s1', 80, 24)
    const engine = FakeEngine.instances[0]!
    const sizes: number[] = []
    const write = engine.write.bind(engine)
    engine.write = (data) => {
      sizes.push(data.length)
      // Every piece must be valid UTF-16 on its own.
      expect(/[\ud800-\udbff]$/.test(data)).toBe(false)
      write(data)
    }
    const big = 'a'.repeat(WRITE_CHUNK - 1) + '😀' + 'b'.repeat(WRITE_CHUNK * 2)
    session.emit(big)
    // 3·WRITE_CHUNK + 1 units; the first piece stops short of the pair, so four pieces.
    expect(sizes.length).toBe(4)
    expect(sizes[0]).toBe(WRITE_CHUNK - 1)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(WRITE_CHUNK)
    expect(engine.written).toBe(big)
  })

  it('reattaching replaces and frees the previous engine', () => {
    const { host } = setup()
    host.attach('s1', 80, 24)
    const second = host.attach('s1', 80, 24)
    expect(second).toMatchObject({ ok: true, attachId: 2 })
    expect(FakeEngine.instances[0]!.disposed).toBe(true)
    expect(FakeEngine.instances[1]!.disposed).toBe(false)
    expect(host.size).toBe(1)
  })

  it('frees the engine on detach and tolerates repeated detach', () => {
    const { host } = setup()
    host.attach('s1', 80, 24)
    host.detach('s1')
    host.detach('s1')
    expect(FakeEngine.instances[0]!.disposed).toBe(true)
    expect(host.size).toBe(0)
  })

  it('does not leak engines across repeated mount and unmount', () => {
    const { host } = setup()
    for (let index = 0; index < 200; index++) {
      host.attach('s1', 80, 24)
      host.detach('s1')
    }
    expect(host.size).toBe(0)
    expect(FakeEngine.instances.every((engine) => engine.disposed)).toBe(true)
  })

  it('refuses to attach when the engine is unavailable', () => {
    const { host } = setup({
      status: () => ({ available: false, reason: 'missing-package', detail: 'not bundled' }),
      factory: () => undefined
    })
    expect(host.attach('s1', 80, 24)).toEqual({
      ok: false,
      reason: 'missing-package',
      detail: 'not bundled'
    })
  })

  it('reports an engine that fails while being seeded as an initialisation failure', () => {
    const { session, host } = setup({
      factory: () => ({
        info,
        create: (options) => {
          const engine = new FakeEngine(options)
          engine.failOn = 'snapshot'
          return engine
        }
      })
    })
    session.emit('hello')
    expect(host.attach('s1', 80, 24)).toMatchObject({ ok: false, reason: 'init-failed' })
    expect(FakeEngine.instances[0]!.disposed).toBe(true)
    expect(host.size).toBe(0)
  })

  it('drops an engine that throws at runtime and tells the renderer to fall back', () => {
    const { session, host, failures } = setup()
    host.attach('s1', 80, 24)
    FakeEngine.instances[0]!.failOn = 'write'
    session.emit('boom')
    expect(failures).toEqual([
      { id: 's1', reason: 'runtime-error', detail: 'styr-terminal: write failed' }
    ])
    expect(host.has('s1')).toBe(false)
    expect(FakeEngine.instances[0]!.disposed).toBe(true)
    // Later output for the session is ignored rather than throwing again.
    session.emit('after')
    expect(failures).toHaveLength(1)
  })

  it('treats a failed resize, scroll or frame read as a runtime failure', () => {
    for (const method of ['resize', 'scroll', 'takeFrame'] as const) {
      const { host, failures, flush } = setup()
      host.attach('s1', 80, 24)
      FakeEngine.instances.at(-1)!.failOn = method
      if (method === 'resize') host.resize('s1', 100, 30)
      else if (method === 'scroll') host.scroll('s1', 5)
      else {
        host.resize('s1', 100, 30)
        flush()
      }
      expect(failures.map((failure) => failure.reason)).toEqual(['runtime-error'])
    }
  })

  it('returns text from the engine, and nothing once it is gone', () => {
    const { session, host } = setup()
    session.emit('one\r\ntwo')
    host.attach('s1', 80, 24)
    expect(host.text('s1')).toBe('one\ntwo')
    expect(host.lines('s1', 1, 2)).toBe('two')
    host.detach('s1')
    expect(host.text('s1')).toBe('')
  })
})

/**
 * The fallback promise: when the native engine fails mid-stream, xterm.js takes over the same live
 * session and ends up with every byte, once, in order. xterm.js gets there the way it does on any
 * mount — the backlog, then live chunks newer than the backlog's sequence — so this drives the real
 * `TerminalOutputSynchronizer` with the output a PTY produced before, during and after the handoff.
 */
describe('handoff to xterm.js', () => {
  it('loses and reorders nothing when the engine fails mid-stream', () => {
    const { session, host, failures } = setup()
    const expected: string[] = []
    const say = (data: string): TerminalOutput => {
      expected.push(data)
      return session.emit(data)
    }
    say('before attach\r\n')
    host.attach('s1', 80, 24)
    say('é') // multi-byte
    say('😀 split ')
    FakeEngine.instances[0]!.failOn = 'write'
    say('the chunk that kills the engine\r\n')
    expect(failures).toHaveLength(1)

    // The renderer now mounts xterm.js: it subscribes to live data, then asks for the backlog.
    let shown = ''
    const xterm = new TerminalOutputSynchronizer({
      write: (data) => (shown += data),
      mark: () => {}
    })
    // Output that arrives while the backlog request is in flight is held, not dropped.
    const inFlight = [say('in flight 1\r\n'), say('in flight 2\r\n')]
    const backlog = session.snapshot()
    const afterSnapshot = say('after snapshot\r\n')
    for (const output of inFlight) xterm.writeLive(output)
    xterm.writeLive(afterSnapshot)
    xterm.writeBacklog(backlog)
    xterm.writeLive(say('live\r\n'))

    expect(shown).toBe(expected.join(''))
    // The shell session itself was never touched.
    expect(session.sequence).toBe(expected.length)
  })
})

describe('NativeTerminalHost command blocks', () => {
  const at = 1_000
  const start = (offset: number, id = 'c1', command = 'ls'): TerminalMark => ({
    offset,
    kind: 'start',
    id,
    command,
    at
  })
  const end = (offset: number, id = 'c1', exitCode = 0): TerminalMark => ({
    offset,
    kind: 'end',
    id,
    exitCode,
    at: at + 250
  })
  const output = (data: string, marks: TerminalMark[], sequence = 1): TerminalOutput => ({
    data,
    sequence,
    marks
  })

  it('marks the command row and closes the block where its output ended', () => {
    const { host, frames, flush } = setup()
    host.attach('s1', 80, 24)
    host.write('s1', output('$ ls\r\na\r\nb\r\n$ ', [start(6), end(12)]))
    flush()
    expect(FakeEngine.instances[0]!.written).toBe('$ ls\r\na\r\nb\r\n$ ')
    expect(frames.at(-1)!.blocks).toEqual([
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
  })

  it('lets a running command follow the cursor, and sends blocks only when they change', () => {
    const { host, frames, flush } = setup()
    host.attach('s1', 80, 24)
    host.write('s1', output('$ build\r\n', [start(9, 'c1', 'build')]))
    flush()
    expect(frames.at(-1)!.blocks).toMatchObject([{ startLine: 0, endLine: 1, open: true }])
    host.write('s1', output('step 1\r\nstep 2', [], 2))
    flush()
    expect(frames.at(-1)!.blocks).toMatchObject([{ startLine: 0, endLine: 3, open: true }])
    host.resize('s1', 100, 30)
    flush()
    expect(frames.at(-1)!.frame).toBeDefined()
    expect(frames.at(-1)!.blocks).toBeUndefined()
  })

  it('rebuilds blocks from the backlog marks on attach', () => {
    const backlog = output('$ ls\r\na\r\n', [start(6), end(9)])
    const { host } = setup({ backlog: () => backlog })
    const result = host.attach('s1', 80, 24)
    expect(result.ok && result.blocks).toMatchObject([{ id: 'c1', startLine: 0, endLine: 2 }])
  })

  it('forgets a command once its line has left the buffer', () => {
    const { host, frames, flush } = setup()
    host.attach('s1', 80, 24)
    host.write('s1', output('$ ls\r\na\r\n', [start(6), end(9)]))
    flush()
    FakeEngine.instances[0]!.marks.delete('c1')
    host.write('s1', output('more\r\n', [], 2))
    flush()
    expect(frames.at(-1)!.blocks).toEqual([])
  })

  it('ignores an end without a start and a start the engine could not mark', () => {
    const { host, frames, flush } = setup()
    host.attach('s1', 80, 24)
    // At the very first row there is no row above the cursor to mark.
    host.write('s1', output('x', [start(0, 'c0'), end(1, 'c9')]))
    flush()
    expect(frames.at(-1)!.blocks).toBeUndefined()
    expect(FakeEngine.instances[0]!.written).toBe('x')
  })

  it('writes everything but draws no blocks with an engine that cannot mark lines', () => {
    const factory: NativeEngineFactory = {
      info,
      create: (options) =>
        Object.assign(new FakeEngine(options), {
          markLine: undefined,
          markedLines: undefined,
          cursorPosition: undefined
        })
    }
    const { host, frames, flush } = setup({ factory: () => factory })
    const result = host.attach('s1', 80, 24)
    host.write('s1', output('$ ls\r\na\r\n', [start(6), end(9)]))
    flush()
    expect(result.ok && result.blocks).toEqual([])
    expect(FakeEngine.instances[0]!.written).toBe('$ ls\r\na\r\n')
    expect(frames.every((event) => event.blocks === undefined)).toBe(true)
  })

  it('falls back when reading the marks throws', () => {
    const { host, failures, flush } = setup()
    host.attach('s1', 80, 24)
    FakeEngine.instances[0]!.failOn = 'markedLines'
    host.write('s1', output('$ ls\r\na\r\n', [start(6), end(9)]))
    flush()
    expect(failures).toMatchObject([{ id: 's1', reason: 'runtime-error' }])
    expect(host.has('s1')).toBe(false)
  })
})
