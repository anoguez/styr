/**
 * Where the Worklog's numbers come from: each task's agent sessions, and the model calls recorded in
 * their transcripts. Read on demand and never stored. Node-only; the pure part is `worklog.ts`.
 */
import { readFileSync, statSync } from 'node:fs'
import { providerById } from './providers/index.js'
import type { AgentProviderId, TranscriptUsage } from './providers/types.js'
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

const transcriptCache = new Map<
  string,
  { mtimeMs: number; size: number; calls: TranscriptUsage[] }
>()

/** The real source: the CLIs' transcripts on disk, re-read only when one has changed. */
export const diskWorklogSources: WorklogSourcePorts = {
  sessionUsage(provider, sessionId) {
    const agent = providerById(provider)
    const file = agent.transcriptPath(sessionId)
    if (!file) return undefined
    try {
      const { mtimeMs, size } = statSync(file)
      const cached = transcriptCache.get(file)
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.calls
      const calls = agent.transcriptUsage(readFileSync(file, 'utf8'))
      transcriptCache.set(file, { mtimeMs, size, calls })
      return calls
    } catch {
      return undefined
    }
  }
}
