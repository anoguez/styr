import { describe, expect, it, vi } from 'vitest'
import { sessionDispatcher } from './terminalEvents.js'

type Payload = { id: string; data: string }

function bridge() {
  let listener: ((payload: Payload) => void) | undefined
  const subscribe = vi.fn((handler: (payload: Payload) => void) => {
    listener = handler
    return () => {
      listener = undefined
    }
  })
  return { subscribe, send: (payload: Payload) => listener?.(payload), open: () => !!listener }
}

describe('sessionDispatcher', () => {
  it('hands a chunk to its own session only, over one bridge subscription', () => {
    const b = bridge()
    const on = sessionDispatcher<Payload>(b.subscribe)
    const handlers = Array.from({ length: 10 }, (_, n) => {
      const handler = vi.fn()
      on(`s${n}`, handler)
      return handler
    })
    b.send({ id: 's3', data: 'x' })
    expect(b.subscribe).toHaveBeenCalledOnce()
    expect(handlers[3]).toHaveBeenCalledWith({ id: 's3', data: 'x' })
    expect(handlers.filter((handler) => handler.mock.calls.length > 0)).toHaveLength(1)
  })

  it('stops delivering after unregistering, and drops the subscription with the last view', () => {
    const b = bridge()
    const on = sessionDispatcher<Payload>(b.subscribe)
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = on('s1', first)
    const offSecond = on('s1', second)
    offFirst()
    b.send({ id: 's1', data: 'x' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    offSecond()
    expect(b.open()).toBe(false)
    on('s2', vi.fn())
    expect(b.subscribe).toHaveBeenCalledTimes(2)
  })
})
