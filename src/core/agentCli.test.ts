import { describe, expect, it } from 'vitest'
import {
  checkAgentCli,
  installCommandFor,
  shellName,
  type AgentCliTarget,
  type ShellRun,
  type ShellRunner
} from './agentCli.js'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

const mac: AgentCliTarget = {
  provider: 'claude',
  command: 'claude',
  shell: '/bin/zsh',
  platform: 'darwin'
}
const windows: AgentCliTarget = { ...mac, shell: GIT_BASH, platform: 'win32' }

/** A runner that records what it was asked to run and answers with `result`. */
function runner(result: ShellRun): ShellRunner & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = []
  const run = (async (shell: string, args: string[]) => {
    calls.push([shell, args])
    return result
  }) as ShellRunner & { calls: [string, string[]][] }
  run.calls = calls
  return run
}

describe('checkAgentCli', () => {
  it('asks the login shell for the version on macOS, as the terminal would run it', async () => {
    const run = runner({ code: 0, stdout: '2.1.294 (Claude Code)\n', stderr: '' })
    const report = await checkAgentCli(mac, run)
    expect(run.calls).toEqual([['/bin/zsh', ['-l', '-c', 'claude --version']]])
    expect(report.status).toEqual({ state: 'ready', version: '2.1.294' })
    expect(report.problem).toBe('')
    expect(report.platform).toBe('darwin')
  })

  it('runs through Git Bash on Windows', async () => {
    const run = runner({ code: 0, stdout: '2.1.294 (Claude Code)', stderr: '' })
    await checkAgentCli(windows, run)
    expect(run.calls).toEqual([[GIT_BASH, ['-l', '-c', 'claude --version']]])
  })

  it('keeps flags from the configured command', async () => {
    const run = runner({ code: 0, stdout: 'codex-cli 0.160.0', stderr: '' })
    const report = await checkAgentCli(
      { ...mac, provider: 'codex', command: 'codex --profile work' },
      run
    )
    expect(run.calls[0]![1]).toEqual(['-l', '-c', 'codex --profile work --version'])
    expect(report.status).toEqual({ state: 'ready', version: '0.160.0' })
  })

  it('reports a missing CLI with the macOS install command', async () => {
    const report = await checkAgentCli(
      mac,
      runner({ code: 127, stdout: '', stderr: 'zsh: command not found: claude' })
    )
    expect(report.status).toEqual({ state: 'missing' })
    expect(report.problem).toContain('was not found by zsh')
    expect(report.installCommand).toBe('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('reports a missing CLI with the Windows install command, naming Git Bash', async () => {
    const report = await checkAgentCli(
      windows,
      runner({ code: 127, stdout: '', stderr: 'bash: claude: command not found' })
    )
    expect(report.problem).toContain('was not found by Git Bash')
    expect(report.problem).toContain('PowerShell')
    expect(report.installCommand).toBe('irm https://claude.ai/install.ps1 | iex')
  })

  it('refuses PowerShell or cmd on Windows without running anything', async () => {
    for (const shell of ['powershell.exe', 'C:\\Windows\\System32\\cmd.exe', 'pwsh']) {
      const run = runner({ code: 0, stdout: '', stderr: '' })
      const report = await checkAgentCli({ ...windows, shell }, run)
      expect(report.status).toEqual({ state: 'unsupported_shell' })
      expect(report.problem).toContain('Git for Windows')
      expect(run.calls).toEqual([])
    }
  })

  it('does not refuse pwsh on macOS, where it has always been allowed', async () => {
    const run = runner({ code: 0, stdout: '2.1.294', stderr: '' })
    const report = await checkAgentCli({ ...mac, shell: '/opt/homebrew/bin/pwsh' }, run)
    expect(report.status.state).toBe('ready')
  })

  it('reports other failures with the first line of the error', async () => {
    const report = await checkAgentCli(
      mac,
      runner({ code: 1, stdout: '', stderr: 'Error: unsupported Node\n  at x' })
    )
    expect(report.status).toEqual({ state: 'failed', detail: 'Error: unsupported Node' })
    expect(report.installCommand).toBeUndefined()
  })

  it('explains a shell that did not start', async () => {
    const report = await checkAgentCli(
      { ...mac, shell: '/no/such/shell' },
      runner({ code: null, stdout: '', stderr: '' })
    )
    expect(report.status).toEqual({
      state: 'failed',
      detail: 'the shell /no/such/shell could not be started'
    })
  })
})

describe('platform naming', () => {
  it('names the install command per OS', () => {
    expect(installCommandFor('claude', 'darwin')).toContain('install.sh')
    expect(installCommandFor('claude', 'win32')).toContain('install.ps1')
    expect(installCommandFor('codex', 'win32')).toBe('npm install -g @openai/codex')
  })

  it('calls bash.exe on Windows Git Bash, and leaves other shells as named', () => {
    expect(shellName(GIT_BASH, 'win32')).toBe('Git Bash')
    expect(shellName('/bin/bash', 'darwin')).toBe('bash')
    expect(
      shellName('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32')
    ).toBe('powershell')
  })
})
