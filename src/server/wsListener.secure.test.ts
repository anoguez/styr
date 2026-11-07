import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { AccessStore } from '@host/remoteAccess/accessStore.js'
import { createSecureClientHandshake } from '@host/remoteAccess/secureClient.js'
import type { SecureFrameChannel, SecureSessions } from '@host/remoteAccess/secureSession.js'
import { RpcPeer } from '@host/rpc/jsonRpc.js'
import { CLOSE, MAX_FRAME_BYTES, type NetworkListener } from './wsListener.js'
import { listenOnLoopback, networkHost, TestPhone } from './networkFixture.js'

/** Protocol 2 through the real listener: what a phone on a relay will see. */
describe('network listener, protocol 2', () => {
  let host: ReturnType<typeof networkHost>
  let store: AccessStore
  let listener: NetworkListener
  const phones: TestPhone[] = []

  async function start(secureSessions: SecureSessions): Promise<void> {
    host = networkHost()
    store = host.store()
    listener = await listenOnLoopback(host, store, { secureSessions })
  }

  async function phone(): Promise<TestPhone> {
    const created = new TestPhone(listener.address.port, store.identity().fingerprint)
    phones.push(created)
    await created.opened()
    return created
  }

  const identity = generateKeyPairSync('ed25519')
  const device = {
    privateKey: identity.privateKey,
    publicKey: identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  }

  /** Runs the device's side over the socket; the channel once `ready`, or undefined. */
  async function handshake(
    socket: TestPhone,
    signIn: { type: 'auth'; deviceId: string } | { type: 'pair'; name: string; secret: string }
  ): Promise<{ channel: SecureFrameChannel; deviceId?: string } | undefined> {
    const client = createSecureClientHandshake({
      pinnedFingerprint: socket.fingerprint,
      identity: device,
      signIn,
      maxMessageBytes: MAX_FRAME_BYTES
    })
    socket.send(client.start())
    for (;;) {
      const frame = await socket.next()
      if (frame === '') return undefined
      const step = client.receive(frame)
      if (step.kind === 'send') for (const out of step.frames) socket.send(out)
      if (step.kind === 'ready') return step
    }
  }

  /** JSON-RPC over the channel, as the phone's SecureFrameChannel will carry it. */
  function rpc(socket: TestPhone, channel: SecureFrameChannel): RpcPeer {
    const peer = new RpcPeer((line) => {
      for (const frame of channel.seal(line.replace(/\n$/, ''))) socket.send(frame)
    })
    const deliver = (frame: string): void => {
      const text = channel.open(frame)
      if (text !== undefined) peer.receive(`${text}\n`)
    }
    socket.socket.removeAllListeners('message')
    socket.socket.on('message', (data) => deliver(data.toString()))
    // Frames that came in before this, in order: skipping one would break the channel.
    for (const queued of socket.messages.splice(0)) deliver(queued)
    return peer
  }

  async function pairAndSignIn() {
    const offer = store.startPairing()
    const first = await phone()
    const paired = await handshake(first, { type: 'pair', name: 'iPhone', secret: offer.secret })
    first.close()
    const again = await phone()
    const ready = await handshake(again, { type: 'auth', deviceId: paired!.deviceId! })
    return { socket: again, channel: ready!.channel, deviceId: paired!.deviceId! }
  }

  afterEach(async () => {
    for (const p of phones.splice(0)) p.close()
    await listener.close()
    host.cleanup()
  })

  it('pairs, signs in and carries JSON-RPC end to end', async () => {
    await start('allow')
    const { socket, channel } = await pairAndSignIn()
    const peer = rpc(socket, channel)
    await expect(peer.request('tasks:list', [])).resolves.toEqual([{ id: 'TASK-1@open' }])
  })

  it('ends the session on a tampered frame', async () => {
    await start('allow')
    const { socket, channel } = await pairAndSignIn()
    const [frame] = channel.seal(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks:list' }))
    const bytes = Buffer.from(frame!, 'base64')
    bytes[bytes.length - 1]! ^= 1
    socket.send(bytes.toString('base64'))
    expect((await socket.waitClosed()).code).toBe(CLOSE.BAD_REQUEST)
  })

  it('ends the session on a replayed frame', async () => {
    await start('allow')
    const { socket, channel } = await pairAndSignIn()
    const [frame] = channel.seal(JSON.stringify({ jsonrpc: '2.0', method: 'noop' }))
    socket.send(frame!)
    socket.send(frame!)
    expect((await socket.waitClosed()).code).toBe(CLOSE.BAD_REQUEST)
  })

  it('require: refuses protocol 1 with 4401 and no plaintext answer', async () => {
    await start('require')
    const socket = await phone()
    socket.send({ type: 'hello', protocol: 1, clientNonce: 'a'.repeat(32) })
    expect((await socket.waitClosed()).code).toBe(CLOSE.UNAUTHORIZED)
    expect(socket.messages).toEqual([])
  })

  it('off (direct mode by default): protocol 1 unchanged, protocol 2 refused with its reason', async () => {
    await start('off')
    const socket = await phone()
    const result = await handshake(socket, { type: 'auth', deviceId: 'x' }).catch(
      (error: Error) => error
    )
    expect(result).toBeInstanceOf(Error)
    expect((await socket.waitClosed()).code).toBe(CLOSE.UNAUTHORIZED)
  })

  it('a revoked device is cut off', async () => {
    await start('allow')
    const { socket, deviceId } = await pairAndSignIn()
    store.revoke(deviceId)
    expect((await socket.waitClosed()).code).toBe(CLOSE.REVOKED)
  })
})
