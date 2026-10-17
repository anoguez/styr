import { afterEach, describe, expect, it, vi } from 'vitest'
import { shippedSettings } from '@core/config.js'
import type { ShellRun, ShellRunner } from '@core/agentCli.js'
import type { Settings } from '@core/types.js'
import { createAgentCliChecks, execFileShell } from './agentCli.js'

/** A runner that answers with the next of `results` (the last repeats) and counts its calls. */
function runner(...results: ShellRun[]): ShellRunner & { calls: number } {
  const run = Object.assign(
    async () => {
      run.calls++
      return results[Math.min(run.calls - 1, results.length - 1)]!
    },
    { calls: 0 }
  )
  return run
}

const READY: ShellRun = { code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' }
const MISSING: ShellRun = { code: 127, stdout: '', stderr: '' }
const NOISY: ShellRun = { code: 1, stdout: '', stderr: 'profile error' }

const settings = { ...shippedSettings(), shell: '/bin/zsh' } as Settings

afterEach(() => vi.restoreAllMocks())

describe('agent CLI checks', () => {
  it('remembers a ready CLI, so the next launch does not check again', async () => {
    const run = runner(READY)
    const checks = createAgentCliChecks(run, 'darwin')
    await checks.ensureAgentCli('claude', settings)
    await checks.ensureAgentCli('claude', settings)
    expect(run.calls).toBe(1)
  })

  it('refuses a launch when the shell does not find the CLI, and checks again next time', async () => {
    const run = runner(MISSING, READY)
    const checks = createAgentCliChecks(run, 'darwin')
    await expect(checks.ensureAgentCli('claude', settings)).rejects.toThrow()
    await expect(checks.ensureAgentCli('claude', settings)).resolves.toBeUndefined()
    expect(run.calls).toBe(2)
  })

  it('lets a launch through when the check only failed, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const checks = createAgentCliChecks(runner(NOISY), 'darwin')
    await expect(checks.ensureAgentCli('claude', settings)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('always checks for Settings, and forgets a CLI that stopped working', async () => {
    const run = runner(READY, MISSING, MISSING)
    const checks = createAgentCliChecks(run, 'darwin')
    const request = { provider: 'claude' as const, command: 'claude', shell: '/bin/zsh' }
    expect((await checks.agentCliStatus(request)).status.state).toBe('ready')
    expect((await checks.agentCliStatus(request)).status.state).toBe('missing')
    await expect(checks.ensureAgentCli('claude', settings)).rejects.toThrow()
    expect(run.calls).toBe(3)
  })

  it('a Settings check that passed spares the next launch its check', async () => {
    const run = runner(READY)
    const checks = createAgentCliChecks(run, 'darwin')
    await checks.agentCliStatus({ provider: 'claude', command: 'claude', shell: '/bin/zsh' })
    await checks.ensureAgentCli('claude', settings)
    expect(run.calls).toBe(1)
  })
})

describe('execFileShell', () => {
  it('reports a program that ran', async () => {
    const result = await execFileShell(
      process.execPath,
      ['-e', 'process.stdout.write("1.2.3")'],
      {}
    )
    expect(result).toEqual({ code: 0, stdout: '1.2.3', stderr: '' })
  })

  it('reports an exit code, or null with the reason when the shell did not run', async () => {
    expect((await execFileShell(process.execPath, ['-e', 'process.exit(3)'], {})).code).toBe(3)
    const missing = await execFileShell('/no/such/shell', [], {})
    expect(missing.code).toBeNull()
    expect(missing.stderr).not.toBe('')
  })
})
