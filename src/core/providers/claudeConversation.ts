import {
  editPatch,
  lineCount,
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
      .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, '')
      .replace(/^Caveat:.*$/gm, '')
      // Notes Claude Code adds itself when a turn is cut short.
      .replace(/^\[Request interrupted by user[^\]]*\]$/gm, '')
      .trim()
  )
}

/** One line naming what a call works on: its file, command, pattern or address. */
function summary(use: ConversationToolUse): string {
  const { input } = use
  const first =
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
  const line = first.split('\n')[0] ?? ''
  return first.includes('\n') ? `${line} …` : line
}

const COUNTED = new Set(['Read', 'Bash', 'Grep', 'Glob'])

function result(use: ConversationToolUse): string | undefined {
  if (use.text === undefined) return undefined
  const first = use.text.split('\n').find((line) => line.trim() !== '')
  if (use.isError) return first?.slice(0, 160) ?? 'failed'
  if (COUNTED.has(use.tool)) return lineCount(use.text)
  return first?.slice(0, 160)
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
  return {
    summary: summary(use),
    ...(outcome !== undefined ? { result: outcome } : {}),
    ...(patch && path ? { edit: { path, ...patch } } : {})
  }
}

export const claudeConversation: ConversationAdapter = { promptText, describeTool }
