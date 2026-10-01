import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
    const threadId =
      typeof message.params?.threadId === 'string' ? message.params.threadId : undefined
    if (event && threadId) this.onEvent(threadId, event)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}
