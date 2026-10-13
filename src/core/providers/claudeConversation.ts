import {
  editPatch,
  lineCount,
  outputText,
  type ConversationAdapter,
  type ConversationToolUse,
  type ToolDescription
} from '../agentConversation.js'

/**
 * Claude Code's side of a drawn conversation: the notes it wraps around a user message, and its
 * own tool names (`Read`, `Edit`, `Bash`…). Pure, as the renderer imports it.
 */

const str = (input: Record<string, unknown>, key: string): string | undefined =>
  typeof input[key] === 'string' ? (input[key] as string) : undefined

/** What a user message says: Claude Code tags its own notes (`<system-reminder>`, a slash command). */
function promptText(raw: string): string {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(raw)?.[1]?.trim()
  const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)?.[1]?.trim()
  if (command) return args ? `${command} ${args}` : command
  return (
    raw
      // Text pasted into Claude Code's own input is filed as pasted content: show what was pasted.
      .replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g, '$1')
      .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, '')
      .replace(/^Caveat:.*$/gm, '')
      // Notes Claude Code adds itself when a turn is cut short.
      .replace(/^\[Request interrupted by user[^\]]*\]$/gm, '')
      .trim()
  )
}

/** An MCP tool's server and name, from Claude Code's `mcp__<server>__<tool>`. */
function mcpTool(tool: string): { server: string; name: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(tool)
  return match ? { server: match[1]!, name: match[2]! } : null
}

/** An MCP call's arguments in a line, as Claude Code's own view lists them. */
function argumentsLine(input: Record<string, unknown>): string {
  return Object.entries(input)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => {
      const shown = typeof value === 'string' ? JSON.stringify(value.split('\n')[0]) : String(value)
      return `${key}: ${shown.length > 120 ? `${shown.slice(0, 119)}…` : shown}`
    })
    .join(', ')
}

/** What a call works on: its file, command (every line of it), pattern or address. */
function summary(use: ConversationToolUse): string {
  const { input } = use
  if (mcpTool(use.tool)) return argumentsLine(input)
  return (
    str(input, 'file_path') ??
    str(input, 'notebook_path') ??
    str(input, 'command') ??
    str(input, 'pattern') ??
    str(input, 'url') ??
    str(input, 'query') ??
    str(input, 'description') ??
    str(input, 'prompt') ??
    Object.values(input).find((value): value is string => typeof value === 'string') ??
    ''
  ).trim()
}

const COUNTED = new Set(['Read', 'Bash', 'Grep', 'Glob'])
/** Tools whose result says nothing the block does not show already: a file read, an edit's diff. */
const QUIET = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'TodoWrite'])

function result(use: ConversationToolUse): string | undefined {
  if (use.text === undefined) return undefined
  const first = use.text.split('\n').find((line) => line.trim() !== '')
  if (use.isError) return first?.slice(0, 160) ?? 'failed'
  if (COUNTED.has(use.tool)) return lineCount(use.text)
  return first?.slice(0, 160)
}

function output(use: ConversationToolUse): string | undefined {
  if (use.text === undefined || (QUIET.has(use.tool) && !use.isError)) return undefined
  return outputText(use.text) || undefined
}

function edits(use: ConversationToolUse): { old: string; next: string }[] {
  const { tool, input } = use
  if (tool === 'Edit') {
    return [{ old: str(input, 'old_string') ?? '', next: str(input, 'new_string') ?? '' }]
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits
      .filter((edit): edit is Record<string, unknown> => typeof edit === 'object' && edit !== null)
      .map((edit) => ({ old: str(edit, 'old_string') ?? '', next: str(edit, 'new_string') ?? '' }))
  }
  if (tool === 'Write') return [{ old: '', next: str(input, 'content') ?? '' }]
  return []
}

function describeTool(use: ConversationToolUse): ToolDescription {
  const path = str(use.input, 'file_path')
  const patch = path ? editPatch(edits(use)) : null
  const outcome = result(use)
  const shown = output(use)
  const mcp = mcpTool(use.tool)
  return {
    ...(mcp ? { name: `${mcp.server} · ${mcp.name}` } : {}),
    summary: summary(use),
    ...(outcome !== undefined ? { result: outcome } : {}),
    ...(shown ? { output: shown } : {}),
    ...(patch && path ? { edit: { path, ...patch } } : {})
  }
}

export const claudeConversation: ConversationAdapter = {
  promptText,
  describeTool,
  // Claude Code reads an image off the clipboard on Ctrl+V (Cmd+V pastes only text).
  pasteImageKey: '\x16'
}
