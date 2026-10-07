import type { Register } from 'claude-code'

// Loaded only for agents Styr launches (CLAUDE_CODE_PLUGIN_DIRS). Styr names the file in
// STYR_USAGE_FILE; without it the mod does nothing. The quota is per account, not per task.
export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      const file = await $.env.get('STYR_USAGE_FILE')
      if (file) {
        const { rateLimits } = await $.session.usage()
        if (rateLimits.length > 0) {
          await $.fs.write(file, JSON.stringify({ at: new Date().toISOString(), rateLimits }))
        }
      }
    } catch {
      // Usage is a convenience; never disturb the turn.
    }
    return result
  })
}
