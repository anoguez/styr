import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

interface RpcMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

export type CodexLifecycleEvent =
  'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'Notification' | 'Stop'

const EVENT_BY_NOTIFICATION: Record<string, CodexLifecycleEvent> = {
  'thread/started': 'SessionStart',
  'turn/started': 'UserPromptSubmit',
  'item/started': 'PreToolUse',
  'turn/completed': 'Stop',
  'turn/failed': 'Stop',
  'item/commandExecution/requestApproval': 'Notification',
  'item/fileChange/requestApproval': 'Notification',
  'item/permissions/requestApproval': 'Notification'
}

const MINIMUM_CODEX_VERSION = [0, 159, 3] as const

function assertCompatibleCodex(command: string): void {
  let output: string
  try {
    output = execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    throw new Error(
      `Could not run ${command}. Install Codex CLI ${MINIMUM_CODEX_VERSION.join('.')} or later.`
    )
  }
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  if (!match) throw new Error(`Could not determine the Codex CLI version from: ${output.trim()}`)
  const version = match.slice(1).map(Number)
  const older = version.findIndex((part, index) => part !== MINIMUM_CODEX_VERSION[index])
  const actual = older === -1 ? undefined : version[older]
  const required = older === -1 ? undefined : MINIMUM_CODEX_VERSION[older]
  if (actual !== undefined && required !== undefined && actual < required) {
    throw new Error(
      `Codex CLI ${MINIMUM_CODEX_VERSION.join('.')} or later is required for live status.`
    )
  }
}

/** Minimal JSON-RPC client for Codex's documented local app-server protocol. */
export class CodexAppServer {
  private process: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  constructor(
    private readonly command: string,
    private readonly onEvent: (threadId: string, event: CodexLifecycleEvent) => void
  ) {}

  async startThread(cwd: string): Promise<string> {
    this.ensureStarted()
    await this.request('initialize', {
      clientInfo: { name: 'styr', title: 'Styr', version: '0.3.0' },
      capabilities: null
    })
    this.notify('initialized', {})
    const result = (await this.request('thread/start', {
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    })) as { thread?: { id?: string } }
    const id = result.thread?.id
    if (!id) throw new Error('Codex app-server did not return a thread id.')
    return id
  }

  close(): void {
    this.process?.kill()
    this.process = undefined
  }

  private ensureStarted(): void {
    if (this.process) return
    assertCompatibleCodex(this.command)
    const child = spawn(this.command, ['app-server', '--stdio'], { stdio: 'pipe' })
    this.process = child
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))
    child.on('error', (error) => this.rejectPending(error))
    child.on('exit', () => this.rejectPending(new Error('Codex app-server stopped unexpectedly.')))
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const child = this.process
    if (!child) return Promise.reject(new Error('Codex app-server is not running.'))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  private onLine(line: string): void {
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error)
        pending.reject(new Error(message.error.message ?? 'Codex app-server request failed.'))
      else pending.resolve(message.result)
      return
    }
    const event = message.method ? EVENT_BY_NOTIFICATION[message.method] : undefined
    const directThreadId = message.params?.threadId
    const nestedThread = message.params?.thread
    const threadId =
      typeof directThreadId === 'string'
        ? directThreadId
        : typeof nestedThread === 'object' &&
            nestedThread !== null &&
            typeof (nestedThread as { id?: unknown }).id === 'string'
          ? (nestedThread as { id: string }).id
          : undefined
    if (event && threadId) this.onEvent(threadId, event)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
