import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { promisify } from 'node:util'
import {
  CODEX_UPGRADE_HINT,
  FrameDecoder,
  MIN_CODEX_VERSION,
  ThreadBindings,
  encodeTextFrame,
  isSupportedCodexVersion,
  parseCodexVersion,
  type ThreadUpdate
} from '@core/providers/codexProtocol.js'
import { shellQuote } from '@core/shell.js'

const run = promisify(execFile)
const HANDSHAKE_TIMEOUT_MS = 5_000
const RECONNECT_DELAY_MS = 3_000

/**
 * Runs through the user's login shell, as the embedded terminal does. A packaged app launched from
 * Finder inherits a bare PATH, so spawning the configured command directly fails with ENOENT even
 * though it works in a terminal. The command is a shell string (it may carry flags), as in a launch.
 */
async function output(command: string, args: string[]): Promise<string> {
  const line = [command, ...args.map((arg) => `'${shellQuote(arg)}'`)].join(' ')
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-l', '-c', line], {
      timeout: 15_000
    })
    return stdout
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error)
    throw new Error(
      `\`${[command, ...args].join(' ')}\` failed: ${detail}. ${CODEX_UPGRADE_HINT}`,
      {
        cause: error
      }
    )
  }
}

/**
 * Checks everything a monitored Codex session depends on and returns the daemon's control socket:
 * the CLI version, a running app-server daemon of a supported version. Throws an error that says
 * what to fix, so a launch is refused up front instead of running with no live status.
 */
export async function prepareCodex(command: string): Promise<string> {
  const required = MIN_CODEX_VERSION.join('.')
  const cli = parseCodexVersion(await output(command, ['--version']))
  if (!cli || !isSupportedCodexVersion(cli)) {
    throw new Error(
      `Codex CLI ${required} or later is required (found ${cli ? cli.join('.') : 'an unknown version'}). ${CODEX_UPGRADE_HINT}`
    )
  }
  await output(command, ['app-server', 'daemon', 'start'])
  let info: { socketPath?: string; appServerVersion?: string }
  try {
    info = JSON.parse(await output(command, ['app-server', 'daemon', 'version'])) as typeof info
  } catch {
    throw new Error(
      `Codex's app-server daemon returned unreadable version info. ${CODEX_UPGRADE_HINT}`
    )
  }
  const server = info.appServerVersion ? parseCodexVersion(info.appServerVersion) : undefined
  if (!info.socketPath || !server || !isSupportedCodexVersion(server)) {
    throw new Error(
      `The Codex app-server daemon is missing or older than ${required}. Run \`${command} app-server daemon restart\`, then launch again.`
    )
  }
  return info.socketPath
}

interface Connection {
  socket: net.Socket
  send(message: unknown): void
}

/**
 * A read-only listener on the Codex daemon. The embedded terminal runs the interactive Codex UI
 * against the same daemon (`--remote`), and the daemon broadcasts `thread/started` and
 * `thread/status/changed` for every thread to every connected client — so this connection watches
 * the agent without ever owning or steering it.
 */
export class CodexMonitor {
  private readonly bindings = new ThreadBindings()
  private connection: Promise<Connection> | undefined
  private socketPath = ''
  private retry: NodeJS.Timeout | undefined

  constructor(private readonly onUpdate: (update: ThreadUpdate) => void) {}

  /** Watches the thread a fresh launch will create in `cwd`. */
  async expect(socketPath: string, taskId: string, cwd: string): Promise<void> {
    await this.connect(socketPath)
    this.bindings.expect(taskId, cwd)
  }

  /** Watches a session that already has an id (a resume). */
  async watch(socketPath: string, taskId: string, threadId: string): Promise<void> {
    await this.connect(socketPath)
    this.bindings.bind(taskId, threadId)
  }

  release(taskId: string): void {
    this.bindings.release(taskId)
  }

  private connect(socketPath: string): Promise<Connection> {
    this.socketPath = socketPath
    this.connection ??= this.open(socketPath).catch((error) => {
      this.connection = undefined
      throw error
    })
    return this.connection
  }

  private open(socketPath: string): Promise<Connection> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath)
      const decoder = new FrameDecoder()
      let upgraded = false
      let head = Buffer.alloc(0)
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error)
      }
      const timer = setTimeout(
        () => fail(new Error('The Codex app-server did not complete its handshake in time.')),
        HANDSHAKE_TIMEOUT_MS
      )
      const send = (message: unknown): void => {
        socket.write(encodeTextFrame(JSON.stringify(message), randomBytes(4)))
      }
      const onMessage = (text: string): void => {
        let message: { id?: number; method?: string; params?: unknown; error?: unknown }
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (message.id === 1 && !message.method) {
          if (message.error) return fail(new Error('The Codex app-server rejected the handshake.'))
          clearTimeout(timer)
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          settled = true
          resolve({ socket, send })
          return
        }
        const update =
          message.method === 'thread/started'
            ? this.bindings.onStarted(message.params)
            : message.method === 'thread/status/changed'
              ? this.bindings.onStatus(message.params)
              : undefined
        if (update) this.onUpdate(update)
      }

      socket.on('error', (error) =>
        fail(new Error(`Could not reach the Codex daemon: ${error.message}`))
      )
      socket.on('close', () => {
        clearTimeout(timer)
        fail(new Error('The Codex app-server closed the connection.'))
        this.connection = undefined
        this.scheduleReconnect()
      })
      socket.on('connect', () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`
        )
      })
      socket.on('data', (chunk: Buffer) => {
        let body: Buffer = chunk
        if (!upgraded) {
          head = Buffer.concat([head, chunk])
          const end = head.indexOf('\r\n\r\n')
          if (end === -1) return
          if (!/^HTTP\/1\.1 101/.test(head.subarray(0, 12).toString())) {
            return fail(new Error('The Codex daemon refused the WebSocket upgrade.'))
          }
          upgraded = true
          body = head.subarray(end + 4)
          send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              clientInfo: { name: 'styr', title: 'Styr', version: '1' },
              capabilities: null
            }
          })
        }
        for (const frame of decoder.push(body)) {
          if (frame.opcode === 1) onMessage(frame.payload.toString('utf8'))
          else if (frame.opcode === 8) socket.end()
          else if (frame.opcode === 9) {
            socket.write(Buffer.concat([Buffer.from([0x8a, 0x80]), randomBytes(4)]))
          }
        }
      })
    })
  }

  /** A daemon restart drops the connection; reconnect while any session still depends on it. */
  private scheduleReconnect(): void {
    if (this.retry || this.bindings.size === 0 || !this.socketPath) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      if (this.bindings.size === 0) return
      this.connect(this.socketPath).catch(() => this.scheduleReconnect())
    }, RECONNECT_DELAY_MS)
  }
}
