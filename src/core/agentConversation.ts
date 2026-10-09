/**
 * An agent CLI's conversation in Styr's own, provider-neutral shape, and the agent blocks Styr
 * Terminal draws from it in place of the CLI's TUI.
 *
 * The shape is the file each terminal's agent conversation is written to (STYR_CONVERSATION_FILE):
 * whatever a provider's source is — Claude Code's mod writes the file directly — it ends up as
 * `{ at, working, messages }`. What differs between CLIs (their tool names, the notes they wrap a
 * prompt in) is a `ConversationAdapter` in `providers/conversation.ts`; nothing here names one.
 * Pure: the main process parses the file, the renderer maps it. The file is written by a program
 * outside Styr, so the parser trusts nothing in it and bounds what it keeps.
 */
import type {
  AgentMessageBlock,
  AgentToolCallBlock,
  BlockState,
  DiffBlock,
  StyrBlock
} from './types/blocks.js'
import type { AgentProviderId } from './providers/types.js'

export interface ConversationToolUse {
  id: string
  /** The tool's name as the CLI calls it. */
  tool: string
  input: Record<string, unknown>
  /** The result as the model read it; absent while the call runs. */
  text?: string
  isError?: boolean
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  text: string
  toolUses: ConversationToolUse[]
}

/** A command the CLI runs by `/name` (built-in, plugin or MCP), as its own menu lists it. */
export interface AgentCommand {
  name: string
  description: string
}

export interface AgentConversation {
  /** When it was written (ISO). */
  at: string
  /** A turn is running. */
  working: boolean
  messages: ConversationMessage[]
  /** The slash commands the CLI offers now, in its own order; absent when its source has none. */
  commands?: AgentCommand[]
}

/** How one CLI's tool call reads in a block: what it works on, how it went, what it changed. */
export interface ToolDescription {
  summary: string
  result?: string
  edit?: Pick<DiffBlock['payload'], 'path' | 'patch' | 'additions' | 'deletions'>
}

/** What differs between CLIs when their conversation is drawn. Pure; see `providers/conversation.ts`. */
export interface ConversationAdapter {
  /** What a user message says to the person, without the notes the CLI wraps around it. */
  promptText: (raw: string) => string
  describeTool: (use: ConversationToolUse) => ToolDescription
}

const MAX_MESSAGES = 300
const MAX_COMMANDS = 300
const MAX_TEXT = 8_000
const MAX_FIELD = 4_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

function parseInput(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(value).slice(0, 40)) {
    if (typeof field === 'string') out[key] = field.slice(0, MAX_FIELD)
    else if (typeof field === 'number' || typeof field === 'boolean') out[key] = field
    else if (Array.isArray(field) && depth === 0) {
      // A list of edits (and the like): one level of plain records.
      out[key] = field.slice(0, 20).map((item) => parseInput(item, 1))
    }
  }
  return out
}

function parseToolUse(value: unknown): ConversationToolUse | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.tool !== 'string') {
    return null
  }
  return {
    id: value.id.slice(0, 200),
    tool: value.tool.slice(0, 200),
    input: parseInput(value.input),
    ...(typeof value.text === 'string' ? { text: value.text.slice(0, MAX_TEXT) } : {}),
    ...(value.isError === true ? { isError: true } : {})
  }
}

/** A conversation file, or null when it is not one. */
export function parseAgentConversation(source: string): AgentConversation | null {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return null
  }
  if (!isRecord(raw) || !Array.isArray(raw.messages)) return null
  const messages: ConversationMessage[] = []
  for (const item of raw.messages.slice(-MAX_MESSAGES)) {
    if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant')) continue
    messages.push({
      role: item.role,
      text: text(item.text, MAX_TEXT),
      toolUses: Array.isArray(item.toolUses)
        ? item.toolUses
            .slice(0, 50)
            .map(parseToolUse)
            .filter((use): use is ConversationToolUse => use !== null)
        : []
    })
  }
  const commands = Array.isArray(raw.commands)
    ? raw.commands
        .slice(0, MAX_COMMANDS)
        .filter(isRecord)
        .map((command) => ({
          name: text(command.name, 64).replace(/^\//, ''),
          description: text(command.description, 200)
        }))
        .filter((command) => /^[\w:.-]+$/.test(command.name))
    : undefined
  return {
    at: text(raw.at, 64),
    working: raw.working === true,
    messages,
    ...(commands ? { commands } : {})
  }
}

const lines = (value: string): string[] => (value === '' ? [] : value.split('\n'))

/** A patch of edits to one file as removed then added lines, with counts; null for none. */
export function editPatch(
  edits: { old: string; next: string }[]
): Pick<DiffBlock['payload'], 'patch' | 'additions' | 'deletions'> | null {
  if (edits.length === 0) return null
  let additions = 0
  let deletions = 0
  const parts: string[] = []
  for (const edit of edits) {
    const removed = lines(edit.old)
    const added = lines(edit.next)
    deletions += removed.length
    additions += added.length
    parts.push(
      [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join('\n')
    )
  }
  return { patch: parts.join('\n@@\n'), additions, deletions }
}

/** "3 lines", "no output": how much a call returned. */
export function lineCount(value: string): string {
  const count = value.split('\n').filter((line) => line.trim() !== '').length
  return count === 0 ? 'no output' : `${count} line${count === 1 ? '' : 's'}`
}

/**
 * The conversation as Styr blocks, oldest first: what the person typed, what the agent said, each
 * tool call (an edit also as its diff). A call without a result is still running while the turn
 * is, and was cut short once it is not.
 */
export function agentBlocks(
  conversation: AgentConversation,
  sessionId: string,
  adapter: ConversationAdapter,
  provider?: AgentProviderId
): StyrBlock[] {
  const at = Date.parse(conversation.at) || 0
  const envelope = (id: string, state: BlockState) => ({
    id,
    sessionId,
    state,
    createdAt: at,
    updatedAt: at
  })
  const blocks: StyrBlock[] = []
  conversation.messages.forEach((message, index) => {
    const shown = message.role === 'user' ? adapter.promptText(message.text) : message.text.trim()
    if (shown) {
      const block: AgentMessageBlock = {
        ...envelope(`m${index}`, 'completed'),
        kind: 'agent-message',
        payload: { role: message.role, text: shown, ...(provider ? { provider } : {}) }
      }
      blocks.push(block)
    }
    for (const use of message.toolUses) {
      const state: BlockState =
        use.text === undefined
          ? conversation.working
            ? 'streaming'
            : 'cancelled'
          : use.isError
            ? 'failed'
            : 'completed'
      const { summary, result, edit } = adapter.describeTool(use)
      const call: AgentToolCallBlock = {
        ...envelope(use.id, state),
        kind: 'agent-tool-call',
        payload: { tool: use.tool, summary, ...(result !== undefined ? { result } : {}) }
      }
      blocks.push(call)
      if (edit) {
        const diff: DiffBlock = {
          ...envelope(`${use.id}:diff`, state),
          kind: 'diff',
          parentId: use.id,
          payload: edit
        }
        blocks.push(diff)
      }
    }
  })
  return blocks
}

/** The person's prompts, oldest first, for Up and Down in the input. */
export function promptHistory(
  conversation: AgentConversation,
  adapter: ConversationAdapter
): string[] {
  const history: string[] = []
  for (const message of conversation.messages) {
    if (message.role !== 'user') continue
    const prompt = adapter.promptText(message.text)
    if (prompt && history.at(-1) !== prompt) history.push(prompt)
  }
  return history
}
