import type { McpProbeResult, McpRegistration } from './types.js'

/**
 * Reads the output of `<cli> mcp get styr`, which both CLIs print as a few labelled lines. `argsLine`
 * captures the value of the line naming the server's arguments (the script path, for a `node`
 * server). A server the CLI does not know exits non-zero with "No MCP server named …"; any other
 * failure, or a server without arguments (an HTTP one), is `unknown` rather than `missing`.
 */
export function parseMcpGet(result: McpProbeResult, argsLine: RegExp): McpRegistration {
  if (result.code === null) return { state: 'unknown' }
  if (result.code === 0) {
    const entry = argsLine.exec(result.stdout)?.[1]?.trim()
    return entry ? { state: 'registered', entry } : { state: 'unknown' }
  }
  return /No MCP server named/i.test(`${result.stdout}\n${result.stderr}`)
    ? { state: 'missing' }
    : { state: 'unknown' }
}
