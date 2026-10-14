import { beforeEach, describe, expect, it } from 'vitest'
import type { TerminalOutput, TerminalRuntimeState } from '@core/types.js'
import {
  createTerminalsService,
  terminalBroadcasts,
  type PtyProcess,
  type PtySpawnOptions,
  type TerminalsService
} from './terminalsService.js'

interface FakePty extends PtyProcess {
  options: PtySpawnOptions
  written: string[]
  resized: [number, number][]
  killed: boolean
  emitData(data: string): void
  emitExit(exitCode: number): void
}

interface Harness {
  service: TerminalsService
  ptys: FakePty[]
  data: [string, TerminalOutput][]
  exits: [string, number][]
  states: TerminalRuntimeState[]
}

function fakePty(options: PtySpawnOptions): FakePty {
  let onData: (data: string) => void = () => {}
  let onExit: (event: { exitCode: number }) => void = () => {}
  const pty: FakePty = {
    options,
    written: [],
    resized: [],
    killed: false,
    onData: (listener) => (onData = listener),
    onExit: (listener) => (onExit = listener),
    write: (data) => pty.written.push(data),
    resize: (cols, rows) => pty.resized.push([cols, rows]),
    kill: () => (pty.killed = true),
    emitData: (data) => onData(data),
    emitExit: (exitCode) => onExit({ exitCode })
  }
  return pty
}

function harness(): Harness {
  const ptys: FakePty[] = []
  const service = createTerminalsService({
    spawn: (_file, _args, options) => {
      const pty = fakePty(options)
      ptys.push(pty)
      return pty
    },
    usageEnv: (_existing, terminalId) => ({ STYR_CONTEXT_FILE: `/usage/${terminalId}.json` })
  })
  const h: Harness = { service, ptys, data: [], exits: [], states: [] }
  service.onTerminalData((id, output) => h.data.push([id, output]))
  service.onTerminalExit((id, exitCode) => h.exits.push([id, exitCode]))
  service.onTerminalRuntimeState((state) => h.states.push(state))
  return h
}

/** One of Styr's shell-integration records (`terminalProtocol.ts`). */
const event = (name: string, ...fields: string[]): string =>
  `\x1b]777;STYR;${name};${fields.map((value) => Buffer.from(value).toString('base64')).join(';')}\x1b\\`

let h: Harness
const last = (): FakePty => h.ptys[h.ptys.length - 1]!

beforeEach(() => {
  h = harness()
})

describe('terminals service', () => {
  it('creates a session through the spawn port, with the usage environment and first command', () => {
    const info = h.service.createSession({
      cwd: '/no/such/folder',
      title: 'Agent',
      taskId: 'TASK-0001',
      workspaceId: 'w1',
      provider: 'codex',
      command: 'codex',
      env: { STYR_TASK_ID: 'TASK-0001', COLORTERM: 'none' }
    })

    expect(info).toMatchObject({
      title: 'Agent',
      taskId: 'TASK-0001',
      workspaceId: 'w1',
      provider: 'codex'
    })
    expect(info.replay).toBeUndefined()
    expect(info.cwd).not.toBe('/no/such/folder')
    expect(last().options).toMatchObject({ name: 'xterm-256color', cols: 100, rows: 30 })
    expect(last().options.env).toMatchObject({
      STYR_TASK_ID: 'TASK-0001',
      STYR_CONTEXT_FILE: `/usage/${info.id}.json`,
      COLORTERM: 'truecolor'
    })
    expect(last().written).toEqual(['codex\r'])
    expect(h.service.listSessions()).toEqual([info])
  })

  it('on exit tells the listeners, drops the session and keeps its task and final state', () => {
    const info = h.service.createSession({ taskId: 'TASK-0002', workspaceId: 'w2' })
    last().emitExit(1)

    expect(h.exits).toEqual([[info.id, 1]])
    expect(h.states).toEqual([expect.objectContaining({ sessionId: info.id, terminated: true })])
    expect(h.service.listSessions()).toEqual([])
    expect(h.service.findSessionByTask('TASK-0002', 'w2')).toBeUndefined()
    expect(h.service.sessionTask(info.id)).toEqual({ taskId: 'TASK-0002', workspaceId: 'w2' })
    expect(h.service.terminalRuntimeState(info.id)).toMatchObject({ lastExitCode: 1 })
    // Writes to a gone session go nowhere.
    h.service.writeToSession(info.id, 'x')
    expect(last().written).toEqual([])
  })

  it('a killed session leaves no exit record behind', () => {
    const info = h.service.createSession({ taskId: 'TASK-0003', workspaceId: 'w1' })
    h.service.killSession(info.id)
    expect(last().killed).toBe(true)
    expect(h.service.listSessions()).toEqual([])
    expect(h.service.sessionTask(info.id)).toBeUndefined()
  })

  it('findSessionByTask matches the workspace as well as the task id', () => {
    const first = h.service.createSession({ taskId: 'TASK-0001', workspaceId: 'w1' })
    const second = h.service.createSession({ taskId: 'TASK-0001', workspaceId: 'w2' })

    expect(h.service.findSessionByTask('TASK-0001', 'w1')?.id).toBe(first.id)
    expect(h.service.findSessionByTask('TASK-0001', 'w2')?.id).toBe(second.id)
    expect(h.service.findSessionByTask('TASK-0001', 'w3')).toBeUndefined()
    expect(h.service.findSessionByTask('TASK-0001')).toBeUndefined()

    // The other workspace's session outlives this one's exit.
    h.ptys[0]!.emitExit(0)
    expect(h.service.findSessionByTask('TASK-0001', 'w1')).toBeUndefined()
    expect(h.service.findSessionByTask('TASK-0001', 'w2')?.id).toBe(second.id)
  })

  it('replays the backlog with its command marks, as a reloaded renderer asks for it', () => {
    const info = h.service.createSession({ cwd: '/' })
    last().emitData('$ ')
    last().emitData(`${event('COMMAND_STARTED', '/', 'ls')}a b\n`)
    last().emitData(`${event('COMMAND_FINISHED', '0')}$ `)

    expect(h.data.map(([, output]) => output.data)).toEqual(['$ ', 'a b\n', '$ '])
    const backlog = h.service.sessionBacklog(info.id)
    expect(backlog).toMatchObject({ data: '$ a b\n$ ', sequence: 3 })
    expect(backlog.marks.map((mark) => [mark.kind, mark.offset])).toEqual([
      ['start', 2],
      ['end', 6]
    ])
    expect(h.service.terminalRuntimeState(info.id)?.lastCommand).toMatchObject({
      command: 'ls',
      exitCode: 0,
      output: 'a b\n'
    })
    expect(h.service.sessionBacklog('missing')).toEqual({ data: '', sequence: 0, marks: [] })
  })

  it('services are independent of each other', () => {
    h.service.createSession({})
    expect(harness().service.listSessions()).toEqual([])
  })
})

describe('terminalBroadcasts', () => {
  it('sends data, runtime state and exit on their channels', () => {
    const sent: [string, unknown][] = []
    const events = terminalBroadcasts((channel, payload) => sent.push([channel, payload]))
    const state = { sessionId: 's1', cwd: '/', promptReady: true }

    events.data('s1', { data: 'x', sequence: 1, marks: [] })
    events.runtimeState(state)
    events.exit('s1', 2)

    expect(sent).toEqual([
      ['terminal:data', { id: 's1', data: 'x', sequence: 1, marks: [] }],
      ['terminal:runtimeState', state],
      ['terminal:exit', { id: 's1', exitCode: 2 }]
    ])
  })
})
