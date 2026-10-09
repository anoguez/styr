import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'turn.complete'>>[0]

// Loaded only for agents Styr launches (CLAUDE_CODE_PLUGIN_DIRS). Styr names three files and the mod
// does nothing without them: STYR_USAGE_FILE, the account's rate-limit windows (shared by every
// session); STYR_CONTEXT_FILE, this terminal's own context-window fill; and STYR_CONVERSATION_FILE,
// this terminal's conversation in Styr's provider-neutral shape (src/core/agentConversation.ts),
// which Styr Terminal draws as blocks in place of the TUI.
async function record($: Engine): Promise<void> {
  try {
    const quotaFile = await $.env.get('STYR_USAGE_FILE')
    const contextFile = await $.env.get('STYR_CONTEXT_FILE')
    if (!quotaFile && !contextFile) return
    const { rateLimits, context } = await $.session.usage()
    const at = new Date().toISOString()
    if (quotaFile && rateLimits.length > 0) {
      await $.fs.write(quotaFile, JSON.stringify({ at, rateLimits }))
    }
    if (contextFile && context.percent !== undefined) {
      const { percent, tokens, window } = context
      await $.fs.write(contextFile, JSON.stringify({ at, context: { percent, tokens, window } }))
    }
  } catch {
    // Usage is a convenience; never disturb the session.
  }
}

/** Messages kept, and how much of any one text: the file is rewritten whole on each change. */
const MESSAGES = 300
const TEXT = 8000
const FIELD = 4000
const RESULT = 2000

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text

/** A tool's arguments, strings clipped: enough to name the call and draw an edit's diff. */
function clipInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') out[key] = clip(value, FIELD)
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (key === 'edits' && Array.isArray(value)) {
      out[key] = value
        .slice(0, 20)
        .map((edit) =>
          typeof edit === 'object' && edit !== null ? clipInput(edit as Record<string, unknown>) : {}
        )
    }
  }
  return out
}

/** The slash commands on offer, refreshed when the session starts and after each turn. */
let commands: { name: string; description: string }[] = []

async function listCommands($: Engine): Promise<void> {
  try {
    commands = (await $.command.list()).map(({ name, description }) => ({
      name,
      description: clip(description, 200)
    }))
  } catch {
    // Keep the last list.
  }
}

/** Writes the conversation so far for Styr, whether a turn is running, and the commands. */
async function conversation($: Engine, working: boolean): Promise<void> {
  try {
    const file = await $.env.get('STYR_CONVERSATION_FILE')
    if (!file) return
    const messages = (await $.session.messages()).slice(-MESSAGES).map((message) => ({
      role: message.role,
      text: clip(message.text, TEXT),
      toolUses: message.toolUses.map((use) => ({
        id: use.tool_use_id,
        tool: use.tool,
        input: clipInput(use.input),
        ...(use.text !== undefined ? { text: clip(use.text, RESULT) } : {}),
        ...(use.isError ? { isError: true } : {})
      }))
    }))
    await $.fs.write(
      file,
      JSON.stringify({ at: new Date().toISOString(), working, messages, commands })
    )
  } catch {
    // The block view is a convenience; never disturb the session.
  }
}

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await record($)
    await listCommands($)
    await conversation($, false)
    return result
  })

  // A resumed chat already has a context fill and a conversation; show both before the first turn.
  // The conversation is read once the session is up: inside session.start it is not loaded yet.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await record($)
    $.clock.after(500, () => void listCommands($).then(() => conversation($, false)))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    await conversation($, true)
    return result
  })

  // Before a tool runs, so the call shows as running, and after, with its result.
  on('tool.call', async ($, e, next) => {
    await conversation($, true)
    const result = await next(e)
    await conversation($, true)
    return result
  })
}
