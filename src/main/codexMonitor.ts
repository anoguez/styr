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
import { codexConversationFromThread } from '@core/providers/codexConversation.js'
import type { AgentConversation } from '@core/agentConversation.js'
import { resolveShell, type TerminalShell } from '@core/platformShell.js'

const run = promisify(execFile)
const HANDSHAKE_TIMEOUT_MS = 5_000
const RECONNECT_DELAY_MS = 3_000

/**
 * Runs through the user's login shell, as the embedded terminal does. A packaged app launched from
 * Finder inherits a bare PATH, so spawning the configured command directly fails with ENOENT even
 * though it works in a terminal. The command is a shell string (it may carry flags), as in a launch.
 */
async function output(shell: TerminalShell, command: string, args: string[]): Promise<string> {
  const { syntax } = shell
  const line = [syntax.invoke(command), ...args.map((arg) => syntax.quote(arg))].join(' ')
  try {
    const { stdout } = await run(shell.path, shell.commandArgs(line), {
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
export async function prepareCodex(command: string, configuredShell: string): Promise<string> {
  const shell = resolveShell(configuredShell)
  const required = MIN_CODEX_VERSION.join('.')
  const cli = parseCodexVersion(await output(shell, command, ['--version']))
  if (!cli || !isSupportedCodexVersion(cli)) {
    throw new Error(
      `Codex CLI ${required} or later is required (found ${cli ? cli.join('.') : 'an unknown version'}). ${CODEX_UPGRADE_HINT}`
    )
  }
  await output(shell, command, ['app-server', 'daemon', 'start'])
  let info: { socketPath?: string; appServerVersion?: string }
  try {
    info = JSON.parse(
      await output(shell, command, ['app-server', 'daemon', 'version'])
    ) as typeof info
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
  request(method: string, params: unknown): Promise<unknown>
}

interface PendingApproval {
  requestId: number | string
  prompt: string
}

/**
 * A Codex app-server client. It watches the embedded Codex UI's thread and also owns Styr-originated
 * turns and approval replies, all over the daemon's JSON-RPC WebSocket connection.
 */
export class CodexMonitor {
  private readonly bindings = new ThreadBindings()
  private connection: Promise<Connection> | undefined
  private socketPath = ''
  private retry: NodeJS.Timeout | undefined
  private nextRequestId = 2
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >()
  private readonly approvals = new Map<string, PendingApproval>()

  constructor(
    private readonly onUpdate: (update: ThreadUpdate) => void,
    private readonly onConversation: (taskId: string, value: AgentConversation) => void = () => {}
  ) {}

  /** Watches the thread a fresh launch will create in `cwd`. */
  async expect(socketPath: string, taskId: string, cwd: string): Promise<void> {
    await this.connect(socketPath)
    this.bindings.expect(taskId, cwd)
  }

  /** Watches a session that already has an id (a resume). */
  async watch(socketPath: string, taskId: string, threadId: string): Promise<void> {
    await this.connect(socketPath)
    this.bindings.bind(taskId, threadId)
    this.refreshConversation(threadId)
  }

  release(taskId: string): void {
    const threadId = this.bindings.threadFor(taskId)
    this.bindings.release(taskId)
    if (threadId) this.approvals.delete(threadId)
  }

  async submitPrompt(taskId: string, text: string): Promise<void> {
    const threadId = this.bindings.threadFor(taskId)
    if (!threadId) throw new Error('Codex thread is not connected to this terminal.')
    const connection = await this.connect(this.socketPath)
    await connection.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: text.slice(0, 8_000) }]
    })
  }

  async readConversation(taskId: string): Promise<AgentConversation | null> {
    const threadId = this.bindings.threadFor(taskId)
    if (!threadId) return null
    const connection = await this.connect(this.socketPath)
    const result = await connection.request('thread/read', { threadId, includeTurns: true })
    const conversation = codexConversationFromThread(result)
    const approval = this.approvals.get(threadId)
    return conversation && approval
      ? {
          ...conversation,
          approval: {
            id: String(approval.requestId),
            prompt: approval.prompt,
            options: ['Allow', 'Deny']
          }
        }
      : conversation
  }

  async answerApproval(taskId: string, approvalId: string, allow: boolean): Promise<void> {
    const threadId = this.bindings.threadFor(taskId)
    const approval = threadId ? this.approvals.get(threadId) : undefined
    if (!threadId || !approval || String(approval.requestId) !== approvalId)
      throw new Error('This Codex approval is no longer waiting for a decision.')
    const connection = await this.connect(this.socketPath)
    connection.send({
      jsonrpc: '2.0',
      id: approval.requestId,
      result: { decision: allow ? 'accept' : 'decline' }
    })
    this.approvals.delete(threadId)
    this.refreshConversation(threadId)
  }

  private refreshConversation(threadId: string): void {
    const taskId = this.bindings.taskForThread(threadId)
    if (!taskId) return
    void this.readConversation(taskId)
      .then((conversation) => {
        if (conversation) this.onConversation(taskId, conversation)
      })
      .catch(() => {})
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
      const request = (method: string, params: unknown): Promise<unknown> => {
        const id = this.nextRequestId++
        return new Promise((resolveRequest, rejectRequest) => {
          const timer = setTimeout(() => {
            this.pending.delete(id)
            rejectRequest(new Error(`Codex app-server request timed out: ${method}`))
          }, 15_000)
          this.pending.set(id, {
            resolve: (value) => {
              clearTimeout(timer)
              resolveRequest(value)
            },
            reject: (error) => {
              clearTimeout(timer)
              rejectRequest(error)
            }
          })
          send({ jsonrpc: '2.0', id, method, params })
        })
      }
      const onMessage = (text: string): void => {
        let message: {
          id?: number | string
          method?: string
          params?: unknown
          error?: unknown
          result?: unknown
        }
        try {
          message = JSON.parse(text)
        } catch {
          return
        }
        if (message.id !== 1 && typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          if (message.error) pending.reject(new Error('Codex app-server rejected the request.'))
          else pending.resolve(message.result)
          return
        }
        if (
          (message.method === 'item/commandExecution/requestApproval' ||
            message.method === 'item/fileChange/requestApproval') &&
          (typeof message.id === 'number' || typeof message.id === 'string')
        ) {
          const params = message.params as
            | { threadId?: unknown; command?: unknown; reason?: unknown; itemId?: unknown }
            | undefined
          if (
            typeof params?.threadId === 'string' &&
            this.bindings.taskForThread(params.threadId)
          ) {
            const detail =
              typeof params.command === 'string'
                ? params.command
                : typeof params.reason === 'string'
                  ? params.reason
                  : 'Codex requests approval.'
            this.approvals.set(params.threadId, {
              requestId: message.id,
              prompt: detail.slice(0, 2_000)
            })
            this.refreshConversation(params.threadId)
          } else {
            send({ jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } })
          }
          return
        }
        if (message.id === 1 && !message.method) {
          if (message.error) return fail(new Error('The Codex app-server rejected the handshake.'))
          clearTimeout(timer)
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          settled = true
          resolve({ socket, send, request })
          return
        }
        const update =
          message.method === 'thread/started'
            ? this.bindings.onStarted(message.params)
            : message.method === 'thread/status/changed'
              ? this.bindings.onStatus(message.params)
              : undefined
        if (update) this.onUpdate(update)
        const params = message.params as { threadId?: unknown } | undefined
        if (
          typeof params?.threadId === 'string' &&
          (message.method?.startsWith('item/') ||
            message.method?.startsWith('turn/') ||
            message.method === 'thread/status/changed' ||
            message.method === 'thread/started')
        )
          this.refreshConversation(params.threadId)
      }

      socket.on('error', (error) =>
        fail(new Error(`Could not reach the Codex daemon: ${error.message}`))
      )
      socket.on('close', () => {
        clearTimeout(timer)
        for (const pending of this.pending.values())
          pending.reject(new Error('Codex app-server connection closed.'))
        this.pending.clear()
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
          if (head.length > 16 * 1024)
            return fail(new Error('The Codex daemon sent oversized WebSocket handshake headers.'))
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
        let frames: ReturnType<FrameDecoder['push']>
        try {
          frames = decoder.push(body)
        } catch (error) {
          return fail(error instanceof Error ? error : new Error('Invalid Codex WebSocket frame.'))
        }
        for (const frame of frames) {
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
