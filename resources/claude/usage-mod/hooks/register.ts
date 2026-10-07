import type { Hook, Register } from 'claude-code'

type Engine = Parameters<Hook<'turn.complete'>>[0]

// Loaded only for agents Styr launches (CLAUDE_CODE_PLUGIN_DIRS). Styr names two files and the mod
// does nothing without them: STYR_USAGE_FILE, the account's rate-limit windows (shared by every
// session), and STYR_CONTEXT_FILE, this terminal's own context-window fill.
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

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await record($)
    return result
  })

  // A resumed chat already has a context fill; without this its bar waits for the first turn.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await record($)
    return result
  })
}
