import type { AgentMessageBlock, AgentToolCallBlock } from '@core/types/blocks.js'

/**
 * Folding the chat's tool calls: a run of two or more calls in a row (nothing said between them)
 * shows as one group row that names what is in it and, while one of its calls runs, what that call
 * is doing. Opening the group shows the calls as before. Pure; `AgentBlockList` draws it.
 */

export type ChatRow = AgentMessageBlock | AgentToolCallBlock

export interface ToolGroup {
  kind: 'tool-group'
  /** The first call's id: the group keeps it (and its open state) as later calls join. */
  id: string
  calls: AgentToolCallBlock[]
}

/** A row of the chat as drawn: a message, a lone call, or a group of calls. */
export type ChatItem = { row: ChatRow; avatar: boolean } | { row: ToolGroup; avatar: boolean }

/** A call not finished yet: running, about to, or waiting on the person. */
export const isRunning = (state: AgentToolCallBlock['state']): boolean =>
  state === 'streaming' || state === 'pending' || state === 'awaiting-input'

const isUserMessage = (row: ChatRow | undefined): boolean =>
  row?.kind === 'agent-message' && row.payload.role === 'user'

/**
 * The rows as drawn, with runs of calls folded into groups. `avatar` marks the first row of each of
 * the agent's turns (the first after the person's message), where Styr's avatar goes.
 */
export function groupToolCalls(rows: ChatRow[]): ChatItem[] {
  const items: ChatItem[] = []
  let at = 0
  while (at < rows.length) {
    const row = rows[at]!
    const avatar = !isUserMessage(row) && (at === 0 || isUserMessage(rows[at - 1]))
    if (row.kind !== 'agent-tool-call') {
      items.push({ row, avatar })
      at += 1
      continue
    }
    const calls: AgentToolCallBlock[] = []
    while (rows[at]?.kind === 'agent-tool-call') {
      calls.push(rows[at] as AgentToolCallBlock)
      at += 1
    }
    items.push(
      calls.length === 1
        ? { row: calls[0]!, avatar }
        : { row: { kind: 'tool-group', id: calls[0]!.id, calls }, avatar }
    )
  }
  return items
}

/** What a group row says about its calls. */
export interface ToolGroupSummary {
  /** Each tool and how many calls of it, in order of first use: "Bash ×4 · Read ×2". */
  label: string
  /** The call running now (the latest, if several), whose work the row shows live. */
  running?: AgentToolCallBlock
  failed: number
  /** The group's own state: running while any call runs, failed if any failed, else completed. */
  state: AgentToolCallBlock['state']
}

export function summarizeToolGroup(calls: AgentToolCallBlock[]): ToolGroupSummary {
  const counts = new Map<string, number>()
  for (const call of calls) counts.set(call.payload.tool, (counts.get(call.payload.tool) ?? 0) + 1)
  const label = [...counts]
    .map(([tool, count]) => (count === 1 ? tool : `${tool} ×${count}`))
    .join(' · ')
  const running = calls.findLast((call) => isRunning(call.state))
  const failed = calls.filter((call) => call.state === 'failed').length
  const state: AgentToolCallBlock['state'] = running
    ? running.state
    : failed > 0
      ? 'failed'
      : calls.every((call) => call.state === 'cancelled')
        ? 'cancelled'
        : 'completed'
  return { label, running, failed, state }
}
