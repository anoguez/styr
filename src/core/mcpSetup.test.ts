import { describe, expect, it } from 'vitest'
import { resolveShell } from './platformShell.js'
import { checkMcpSetup, pointsAt, type McpSetupTarget } from './mcpSetup.js'
import type { ShellRun } from './agentCli.js'

// Fixtures are the real output of `claude mcp get styr` / `codex mcp get styr`.
const ENTRY = '/Applications/Styr.app/Contents/Resources/app.asar.unpacked/out/main/mcp/index.mjs'
const claudeOut = (args: string): ShellRun => ({
  code: 0,
  stdout: `styr:\n  Scope: User config (available in all your projects)\n  Status: ✔ Connected\n  Type: stdio\n  Command: node\n  Args: ${args}\n  Environment:\n\nTo remove this server, run: claude mcp remove styr -s user\n`,
  stderr: ''
})
const codexOut = (args: string): ShellRun => ({
  code: 0,
  stdout: `styr\n  enabled: true\n  transport: stdio\n  command: node\n  args: ${args}\n  cwd: -\n  env: STYR_MCP_AUTHOR=*****\n  remove: codex mcp remove styr\n`,
  stderr: ''
})
const CLAUDE_MISSING: ShellRun = {
  code: 1,
  stdout: 'No MCP server named "styr". Configured servers: claude_design',
  stderr: ''
}
const CODEX_MISSING: ShellRun = {
  code: 1,
  stdout: '',
  stderr: "Error: No MCP server named 'styr' found."
}

function target(
  provider: 'claude' | 'codex',
  platform: NodeJS.Platform = 'darwin'
): McpSetupTarget {
  return { provider, command: provider, shell: resolveShell('/bin/zsh', 'darwin'), platform }
}

const state = async (
  provider: 'claude' | 'codex',
  run: ShellRun,
  exists = true,
  expected = ENTRY
): Promise<string> =>
  (
    await checkMcpSetup(
      target(provider),
      expected,
      async () => run,
      () => exists
    )
  ).state

describe('checkMcpSetup', () => {
  it.each([
    ['claude', claudeOut, CLAUDE_MISSING],
    ['codex', codexOut, CODEX_MISSING]
  ] as const)('reads %s: registered, stale, missing', async (provider, out, missing) => {
    expect(await state(provider, out(ENTRY))).toBe('registered')
    expect(await state(provider, out('/old/place/mcp/index.mjs'))).toBe('stale')
    expect(await state(provider, out(ENTRY), false)).toBe('stale')
    expect(await state(provider, missing)).toBe('missing')
  })

  it('is unknown when the CLI is absent, fails oddly, times out or prints something else', async () => {
    expect(await state('claude', { code: 127, stdout: '', stderr: '' })).toBe('unknown')
    expect(await state('claude', { code: 1, stdout: '', stderr: 'profile error' })).toBe('unknown')
    expect(await state('codex', { code: null, stdout: '', stderr: 'ETIMEDOUT' })).toBe('unknown')
    expect(await state('codex', { code: 0, stdout: 'garbage', stderr: '' })).toBe('unknown')
  })

  it('is unknown, without running anything, in a shell that cannot carry a launch', async () => {
    let ran = false
    const shell = { ...resolveShell('/bin/zsh', 'darwin'), unsupported: 'No.' }
    const report = await checkMcpSetup(
      { ...target('claude'), shell },
      ENTRY,
      async () => ((ran = true), claudeOut(ENTRY)),
      () => true
    )
    expect(report.state).toBe('unknown')
    expect(ran).toBe(false)
  })

  it('probes with the configured command, flags included, and offers the fix-it commands', async () => {
    let line = ''
    const report = await checkMcpSetup(
      { ...target('claude'), command: 'claude --model x' },
      ENTRY,
      async (_path, args) => ((line = args.join(' ')), claudeOut('/old/index.mjs')),
      () => true
    )
    expect(line).toContain('claude --model x mcp get styr')
    expect(report.registeredEntry).toBe('/old/index.mjs')
    expect(report.removeCommand).toBe('claude mcp remove styr -s user')
    expect(report.installCommand).toContain(`'${ENTRY}'`)
  })

  it('compares the script path only, ignoring a runner flag before it', async () => {
    expect(await state('claude', claudeOut(`--no-warnings ${ENTRY}`))).toBe('registered')
  })
})

describe('pointsAt', () => {
  it('compares Windows paths case-insensitively and across slash styles', () => {
    const entry = 'C:\\Program Files\\Styr\\out\\main\\mcp\\index.mjs'
    expect(pointsAt('c:/program files/styr/out/main/mcp/index.mjs', entry, 'win32')).toBe(true)
    expect(pointsAt('c:/program files/styr/out/main/mcp/index.mjs', entry, 'linux')).toBe(false)
    expect(pointsAt('/a/B/index.mjs', '/a/b/index.mjs', 'darwin')).toBe(false)
  })
})
