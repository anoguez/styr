import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type {
  NativeBlockEvent,
  NativeEngineFailure,
  NativeFrameEvent,
  TerminalOutput
} from '@core/types.js'
import { loadNativeEngine } from './nativeEngine.js'
import { NativeTerminalHost } from './nativeHost.js'

/**
 * Runs Styr's loader and host against a real build of the private package. Skipped unless
 * STYR_TERMINAL_PATH names its package directory, so public CI and forks never need it; a trusted
 * job (or a developer with the package) runs it with the variable set.
 */
const packagePath = process.env.STYR_TERMINAL_PATH
const enabled = Boolean(packagePath && existsSync(packagePath))

describe.skipIf(!enabled)('Styr Terminal package (real build)', () => {
  const load = () =>
    loadNativeEngine({
      platform: process.platform,
      arch: process.arch,
      isPackaged: false,
      appPath: process.cwd(),
      devPath: packagePath,
      exists: existsSync,
      load: (specifier) => createRequire(import.meta.url)(specifier)
    })

  it('loads, passes the compatibility check and the probe', () => {
    const { status } = load()
    expect(status).toMatchObject({ available: true, info: { apiVersion: 1 } })
  })

  it('renders shell output through the host, answers queries and falls back on failure', () => {
    const { factory, status } = load()
    let backlog = 'prompt$ \x1b[31mred\x1b[0m done\r\n'
    let sequence = 1
    const frames: NativeFrameEvent[] = []
    const failures: NativeEngineFailure[] = []
    const replies: string[] = []
    const deferred: (() => void)[] = []
    const host = new NativeTerminalHost({
      factory: () => factory,
      status: () => status,
      backlog: () => ({ data: backlog, sequence, marks: [] }),
      writeToPty: (_id, data) => replies.push(data),
      sendFrame: (event) => frames.push(event),
      sendBlocks: () => {},
      sendFailure: (failure) => failures.push(failure),
      defer: (task) => deferred.push(task)
    })
    const emit = (data: string): void => {
      backlog += data
      sequence += 1
      const output: TerminalOutput = { data, sequence, marks: [] }
      host.write('s', output)
      while (deferred.length) deferred.shift()!()
    }

    const attached = host.attach('s', 40, 5)
    if (!attached.ok) throw new Error(attached.detail)
    const red = attached.frame.lines[0]!.runs.find((run) => run.text === 'red')
    expect(red?.fg).toBe(1)

    emit('café ✓ 😀\r\n')
    emit('\x1b[6n')
    const reply = replies.join('')
    expect(reply.startsWith('\x1b[')).toBe(true)
    expect(reply.slice(2)).toMatch(/^\d+;\d+R$/)
    expect(host.text('s')).toContain('café ✓ 😀')

    emit('\x1b[?1049h\x1b[2J\x1b[Hfull screen')
    expect(frames.at(-1)!.frame).toMatchObject({ altScreen: true, full: true })
    emit('\x1b[?1049l')
    expect(frames.at(-1)!.frame?.altScreen).toBe(false)

    host.resize('s', 20, 3)
    while (deferred.length) deferred.shift()!()
    expect(frames.at(-1)!.frame).toMatchObject({ cols: 20, rows: 3 })

    host.detach('s')
    expect(host.has('s')).toBe(false)
    expect(failures).toEqual([])
  })

  it('turns command marks into blocks that follow their lines', () => {
    const { factory, status } = load()
    const sent: NativeFrameEvent[] = []
    const deferred: (() => void)[] = []
    const host = new NativeTerminalHost({
      factory: () => factory,
      status: () => status,
      backlog: () => ({ data: '', sequence: 0, marks: [] }),
      writeToPty: () => {},
      sendFrame: (event) => sent.push(event),
      sendBlocks: () => {},
      sendFailure: () => {},
      defer: (task) => deferred.push(task)
    })
    const attached = host.attach('s', 20, 4)
    if (!attached.ok) throw new Error(attached.detail)
    const at = Date.now()
    const start = { offset: 6, kind: 'start' as const, id: 'c1', command: 'ls', at }
    const end = { offset: 9, kind: 'end' as const, id: 'c1', exitCode: 0, at: at + 5 }
    host.write('s', { data: '$ ls\r\na\r\n', sequence: 1, marks: [start, end] })
    host.write('s', { data: 'x\r\n'.repeat(6), sequence: 2, marks: [] })
    while (deferred.length) deferred.shift()!()
    const blocks = sent.findLast((event) => event.blocks)?.blocks
    expect(blocks).toEqual([
      expect.objectContaining({ id: 'c1', command: 'ls', startLine: 0, endLine: 2, open: false })
    ])
    expect(host.lines('s', 0, 2)).toBe('$ ls\na')
    host.detach('s')
  })

  it('splits a zsh-like session into a block list with styled, wrapped rows', () => {
    const { factory, status } = load()
    const lists: NativeBlockEvent[] = []
    const deferred: (() => void)[] = []
    const host = new NativeTerminalHost({
      factory: () => factory,
      status: () => status,
      backlog: () => ({ data: '', sequence: 0, marks: [] }),
      writeToPty: () => {},
      sendFrame: () => {},
      sendBlocks: (event) => lists.push(event),
      sendFailure: () => {},
      defer: (task) => deferred.push(task)
    })
    host.attach('s', 10, 4)
    const prompt = '\x1b[32m➜\x1b[0m repo ls\r\n'
    const output = 'abcdefghijKLM\r\n'
    const at = Date.now()
    host.write('s', {
      data: prompt + output,
      sequence: 1,
      marks: [
        { offset: 0, kind: 'prompt', id: 'p1', at },
        { offset: prompt.length, kind: 'start', id: 'c1', command: 'ls', at },
        { offset: prompt.length + output.length, kind: 'end', id: 'c1', exitCode: 0, at }
      ]
    })
    while (deferred.length) deferred.shift()!()
    const finished = lists
      .flatMap((event) => event.events)
      .find((event) => event.kind === 'finished')
    if (finished?.kind !== 'finished') throw new Error('no finished block')
    expect(finished.block.prompt[0]!.runs[0]).toMatchObject({ text: '➜', fg: 2 })
    expect(finished.block.output.map((row) => row.wrapped)).toEqual([true, false])
    expect(finished.block.output.map((row) => row.runs.map((run) => run.text).join(''))).toEqual([
      'abcdefghij',
      'KLM'
    ])
    host.detach('s')
  })

  it('survives adversarial input without throwing', () => {
    const { factory } = load()
    const engine = factory!.create({ cols: 80, rows: 24, scrollback: 100 })
    try {
      engine.write('\x1b[' + '9;'.repeat(100_000) + 'm')
      engine.write('\x1b]0;' + 'x'.repeat(900_000))
      engine.write('\x07\x1b[?1049h\x1b[999;999H\x1b[1000S')
      expect(engine.snapshot().rows).toBe(24)
    } finally {
      engine.dispose()
    }
  })
})
