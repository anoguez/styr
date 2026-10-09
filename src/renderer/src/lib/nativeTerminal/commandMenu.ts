import type { AgentCommand } from '@core/agentConversation.js'
import { rankBy } from '../fuzzy.js'

/** Commands the menu lists at once; the rest are a keystroke away. */
export const MENU_LIMIT = 50

/**
 * The command being typed, without its slash: the input is `/` and a name with no space yet.
 * Null for anything else, so the menu shows only while a command is being chosen.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s]*)$/.exec(text)
  return match ? (match[1] ?? '') : null
}

/**
 * The commands that fit `query`, best first: names starting with it ahead of the rest, then the
 * fuzzy score. With nothing typed, the CLI's own order.
 */
export function matchCommands(query: string, commands: AgentCommand[]): AgentCommand[] {
  if (query === '') return commands.slice(0, MENU_LIMIT)
  const lower = query.toLowerCase()
  return rankBy(query, commands, (command) => command.name)
    .sort((left, right) => {
      const a = left.item.name.toLowerCase().startsWith(lower) ? 1 : 0
      const b = right.item.name.toLowerCase().startsWith(lower) ? 1 : 0
      return b - a || right.score - left.score
    })
    .slice(0, MENU_LIMIT)
    .map((ranked) => ranked.item)
}

/** Whether a submitted line runs a command rather than talking to the agent. */
export function isSlashCommand(text: string): boolean {
  return /^\/[\w:.-]+(\s|$)/.test(text.trim())
}
