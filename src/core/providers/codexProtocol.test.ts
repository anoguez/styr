import { describe, expect, it } from 'vitest'
import {
  FrameDecoder,
  ThreadBindings,
  encodeTextFrame,
  eventForStatus,
  isSupportedCodexVersion,
  parseCodexVersion,
  startedThread
} from './codexProtocol.js'
import { EVENT_STATE } from '../agentState.js'

const status = (threadId: string, value: unknown) => ({ threadId, status: value })
const started = (id: string, cwd: string, extra: object = {}) => ({
  thread: { id, environments: [{ environmentId: 'local', cwd }], ephemeral: false, ...extra }
})

describe('Codex version policy', () => {
  it('parses CLI output and enforces 0.159.3 as the floor', () => {
    expect(parseCodexVersion('codex-cli 0.159.3')).toEqual([0, 159, 3])
    expect(parseCodexVersion('no version')).toBeUndefined()
    expect(isSupportedCodexVersion([0, 159, 3])).toBe(true)
    expect(isSupportedCodexVersion([0, 160, 0])).toBe(true)
    expect(isSupportedCodexVersion([1, 0, 0])).toBe(true)
    expect(isSupportedCodexVersion([0, 159, 2])).toBe(false)
    expect(isSupportedCodexVersion([0, 158, 9])).toBe(false)
  })
})

describe('live-state transitions', () => {
  const stateOf = (value: unknown) => {
    const change = eventForStatus(status('t', value))
    return change ? EVENT_STATE[change.event] : undefined
  }

  it('maps thread status to Styr states', () => {
    expect(stateOf({ type: 'active', activeFlags: [] })).toBe('working')
    expect(stateOf({ type: 'active', activeFlags: ['waitingOnApproval'] })).toBe('waiting')
    expect(stateOf({ type: 'active', activeFlags: ['waitingOnUserInput'] })).toBe('waiting')
    expect(stateOf({ type: 'idle' })).toBe('idle')
  })

  it('ignores statuses that say nothing about the agent', () => {
    expect(stateOf({ type: 'notLoaded' })).toBeUndefined()
    expect(stateOf({ type: 'systemError' })).toBeUndefined()
    expect(eventForStatus({ status: { type: 'idle' } })).toBeUndefined()
  })

  it('treats a started thread as Ready and skips ephemeral ones', () => {
    expect(EVENT_STATE.SessionStart).toBe('ready')
    expect(startedThread(started('a', '/w'))).toEqual({ threadId: 'a', cwd: '/w' })
    expect(startedThread(started('b', '/w', { ephemeral: true }))).toBeUndefined()
  })
})

describe('ThreadBindings', () => {
  it('claims a fresh thread for the launch waiting in that directory and follows it through a turn', () => {
    const bindings = new ThreadBindings()
    bindings.expect('TASK-1', '/w/one')
    bindings.expect('TASK-2', '/w/two')

    expect(bindings.onStarted(started('thread-2', '/w/two'))).toEqual({
      taskId: 'TASK-2',
      event: 'SessionStart',
      boundSessionId: 'thread-2'
    })
    expect(bindings.onStatus(status('thread-2', { type: 'active', activeFlags: [] }))).toEqual({
      taskId: 'TASK-2',
      event: 'UserPromptSubmit'
    })
    expect(
      bindings.onStatus(status('thread-2', { type: 'active', activeFlags: ['waitingOnApproval'] }))
    ).toEqual({ taskId: 'TASK-2', event: 'Notification' })
    expect(bindings.onStatus(status('thread-2', { type: 'idle' }))).toEqual({
      taskId: 'TASK-2',
      event: 'Stop'
    })
  })

  it('ignores threads nobody launched, including a second thread in a claimed directory', () => {
    const bindings = new ThreadBindings()
    bindings.expect('TASK-1', '/w')
    bindings.onStarted(started('mine', '/w'))

    expect(bindings.onStarted(started('stranger', '/w'))).toBeUndefined()
    expect(bindings.onStatus(status('stranger', { type: 'idle' }))).toBeUndefined()
  })

  it('binds a resumed session by id and stops reporting once released', () => {
    const bindings = new ThreadBindings()
    bindings.bind('TASK-1', 'known')
    expect(bindings.onStatus(status('known', { type: 'idle' }))).toMatchObject({ taskId: 'TASK-1' })
    expect(bindings.onStarted(started('known', '/w'))).toEqual({
      taskId: 'TASK-1',
      event: 'SessionStart'
    })

    bindings.release('TASK-1')
    expect(bindings.onStatus(status('known', { type: 'idle' }))).toBeUndefined()
    expect(bindings.size).toBe(0)
  })
})

describe('WebSocket framing', () => {
  const mask = Uint8Array.from([1, 2, 3, 4])

  it('round-trips short and long text frames, split across chunks', () => {
    const decoder = new FrameDecoder()
    for (const text of ['hi', 'x'.repeat(200), 'y'.repeat(70_000)]) {
      const frame = encodeTextFrame(text, mask)
      const middle = Math.floor(frame.length / 2)
      expect(decoder.push(frame.subarray(0, middle))).toEqual([])
      const [message] = decoder.push(frame.subarray(middle))
      expect(message?.opcode).toBe(1)
      expect(message?.payload.toString()).toBe(text)
    }
  })

  it('reads unmasked server frames and joins fragments', () => {
    const decoder = new FrameDecoder()
    const first = Buffer.from([0x01, 0x02, 0x68, 0x65]) // text, not final: "he"
    const rest = Buffer.from([0x80, 0x03, 0x6c, 0x6c, 0x6f]) // continuation, final: "llo"
    expect(decoder.push(first)).toEqual([])
    const [message] = decoder.push(rest)
    expect(message?.opcode).toBe(1)
    expect(message?.payload.toString()).toBe('hello')
  })
})
