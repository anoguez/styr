import {
  lineCount,
  parseAgentConversation,
  type AgentConversation,
  type ConversationAdapter,
  type ConversationMessage,
  type ConversationToolUse,
  type ToolDescription
} from '../agentConversation.js'

const MAX_TURNS = 300
const MAX_ITEMS_PER_TURN = 100
const MAX_TEXT = 8_000

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const bounded = (value: unknown, max = MAX_TEXT): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

function contentText(value: unknown): string {
  if (typeof value === 'string') return bounded(value)
  if (!Array.isArray(value)) return ''
  return value
    .slice(0, 50)
    .map((part) => {
      if (typeof part === 'string') return part
      const item = record(part)
      return item?.type === 'text' ? bounded(item.text) : ''
    })
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT)
}

function itemTools(item: Record<string, unknown>): ConversationToolUse[] {
  const type = bounded(item.type, 80)
  const id = bounded(item.id, 200)
  if (!id) return []
  if (type === 'commandExecution') {
    const command = bounded(item.command, 4_000)
    const output = bounded(item.aggregatedOutput)
    const finished = ['completed', 'failed', 'declined', 'canceled'].includes(
      bounded(item.status, 40)
    )
    return [
      {
        id,
        tool: 'shell',
        input: { command },
        ...(finished ? { text: output } : {}),
        ...(item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0)
          ? { isError: true }
          : {})
      }
    ]
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.slice(0, 20) : []
    return changes.flatMap((value, index) => {
      const change = record(value)
      const path = bounded(change?.path, 1_000)
      const patch = bounded(change?.diff, MAX_TEXT)
      return path
        ? [
            {
              id: `${id}:${index}`,
              tool: 'apply_patch',
              input: { file_path: path, patch },
              text: ''
            }
          ]
        : []
    })
  }
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'collabAgentToolCall') {
    const tool = bounded(item.tool, 200) || bounded(item.toolName, 200) || type
    const input = record(item.arguments) ?? record(item.input) ?? {}
    const output = bounded(item.result ?? item.content)
    const finished = ['completed', 'failed', 'declined', 'canceled'].includes(
      bounded(item.status, 40)
    )
    return [
      {
        id,
        tool,
        input,
        ...(finished || output ? { text: output } : {}),
        ...(item.status === 'failed' ? { isError: true } : {})
      }
    ]
  }
  return []
}

/** Converts app-server thread/read data into the bounded neutral conversation file shape. */
export function codexConversationFromThread(value: unknown): AgentConversation | null {
  const root = record(value)
  const thread = record(root?.thread) ?? root
  if (!thread || !Array.isArray(thread.turns)) return null
  const messages: ConversationMessage[] = []
  let toolCount = 0
  for (const turnValue of thread.turns.slice(-MAX_TURNS)) {
    const turn = record(turnValue)
    if (!Array.isArray(turn?.items)) continue
    for (const itemValue of turn.items.slice(0, MAX_ITEMS_PER_TURN)) {
      if (messages.length >= 300 || toolCount >= 500) break
      const item = record(itemValue)
      if (!item) continue
      const type = bounded(item.type, 80)
      if (type === 'userMessage' || type === 'agentMessage') {
        const text = contentText(item.content ?? item.text)
        const role = type === 'userMessage' ? 'user' : 'assistant'
        if (text) messages.push({ role, text, toolUses: [] })
      }
      const tools = itemTools(item)
      if (tools.length > 0) {
        const previous = messages.at(-1)
        const remaining = Math.min(
          50 - (previous?.role === 'assistant' ? previous.toolUses.length : 0),
          500 - toolCount
        )
        if (remaining <= 0) continue
        const kept = tools.slice(0, remaining)
        toolCount += kept.length
        if (previous?.role === 'assistant') previous.toolUses.push(...kept)
        else messages.push({ role: 'assistant', text: '', toolUses: kept })
      }
    }
  }
  const status = record(thread.status)
  const timestamp =
    typeof thread.updatedAt === 'number'
      ? thread.updatedAt < 100_000_000_000
        ? thread.updatedAt * 1_000
        : thread.updatedAt
      : NaN
  const date = new Date(timestamp)
  const at = Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString()
  // Reuse the shared strict parser for final per-field, array, and text bounds.
  return parseAgentConversation(
    JSON.stringify({ at, working: status?.type === 'active', promptInbox: true, messages })
  )
}

const str = (input: Record<string, unknown>, key: string): string | undefined =>
  typeof input[key] === 'string' ? (input[key] as string) : undefined

function promptText(raw: string): string {
  return raw
    .replace(
      /<(?:environment_context|permissions instructions|system-reminder)>[\s\S]*?<\/(?:environment_context|permissions instructions|system-reminder)>/g,
      ''
    )
    .trim()
}

function describeTool(use: ConversationToolUse): ToolDescription {
  const command = str(use.input, 'command') ?? ''
  const path = str(use.input, 'file_path')
  if (use.tool === 'apply_patch' && path) {
    const patch = str(use.input, 'patch') ?? ''
    const additions = patch
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length
    const deletions = patch
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---')).length
    return {
      summary: path,
      ...(use.text !== undefined ? { result: use.isError ? 'failed' : 'updated' } : {}),
      edit: { path, patch, additions, deletions }
    }
  }
  const summary = command.split('\n')[0] ?? ''
  const output = use.text
  return {
    summary:
      summary ||
      Object.values(use.input).find((entry): entry is string => typeof entry === 'string') ||
      '',
    ...(output !== undefined
      ? {
          result: use.isError ? output.split('\n')[0]?.slice(0, 160) || 'failed' : lineCount(output)
        }
      : {})
  }
}

export const codexConversation: ConversationAdapter = { promptText, describeTool }
