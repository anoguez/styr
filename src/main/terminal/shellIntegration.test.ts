import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  bashIntegrationScript,
  encodePowerShell,
  fishIntegrationScript,
  fishQuote,
  powershellIntegrationScript,
  shellIntegrationLaunch,
  zshIntegrationScript
} from './shellIntegration.js'

const ESC = String.fromCharCode(27)
const RECORD = new RegExp(`${ESC}\\]777;STYR;([^${ESC}]*)${ESC}\\\\`, 'g')

/** The Styr records in a shell's output, fields decoded. */
function records(output: string): string[][] {
  return Array.from(output.matchAll(RECORD), (match) => {
    const [event, ...fields] = match[1]!.split(';')
    return [event!, ...fields.map((field) => Buffer.from(field, 'base64').toString('utf8'))]
  })
}

/** The records without the working directory, which every prompt repeats. */
function events(output: string): string[][] {
  return records(output)
    .filter(([event]) => event !== 'CWD_CHANGED')
    .map(([event, ...fields]) => {
      if (event === 'COMMAND_STARTED') return [event, fields[1]!]
      return event === 'COMMAND_FINISHED' ? [event, fields[0]!] : [event!]
    })
}

const EXPECTED = [
  ['PROMPT_READY'],
  ['COMMAND_STARTED', 'echo hello'],
  ['COMMAND_FINISHED', '0'],
  ['PROMPT_READY'],
  ['COMMAND_STARTED', 'false'],
  ['COMMAND_FINISHED', '1'],
  ['PROMPT_READY'],
  // An empty line runs nothing: a new prompt, no command.
  ['PROMPT_READY']
]

function onPath(name: string): string | undefined {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

function withDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'styr-shell-integration-'))
  try {
    return run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('shellIntegrationLaunch', () => {
  const shell = (integration?: 'zsh' | 'bash' | 'fish' | 'pwsh', args = ['-l']) => ({
    integration,
    interactiveArgs: args
  })

  it('starts a shell without an integration exactly as configured', () => {
    expect(shellIntegrationLaunch(shell(undefined), {})).toEqual({ args: ['-l'], env: {} })
  })

  it('points zsh at a private startup directory that reads the user’s own', () => {
    const launch = shellIntegrationLaunch(shell('zsh'), { ZDOTDIR: '/home/me/zsh' })
    expect(launch.args).toEqual(['-l'])
    expect(launch.env.STYR_ORIGINAL_ZDOTDIR).toBe('/home/me/zsh')
    expect(existsSync(join(launch.env.ZDOTDIR!, '.zlogin'))).toBe(true)
  })

  it('runs bash with an init file in place of the login profile', () => {
    const launch = shellIntegrationLaunch(shell('bash'), {})
    expect(launch.args[0]).toBe('--init-file')
    expect(existsSync(launch.args[1]!)).toBe(true)
    expect(launch.args).not.toContain('-l')
  })

  it('sources fish’s hooks after its config, as a quoted path', () => {
    const launch = shellIntegrationLaunch(shell('fish'), {})
    expect(launch.args.slice(0, 2)).toEqual(['-l', '--init-command'])
    expect(launch.args[2]).toMatch(/^source '.*fish-integration\.fish'$/)
    expect(fishQuote("it's a\\path")).toBe("'it\\'s a\\\\path'")
  })

  it('passes PowerShell its hooks as an encoded command, after the profile', () => {
    const launch = shellIntegrationLaunch(shell('pwsh', ['-Login', '-NoLogo']), {})
    expect(launch.args.slice(0, 4)).toEqual(['-Login', '-NoLogo', '-NoExit', '-EncodedCommand'])
    const decoded = Buffer.from(launch.args[4]!, 'base64').toString('utf16le')
    expect(decoded).toBe(powershellIntegrationScript())
    expect(encodePowerShell('a')).toBe('YQA=')
  })
})

describe('bash integration', () => {
  it.skipIf(!existsSync('/bin/bash'))('marks prompts and commands in a real bash', () => {
    const output = withDirectory((home) => {
      const script = join(home, 'integration.sh')
      writeFileSync(script, bashIntegrationScript(), 'utf8')
      return execFileSync('/bin/bash', ['--init-file', script, '-i'], {
        input: 'echo hello\nfalse\n\nexit 0\n',
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'ignore']
      })
    })
    expect(events(output).slice(0, EXPECTED.length)).toEqual(EXPECTED)
  })

  it.skipIf(!existsSync('/bin/bash'))(
    'reads the login profile and keeps its prompt command, trap and exit status',
    () => {
      const output = withDirectory((home) => {
        writeFileSync(
          join(home, '.bash_profile'),
          [
            'HISTCONTROL=ignorespace',
            "PROMPT_COMMAND='echo profile-prompt;'",
            "trap ': user-trap' DEBUG",
            'echo profile-read'
          ].join('\n')
        )
        const script = join(home, 'integration.sh')
        writeFileSync(script, bashIntegrationScript(), 'utf8')
        return execFileSync('/bin/bash', ['--init-file', script, '-i'], {
          input: ' echo unrecorded\nfalse\necho "status $?"\nexit\n',
          encoding: 'utf8',
          env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
          stdio: ['pipe', 'pipe', 'ignore']
        })
      })
      expect(output).toContain('profile-read')
      expect(output).toContain('profile-prompt')
      // The profile's prompt command is not taken for the user's, and $? survives the hooks.
      expect(output).toContain('status 1')
      expect(events(output).filter(([event]) => event === 'COMMAND_STARTED')).toEqual([
        // Not in history (ignorespace): its first command stands in for the line.
        ['COMMAND_STARTED', 'echo unrecorded'],
        ['COMMAND_STARTED', 'false'],
        ['COMMAND_STARTED', 'echo "status $?"'],
        ['COMMAND_STARTED', 'exit']
      ])
    }
  )
})

const fish = onPath('fish')

describe('fish integration', () => {
  it('hooks fish’s own events', () => {
    const script = fishIntegrationScript()
    for (const event of ['fish_preexec', 'fish_postexec', 'fish_prompt']) {
      expect(script).toContain(`--on-event ${event}`)
    }
  })

  it.skipIf(!fish)('emits the records from fish’s events', () => {
    const output = withDirectory((home) => {
      const script = join(home, 'integration.fish')
      writeFileSync(script, fishIntegrationScript(), 'utf8')
      return execFileSync(
        fish!,
        [
          '--no-config',
          '-c',
          `source ${fishQuote(script)}; emit fish_prompt; emit fish_preexec 'echo hello'; true; emit fish_postexec 'echo hello'; emit fish_prompt; emit fish_preexec false; false; emit fish_postexec false; emit fish_prompt; emit fish_prompt`
        ],
        { encoding: 'utf8' }
      )
    })
    expect(events(output)).toEqual(EXPECTED)
  })
})

const pwsh = onPath('pwsh')

describe('PowerShell integration', () => {
  it.skipIf(!pwsh)('wraps the prompt and the line reader', () => {
    const output = withDirectory((home) => {
      const script = join(home, 'integration.ps1')
      writeFileSync(script, powershellIntegrationScript(), 'utf8')
      // PSReadLine's reader, replaced by one that returns each line in turn.
      const driver = [
        '$global:__lines = @("echo hello", "Get-Item /nonexistent", "")',
        'function global:PSConsoleHostReadLine { $l = $global:__lines[0]; $global:__lines = @($global:__lines | Select-Object -Skip 1); $l }',
        `. ${"'" + script.replace(/'/g, "''") + "'"}`,
        // As the console host runs it: read a line, run it, show the prompt.
        '$null = prompt',
        '$null = PSConsoleHostReadLine',
        'echo hello | Out-Null',
        '$null = prompt',
        '$null = PSConsoleHostReadLine',
        'Get-Item /nonexistent 2>$null',
        '$null = prompt',
        '$null = PSConsoleHostReadLine',
        '$null = prompt'
      ].join('\n')
      return execFileSync(pwsh!, ['-NoProfile', '-NonInteractive', '-Command', driver], {
        encoding: 'utf8'
      })
    })
    expect(events(output)).toEqual([
      ['PROMPT_READY'],
      ['COMMAND_STARTED', 'echo hello'],
      ['COMMAND_FINISHED', '0'],
      ['PROMPT_READY'],
      ['COMMAND_STARTED', 'Get-Item /nonexistent'],
      ['COMMAND_FINISHED', '1'],
      ['PROMPT_READY'],
      ['PROMPT_READY']
    ])
  })
})

describe('zsh integration', () => {
  it('uses zsh lifecycle hooks and emits only Styr private OSC metadata', () => {
    const script = zshIntegrationScript()

    expect(script).toContain('preexec_functions+=(__styr_preexec)')
    expect(script).toContain('precmd_functions+=(__styr_precmd)')
    expect(script).toContain('chpwd_functions+=(__styr_chpwd)')
    expect(script).toContain('777;STYR;')
    expect(script).toContain('COMMAND_FINISHED')
  })

  it.skipIf(!existsSync('/bin/zsh'))('emits private OSC records from real zsh hooks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'styr-zsh-integration-'))
    const scriptPath = join(directory, 'integration.zsh')
    writeFileSync(scriptPath, zshIntegrationScript(), 'utf8')

    try {
      const output = execFileSync(
        '/bin/zsh',
        [
          '-dfc',
          'source "$1"; __styr_preexec "echo hello"; print -n hello; __styr_precmd',
          'zsh',
          scriptPath
        ],
        { encoding: 'utf8' }
      )

      expect(output).toContain('\x1b]777;STYR;COMMAND_STARTED;')
      expect(output).toContain('\x1b]777;STYR;COMMAND_FINISHED;MA==\x1b\\')
      expect(output).toContain('\x1b]777;STYR;PROMPT_READY;')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
