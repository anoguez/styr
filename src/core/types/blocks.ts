import type { AgentProviderId } from '../providers/types.js'

/**
 * Styr's agent-native block model: the unit a terminal panel can show, whether it came from a shell
 * or from an agent. Every kind shares one lifecycle and one envelope, so a renderer lays them out
 * without knowing which kinds exist, and a new kind is a new `kind` plus a payload — not a new
 * pipeline. Terminal emulation stays out of it: an `active-terminal` block points at a live session
 * by id and the session's engine (xterm.js or Styr Terminal) draws it. See `core/blocks.ts` for the
 * lifecycle rules and docs/architecture/terminal-engine.md for how the two fit together.
 */

/**
 * `pending`: announced, nothing to show yet. `streaming`: content is arriving. `awaiting-input`: it
 * waits on the user (an approval, an interactive program). `completed`/`failed`/`cancelled` are
 * final: a block in one of them never changes again.
 */
export type BlockState =
  'pending' | 'streaming' | 'awaiting-input' | 'completed' | 'failed' | 'cancelled'

export interface BlockEnvelope<K extends string, P> {
  id: string
  kind: K
  /** The terminal session the block belongs to. */
  sessionId: string
  /** The block this one answers or belongs to: an output's command, a tool call's agent message. */
  parentId?: string
  state: BlockState
  /** Epoch milliseconds. */
  createdAt: number
  updatedAt: number
  payload: P
}

export type CommandBlock = BlockEnvelope<
  'command',
  { command: string; cwd: string; exitCode?: number; startedAt: number; endedAt?: number }
>

/** A command's output as plain text, capped by whoever produces it. */
export type OutputBlock = BlockEnvelope<'output', { text: string; truncated: boolean }>

export type AgentMessageBlock = BlockEnvelope<
  'agent-message',
  { role: 'user' | 'assistant'; text: string; provider?: AgentProviderId }
>

export type AgentToolCallBlock = BlockEnvelope<
  'agent-tool-call',
  { tool: string; summary: string; result?: string }
>

export type DiffBlock = BlockEnvelope<
  'diff',
  { path: string; patch: string; additions: number; deletions: number }
>

export type ApprovalBlock = BlockEnvelope<
  'approval',
  { prompt: string; options: string[]; decision?: string }
>

/** A live terminal grid embedded in the stream; the session's engine renders it. */
export type ActiveTerminalBlock = BlockEnvelope<
  'active-terminal',
  { terminalSessionId: string; fullscreen: boolean }
>

export type StyrBlock =
  | CommandBlock
  | OutputBlock
  | AgentMessageBlock
  | AgentToolCallBlock
  | DiffBlock
  | ApprovalBlock
  | ActiveTerminalBlock

export type BlockKind = StyrBlock['kind']

export const BLOCK_KINDS = [
  'command',
  'output',
  'agent-message',
  'agent-tool-call',
  'diff',
  'approval',
  'active-terminal'
] as const satisfies readonly BlockKind[]
