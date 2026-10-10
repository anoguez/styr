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
export type CodexEvent =
  'SessionStart' | 'UserPromptSubmit' | 'Notification' | 'Stop' | 'SubagentStart' | 'SubagentStop'

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

/**
 * Who started a thread. `thread_spawn` is the agent spawning a helper, which belongs to the thread
 * named as its parent; the other `subAgent` sources (review, compact, memory consolidation) are
 * Codex's own housekeeping and belong to nobody.
 */
function spawnOf(
  thread: Record<string, unknown>
): { parentThreadId: string; label: string } | 'internal' | undefined {
  const subAgent = asRecord(thread.source)?.subAgent
  const spawn = asRecord(asRecord(subAgent)?.thread_spawn)
  if (subAgent !== undefined && !spawn) return 'internal'
  const parent = thread.parentThreadId ?? spawn?.parent_thread_id
  if (typeof parent !== 'string') return undefined
  const names = [thread.agentNickname, spawn?.agent_nickname, thread.agentRole, spawn?.agent_role]
  const label = names.find((name): name is string => typeof name === 'string' && name.trim() !== '')
  return { parentThreadId: parent, label: label?.trim() ?? 'Subagent' }
}

/** A thread the agent spawned to help it, with the thread that spawned it. */
export function spawnedThread(
  params: unknown
): { threadId: string; parentThreadId: string; label: string } | undefined {
  const thread = asRecord(asRecord(params)?.thread)
  if (!thread || thread.ephemeral === true || typeof thread.id !== 'string') return undefined
  const spawn = spawnOf(thread)
  return spawn && spawn !== 'internal' ? { threadId: thread.id, ...spawn } : undefined
}

/**
 * A user-facing thread. Ephemeral threads (title generation and the like) are not agents, and a
 * subagent's thread is its parent's helper — claiming it for a launch would bind the task to it.
 */
export function startedThread(params: unknown): { threadId: string; cwd: string } | undefined {
  const thread = asRecord(asRecord(params)?.thread)
  if (!thread || thread.ephemeral === true || typeof thread.id !== 'string') return undefined
  if (spawnOf(thread)) return undefined
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
  /** The event is about this helper of the task's agent, not about the agent itself. */
  subagent?: { id: string; label: string }
  /** The task's own thread went from idle to active: a new turn, which clears done subagents. */
  turnStarted?: boolean
}

/**
 * Which task a daemon thread belongs to. A fresh launch cannot know its thread id — the TUI creates
 * it — so it registers the directory it started in and claims the first user thread to appear
 * there. A resume already knows the id and binds it directly.
 */
export class ThreadBindings {
  private readonly threads = new Map<string, string>()
  private readonly expected: { taskId: string; cwd: string }[] = []
  private readonly subagents = new Map<
    string,
    { taskId: string; label: string; running: boolean }
  >()
  /** The last event each task thread reported, to tell a new turn from a turn carrying on. */
  private readonly lastEvent = new Map<string, CodexEvent>()

  get size(): number {
    return this.threads.size + this.expected.length
  }

  threadFor(taskId: string): string | undefined {
    return [...this.threads].find(([, owner]) => owner === taskId)?.[0]
  }

  taskForThread(threadId: string): string | undefined {
    return this.ownerOf(threadId)
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
    for (const [threadId, owner] of this.threads) {
      if (owner !== taskId) continue
      this.threads.delete(threadId)
      this.lastEvent.delete(threadId)
    }
    for (const [threadId, subagent] of this.subagents)
      if (subagent.taskId === taskId) this.subagents.delete(threadId)
    for (let index = this.expected.length - 1; index >= 0; index -= 1) {
      if (this.expected[index]?.taskId === taskId) this.expected.splice(index, 1)
    }
  }

  /** The task a thread works for: its own thread, or a helper of it at any depth. */
  private ownerOf(threadId: string): string | undefined {
    return this.threads.get(threadId) ?? this.subagents.get(threadId)?.taskId
  }

  onStarted(params: unknown): ThreadUpdate | undefined {
    const spawned = spawnedThread(params)
    if (spawned) {
      const taskId = this.ownerOf(spawned.parentThreadId)
      if (!taskId) return undefined
      this.subagents.set(spawned.threadId, { taskId, label: spawned.label, running: true })
      return {
        taskId,
        event: 'SubagentStart',
        subagent: { id: spawned.threadId, label: spawned.label }
      }
    }
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
    if (!change) return undefined
    const subagent = this.subagents.get(change.threadId)
    if (subagent) return this.onSubagentStatus(change.threadId, subagent, change.event)
    const taskId = this.threads.get(change.threadId)
    if (!taskId) return undefined
    const previous = this.lastEvent.get(change.threadId)
    this.lastEvent.set(change.threadId, change.event)
    const turnStarted =
      change.event === 'UserPromptSubmit' && (previous === undefined || previous === 'Stop')
    return turnStarted
      ? { taskId, event: change.event, turnStarted }
      : { taskId, event: change.event }
  }

  /** Idle is done, active again (a follow-up) is running again; repeats report nothing. */
  private onSubagentStatus(
    threadId: string,
    subagent: { taskId: string; label: string; running: boolean },
    event: CodexEvent
  ): ThreadUpdate | undefined {
    const running = event !== 'Stop'
    if (running === subagent.running) return undefined
    subagent.running = running
    return {
      taskId: subagent.taskId,
      event: running ? 'SubagentStart' : 'SubagentStop',
      subagent: { id: threadId, label: subagent.label }
    }
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

const MAX_FRAME_BYTES = 8 * 1024 * 1024

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
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES)
        throw new Error('Codex app-server sent an oversized WebSocket frame.')
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
        if (this.fragmentBytes + payload.length > MAX_FRAME_BYTES)
          throw new Error('Codex app-server sent an oversized WebSocket message.')
        this.fragments.push(payload)
        this.fragmentBytes += payload.length
        if (final) {
          const message = Buffer.concat(this.fragments)
          // A continuation (0) belongs to the data frame that started it; report that frame's kind.
          frames.push({ opcode: this.startOpcode ?? opcode, payload: message })
          this.fragments = []
          this.fragmentBytes = 0
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
  private fragmentBytes = 0
}
