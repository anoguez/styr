import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../rpc/jsonRpc.js'
import { HELLO, fakeClock, fakeServer, settle } from './remoteFixture.js'
import { openServerSession } from './session.js'

function open(handlers = {}) {
  const server = fakeServer(handlers)
  const clock = fakeClock()
  const session = openServerSession('devbox', { spawn: server.spawn, ...clock.ports })
  return { server, clock, session }
}

describe('openServerSession', () => {
  it('waits for the hello, sends requests, and ends the child on close', async () => {
    const { server, session } = open({
      'workspaces:create': ([name]: unknown[]) => ({ activeId: name })
    })
    server.hello()
    const opened = await session
    expect(opened.hello.version).toBe(HELLO.version)
    expect(await opened.request('workspaces:create', ['devbox'])).toEqual({ activeId: 'devbox' })
    opened.close()
    expect(server.children[0]!.killed).toBe(true)
  })

  it('refuses a server on another protocol, sending it nothing', async () => {
    const { server, session } = open()
    server.hello({ ...HELLO, protocol: PROTOCOL_VERSION + 1 })
    await expect(session).rejects.toThrow(/server protocol .* is not this app's/)
    expect(server.calls).toEqual([])
    expect(server.children[0]!.killed).toBe(true)
  })

  it('reports ssh’s words when the child ends before the hello', async () => {
    const { server, session } = open()
    server.drop('styr: no Styr server is running on /home/me/.styr/server.sock (ENOENT)\n', 2)
    await expect(session).rejects.toThrow(
      'Could not reach the Styr server on devbox: styr: no Styr server is running'
    )
  })

  it('gives up when no hello comes in time', async () => {
    const { clock, session } = open()
    const outcome = session.catch((error: unknown) => error)
    clock.advance(15_000)
    await settle()
    expect(String(await outcome)).toBe('Error: devbox did not answer within 15s.')
  })
})
