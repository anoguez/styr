import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'

/**
 * Newline-delimited JSON-RPC 2.0, the wire format between `styr serve` and its clients (see
 * `docs/architecture/remote.md`). One message per line: `JSON.stringify` never emits a raw newline,
 * so a line is always a whole message. Params are always the call's argument list, as an IPC
 * channel receives them.
 */

export type RpcId = number | string

export interface RpcRequest {
  jsonrpc: '2.0'
  id: RpcId
  method: string
  params: unknown[]
}

export interface RpcNotification {
  jsonrpc: '2.0'
  method: string
  params: unknown[]
}

export interface RpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface RpcSuccess {
  jsonrpc: '2.0'
  id: RpcId
  result: unknown
}

export interface RpcFailure {
  jsonrpc: '2.0'
  id: RpcId | null
  error: RpcErrorBody
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure

/** The JSON-RPC error codes, plus `HANDLER` for an error thrown by the channel's handler. */
export const RPC_ERRORS = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  HANDLER: -32000
} as const

/** The longest line a peer accepts: far above any backlog `TerminalTranscript` keeps. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024

const idSchema = z.union([z.number(), z.string()])
const paramsSchema = z.array(z.unknown()).optional()

const messageSchema = z.union([
  z.object({
    jsonrpc: z.literal('2.0'),
    id: idSchema,
    method: z.string().min(1),
    params: paramsSchema
  }),
  z.object({ jsonrpc: z.literal('2.0'), method: z.string().min(1), params: paramsSchema }),
  z.object({ jsonrpc: z.literal('2.0'), id: idSchema, result: z.unknown() }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: idSchema.nullable(),
    error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
  })
])

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** One message as a line. `undefined` has no JSON form, so a missing result is sent as `null`. */
export function encodeMessage(message: RpcMessage): string {
  if ('result' in message && message.result === undefined) {
    return `${JSON.stringify({ ...message, result: null })}\n`
  }
  return `${JSON.stringify(message)}\n`
}

/**
 * Parses one line into a message, or says why it is not one. A request or notification without
 * `params` gets an empty argument list.
 */
export function parseMessage(
  line: string
): { ok: true; message: RpcMessage } | { ok: false; error: RpcFailure } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, error: failure(null, RPC_ERRORS.PARSE, 'Parse error') }
  }
  const parsed = messageSchema.safeParse(value)
  if (!parsed.success) {
    const id = idSchema.safeParse((value as { id?: unknown } | null)?.id)
    return {
      ok: false,
      error: failure(id.success ? id.data : null, RPC_ERRORS.INVALID_REQUEST, 'Invalid request')
    }
  }
  const message = parsed.data
  if ('method' in message)
    return { ok: true, message: { ...message, params: message.params ?? [] } }
  return { ok: true, message: message as RpcMessage }
}

export function failure(
  id: RpcId | null,
  code: number,
  message: string,
  data?: unknown
): RpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  }
}

/**
 * Splits a byte stream into lines. Chunks may cut a line, or a UTF-8 character, anywhere; a line
 * longer than `maxLineBytes` is dropped whole and reported once, and the decoder carries on at the
 * next newline.
 */
export class LineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private overflowing = false

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void = () => {},
    private readonly maxLineBytes = MAX_LINE_BYTES
  ) {}

  push(chunk: Buffer | string): void {
    this.consume(typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
  }

  /** The stream ended: a last line without a newline still counts. */
  end(): void {
    this.consume(this.decoder.end())
    const rest = this.pending
    this.pending = ''
    if (!this.overflowing && rest.trim()) this.onLine(rest)
    this.overflowing = false
  }

  private consume(text: string): void {
    let start = 0
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      const piece = text.slice(start, newline)
      start = newline + 1
      if (this.overflowing) {
        this.overflowing = false
        this.pending = ''
        continue
      }
      const line = this.pending + piece
      this.pending = ''
      if (Buffer.byteLength(line) > this.maxLineBytes) this.onOverflow()
      else if (line.trim()) this.onLine(line)
    }
    if (this.overflowing) return
    this.pending += text.slice(start)
    if (Buffer.byteLength(this.pending) > this.maxLineBytes) {
      this.pending = ''
      this.overflowing = true
      this.onOverflow()
    }
  }
}

export interface RpcPeerHandlers {
  /** Answers a request; a throw or rejection becomes an error response. */
  request?(method: string, params: unknown[]): unknown
  notification?(method: string, params: unknown[]): void
}

/**
 * One end of a connection: sends requests and notifications, matches responses to requests, and
 * hands incoming calls to `handlers`. Transport-free: feed it bytes with `receive`, and it writes
 * whole lines through `write`. Both the server (one peer per client) and a client use it.
 */
export class RpcPeer {
  private nextId = 1
  private closed = false
  private readonly pending = new Map<
    RpcId,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private readonly lines: LineDecoder

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: RpcPeerHandlers = {}
  ) {
    this.lines = new LineDecoder(
      (line) => this.receiveLine(line),
      () => this.send(failure(null, RPC_ERRORS.INVALID_REQUEST, 'Message too large'))
    )
  }

  receive(chunk: Buffer | string): void {
    this.lines.push(chunk)
  }

  request(method: string, params: unknown[] = []): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError(RPC_ERRORS.INTERNAL, 'Connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown[] = []): void {
    if (!this.closed) this.send({ jsonrpc: '2.0', method, params })
  }

  /** The connection is gone: every request still waiting rejects. */
  close(reason = 'Connection closed'): void {
    if (this.closed) return
    this.lines.end()
    this.closed = true
    for (const { reject } of this.pending.values())
      reject(new RpcError(RPC_ERRORS.INTERNAL, reason))
    this.pending.clear()
  }

  private send(message: RpcMessage): void {
    if (!this.closed) this.write(encodeMessage(message))
  }

  private receiveLine(line: string): void {
    const parsed = parseMessage(line)
    if (!parsed.ok) return this.send(parsed.error)
    const message = parsed.message
    if ('method' in message) {
      if ('id' in message) return this.answer(message)
      try {
        this.handlers.notification?.(message.method, message.params)
      } catch (error) {
        // A notification has no reply; a handler that throws must not take the connection down.
        console.error(`Styr: notification ${message.method} failed:`, error)
      }
      return
    }
    if (message.id === null) return
    const waiting = this.pending.get(message.id)
    if (!waiting) return
    this.pending.delete(message.id)
    if ('error' in message) {
      waiting.reject(new RpcError(message.error.code, message.error.message, message.error.data))
    } else {
      waiting.resolve(message.result)
    }
  }

  private answer(request: RpcRequest): void {
    const respond = (value: unknown): void =>
      this.send({ jsonrpc: '2.0', id: request.id, result: value })
    const fail = (error: unknown): void => this.send(toFailure(request.id, error))
    if (!this.handlers.request) {
      return fail(new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${request.method}`))
    }
    let result: unknown
    try {
      result = this.handlers.request(request.method, request.params)
    } catch (error) {
      return fail(error)
    }
    if (result instanceof Promise) result.then(respond, fail)
    else respond(result)
  }
}

function toFailure(id: RpcId, error: unknown): RpcFailure {
  if (error instanceof RpcError) return failure(id, error.code, error.message, error.data)
  if (error instanceof z.ZodError) {
    return failure(id, RPC_ERRORS.INVALID_PARAMS, 'Invalid params', error.issues)
  }
  const message = error instanceof Error ? error.message : String(error)
  return failure(id, RPC_ERRORS.HANDLER, message)
}
