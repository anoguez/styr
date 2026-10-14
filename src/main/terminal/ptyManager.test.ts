import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalOutput, TerminalRuntimeState } from '@core/types.js'

/**
 * Pins `ptyManager` as main binds it: node-pty and the usage mod are faked, everything between
 * them (shell resolution, transcript, listeners, the session table) is real.
 */

interface FakePty {
  file: string
  options: { cwd: string; env: Record<string, string> }
  written: string[]
  resized: [number, number][]
  killed: boolean
  emitData(data: string): void
  emitExit(exitCode: number): void
}

const ptys: FakePty[] = []

vi.mock('node-pty', () => ({
  spawn: (file: string, _args: string[], options: FakePty['options']) => {
    let onData: (data: string) => void = () => {}
    let onExit: (event: { exitCode: number }) => void = () => {}
    const pty: FakePty = {
      file,
      options,
      written: [],
      resized: [],
      killed: false,
      emitData: (data) => onData(data),
      emitExit: (exitCode) => onExit({ exitCode })
    }
    ptys.push(pty)
    return {
      onData: (listener: typeof onData) => (onData = listener),
      onExit: (listener: typeof onExit) => (onExit = listener),
      write: (data: string) => pty.written.push(data),
      resize: (cols: number, rows: number) => pty.resized.push([cols, rows]),
      kill: () => (pty.killed = true)
    }
  }
}))
vi.mock('../usage.js', () => ({
  usageEnv: (_existing: string | undefined, terminalId: string) => ({
    STYR_CONTEXT_FILE: `/usage/${terminalId}.json`
  })
}))

const pty = await import('./ptyManager.js')

const data: [string, TerminalOutput][] = []
const exits: [string, number][] = []
const states: TerminalRuntimeState[] = []
pty.onTerminalData((id, output) => data.push([id, output]))
pty.onTerminalExit((id, exitCode) => exits.push([id, exitCode]))
pty.onTerminalRuntimeState((state) => states.push(state))

const last = (): FakePty => ptys[ptys.length - 1]!
/** One of Styr's shell-integration records (`terminalProtocol.ts`). */
const event = (name: string, ...fields: string[]): string =>
  `\x1b]777;STYR;${name};${fields.map((value) => Buffer.from(value).toString('base64')).join(';')}\x1b\\`

beforeEach(() => {
  pty.killAllSessions()
  ptys.length = 0
  data.length = 0
  exits.length = 0
  states.length = 0
})

describe('ptyManager', () => {
  it('creates a session with its metadata, environment and first command', () => {
    const info = pty.createSession({
      cwd: '/no/such/folder',
      title: 'Agent',
      taskId: 'TASK-0001',
      workspaceId: 'w1',
      provider: 'claude',
      replay: true,
      command: 'claude',
      env: { STYR_TASK_ID: 'TASK-0001', TERM: 'dumb' }
    })

    expect(info).toMatchObject({
      title: 'Agent',
      taskId: 'TASK-0001',
      workspaceId: 'w1',
      provider: 'claude',
      replay: true
    })
    expect(info.id).toHaveLength(10)
    // A missing folder falls back to the home folder rather than failing to spawn.
    expect(info.cwd).not.toBe('/no/such/folder')
    expect(last().options.cwd).toBe(info.cwd)
    expect(last().options.env).toMatchObject({
      STYR_TASK_ID: 'TASK-0001',
      STYR_CONTEXT_FILE: `/usage/${info.id}.json`,
      // Applied last, so a caller cannot turn off colour.
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    })
    expect(last().written).toEqual(['claude\r'])
    expect(pty.listSessions()).toEqual([info])
  })

  it('leaves out the optional fields a plain terminal does not have', () => {
    const info = pty.createSession({})
    expect(info.title).toBe('Terminal')
    expect(Object.keys(info).sort()).toEqual(['cwd', 'dialect', 'id', 'title'])
    expect(last().written).toEqual([])
  })

  it('writes, resizes (at least 1×1) and kills by id, and ignores unknown ids', () => {
    const info = pty.createSession({})
    pty.writeToSession(info.id, 'ls\r')
    pty.resizeSession(info.id, 0, 40)
    pty.writeToSession('missing', 'x')
    pty.resizeSession('missing', 10, 10)
    pty.killSession('missing')
    expect(last().written).toEqual(['ls\r'])
    expect(last().resized).toEqual([[1, 40]])

    pty.killSession(info.id)
    expect(last().killed).toBe(true)
    expect(pty.listSessions()).toEqual([])
  })

  it('streams output to the listeners and replays it as the backlog', () => {
    const info = pty.createSession({})
    last().emitData('hello ')
    last().emitData('world')

    expect(data.map(([id, output]) => [id, output.data, output.sequence])).toEqual([
      [info.id, 'hello ', 1],
      [info.id, 'world', 2]
    ])
    expect(pty.sessionBacklog(info.id)).toEqual({ data: 'hello world', sequence: 2, marks: [] })
    expect(pty.sessionBacklog('missing')).toEqual({ data: '', sequence: 0, marks: [] })
  })

  it('replays command marks with the backlog and reports runtime state', () => {
    const info = pty.createSession({ cwd: '/' })
    last().emitData(
      `$ ${event('COMMAND_STARTED', '/', 'ls')}files\n${event('COMMAND_FINISHED', '0')}`
    )

    const backlog = pty.sessionBacklog(info.id)
    expect(backlog.data).toBe('$ files\n')
    expect(backlog.marks.map((mark) => [mark.kind, mark.offset])).toEqual([
      ['start', 2],
      ['end', 8]
    ])
    expect(states.map((state) => Boolean(state.runningCommand))).toEqual([true, false])
    expect(pty.terminalRuntimeState(info.id)?.lastCommand).toMatchObject({
      command: 'ls',
      exitCode: 0
    })
  })

  it('on exit drops the session but keeps its task and final state', () => {
    const info = pty.createSession({ taskId: 'TASK-0002', workspaceId: 'w1' })
    last().emitExit(3)

    expect(exits).toEqual([[info.id, 3]])
    expect(states.at(-1)).toMatchObject({ sessionId: info.id, terminated: true, lastExitCode: 3 })
    expect(pty.listSessions()).toEqual([])
    expect(pty.findSessionByTask('TASK-0002', 'w1')).toBeUndefined()
    expect(pty.sessionTask(info.id)).toEqual({ taskId: 'TASK-0002', workspaceId: 'w1' })
    expect(pty.terminalRuntimeState(info.id)).toMatchObject({ terminated: true })
  })

  it('finds a task session only in its own workspace', () => {
    const first = pty.createSession({ taskId: 'TASK-0001', workspaceId: 'w1' })
    const second = pty.createSession({ taskId: 'TASK-0001', workspaceId: 'w2' })
    pty.createSession({})

    expect(pty.findSessionByTask('TASK-0001', 'w1')).toEqual(first)
    expect(pty.findSessionByTask('TASK-0001', 'w2')).toEqual(second)
    expect(pty.findSessionByTask('TASK-0001', 'w3')).toBeUndefined()
    expect(pty.findSessionByTask('TASK-0001')).toBeUndefined()
    expect(pty.sessionTask(second.id)).toEqual({ taskId: 'TASK-0001', workspaceId: 'w2' })
  })

  it('kills every live session', () => {
    pty.createSession({})
    pty.createSession({})
    pty.killAllSessions()
    expect(ptys.every((each) => each.killed)).toBe(true)
    expect(pty.listSessions()).toEqual([])
  })
})
