/**
 * The routing tables of the remote router (`router.ts`): where each IPC channel goes and how it
 * behaves while a remote board is not live. Pure data, so a new channel is classified in one
 * place, and `router.test.ts` checks every channel the server answers has a route.
 */

/** The renderer's board reads and writes: they follow the active workspace. */
export const ACTIVE_CHANNELS: ReadonlySet<string> = new Set([
  'sources:providers',
  'sources:ghStatus',
  'sources:state',
  'sources:restTest',
  'sources:targets',
  'sources:sync',
  'sources:preview',
  'sources:apply',
  'sources:link',
  'sources:unlink',
  'sources:refresh',
  'tasks:list',
  'tasks:get',
  'tasks:problems',
  'tasks:removeWorktree',
  'tasks:create',
  'tasks:update',
  'tasks:note',
  'tasks:reorder',
  'tasks:archive',
  'tasks:delete',
  'tasks:forgetSession',
  'tasks:checkMerged',
  'git:branches',
  'git:taskDiff',
  'git:filePatch',
  'git:diffStats',
  'agents:list',
  'agents:remove',
  'agents:cliStatus',
  'worklog:load',
  'diagnostics:stop',
  'app:mcpCommand',
  'orchestrate:plan',
  'orchestrate:run',
  'orchestrate:autoState',
  'orchestrate:autoSet',
  'terminal:create',
  'terminal:launchAgent',
  'terminal:resumeSession',
  'terminal:previewPrompt',
  'terminal:createPr',
  'terminal:askReview',
  'terminal:gitContext',
  'terminal:listDirectories',
  'usage:claude'
])

/** Calls about one terminal session, whose id is the first argument: they go where it runs. */
export const SESSION_CHANNELS: ReadonlySet<string> = new Set([
  'terminal:kill',
  'terminal:backlog',
  'terminal:runtimeState',
  'terminal:askFork',
  'terminal:handOff',
  'usage:codex',
  'usage:context',
  'agent:conversation',
  'agent:prompt',
  'agent:approval'
])

/** One-way calls about one session (`ipcMain.on`), sent where it runs. */
export const SESSION_SENDS: ReadonlySet<string> = new Set(['terminal:write', 'terminal:resize'])

/**
 * Channels the router answers itself: merging local and remote answers, or acting on this
 * machine for a remote path.
 */
export const SPECIAL_CHANNELS: ReadonlySet<string> = new Set([
  'workspaces:list',
  'workspaces:activity',
  'workspaces:boardSummary',
  'workspaces:switch',
  'workspaces:create',
  'workspaces:rename',
  'workspaces:delete',
  'settings:get',
  'settings:save',
  'settings:brokenFiles',
  'terminal:list',
  'diagnostics:snapshot',
  'tasks:reveal',
  'tasks:openInEditor',
  'terminal:openInCode',
  'terminal:revealDirectory'
])

/** Calls that change something. While a remote board is not live they are refused, never queued. */
export const WRITE_CHANNELS: ReadonlySet<string> = new Set([
  'tasks:removeWorktree',
  'tasks:create',
  'tasks:update',
  'tasks:note',
  'tasks:reorder',
  'tasks:archive',
  'tasks:delete',
  'tasks:forgetSession',
  'tasks:checkMerged',
  'sources:sync',
  'sources:apply',
  'sources:link',
  'sources:unlink',
  'sources:refresh',
  'agents:remove',
  'orchestrate:run',
  'orchestrate:autoSet',
  'terminal:create',
  'terminal:launchAgent',
  'terminal:resumeSession',
  'terminal:kill',
  'terminal:createPr',
  'terminal:askReview',
  'terminal:askFork',
  'terminal:handOff',
  'agent:prompt',
  'agent:approval'
])

/** Reads whose last answer is kept, so a disconnected board stays visible read-only. */
export const SNAPSHOT_CHANNELS: ReadonlySet<string> = new Set([
  'tasks:list',
  'tasks:get',
  'tasks:problems',
  'agents:list',
  'git:diffStats',
  'sources:state',
  'orchestrate:autoState',
  'worklog:load',
  'settings:get'
])

/** What a read answers with when it has no snapshot yet: an empty board, not an error. */
export const OFFLINE_DEFAULTS: Readonly<Record<string, () => unknown>> = {
  'tasks:list': () => [],
  'tasks:get': () => null,
  'tasks:problems': () => [],
  'agents:list': () => [],
  'git:diffStats': () => ({}),
  'sources:state': () => ({})
}

/** Calls whose result is one new terminal session, which the router tags with its host. */
export const SESSION_RESULT_CHANNELS: ReadonlySet<string> = new Set([
  'terminal:create',
  'terminal:launchAgent',
  'terminal:resumeSession',
  'terminal:askReview',
  'terminal:askFork'
])

/** Board broadcasts: from the local services they are dropped while a remote board is active. */
export const BOARD_BROADCASTS: ReadonlySet<string> = new Set([
  'tasks:changed',
  'agents:changed',
  'orchestrate:autoState',
  'orchestrate:autoStarted',
  'sources:state',
  'usage:claude'
])

/** Broadcasts addressed to one terminal session: forwarded from every host. */
export const SESSION_BROADCASTS: ReadonlySet<string> = new Set([
  'terminal:runtimeState',
  'usage:context',
  'agent:conversation'
])

export type ChannelRoute = 'active' | 'session' | 'special' | 'local'

/** Where a channel goes, for the coverage test against the server's table. */
export function channelRoute(channel: string): ChannelRoute {
  if (ACTIVE_CHANNELS.has(channel)) return 'active'
  if (SESSION_CHANNELS.has(channel)) return 'session'
  if (SPECIAL_CHANNELS.has(channel)) return 'special'
  return 'local'
}
