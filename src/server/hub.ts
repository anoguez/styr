import { z } from 'zod'
import { RPC_ERRORS, RpcError, RpcPeer } from '@host/rpc/jsonRpc.js'
import type { TerminalOutput } from '@core/types.js'

/**
 * One channel the server answers: the same name and arguments as the IPC channel, with a zod
 * schema for the argument list checked before `run` sees it.
 */
export interface Channel {
  args: z.ZodType<unknown[]>
  run(...args: never[]): unknown
}

export type ChannelTable = Record<string, Channel>

/** What `styr serve` reports to each client on attach, and from `server:info`. */
export interface ServerInfo {
  /** The JSON-RPC surface's own version; bumped when a client must change with it. */
  protocol: number
  /** Styr's version. The client and the server must match (TASK-0129, Version lock). */
  version: string
  pid: number
  /** When the server started, on the server's clock. */
  startedAt: string
  storageDir: string
  platform: string
}

export const PROTOCOL_VERSION = 1

export interface HubPorts {
  /** Invoke channels (request/response) and one-way channels (notifications). */
  invoke: ChannelTable
  send: ChannelTable
  info(): ServerInfo
  /** The last `server:tray` model, for a client that has just attached. */
  tray(): unknown
  terminals: {
    backlog(id: string): TerminalOutput
    resize(id: string, cols: number, rows: number): void
  }
  /** `pinnedWorkspaceId` and the reset, so a handler that leaves the pin set is caught. */
  pin: { current(): string | undefined; clear(): void }
}

interface Client {
  id: number
  peer: RpcPeer
  /** Terminals this client is attached to: it receives their `terminal:data`. */
  attached: Set<string>
  /** The last size this client's view had for each terminal. */
  sizes: Map<string, { cols: number; rows: number }>
}

const size = z.number().int().min(1).max(10_000)
const attachArgs = z.tuple([z.string().min(1), size.optional(), size.optional()])
const terminalArgs = z.tuple([z.string().min(1)])
const resizeArgs = z.tuple([z.string().min(1), size, size])

/**
 * The connected clients. Each gets its own peer; broadcasts go to all of them, and terminal data
 * only to those attached to that terminal. The PTY size follows the client that focused the
 * terminal last: other clients' sizes are kept, and applied when they focus it.
 */
export function createHub(ports: HubPorts) {
  const clients = new Set<Client>()
  /** Which client's size a terminal follows. */
  const focus = new Map<string, Client>()
  let nextClientId = 1

  function connect(write: (line: string) => void): {
    receive(chunk: Buffer | string): void
    close(): void
  } {
    const client: Client = {
      id: nextClientId++,
      peer: undefined as unknown as RpcPeer,
      attached: new Set(),
      sizes: new Map()
    }
    client.peer = new RpcPeer(write, {
      request: (method, params) => request(client, method, normalise(params)),
      notification: (method, params) => notification(client, method, normalise(params))
    })
    clients.add(client)
    client.peer.notify('server:hello', [ports.info()])
    return {
      receive: (chunk) => client.peer.receive(chunk),
      close: () => disconnect(client)
    }
  }

  function disconnect(client: Client): void {
    if (!clients.delete(client)) return
    client.peer.close()
    for (const [terminal, owner] of focus) if (owner === client) focus.delete(terminal)
  }

  function request(client: Client, method: string, params: unknown[]): unknown {
    switch (method) {
      case 'server:info':
        return ports.info()
      case 'server:tray':
        return ports.tray()
      case 'terminal:attach': {
        const [id, cols, rows] = attachArgs.parse(params)
        client.attached.add(id)
        if (cols && rows) {
          client.sizes.set(id, { cols, rows })
          if (!focus.has(id)) applyFocus(client, id)
        }
        // Synchronous, so no `terminal:data` can fall between this backlog and the live stream.
        return ports.terminals.backlog(id)
      }
      case 'terminal:detach': {
        const [id] = terminalArgs.parse(params)
        client.attached.delete(id)
        client.sizes.delete(id)
        if (focus.get(id) === client) focus.delete(id)
        return undefined
      }
    }
    const channel = ports.invoke[method]
    if (!channel) throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`)
    return guarded(method, () => channel.run(...(channel.args.parse(params) as never[])))
  }

  function notification(client: Client, method: string, params: unknown[]): void {
    switch (method) {
      case 'terminal:focus': {
        const [id] = terminalArgs.parse(params)
        applyFocus(client, id)
        return
      }
      case 'terminal:resize': {
        const [id, cols, rows] = resizeArgs.parse(params)
        client.sizes.set(id, { cols, rows })
        if (!focus.has(id)) focus.set(id, client)
        if (focus.get(id) === client) ports.terminals.resize(id, cols, rows)
        return
      }
    }
    const channel = ports.send[method]
    if (!channel) return
    guarded(method, () => channel.run(...(channel.args.parse(params) as never[])))
  }

  /** The terminal now follows `client`'s size, if its view has reported one. */
  function applyFocus(client: Client, id: string): void {
    focus.set(id, client)
    const known = client.sizes.get(id)
    if (known) ports.terminals.resize(id, known.cols, known.rows)
  }

  /**
   * Runs a handler, then checks it left no workspace pinned — neither when it returned, nor, for
   * an async one, when it settled. `inOtherWorkspace` pins only around synchronous work; a pin
   * still set here would redirect every other client's calls to that workspace.
   */
  function guarded(method: string, run: () => unknown): unknown {
    let result: unknown
    try {
      result = run()
    } finally {
      checkPin(method)
    }
    if (result instanceof Promise) {
      // The pin can only leak across an await inside the handler, so check again when it settles.
      void result.then(
        () => checkPin(method),
        () => checkPin(method)
      )
    }
    return result
  }

  function checkPin(method: string): void {
    const pinned = ports.pin.current()
    if (pinned === undefined) return
    ports.pin.clear()
    console.error(`Styr server: ${method} left workspace ${pinned} pinned; cleared it.`)
  }

  function broadcast(channel: string, payload?: unknown): void {
    const params = payload === undefined ? [] : [payload]
    for (const client of clients) client.peer.notify(channel, params)
  }

  /** `terminal:data` goes only to the clients attached to that terminal. */
  function terminalData(id: string, output: TerminalOutput): void {
    for (const client of clients) {
      if (client.attached.has(id)) client.peer.notify('terminal:data', [{ id, ...output }])
    }
  }

  /** A terminal exited: nobody is attached to it any more. */
  function terminalExited(id: string): void {
    focus.delete(id)
    for (const client of clients) {
      client.attached.delete(id)
      client.sizes.delete(id)
    }
  }

  function closeAll(): void {
    for (const client of [...clients]) disconnect(client)
  }

  return {
    connect,
    broadcast,
    terminalData,
    terminalExited,
    closeAll,
    clientCount: () => clients.size
  }
}

export type Hub = ReturnType<typeof createHub>

/**
 * JSON has no `undefined`: an optional argument the client left out arrives as `null` inside the
 * argument list. Top-level nulls become `undefined` again, as the IPC handlers would see them.
 */
function normalise(params: unknown[]): unknown[] {
  return params.map((param) => (param === null ? undefined : param))
}
