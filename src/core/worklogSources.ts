/**
 * Where the Worklog's hours come from: each task's own trail — the records in its agents'
 * transcripts, its activity notes, and the commits on its branch — turned into stretches of work
 * by `workIntervals`. Read on demand and never stored. Node-only; the pure part is `worklog.ts`.
 */
import { readFileSync, statSync } from 'node:fs'
import { baseBranchFor, branchExists, branchNameFor, git } from './gitExec.js'
import { providerById } from './providers/index.js'
import type { AgentProviderId } from './providers/types.js'
import { checkoutOf } from './taskCheckout.js'
import type { Task, WorklogTask, WorktreeLocation } from './types.js'
import { clipIntervals, IDLE_GAP_MS, workIntervals } from './worklog.js'

export interface WorklogSourcePorts {
  /** When an agent conversation's transcript recorded something (epoch ms); empty once it is gone. */
  sessionTimes(provider: AgentProviderId, sessionId: string): number[]
  /** Author times (epoch ms) of the task's own commits since `since`; empty without a branch. */
  commitTimes(task: Task, since: number): number[]
}

/**
 * Each task's stretches of work within `[from, to)`. A task Done before `from` cannot have worked
 * in it, so it is not read at all. Signals a little outside the span still count, so a stretch
 * crossing its edge is measured whole before it is cut.
 */
export function collectWorklog(
  tasks: readonly Task[],
  from: number,
  to: number,
  ports: WorklogSourcePorts
): WorklogTask[] {
  const lo = from - IDLE_GAP_MS
  const hi = to + IDLE_GAP_MS
  return tasks
    .filter((task) => task.status !== 'done' || Date.parse(task.updatedAt) >= from)
    .map((task) => {
      const times = [
        ...task.activity.map((entry) => Date.parse(entry.at)),
        ...task.sessions.flatMap((session) => ports.sessionTimes(session.provider, session.id)),
        ...ports.commitTimes(task, lo)
      ].filter((at) => at >= lo && at < hi)
      return {
        taskId: task.id,
        title: task.title,
        project: task.project,
        intervals: clipIntervals(workIntervals(times), from, to)
      }
    })
    .filter((task) => task.intervals.length > 0)
}

const TIMESTAMP = /"timestamp":"(\d{4}-\d\d-\d\dT[^"]+)"/

/** The first `"timestamp"` on each line of a JSONL transcript, as both CLIs write one per record. */
export function transcriptTimes(text: string): number[] {
  const times: number[] = []
  for (const line of text.split('\n')) {
    const match = TIMESTAMP.exec(line)
    const at = match ? Date.parse(match[1]!) : NaN
    if (Number.isFinite(at)) times.push(at)
  }
  return times
}

const transcriptCache = new Map<string, { mtimeMs: number; size: number; times: number[] }>()

/** `transcriptTimes` of a file, re-read only when it has changed since the last call. */
function cachedTranscriptTimes(file: string): number[] {
  try {
    const { mtimeMs, size } = statSync(file)
    const cached = transcriptCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.times
    const times = transcriptTimes(readFileSync(file, 'utf8'))
    transcriptCache.set(file, { mtimeMs, size, times })
    return times
  } catch {
    return []
  }
}

/** The real sources: the CLIs' transcripts on disk and the task branches in git. */
export function diskWorklogSources(
  workspaceId: string,
  location: WorktreeLocation
): WorklogSourcePorts {
  const bases = new Map<string, string | undefined>()
  return {
    sessionTimes(provider, sessionId) {
      const file = providerById(provider).transcriptPath(sessionId)
      return file ? cachedTranscriptTimes(file) : []
    },
    commitTimes(task, since) {
      const { repoPath } = task
      if (!repoPath || task.useWorktree === false) return []
      try {
        const checkout = checkoutOf(workspaceId, task, repoPath, location)
        const branch = branchNameFor(checkout.key)
        if (!branchExists(repoPath, branch)) return []
        if (!bases.has(repoPath)) bases.set(repoPath, baseBranchFor(repoPath))
        const base = checkout.baseBranch ?? bases.get(repoPath)
        const args = ['log', '--format=%at', `--since=@${Math.floor(since / 1000)}`, branch]
        const out = git(base && base !== branch ? [...args, '--not', base] : args, repoPath)
        return out
          .split('\n')
          .filter(Boolean)
          .map((seconds) => Number(seconds) * 1000)
      } catch {
        return []
      }
    }
  }
}
