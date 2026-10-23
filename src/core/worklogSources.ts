/**
 * Where the Worklog's numbers come from: each task's agent sessions, and the model calls recorded in
 * their transcripts. Read on demand and never stored. Node-only; the pure part is `worklog.ts`.
 */
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { providerById } from './providers/index.js'
import type {
  AgentProvider,
  AgentProviderId,
  TranscriptUsage,
  TranscriptUsageReader
} from './providers/types.js'
import type { Task, WorklogSessionDay, WorklogTask } from './types.js'
import { dayKey } from './worklog.js'

export interface WorklogSourcePorts {
  /** The model calls a conversation's transcript records; undefined once the transcript is gone. */
  sessionUsage(provider: AgentProviderId, sessionId: string): TranscriptUsage[] | undefined
}

/**
 * Each task's sessions within `[from, to)`, per day, with the tokens they used. A session whose
 * transcript is gone still counts, on the day it started, with no tokens. A task Done before
 * `from` cannot have worked in it, so it is not read at all. A model message seen in an earlier
 * session of the task (a fork carries its parent's) is not counted again.
 */
export function collectWorklog(
  tasks: readonly Task[],
  from: number,
  to: number,
  ports: WorklogSourcePorts
): WorklogTask[] {
  const within = (at: number): boolean => at >= from && at < to
  return tasks
    .filter((task) => task.status !== 'done' || Date.parse(task.updatedAt) >= from)
    .map((task) => {
      const seen = new Set<string>()
      const sessions: WorklogSessionDay[] = []
      for (const session of task.sessions) {
        const calls = ports.sessionUsage(session.provider, session.id)
        if (!calls) {
          const started = Date.parse(session.startedAt)
          if (within(started))
            sessions.push({ day: dayKey(started), sessionId: session.id, tokens: 0 })
          continue
        }
        const byDay = new Map<string, number>()
        for (const call of calls) {
          if (call.id) {
            if (seen.has(call.id)) continue
            seen.add(call.id)
          }
          if (!within(call.at)) continue
          const day = dayKey(call.at)
          byDay.set(day, (byDay.get(day) ?? 0) + call.tokens)
        }
        for (const [day, tokens] of byDay) sessions.push({ day, sessionId: session.id, tokens })
      }
      return { taskId: task.id, title: task.title, project: task.project, sessions }
    })
    .filter((task) => task.sessions.length > 0)
}

/** A transcript read so far: the calls in its first `offset` bytes, and the reader to go on with. */
interface ReadTranscript {
  file: string
  offset: number
  reader: TranscriptUsageReader
  calls: TranscriptUsage[]
}

/** The bytes of `file` from `offset` up to its last complete line. */
function readNewLines(file: string, offset: number, size: number): Buffer {
  const buffer = Buffer.alloc(size - offset)
  const descriptor = openSync(file, 'r')
  try {
    let read = 0
    while (read < buffer.length) {
      const got = readSync(descriptor, buffer, read, buffer.length - read, offset + read)
      if (got === 0) break
      read += got
    }
    return buffer.subarray(0, buffer.lastIndexOf(0x0a, read - 1) + 1)
  } finally {
    closeSync(descriptor)
  }
}

function sizeOf(file: string): number | undefined {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}

/**
 * Reads what `known.file` gained since `known.offset`, starting over when it is shorter than that
 * (rewritten). False when the file is gone; what was read before then still stands.
 */
function readOn(known: ReadTranscript, fresh: () => TranscriptUsageReader): boolean {
  const size = sizeOf(known.file)
  if (size === undefined) return false
  if (size < known.offset) {
    known.offset = 0
    known.reader = fresh()
    known.calls = []
  }
  if (size > known.offset) {
    try {
      const lines = readNewLines(known.file, known.offset, size)
      known.offset += lines.length
      known.calls.push(...known.reader(lines.toString('utf8')))
    } catch {
      // Unreadable for now; what was read so far still stands.
    }
  }
  return true
}

/**
 * Transcripts on disk, kept read between loads. A transcript only grows, so a later load reads just
 * the lines added since — a running agent's long transcript is not parsed again whole — and its
 * path, which finding can mean scanning every folder the CLI keeps, is looked up once. A transcript
 * not found is looked up again next time: its session may not have written it yet.
 *
 * A session's tokens include its subagents'. Their transcripts are listed again on every load (more
 * appear while it runs) and each is read the same way, keyed by its real path so a symlinked one
 * and its target are parsed once.
 */
export function transcriptSources(
  providerOf: (
    provider: AgentProviderId
  ) => Pick<AgentProvider, 'transcriptPath' | 'transcriptUsageReader' | 'subagentTranscripts'>
): WorklogSourcePorts {
  const transcripts = new Map<string, ReadTranscript>()
  const subagents = new Map<string, ReadTranscript>()
  /** Each subagent path listed, to its real path: still known once the file is gone. */
  const realPaths = new Map<string, string>()
  const realPath = (file: string): string => {
    try {
      realPaths.set(file, realpathSync(file))
    } catch {
      // Gone: the path it had, if it was ever seen.
    }
    return realPaths.get(file) ?? file
  }
  return {
    sessionUsage(provider, sessionId) {
      const agent = providerOf(provider)
      const fresh = (): TranscriptUsageReader => agent.transcriptUsageReader()
      const read = (file: string): ReadTranscript => ({
        file,
        offset: 0,
        reader: fresh(),
        calls: []
      })
      const key = `${provider}:${sessionId}`
      let known = transcripts.get(key)
      if (!known || !readOn(known, fresh)) {
        // Never found, or gone since.
        transcripts.delete(key)
        const file = agent.transcriptPath(sessionId)
        if (!file) return undefined
        known = read(file)
        if (!readOn(known, fresh)) return undefined
        transcripts.set(key, known)
      }
      const calls = [...known.calls]
      for (const file of agent.subagentTranscripts(sessionId, known.file)) {
        const subKey = `${provider}:${realPath(file)}`
        let sub = subagents.get(subKey)
        if (!sub) {
          sub = read(file)
          subagents.set(subKey, sub)
        }
        sub.file = file
        readOn(sub, fresh)
        calls.push(...sub.calls)
      }
      return calls
    }
  }
}

/** The real source: the CLIs' transcripts on disk. */
export const diskWorklogSources = transcriptSources(providerById)
