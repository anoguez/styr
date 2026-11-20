import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { supportDir } from './agentStore.js'
import { TASK_ID_RE } from './taskSchema.js'
import type { Settings } from './types.js'

/**
 * A launch the MCP server asks the host for. The MCP server is a plain Node process with no
 * terminals of its own, so `start_task` drops one of these into the workspace's
 * `.styr/launches/` folder; the host's watcher claims it, starts the task exactly as the card's
 * Start does, and answers with a result file beside it.
 */
export const launchRequestSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().regex(TASK_ID_RE),
  templateId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  /** The answer to "is blocked by …, start anyway?" — the card's confirm, given in advance. */
  startAnyway: z.boolean().optional(),
  author: z.string().optional(),
  /** ISO time it was written; a request older than `LAUNCH_REQUEST_TTL_MS` is dropped unanswered. */
  at: z.string()
})
export type LaunchRequest = z.infer<typeof launchRequestSchema>

export const launchResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    sessionId: z.string(),
    taskId: z.string(),
    provider: z.enum(['claude', 'codex']).optional()
  }),
  z.object({ ok: z.literal(false), error: z.string() })
])
export type LaunchResult = z.infer<typeof launchResultSchema>

/** How long a request waits to be claimed. Past it the app is not running, and nothing launches later. */
export const LAUNCH_REQUEST_TTL_MS = 15_000
/** How long a claimed launch (a worktree to create, a CLI to check) may take to answer. */
export const LAUNCH_RESULT_WAIT_MS = 120_000

const REQUEST = /^([0-9a-f-]{36})\.json$/
const resultName = (id: string): string => `${id}.result.json`

export function launchRequestsDir(settings: Settings): string {
  return supportDir(settings, 'launches')
}

function writeAtomically(dir: string, name: string, payload: unknown): void {
  const temp = join(dir, `.${name}.${process.pid}.tmp`)
  writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8')
  renameSync(temp, join(dir, name))
}

/** The MCP side: queues a request and returns its id. */
export function writeLaunchRequest(
  settings: Settings,
  request: Omit<LaunchRequest, 'id' | 'at'>,
  now: Date = new Date()
): LaunchRequest {
  const full = launchRequestSchema.parse({ ...request, id: randomUUID(), at: now.toISOString() })
  writeAtomically(launchRequestsDir(settings), `${full.id}.json`, full)
  return full
}

/**
 * The host side: takes every pending request. Each file is renamed before it is read, so two hosts
 * (or two passes) never start the same request, and the MCP server can tell a claimed request from
 * an ignored one. Expired and unreadable requests are deleted without an answer.
 */
export function claimLaunchRequests(settings: Settings, now: number = Date.now()): LaunchRequest[] {
  const dir = launchRequestsDir(settings)
  const claimed: LaunchRequest[] = []
  for (const name of readdirSync(dir)) {
    const match = REQUEST.exec(name)
    if (!match) continue
    const claimedPath = join(dir, `${match[1]}.claimed`)
    try {
      renameSync(join(dir, name), claimedPath)
    } catch {
      continue // Withdrawn by the MCP server, or claimed by another pass.
    }
    try {
      const request = launchRequestSchema.parse(JSON.parse(readFileSync(claimedPath, 'utf8')))
      if (now - Date.parse(request.at) <= LAUNCH_REQUEST_TTL_MS) claimed.push(request)
    } catch {
      // Not a request this version understands; nothing waits on it.
    }
    rmSync(claimedPath, { force: true })
  }
  return claimed
}

export function writeLaunchResult(settings: Settings, id: string, result: LaunchResult): void {
  writeAtomically(launchRequestsDir(settings), resultName(id), result)
}

export interface LaunchWait {
  now(): number
  sleep(ms: number): Promise<void>
}

const realWait: LaunchWait = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

const POLL_MS = 150

/**
 * The MCP side: waits for the host's answer. A request still unclaimed after the TTL is withdrawn,
 * so a Styr that opens later never starts it out of the blue.
 */
export async function awaitLaunchResult(
  settings: Settings,
  id: string,
  wait: LaunchWait = realWait
): Promise<LaunchResult> {
  const dir = launchRequestsDir(settings)
  const started = wait.now()
  let claimed = false
  for (;;) {
    try {
      const result = launchResultSchema.parse(
        JSON.parse(readFileSync(join(dir, resultName(id)), 'utf8'))
      )
      rmSync(join(dir, resultName(id)), { force: true })
      return result
    } catch {
      // Not answered yet.
    }
    const elapsed = wait.now() - started
    if (!claimed && elapsed >= LAUNCH_REQUEST_TTL_MS) {
      try {
        unlinkSync(join(dir, `${id}.json`))
        return {
          ok: false,
          error: 'Styr did not pick up the request. Is the Styr app (or `styr serve`) running?'
        }
      } catch {
        claimed = true // The host took it; give the launch itself time to finish.
      }
    }
    if (elapsed >= LAUNCH_RESULT_WAIT_MS) {
      return { ok: false, error: 'Styr took the request but did not answer in time.' }
    }
    await wait.sleep(POLL_MS)
  }
}
