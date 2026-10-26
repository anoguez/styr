import { describe, expect, it } from 'vitest'
import vector from './noiseXX.vector.json' with { type: 'json' }
import { NoiseXX, generateNoiseKeyPair, keyPairFromPrivate } from './noise.js'

const hex = (value: string): Buffer => Buffer.from(value, 'hex')

describe('Noise_XX_25519_ChaChaPoly_SHA256', () => {
  it('reproduces the official test vector', () => {
    const prologue = hex(vector.init_prologue)
    const initiator = new NoiseXX({
      initiator: true,
      prologue,
      staticKey: keyPairFromPrivate(hex(vector.init_static)),
      ephemeralKey: keyPairFromPrivate(hex(vector.init_ephemeral))
    })
    const responder = new NoiseXX({
      initiator: false,
      prologue,
      staticKey: keyPairFromPrivate(hex(vector.resp_static)),
      ephemeralKey: keyPairFromPrivate(hex(vector.resp_ephemeral))
    })
    const sides = [initiator, responder]
    vector.messages.slice(0, 3).forEach((entry, index) => {
      const writer = sides[index % 2]!
      const reader = sides[(index + 1) % 2]!
      const wire = writer.write(hex(entry.payload))
      expect(wire.toString('hex')).toBe(entry.ciphertext)
      expect(reader.read(wire).payload.toString('hex')).toBe(entry.payload)
    })
    const a = initiator.transport()
    const b = responder.transport()
    expect(a.hash.toString('hex')).toBe(vector.handshake_hash)
    expect(b.hash.toString('hex')).toBe(vector.handshake_hash)
    // The vector's transport messages alternate: 3 is responder -> initiator, 4 initiator -> responder.
    vector.messages.slice(3).forEach((entry, index) => {
      const [from, to] = index % 2 === 0 ? [b, a] : [a, b]
      const wire = from.send.encrypt(hex(entry.payload))
      expect(wire.toString('hex')).toBe(entry.ciphertext)
      expect(to.receive.decrypt(wire).toString('hex')).toBe(entry.payload)
    })
  })

  function handshake() {
    const initiator = new NoiseXX({ initiator: true, staticKey: generateNoiseKeyPair() })
    const responder = new NoiseXX({ initiator: false, staticKey: generateNoiseKeyPair() })
    responder.read(initiator.write())
    initiator.read(responder.write(Buffer.from('host')))
    responder.read(initiator.write(Buffer.from('phone')))
    return { a: initiator.transport(), b: responder.transport(), initiator, responder }
  }

  it('lets each side see the other static key and the same hash', () => {
    const { a, b, initiator, responder } = handshake()
    expect(initiator.remoteStatic).toEqual(responder['staticKey'].publicKey)
    expect(responder.remoteStatic).toEqual(initiator['staticKey'].publicKey)
    expect(a.hash).toEqual(b.hash)
  })

  it('ends the session on a tampered, replayed, reordered or dropped message', () => {
    const tampered = handshake()
    const wire = tampered.a.send.encrypt(Buffer.from('hello'))
    wire[0] = wire[0]! ^ 1
    expect(() => tampered.b.receive.decrypt(wire)).toThrow(/authentication/)

    const replay = handshake()
    const first = replay.a.send.encrypt(Buffer.from('one'))
    replay.b.receive.decrypt(first)
    expect(() => replay.b.receive.decrypt(first)).toThrow(/authentication/)

    const reordered = handshake()
    reordered.a.send.encrypt(Buffer.from('one'))
    const second = reordered.a.send.encrypt(Buffer.from('two'))
    expect(() => reordered.b.receive.decrypt(second)).toThrow(/authentication/)
  })

  it('refuses a handshake with a different prologue', () => {
    const initiator = new NoiseXX({
      initiator: true,
      staticKey: generateNoiseKeyPair(),
      prologue: Buffer.from('a')
    })
    const responder = new NoiseXX({
      initiator: false,
      staticKey: generateNoiseKeyPair(),
      prologue: Buffer.from('b')
    })
    responder.read(initiator.write())
    expect(() => initiator.read(responder.write())).toThrow(/authentication/)
  })

  it('refuses out-of-turn calls and a low-order public key', () => {
    const initiator = new NoiseXX({ initiator: true, staticKey: generateNoiseKeyPair() })
    expect(() => initiator.read(Buffer.alloc(32))).toThrow(/turn/)
    const responder = new NoiseXX({ initiator: false, staticKey: generateNoiseKeyPair() })
    expect(() => responder.read(Buffer.alloc(32))).not.toThrow()
    expect(() => responder.write()).toThrow(/invalid public key/)
  })
})
