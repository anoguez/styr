import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  commandShellArgs,
  defaultShell,
  findGitBash,
  interactiveShellArgs,
  isPosixShell,
  shellEnvironment
} from './platformShell.js'

describe('defaultShell', () => {
  it('keeps $SHELL, then zsh, on macOS', () => {
    expect(defaultShell({ SHELL: '/bin/bash' }, 'darwin')).toBe('/bin/bash')
    expect(defaultShell({}, 'darwin')).toBe('/bin/zsh')
  })

  it('keeps $SHELL on Linux and falls back to bash, which every distro has', () => {
    expect(defaultShell({ SHELL: '/usr/bin/zsh' }, 'linux')).toBe('/usr/bin/zsh')
    expect(defaultShell({}, 'linux')).toBe('/bin/bash')
  })

  it('ignores an MSYS $SHELL on Windows and falls back to PowerShell without Git Bash', () => {
    expect(defaultShell({ SHELL: '/usr/bin/bash' }, 'win32')).not.toBe('/usr/bin/bash')
    expect(defaultShell({ SHELL: '/usr/bin/bash', Path: '' }, 'win32')).toMatch(
      /bash\.exe$|powershell\.exe$/
    )
  })
})

describe('findGitBash', () => {
  it('prefers Claude Code’s override', () => {
    const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\bash.exe', ProgramFiles: 'C:\\PF' }
    expect(findGitBash(env, () => true)).toBe('D:\\tools\\bash.exe')
  })

  it('finds the standard install folder', () => {
    const expected = join('C:\\PF', 'Git', 'bin', 'bash.exe')
    expect(findGitBash({ ProgramFiles: 'C:\\PF' }, (path) => path === expected)).toBe(expected)
  })

  it('derives bash from the git.exe on PATH', () => {
    const gitCmd = join('E:\\Git', 'cmd')
    const bash = join(gitCmd, '..', 'bin', 'bash.exe')
    const exists = (path: string): boolean => path === join(gitCmd, 'git.exe') || path === bash
    expect(findGitBash({ Path: gitCmd }, exists)).toBe(bash)
  })

  it('finds nothing when Git is not installed', () => {
    expect(findGitBash({ ProgramFiles: 'C:\\PF', Path: 'C:\\Windows' }, () => false)).toBe(
      undefined
    )
  })
})

describe('shell arguments', () => {
  it('keeps the macOS arguments exactly as they were, whatever the shell', () => {
    for (const shell of ['/bin/zsh', '/bin/bash', '/opt/homebrew/bin/pwsh']) {
      expect(interactiveShellArgs(shell, 'darwin')).toEqual(['-l'])
      expect(commandShellArgs(shell, 'codex --version', 'darwin')).toEqual([
        '-l',
        '-c',
        'codex --version'
      ])
    }
  })

  it('starts Git Bash as a login shell on Windows', () => {
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe'
    expect(interactiveShellArgs(bash, 'win32')).toEqual(['-l'])
    expect(commandShellArgs(bash, 'x', 'win32')).toEqual(['-l', '-c', 'x'])
  })

  it('passes no login flag to PowerShell or cmd on Windows', () => {
    expect(interactiveShellArgs('powershell.exe', 'win32')).toEqual([])
    expect(interactiveShellArgs('C:\\Windows\\System32\\cmd.exe', 'win32')).toEqual([])
    expect(isPosixShell('pwsh')).toBe(false)
    expect(commandShellArgs('pwsh.exe', 'x', 'win32')).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-Command',
      'x'
    ])
    expect(commandShellArgs('cmd.exe', 'x', 'win32')).toEqual(['/d', '/s', '/c', 'x'])
  })

  it('keeps Git Bash in the launch directory on Windows only', () => {
    expect(shellEnvironment('bash.exe', 'win32')).toEqual({ CHERE_INVOKING: '1' })
    expect(shellEnvironment('powershell.exe', 'win32')).toEqual({})
    expect(shellEnvironment('/bin/zsh', 'darwin')).toEqual({})
  })
})
