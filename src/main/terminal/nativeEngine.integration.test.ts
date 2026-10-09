import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { NativeEngineFailure, NativeFrameEvent, TerminalOutput } from '@core/types.js'
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
    expect(frames.at(-1)!.frame.altScreen).toBe(false)

    host.resize('s', 20, 3)
    while (deferred.length) deferred.shift()!()
    expect(frames.at(-1)!.frame).toMatchObject({ cols: 20, rows: 3 })

    host.detach('s')
    expect(host.has('s')).toBe(false)
    expect(failures).toEqual([])
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
