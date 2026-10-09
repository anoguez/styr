import type { AgentState } from '../agentState.js'
import type { InboxGroup } from '../inbox.js'

export const WORKTREE_BRANCH_PREFIX = 'styr/'

/** The workspace every install has. Its folder is the storage root itself, as before workspaces. */
export const DEFAULT_WORKSPACE_ID = 'default'
export const DEFAULT_WORKSPACE_NAME = 'Default'

/** An isolated board: its own tasks, agents and ids. Not to be confused with `storageDir`. */
export interface WorkspaceInfo {
  id: string
  name: string
}

/** The workspaces as the UI lists them, with what it needs to warn before a delete. */
export interface WorkspaceOverview {
  activeId: string
  workspaces: (WorkspaceInfo & { taskCount: number; liveSessions: number })[]
}

/** How many of a workspace's live agents are in each state, and the most urgent of them. */
export interface WorkspaceAgentActivity {
  counts: Record<AgentState, number>
  /** Idle agents whose task is In Review — the Inbox's "ready for your review". */
  review: number
  /** Most urgent by `AGENT_STATE_ORDER`; unset when every agent has exited. */
  top?: Exclude<AgentState, 'exited'>
}

/**
 * Every workspace's agent rollup, pushed on each agent event. `activeId` is the workspace that was
 * active when it was computed, so a switch never counts the new board's agents as background.
 */
export interface WorkspacesActivity {
  activeId: string
  byWorkspace: Record<string, WorkspaceAgentActivity>
}

/** A workspace's Inbox group sizes, with "Needs you" broken down by why. */
export type WorkspaceBoardSummary = Record<Exclude<InboxGroup, 'done'>, number> &
  Record<'waiting' | 'review' | 'spec', number>

/**
 * What names a task's worktree and branch. Task ids are per workspace, so two workspaces can both
 * hold TASK-0001 on one repo; every non-default workspace therefore prefixes its id. Default keeps
 * the bare id so worktrees made before workspaces existed still resolve. Pure, because the prompt
 * (shared with the renderer) needs the branch name too.
 */
export function worktreeKey(workspaceId: string | undefined, taskId: string): string {
  return !workspaceId || workspaceId === DEFAULT_WORKSPACE_ID ? taskId : `${workspaceId}-${taskId}`
}
