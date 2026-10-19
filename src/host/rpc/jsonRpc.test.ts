import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  LineDecoder,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  encodeMessage,
  parseMessage,
  type RpcMessage
} from './jsonRpc.js'

function decode(chunks: (Buffer | string)[], max?: number) {
  const lines: string[] = []
  let overflows = 0
  const decoder = new LineDecoder(
    (line) => lines.push(line),
    () => overflows++,
    max
  )
  for (const chunk of chunks) decoder.push(chunk)
  return { lines, overflows: () => overflows, decoder }
}

/** Two peers wired back to back, as a socket would join them. */
function pair(
  serverHandlers: ConstructorParameters<typeof RpcPeer>[1],
  clientHandlers: ConstructorParameters<typeof RpcPeer>[1] = {}
) {
  const wire: string[] = []
  // eslint-disable-next-line prefer-const
  let client: RpcPeer
  const server = new RpcPeer((line) => {
    wire.push(`< ${line}`)
    client.receive(line)
  }, serverHandlers)
  client = new RpcPeer((line) => {
    wire.push(`> ${line}`)
    server.receive(line)
  }, clientHandlers)
  return { server, client, wire }
}

describe('encodeMessage', () => {
  it('writes one line per message, with any newline in a value escaped', () => {
    const line = encodeMessage({ jsonrpc: '2.0', method: 'terminal:data', params: ['a\nb'] })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(line)).toEqual({ jsonrpc: '2.0', method: 'terminal:data', params: ['a\nb'] })
  })

  it('sends an undefined result as null, which JSON can carry', () => {
    expect(JSON.parse(encodeMessage({ jsonrpc: '2.0', id: 1, result: undefined }))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: null
    })
  })
})

describe('parseMessage', () => {
  it('reads requests, notifications and both kinds of response', () => {
    const messages: RpcMessage[] = [
      { jsonrpc: '2.0', id: 7, method: 'tasks:get', params: ['TASK-0001'] },
      { jsonrpc: '2.0', method: 'tasks:changed', params: [] },
      { jsonrpc: '2.0', id: 'a', result: { ok: true } },
      { jsonrpc: '2.0', id: 7, error: { code: -32000, message: 'nope' } }
    ]
    for (const message of messages) {
      expect(parseMessage(JSON.stringify(message))).toEqual({ ok: true, message })
    }
  })

  it('gives a call without params an empty argument list', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1,"method":"tasks:list"}')).toEqual({
      ok: true,
      message: { jsonrpc: '2.0', id: 1, method: 'tasks:list', params: [] }
    })
  })

  it('reports a line that is not JSON as a parse error', () => {
    expect(parseMessage('{oops')).toEqual({
      ok: false,
      error: { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.PARSE, message: 'Parse error' } }
    })
  })

  it('reports a message of the wrong shape, keeping its id when it has one', () => {
    for (const [line, id] of [
      ['{"jsonrpc":"1.0","id":3,"method":"x"}', 3],
      ['{"jsonrpc":"2.0","id":4,"method":"x","params":{"named":1}}', 4],
      ['[1,2]', null],
      ['null', null]
    ] as const) {
      const parsed = parseMessage(line)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) {
        expect(parsed.error.id).toBe(id)
        expect(parsed.error.error.code).toBe(RPC_ERRORS.INVALID_REQUEST)
      }
    }
  })
})

describe('LineDecoder', () => {
  it('joins a line cut across chunks and splits several lines in one chunk', () => {
    const { lines } = decode(['{"a":', '1}\n{"b":2}\n{"c"', ':3}\n'])
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  it('keeps a multi-byte character cut between two chunks', () => {
    const bytes = Buffer.from('"héllo ✓"\n')
    const cut = bytes.indexOf(0xe2) + 1
    const { lines } = decode([bytes.subarray(0, cut), bytes.subarray(cut)])
    expect(lines).toEqual(['"héllo ✓"'])
  })

  it('skips blank lines and accepts CRLF endings', () => {
    const { lines } = decode(['\n\n{"a":1}\r\n  \n'])
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: 1 }])
  })

  it('delivers a last line without a newline when the stream ends', () => {
    const { lines, decoder } = decode(['{"a":1}\n{"b"', ':2}'])
    expect(lines).toEqual(['{"a":1}'])
    decoder.end()
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('drops an oversized line whole, reports it once and resumes at the next newline', () => {
    const { lines, overflows } = decode(
      ['{"ok":1}\n', 'x'.repeat(8), 'y'.repeat(8), 'z\n{"ok":2}\n'],
      10
    )
    expect(lines).toEqual(['{"ok":1}', '{"ok":2}'])
    expect(overflows()).toBe(1)
  })

  it('drops an oversized line that arrives in one chunk', () => {
    const { lines, overflows } = decode([`${'x'.repeat(20)}\n{"ok":1}\n`], 10)
    expect(lines).toEqual(['{"ok":1}'])
    expect(overflows()).toBe(1)
  })
})

describe('RpcPeer', () => {
  it('answers a request with the handler result, in order with the other calls', async () => {
    const { client } = pair({
      request: (method, params) => ({ method, params })
    })
    await expect(client.request('tasks:get', ['TASK-0001'])).resolves.toEqual({
      method: 'tasks:get',
      params: ['TASK-0001']
    })
  })

  it('waits for a handler that returns a promise', async () => {
    const { client } = pair({ request: async () => 'later' })
    await expect(client.request('x')).resolves.toBe('later')
  })

  it('turns undefined into null on the way back', async () => {
    const { client } = pair({ request: () => undefined })
    await expect(client.request('x')).resolves.toBeNull()
  })

  it('rejects with the thrown message, an RpcError code, or invalid params for a zod error', async () => {
    const { client } = pair({
      request: (method) => {
        if (method === 'throws') throw new Error('Task not found')
        if (method === 'rejects') return Promise.reject(new Error('later failure'))
        if (method === 'unknown') throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, 'Unknown method')
        z.string().parse(1)
      }
    })
    await expect(client.request('throws')).rejects.toMatchObject({
      code: RPC_ERRORS.HANDLER,
      message: 'Task not found'
    })
    await expect(client.request('rejects')).rejects.toMatchObject({ message: 'later failure' })
    await expect(client.request('unknown')).rejects.toMatchObject({
      code: RPC_ERRORS.METHOD_NOT_FOUND
    })
    await expect(client.request('zod')).rejects.toMatchObject({
      code: RPC_ERRORS.INVALID_PARAMS
    })
  })

  it('says method not found when the peer answers no requests', async () => {
    const { client } = pair({})
    await expect(client.request('x')).rejects.toMatchObject({
      code: RPC_ERRORS.METHOD_NOT_FOUND
    })
  })

  it('delivers notifications both ways without a reply', () => {
    const toServer: unknown[] = []
    const toClient: unknown[] = []
    const { server, client, wire } = pair(
      { notification: (method, params) => toServer.push([method, params]) },
      { notification: (method, params) => toClient.push([method, params]) }
    )
    client.notify('terminal:write', ['id', 'ls\r'])
    server.notify('tasks:changed')
    expect(toServer).toEqual([['terminal:write', ['id', 'ls\r']]])
    expect(toClient).toEqual([['tasks:changed', []]])
    expect(wire).toHaveLength(2)
  })

  it('survives a notification handler that throws', () => {
    const { client, wire } = pair({
      notification: () => {
        throw new Error('boom')
      }
    })
    const error = console.error
    console.error = () => {}
    try {
      client.notify('x')
    } finally {
      console.error = error
    }
    expect(wire).toHaveLength(1)
  })

  it('answers garbage with an error response and keeps the connection', async () => {
    const replies: string[] = []
    const peer = new RpcPeer((line) => replies.push(line), { request: () => 'ok' })
    peer.receive('not json\n')
    peer.receive('{"jsonrpc":"2.0","id":1,"method":"x"}\n')
    expect(replies.map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.PARSE, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 1, result: 'ok' }
    ])
  })

  it('ignores a response to no request it made', () => {
    const replies: string[] = []
    const peer = new RpcPeer((line) => replies.push(line))
    peer.receive('{"jsonrpc":"2.0","id":99,"result":1}\n')
    peer.receive('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n')
    expect(replies).toEqual([])
  })

  it('rejects every waiting request on close, and any request after it', async () => {
    const peer = new RpcPeer(() => {})
    const waiting = peer.request('slow')
    peer.close('Server went away')
    await expect(waiting).rejects.toMatchObject({ message: 'Server went away' })
    await expect(peer.request('again')).rejects.toMatchObject({ message: 'Connection closed' })
  })
})
