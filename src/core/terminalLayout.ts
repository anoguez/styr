import { isAgentArchived } from './agentState.js'
import type { TabsOffer, TerminalSessionInfo } from './types.js'
import { z } from 'zod'

/**
 * The terminal tabs of the last session, as `~/.styr/terminal-tabs.json` keeps them. Pure: the
 * file, the sessions and the restore itself are in `host/terminalTabs.ts`. The layout is
 * machine-local state, so it is neither a setting nor in the index; losing it offers nothing.
 */

export const LAYOUT_VERSION = 1

const entrySchema = z.object({
  kind: z.enum(['shell', 'agent']),
  cwd: z.string().min(1),
  title: z.string(),
  taskId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  provider: z.enum(['claude', 'codex']).optional()
})

export const layoutFileSchema = z.object({
  version: z.literal(LAYOUT_VERSION),
  savedAt: z.string(),
  /** Index into `tabs` of the active tab; absent when none was. */
  active: z.number().int().min(0).optional(),
  tabs: z.array(entrySchema).max(500)
})

export type LayoutEntry = z.infer<typeof entrySchema>
export type LayoutFile = z.infer<typeof layoutFileSchema>

/** A file that is missing, unparseable or of another version offers nothing. */
export function parseLayoutFile(text: string): LayoutFile | undefined {
  try {
    const parsed = layoutFileSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/**
 * The entry a session is saved as; none for what a relaunch cannot bring back: a remote session
 * (it keeps running and reattaches itself), a read-back of a past chat, or an Ask / fork chat.
 * `cwd` is where a shell is now.
 */
export function layoutEntry(session: TerminalSessionInfo, cwd: string): LayoutEntry | undefined {
  if (session.host || session.replay) return undefined
  if (!session.taskId) {
    return { kind: 'shell', cwd, title: session.title, ...workspaceOf(session) }
  }
  if (!session.provider || !session.workspaceId) return undefined
  return {
    kind: 'agent',
    cwd: session.cwd,
    title: session.title,
    taskId: session.taskId,
    workspaceId: session.workspaceId,
    provider: session.provider
  }
}

function workspaceOf(session: TerminalSessionInfo): { workspaceId?: string } {
  return session.workspaceId ? { workspaceId: session.workspaceId } : {}
}

/**
 * The live sessions in tab order: the order the renderer reported, then any session it has not
 * mentioned yet (just created) in the order given.
 */
export function inTabOrder(
  sessions: TerminalSessionInfo[],
  order: readonly string[]
): TerminalSessionInfo[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const reported = order.flatMap((id) => {
    const session = byId.get(id)
    byId.delete(id)
    return session ? [session] : []
  })
  return [...reported, ...byId.values()]
}

/**
 * What the file holds: the entries still waiting for an answer, then the live tabs, so a crash
 * before the answer still offers the old ones. `active` is the live active tab, else the pending one.
 */
export function composeLayout(
  pending: readonly LayoutEntry[],
  pendingActive: LayoutEntry | undefined,
  live: readonly LayoutEntry[],
  liveActive: number | undefined,
  savedAt: string
): LayoutFile {
  const tabs = [...pending, ...live]
  const active =
    liveActive !== undefined
      ? pending.length + liveActive
      : pendingActive
        ? pending.indexOf(pendingActive)
        : -1
  return {
    version: LAYOUT_VERSION,
    savedAt,
    ...(active >= 0 ? { active } : {}),
    tabs
  }
}

/**
 * The pending entries a user can answer now: shells (they have no workspace to need) and the agent
 * tabs of the active workspace. Agent tabs of another workspace wait until it is the active one.
 */
export function splitPending(
  pending: readonly LayoutEntry[],
  activeWorkspaceId: string
): { now: LayoutEntry[]; later: LayoutEntry[] } {
  const now: LayoutEntry[] = []
  const later: LayoutEntry[] = []
  for (const entry of pending) {
    ;(entry.kind === 'shell' || entry.workspaceId === activeWorkspaceId ? now : later).push(entry)
  }
  return { now, later }
}

export function offerFor(now: readonly LayoutEntry[], auto: boolean): TabsOffer | null {
  if (now.length === 0) return null
  return { tabs: now.length, agents: now.filter((entry) => entry.kind === 'agent').length, auto }
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

/** The banner's question. Once only agent tabs wait (another workspace's), it says so. */
export function offerText(offer: Pick<TabsOffer, 'tabs' | 'agents'>): string {
  if (offer.tabs === offer.agents) {
    return `Restore ${plural(offer.agents, 'agent tab')} from your last session`
  }
  const agents = offer.agents > 0 ? ` (${plural(offer.agents, 'agent')})` : ''
  return `Restore ${plural(offer.tabs, 'terminal tab')} from your last session${agents}`
}

/** The line a finished restore leaves in the banner. */
export function restoreSummary(restored: number, skipped: readonly string[]): string {
  if (skipped.length === 0) return `${restored} restored`
  return `${restored} restored · ${skipped.length} not restored: ${skipped.join('; ')}`
}

/** Why a shell cannot come back; a missing folder is skipped, never replaced by the home folder. */
export function shellSkip(entry: LayoutEntry, folderExists: boolean): string | undefined {
  return folderExists ? undefined : `${entry.cwd} no longer exists`
}

/**
 * Why a task's agent tab cannot come back, or undefined when it can. A task with no saved chat is
 * skipped rather than started fresh, which would send a prompt and move the card.
 */
export function agentSkip(
  taskId: string,
  task: { status: Parameters<typeof isAgentArchived>[0]['status']; archivedAt?: string } | null,
  chatExists: boolean
): string | undefined {
  if (!task) return `${taskId} no longer exists`
  if (isAgentArchived(task)) return `${taskId} is done or archived`
  if (!chatExists) return `${taskId} has no saved chat`
  return undefined
}
