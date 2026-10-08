import { win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultShell, findGitBash, findPwsh, resolveShell } from './platformShell.js'

const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'

describe('defaultShell', () => {
  it('keeps $SHELL, then zsh, on macOS', () => {
    expect(defaultShell({ SHELL: '/bin/bash' }, 'darwin')).toBe('/bin/bash')
    expect(defaultShell({}, 'darwin')).toBe('/bin/zsh')
  })

  it('keeps $SHELL on Linux and falls back to bash, which every distro has', () => {
    expect(defaultShell({ SHELL: '/usr/bin/zsh' }, 'linux')).toBe('/usr/bin/zsh')
    expect(defaultShell({}, 'linux')).toBe('/bin/bash')
  })

  it('ignores an MSYS $SHELL on Windows', () => {
    expect(defaultShell({ SHELL: '/usr/bin/bash', Path: '' }, 'win32')).not.toBe('/usr/bin/bash')
  })
})

describe('resolveShell on macOS and Linux', () => {
  it('starts bash and zsh exactly as before', () => {
    for (const path of ['/bin/zsh', '/bin/bash', '/usr/bin/fish']) {
      const shell = resolveShell(path, 'darwin')
      expect(shell.path).toBe(path)
      expect(shell.syntax.dialect).toBe('posix')
      expect(shell.interactiveArgs).toEqual(['-l'])
      expect(shell.commandArgs('claude --version')).toEqual(['-l', '-c', 'claude --version'])
      expect(shell.environment).toEqual({})
      expect(shell.unsupported).toBeUndefined()
    }
    expect(resolveShell('/bin/zsh', 'darwin').label).toBe('zsh')
  })

  it('speaks PowerShell to pwsh, as a login shell', () => {
    const shell = resolveShell('/opt/homebrew/bin/pwsh', 'darwin')
    expect(shell.syntax.dialect).toBe('powershell')
    expect(shell.interactiveArgs).toEqual(['-Login', '-NoLogo'])
    expect(shell.commandArgs('x')).toEqual(['-Login', '-NoLogo', '-Command', 'x'])
    expect(shell.unsupported).toBeUndefined()
  })

  it('falls back to the platform default when Settings names no shell', () => {
    expect(resolveShell('', 'darwin', { SHELL: '/bin/zsh' }).path).toBe('/bin/zsh')
  })
})

describe('resolveShell on Windows', () => {
  it('runs Git Bash as a login shell that stays in the launch directory', () => {
    const shell = resolveShell(GIT_BASH, 'win32')
    expect(shell.label).toBe('Git Bash')
    expect(shell.syntax.dialect).toBe('posix')
    expect(shell.interactiveArgs).toEqual(['-l'])
    expect(shell.commandArgs('x')).toEqual(['-l', '-c', 'x'])
    expect(shell.environment).toEqual({ CHERE_INVOKING: '1' })
    expect(shell.unsupported).toBeUndefined()
  })

  it('supports PowerShell 7 with its profile loaded', () => {
    const shell = resolveShell(PWSH, 'win32')
    expect(shell.label).toBe('PowerShell 7')
    expect(shell.syntax.dialect).toBe('powershell')
    expect(shell.interactiveArgs).toEqual(['-NoLogo'])
    expect(shell.commandArgs('x')).toEqual(['-NoLogo', '-Command', 'x'])
    expect(shell.unsupported).toBeUndefined()
  })

  it('opens Windows PowerShell and cmd as terminals but says why agents cannot launch', () => {
    const legacy = resolveShell('powershell.exe', 'win32')
    expect(legacy.syntax.dialect).toBe('powershell')
    expect(legacy.unsupported).toContain('PowerShell 7')
    const cmd = resolveShell('C:\\Windows\\System32\\cmd.exe', 'win32')
    expect(cmd.syntax.dialect).toBe('cmd')
    expect(cmd.unsupported).toContain('Git Bash or PowerShell 7')
  })
})

describe('findGitBash', () => {
  it('prefers Claude Code’s override', () => {
    const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\bash.exe', ProgramFiles: 'C:\\PF' }
    expect(findGitBash(env, () => true)).toBe('D:\\tools\\bash.exe')
  })

  it('finds the standard install folder', () => {
    const expected = win32.join('C:\\PF', 'Git', 'bin', 'bash.exe')
    expect(findGitBash({ ProgramFiles: 'C:\\PF' }, (path) => path === expected)).toBe(expected)
  })

  it('derives bash from the git.exe on PATH', () => {
    const gitCmd = win32.join('E:\\Git', 'cmd')
    const bash = win32.join(gitCmd, '..', 'bin', 'bash.exe')
    const exists = (path: string): boolean =>
      path === win32.join(gitCmd, 'git.exe') || path === bash
    expect(findGitBash({ Path: gitCmd }, exists)).toBe(bash)
  })

  it('finds nothing when Git is not installed', () => {
    expect(findGitBash({ ProgramFiles: 'C:\\PF', Path: 'C:\\Windows' }, () => false)).toBe(
      undefined
    )
  })
})

describe('findPwsh', () => {
  it('finds PowerShell 7 in its install folder, then on PATH', () => {
    expect(findPwsh({ ProgramFiles: 'C:\\Program Files' }, (path) => path === PWSH)).toBe(PWSH)
    const onPath = win32.join('D:\\tools', 'pwsh.exe')
    expect(findPwsh({ Path: 'D:\\tools' }, (path) => path === onPath)).toBe(onPath)
  })

  it('never returns Windows PowerShell', () => {
    const legacy = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'
    expect(findPwsh({ Path: legacy }, (path) => path.endsWith('powershell.exe'))).toBe(undefined)
  })
})
