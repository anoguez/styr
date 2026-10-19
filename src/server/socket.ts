import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { configDir } from '@core/config.js'
import type { Hub } from './hub.js'

/** `~/.styr/server.sock`, or `$STYR_HOME/server.sock`. */
export function defaultSocketPath(): string {
  return join(configDir(), 'server.sock')
}

/** Whether something answers on `path`: a live server, as opposed to a socket file left behind. */
export function isListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path)
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
}

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. */
const MAX_SOCKET_PATH = 103

export interface Listener {
  /** Ends every client, stops listening and removes the socket file. */
  close(): Promise<void>
}

/**
 * Listens on a Unix socket only the user can open (mode 0600, in a 0700 folder). There is no TCP
 * listener and no auth: being able to reach the socket, which over the network means being able
 * to `ssh` in, is the auth. A socket file left by a server that died is replaced; a live server
 * keeps its socket and this one refuses to start.
 */
export async function listen(path: string, hub: Hub): Promise<Listener> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    throw new Error(
      `The socket path is too long for a Unix socket (${MAX_SOCKET_PATH} bytes): ${path}`
    )
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (await isListening(path)) {
    throw new Error(`A Styr server is already running on ${path}.`)
  }
  rmSync(path, { force: true })

  const open = new Set<Socket>()
  const server = createServer((socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    serve(socket, hub)
  })
  // The umask covers the moment between bind and chmod, when the socket would otherwise exist
  // with the default mode.
  const umask = process.umask(0o177)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } finally {
    process.umask(umask)
  }
  chmodSync(path, 0o600)

  return {
    close: () =>
      new Promise((resolve) => {
        hub.closeAll()
        server.close(() => {
          rmSync(path, { force: true })
          resolve()
        })
        // `server.close` waits for open connections to end; end them.
        for (const socket of open) socket.destroy()
      })
  }
}

/**
 * How much unsent output a client may fall behind by. A connection that stalls (ssh hung, the
 * laptop asleep with the socket still open) is dropped past this, rather than buffering a busy
 * terminal's output without end; the client reattaches and replays the backlog.
 */
export const MAX_BUFFERED_BYTES = 32 * 1024 * 1024

function serve(socket: Socket, hub: Hub): void {
  const connection = hub.connect((line) => {
    if (socket.destroyed) return
    if (socket.writableLength > MAX_BUFFERED_BYTES) {
      socket.destroy()
      return
    }
    socket.write(line)
  })
  socket.on('data', (chunk) => connection.receive(chunk))
  socket.on('close', () => connection.close())
  // A client that vanished (the ssh connection dropped) is a close, not a server error.
  socket.on('error', () => socket.destroy())
}

/**
 * `styr serve attach`: pipes stdio to the server's socket, which is what the client's `ssh`
 * runs. Resolves with the exit code: 0 when either side ends, 2 when no server is listening.
 */
export function attach(
  path: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  errors: NodeJS.WritableStream
): Promise<number> {
  return new Promise((resolve) => {
    const socket = connect(path)
    let connected = false
    socket.once('connect', () => {
      connected = true
      input.pipe(socket)
      socket.pipe(output, { end: false })
    })
    // The client hung up (ssh closed stdin): end our half, and the server sees the close.
    input.once('end', () => socket.end())
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (!connected) {
        errors.write(
          `styr: no Styr server is running on ${path} (${error.code ?? error.message})\n`
        )
        resolve(2)
      } else {
        resolve(1)
      }
    })
    socket.once('close', () => {
      if (connected) resolve(0)
    })
  })
}
