/**
 * The pure half of the Codex app-server integration: version policy, the lifecycle-to-state
 * mapping, thread-to-task binding and the WebSocket framing the daemon's control socket speaks.
 * Nothing here touches a socket or a process, so every rule can be tested directly; the I/O lives
 * in `main/codexMonitor.ts`.
 */

export const MIN_CODEX_VERSION = [0, 159, 3] as const

export function parseCodexVersion(output: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export function isSupportedCodexVersion(version: readonly number[]): boolean {
  for (let index = 0; index < MIN_CODEX_VERSION.length; index += 1) {
    const have = version[index] ?? 0
    const need = MIN_CODEX_VERSION[index] as number
    if (have !== need) return have > need
  }
  return true
}

export const CODEX_UPGRADE_HINT = `Install Codex CLI ${MIN_CODEX_VERSION.join('.')} or later (\`codex update\`), or set the Codex command in Settings → Integrations.`

/** Hook-style event names, so Codex shares `EVENT_STATE` with every other provider. */
export type CodexEvent = 'SessionStart' | 'UserPromptSubmit' | 'Notification' | 'Stop'

interface ThreadStatus {
  type?: string
  activeFlags?: string[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * `thread/status/changed` is the one lifecycle signal the daemon broadcasts for every thread:
 * active is working, active waiting on approval or input is waiting, idle after a turn is finished.
 * `notLoaded` and `systemError` say nothing about the agent, so the terminal-exit fallback owns them.
 */
export function eventForStatus(
  params: unknown
): { threadId: string; event: CodexEvent } | undefined {
  const record = asRecord(params)
  const threadId = record?.threadId
  const status = asRecord(record?.status) as ThreadStatus | undefined
  if (typeof threadId !== 'string' || !status) return undefined
  if (status.type === 'idle') return { threadId, event: 'Stop' }
  if (status.type !== 'active') return undefined
  const waiting = status.activeFlags?.some(
    (flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput'
  )
  return { threadId, event: waiting ? 'Notification' : 'UserPromptSubmit' }
}

/** A user-facing thread. Ephemeral threads (title generation and the like) are not agents. */
export function startedThread(params: unknown): { threadId: string; cwd: string } | undefined {
  const thread = asRecord(asRecord(params)?.thread)
  if (!thread || thread.ephemeral === true || typeof thread.id !== 'string') return undefined
  const environment = Array.isArray(thread.environments)
    ? asRecord(thread.environments[0])
    : undefined
  const cwd = environment?.cwd ?? thread.cwd
  return typeof cwd === 'string' ? { threadId: thread.id, cwd } : undefined
}

export interface ThreadUpdate {
  taskId: string
  event: CodexEvent
  /** Set when the thread was just matched to a launch, so its real id can be saved for resume. */
  boundSessionId?: string
}

/**
 * Which task a daemon thread belongs to. A fresh launch cannot know its thread id — the TUI creates
 * it — so it registers the directory it started in and claims the first user thread to appear
 * there. A resume already knows the id and binds it directly.
 */
export class ThreadBindings {
  private readonly threads = new Map<string, string>()
  private readonly expected: { taskId: string; cwd: string }[] = []

  get size(): number {
    return this.threads.size + this.expected.length
  }

  expect(taskId: string, cwd: string): void {
    this.release(taskId)
    this.expected.push({ taskId, cwd })
  }

  bind(taskId: string, threadId: string): void {
    this.release(taskId)
    this.threads.set(threadId, taskId)
  }

  release(taskId: string): void {
    for (const [threadId, owner] of this.threads)
      if (owner === taskId) this.threads.delete(threadId)
    for (let index = this.expected.length - 1; index >= 0; index -= 1) {
      if (this.expected[index]?.taskId === taskId) this.expected.splice(index, 1)
    }
  }

  onStarted(params: unknown): ThreadUpdate | undefined {
    const started = startedThread(params)
    if (!started) return undefined
    const known = this.threads.get(started.threadId)
    if (known) return { taskId: known, event: 'SessionStart' }
    const index = this.expected.findIndex((entry) => entry.cwd === started.cwd)
    const claim = index === -1 ? undefined : this.expected.splice(index, 1)[0]
    if (!claim) return undefined
    this.threads.set(started.threadId, claim.taskId)
    return { taskId: claim.taskId, event: 'SessionStart', boundSessionId: started.threadId }
  }

  onStatus(params: unknown): ThreadUpdate | undefined {
    const change = eventForStatus(params)
    const taskId = change ? this.threads.get(change.threadId) : undefined
    return change && taskId ? { taskId, event: change.event } : undefined
  }
}

// --- WebSocket framing (RFC 6455, text frames only) -------------------------------------------

export function encodeTextFrame(text: string, mask: Uint8Array): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  const header =
    length < 126
      ? Buffer.from([0x81, 0x80 | length])
      : length < 65536
        ? Buffer.from([0x81, 0x80 | 126, length >> 8, length & 0xff])
        : (() => {
            const buffer = Buffer.alloc(10)
            buffer[0] = 0x81
            buffer[1] = 0x80 | 127
            buffer.writeBigUInt64BE(BigInt(length), 2)
            return buffer
          })()
  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = (payload[index] as number) ^ (mask[index % 4] as number)
  }
  return Buffer.concat([header, Buffer.from(mask), masked])
}

export interface Frame {
  opcode: number
  payload: Buffer
}

/** Reassembles frames from arbitrary socket chunks. Handles fragmentation and server (unmasked) frames. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    for (;;) {
      if (this.buffer.length < 2) break
      const first = this.buffer[0] as number
      const second = this.buffer[1] as number
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) break
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) break
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      const masked = (second & 0x80) !== 0
      const maskLength = masked ? 4 : 0
      if (this.buffer.length < offset + maskLength + length) break
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : undefined
      const payload = Buffer.from(
        this.buffer.subarray(offset + maskLength, offset + maskLength + length)
      )
      if (mask)
        for (let index = 0; index < payload.length; index += 1)
          payload[index] = (payload[index] as number) ^ (mask[index % 4] as number)
      this.buffer = this.buffer.subarray(offset + maskLength + length)

      const opcode = first & 0x0f
      const final = (first & 0x80) !== 0
      if (opcode === 0 || opcode === 1 || opcode === 2) {
        this.fragments.push(payload)
        if (final) {
          const message = Buffer.concat(this.fragments)
          // A continuation (0) belongs to the data frame that started it; report that frame's kind.
          frames.push({ opcode: this.startOpcode ?? opcode, payload: message })
          this.fragments = []
          this.startOpcode = undefined
        } else if (opcode !== 0) {
          this.startOpcode = opcode
        }
      } else {
        frames.push({ opcode, payload })
      }
    }
    return frames
  }

  private startOpcode: number | undefined
}
