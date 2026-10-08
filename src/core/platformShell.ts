import { existsSync } from 'node:fs'
import { basename, win32 } from 'node:path'

/**
 * The shell a terminal opens when Settings names none. Launch commands, Claude Code's status hooks
 * and dropped file paths are all written for a POSIX shell, so on Windows that is Git Bash — which
 * Claude Code itself requires there — and PowerShell only when Git for Windows is not installed.
 * `$SHELL` is ignored on Windows: set by an MSYS shell, it is a path like `/usr/bin/bash` that only
 * that shell can resolve.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  // Most Linux systems (and WSL distros) ship bash, not zsh.
  if (platform === 'linux') return env.SHELL ?? '/bin/bash'
  if (platform !== 'win32') return env.SHELL ?? '/bin/zsh'
  return findGitBash(env) ?? 'powershell.exe'
}

/**
 * Git for Windows' `bin\bash.exe` (the wrapper that sets up its PATH, not `usr\bin\bash.exe`).
 * Honours Claude Code's own override, then the standard install folders, then the `git.exe` on
 * PATH. Never `System32\bash.exe`, which is WSL and sees a different filesystem.
 */
export function findGitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  // Windows path rules whatever the host, so the logic (and its tests) read the same on any OS.
  const { join } = win32
  const candidates: string[] = []
  if (env.CLAUDE_CODE_GIT_BASH_PATH) candidates.push(env.CLAUDE_CODE_GIT_BASH_PATH)
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (root) candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
  }
  if (env.LOCALAPPDATA)
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'))
  for (const dir of pathEntries(env)) {
    // Git's installer puts either `<root>\cmd` or `<root>\bin` on PATH.
    if (exists(join(dir, 'git.exe'))) candidates.push(join(dir, '..', 'bin', 'bash.exe'))
  }
  return candidates.find((path) => exists(path))
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  // Windows spells it `Path`; a spread of process.env keeps that spelling.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return ((key && env[key]) || '').split(win32.delimiter).filter(Boolean)
}

type ShellKind = 'posix' | 'powershell' | 'cmd'

function shellKind(shell: string): ShellKind {
  const name = basename(shell.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (name === 'powershell' || name === 'pwsh') return 'powershell'
  if (name === 'cmd') return 'cmd'
  return 'posix'
}

/** Whether `shell` understands the POSIX syntax Styr types into it (quoting, `$(…)`). */
export function isPosixShell(shell: string): boolean {
  return shellKind(shell) === 'posix'
}

/**
 * Arguments that start `shell` as an interactive login shell, so it reads the user's profile.
 * Outside Windows every shell gets `-l`, as it always has (pwsh accepts it there too).
 */
export function interactiveShellArgs(
  shell: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  return platform !== 'win32' || shellKind(shell) === 'posix' ? ['-l'] : []
}

/**
 * Arguments that run one command line through `shell` the way a terminal would: a login shell, so
 * a GUI-launched app sees the PATH the user set up in their profile. Outside Windows this is always
 * `-l -c`, as it always has been.
 */
export function commandShellArgs(
  shell: string,
  line: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'win32') return ['-l', '-c', line]
  switch (shellKind(shell)) {
    case 'powershell':
      return ['-NoLogo', '-NoProfile', '-Command', line]
    case 'cmd':
      return ['/d', '/s', '/c', line]
    default:
      return ['-l', '-c', line]
  }
}

/**
 * Extra environment for a terminal running `shell`. Git Bash's login profile changes to `$HOME`
 * unless CHERE_INVOKING is set, which would drop a task's worktree as the working directory.
 */
export function shellEnvironment(
  shell: string,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  return platform === 'win32' && isPosixShell(shell) ? { CHERE_INVOKING: '1' } : {}
}
