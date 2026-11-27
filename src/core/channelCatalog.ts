/**
 * Every IPC channel the remote router (`host/remote/router.ts`) routes, one entry each: where a
 * call goes and how it behaves while a remote board is not live. The router's tables
 * (`host/remote/channels.ts`) are derived from it, so classifying a channel is one entry here.
 * A channel with no entry is answered locally. Plain data: no Electron, no `node:*`, so the
 * renderer, the host layer and `styr serve` can all import it.
 */

/**
 * Where a call goes: the active workspace's host (`active`), the host running the session whose
 * id is the first argument (`session`), the router itself, merging local and remote answers or
 * acting on this machine for a remote path (`special`), or this machine (`local`).
 */
export type ChannelRoute = 'active' | 'session' | 'special' | 'local'

/**
 * What a read answers with while it has no snapshot yet: an empty board, not an error. `off` is
 * a switch that reads as off (`{ on: false }`).
 */
export type OfflineDefault = 'list' | 'none' | 'record' | 'off'

export interface ChannelSpec {
  readonly route: ChannelRoute
  /** One-way (`ipcMain.on`) rather than invoked; only a `session` channel is sent. */
  readonly send?: true
  /** Changes something: while a remote board is not live it is refused, never queued. */
  readonly write?: true
  /** A read whose last answer is kept, so a disconnected board stays visible read-only. */
  readonly snapshot?: true
  /** A read's answer while it has no snapshot (`OfflineDefault`). Never on a write. */
  readonly offline?: OfflineDefault
  /** Answers with one new terminal session, which the router tags with its host. */
  readonly sessionResult?: true
}

export const CHANNEL_CATALOG = {
  'sources:providers': { route: 'active' },
  'sources:ghStatus': { route: 'active' },
  'sources:state': { route: 'active', snapshot: true, offline: 'record' },
  'sources:restTest': { route: 'active' },
  'sources:targets': { route: 'active' },
  'sources:sync': { route: 'active', write: true },
  'sources:preview': { route: 'active' },
  'sources:apply': { route: 'active', write: true },
  'sources:link': { route: 'active', write: true },
  'sources:unlink': { route: 'active', write: true },
  'sources:refresh': { route: 'active', write: true },

  'tasks:list': { route: 'active', snapshot: true, offline: 'list' },
  'tasks:get': { route: 'active', snapshot: true, offline: 'none' },
  'tasks:problems': { route: 'active', snapshot: true, offline: 'list' },
  'tasks:removeWorktree': { route: 'active', write: true },
  'tasks:create': { route: 'active', write: true },
  'tasks:update': { route: 'active', write: true },
  'tasks:note': { route: 'active', write: true },
  'tasks:reorder': { route: 'active', write: true },
  'tasks:archive': { route: 'active', write: true },
  'tasks:delete': { route: 'active', write: true },
  'tasks:forgetSession': { route: 'active', write: true },
  'tasks:checkMerged': { route: 'active', write: true },

  'files:uploadImage': { route: 'active', write: true },
  'tasks:reveal': { route: 'special' },
  'tasks:openInEditor': { route: 'special' },

  'git:branches': { route: 'active' },
  'git:taskDiff': { route: 'active' },
  'git:filePatch': { route: 'active' },
  'git:diffStats': { route: 'active', snapshot: true, offline: 'record' },

  'agents:list': { route: 'active', snapshot: true, offline: 'list' },
  'agents:remove': { route: 'active', write: true },
  'agents:cliStatus': { route: 'active' },
  'agents:mcpStatus': { route: 'active' },

  'worklog:load': { route: 'active', snapshot: true },

  'review:get': { route: 'active' },
  'review:save': { route: 'active', write: true },
  'review:prepare': { route: 'active' },
  'review:requestChanges': { route: 'active', write: true },

  'diagnostics:stop': { route: 'active' },
  'diagnostics:snapshot': { route: 'special' },

  'app:mcpCommand': { route: 'active' },

  // Read as soon as a remote workspace opens, before its host has said hello: no plan yet, and
  // Auto-run off, until the live answers replace them.
  'orchestrate:plan': { route: 'active', snapshot: true, offline: 'none' },
  'orchestrate:run': { route: 'active', write: true },
  'orchestrate:autoState': { route: 'active', snapshot: true, offline: 'off' },
  'orchestrate:autoSet': { route: 'active', write: true },

  'terminal:create': { route: 'active', write: true, sessionResult: true },
  'terminal:launchAgent': { route: 'active', write: true, sessionResult: true },
  'terminal:resumeSession': { route: 'active', write: true, sessionResult: true },
  'terminal:previewPrompt': { route: 'active' },
  'terminal:createPr': { route: 'active', write: true },
  'terminal:askReview': { route: 'active', write: true, sessionResult: true },
  'terminal:gitContext': { route: 'active' },
  'terminal:listDirectories': { route: 'active' },
  'terminal:kill': { route: 'session', write: true },
  'terminal:backlog': { route: 'session' },
  'terminal:runtimeState': { route: 'session' },
  'terminal:askFork': { route: 'session', write: true, sessionResult: true },
  'terminal:handOff': { route: 'session', write: true },
  'terminal:write': { route: 'session', send: true },
  'terminal:resize': { route: 'session', send: true },
  'terminal:list': { route: 'special' },
  'terminal:openInCode': { route: 'special' },
  'terminal:revealDirectory': { route: 'special' },

  'usage:claude': { route: 'active' },
  'usage:codex': { route: 'session' },
  'usage:context': { route: 'session' },

  'agent:conversation': { route: 'session' },
  'agent:prompt': { route: 'session', write: true },
  'agent:approval': { route: 'session', write: true },
  'agent:answerQuestion': { route: 'session', write: true },

  'workspaces:list': { route: 'special' },
  'workspaces:activity': { route: 'special' },
  'workspaces:boardSummary': { route: 'special' },
  'workspaces:switch': { route: 'special' },
  'workspaces:create': { route: 'special' },
  'workspaces:rename': { route: 'special' },
  'workspaces:delete': { route: 'special' },

  'settings:get': { route: 'special', snapshot: true },
  'settings:save': { route: 'special' },
  'settings:brokenFiles': { route: 'special' }
} as const satisfies Record<string, ChannelSpec>

export type CatalogChannel = keyof typeof CHANNEL_CATALOG

/** The catalog as entries, for deriving the router's tables. */
export const CHANNEL_SPECS: readonly (readonly [string, ChannelSpec])[] =
  Object.entries(CHANNEL_CATALOG)
