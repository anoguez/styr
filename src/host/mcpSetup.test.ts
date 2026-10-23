import { describe, expect, it } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { ShellRun, ShellRunner } from '@core/agentCli.js'
import type { Settings } from '@core/types.js'
import { createMcpSetupChecks } from './mcpSetup.js'

const ENTRY = '/opt/styr/mcp/index.mjs'
const at = (path: string): ShellRun => ({
  code: 0,
  stdout: `styr:\n  Type: stdio\n  Command: node\n  Args: ${path}\n`,
  stderr: ''
})
const MISSING: ShellRun = { code: 1, stdout: 'No MCP server named "styr".', stderr: '' }
const settings = { ...shippedSettings(), shell: '/bin/zsh' } as Settings

function setup(...results: ShellRun[]) {
  const state = { calls: 0 }
  const run: ShellRunner = async () => results[Math.min(state.calls++, results.length - 1)]!
  const checks = createMcpSetupChecks(
    run,
    () => ENTRY,
    () => settings,
    'darwin',
    () => true
  )
  return { state, checks }
}

describe('MCP setup checks', () => {
  it('remembers a registered answer', async () => {
    const { state, checks } = setup(at(ENTRY))
    await checks.mcpSetupStatus({ provider: 'claude' })
    expect((await checks.mcpSetupStatus({ provider: 'claude' })).state).toBe('registered')
    expect(state.calls).toBe(1)
  })

  it('checks a missing, stale or unknown answer again, so registering works without a restart', async () => {
    const { state, checks } = setup(
      MISSING,
      at('/old/index.mjs'),
      { code: null, stdout: '', stderr: '' },
      at(ENTRY)
    )
    const states = []
    for (let i = 0; i < 4; i++)
      states.push((await checks.mcpSetupStatus({ provider: 'claude' })).state)
    expect(states).toEqual(['missing', 'stale', 'unknown', 'registered'])
    expect(state.calls).toBe(4)
  })

  it('bypasses and refreshes the remembered answer when fresh', async () => {
    const { state, checks } = setup(at(ENTRY), MISSING)
    await checks.mcpSetupStatus({ provider: 'claude' })
    expect((await checks.mcpSetupStatus({ provider: 'claude', fresh: true })).state).toBe('missing')
    expect(state.calls).toBe(2)
    expect((await checks.mcpSetupStatus({ provider: 'claude' })).state).toBe('missing')
    expect(state.calls).toBe(3)
  })

  it('keeps each provider’s answer apart', async () => {
    const { state, checks } = setup(at(ENTRY))
    await checks.mcpSetupStatus({ provider: 'claude' })
    await checks.mcpSetupStatus({ provider: 'codex' })
    expect(state.calls).toBe(2)
  })
})
