import { describe, expect, it } from 'vitest'
import {
  checkAgentCli,
  installCommandFor,
  type AgentCliTarget,
  type ShellRun,
  type ShellRunner
} from './agentCli.js'
import { resolveShell } from './platformShell.js'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

const mac: AgentCliTarget = {
  provider: 'claude',
  command: 'claude',
  shell: resolveShell('/bin/zsh', 'darwin'),
  platform: 'darwin'
}
const gitBash: AgentCliTarget = {
  ...mac,
  shell: resolveShell(GIT_BASH, 'win32'),
  platform: 'win32'
}
const pwsh: AgentCliTarget = { ...gitBash, shell: resolveShell(PWSH, 'win32') }

type Call = [string, string[], Record<string, string>]

/** A runner that records what it was asked to run and answers with `result`. */
function runner(result: ShellRun): ShellRunner & { calls: Call[] } {
  const calls: Call[] = []
  const run = async (path: string, args: string[], environment: Record<string, string>) => {
    calls.push([path, args, environment])
    return result
  }
  return Object.assign(run, { calls })
}

describe('checkAgentCli', () => {
  it('asks the login shell for the version on macOS, as the terminal would run it', async () => {
    const run = runner({ code: 0, stdout: '2.1.294 (Claude Code)\n', stderr: '' })
    const report = await checkAgentCli(mac, run)
    expect(run.calls).toEqual([['/bin/zsh', ['-l', '-c', 'claude --version'], {}]])
    expect(report.status).toEqual({ state: 'ready', version: '2.1.294' })
    expect(report.shellLabel).toBe('zsh')
    expect(report.problem).toBe('')
  })

  it('runs through Git Bash on Windows, kept in the launch directory', async () => {
    const run = runner({ code: 0, stdout: '2.1.294 (Claude Code)', stderr: '' })
    await checkAgentCli(gitBash, run)
    expect(run.calls).toEqual([
      [GIT_BASH, ['-l', '-c', 'claude --version'], { CHERE_INVOKING: '1' }]
    ])
  })

  it('runs through PowerShell 7 in its own syntax, mapping not-found to 127', async () => {
    const run = runner({ code: 0, stdout: '2.1.294 (Claude Code)', stderr: '' })
    const report = await checkAgentCli(pwsh, run)
    const [path, args] = run.calls[0]!
    expect(path).toBe(PWSH)
    expect(args.slice(0, 2)).toEqual(['-NoLogo', '-Command'])
    expect(args[2]).toMatch(/^try \{ & claude --version; exit \$LASTEXITCODE \} catch/)
    expect(report.status).toEqual({ state: 'ready', version: '2.1.294' })
    expect(report.shellLabel).toBe('PowerShell 7')
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
    const report = await checkAgentCli(mac, runner({ code: 127, stdout: '', stderr: 'not found' }))
    expect(report.status).toEqual({ state: 'missing' })
    expect(report.problem).toContain('was not found by zsh')
    expect(report.installCommand).toBe('curl -fsSL https://claude.ai/install.sh | bash')
  })

  it('reports a missing CLI in PowerShell 7 with the Windows install command', async () => {
    const report = await checkAgentCli(pwsh, runner({ code: 127, stdout: '', stderr: '' }))
    expect(report.status).toEqual({ state: 'missing' })
    expect(report.problem).toContain('was not found by PowerShell 7')
    expect(report.installCommand).toBe('irm https://claude.ai/install.ps1 | iex')
  })

  it('refuses Windows PowerShell and cmd without running anything, saying why', async () => {
    for (const path of ['powershell.exe', 'C:\\Windows\\System32\\cmd.exe']) {
      const run = runner({ code: 0, stdout: '', stderr: '' })
      const report = await checkAgentCli({ ...gitBash, shell: resolveShell(path, 'win32') }, run)
      expect(report.status).toEqual({ state: 'unsupported_shell' })
      expect(report.problem).toContain('PowerShell 7')
      expect(run.calls).toEqual([])
    }
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
      { ...mac, shell: resolveShell('/no/such/shell', 'darwin') },
      runner({ code: null, stdout: '', stderr: '' })
    )
    expect(report.status).toEqual({
      state: 'failed',
      detail: 'the shell /no/such/shell could not be started'
    })
  })
})

describe('installCommandFor', () => {
  it('names the official install command per OS', () => {
    expect(installCommandFor('claude', 'darwin')).toContain('install.sh')
    expect(installCommandFor('claude', 'win32')).toContain('install.ps1')
    expect(installCommandFor('codex', 'win32')).toBe('npm install -g @openai/codex')
  })
})
