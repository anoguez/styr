import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { syntaxFor, type ShellDialect, type ShellSyntax } from './shell.js'

/**
 * A terminal shell as Styr uses it: how to start it, how to run one command line through it, and
 * the syntax to type into it. Resolved once from the configured shell and the OS by `resolveShell`;
 * every consumer (the PTY, launches, the CLI check, the Codex monitor) asks it rather than looking
 * at the shell's name — the same rule as `providerFor` for agent CLIs.
 */
export interface TerminalShell {
  /** The executable to spawn, as configured or found. */
  path: string
  /** The name shown to the user: "Git Bash", "PowerShell 7", "zsh". */
  label: string
  syntax: ShellSyntax
  /** Arguments that start it as an interactive shell that reads the user's profile. */
  interactiveArgs: string[]
  /**
   * Arguments that run `line` and exit, loading the same profile an interactive session would, so
   * the PATH matches what a launch in the terminal will see.
   */
  commandArgs(line: string): string[]
  /** Extra environment for a terminal running it. */
  environment: Record<string, string>
  /** Why agents cannot be launched from it, in words; undefined when they can. */
  unsupported?: string
}

/**
 * The shell a terminal opens when Settings names none: `$SHELL` (else zsh) on macOS, `$SHELL` (else
 * bash) on Linux. On Windows, Git Bash first — Claude Code runs its hooks and its own commands
 * through it — then PowerShell 7, and Windows PowerShell only when neither is installed. `$SHELL` is
 * ignored on Windows: set by an MSYS shell, it is a path like `/usr/bin/bash` only that shell knows.
 */
export function defaultShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') return env.SHELL ?? '/bin/zsh'
  return findGitBash(env) ?? findPwsh(env) ?? 'powershell.exe'
}

type ShellKind = 'posix' | 'pwsh' | 'windows-powershell' | 'cmd'

function executableName(path: string): string {
  return (path.replace(/\\/g, '/').split('/').pop() ?? path).toLowerCase().replace(/\.exe$/, '')
}

function kindOf(path: string): ShellKind {
  const name = executableName(path)
  if (name === 'pwsh') return 'pwsh'
  if (name === 'powershell') return 'windows-powershell'
  if (name === 'cmd') return 'cmd'
  return 'posix'
}

const DIALECTS: Record<ShellKind, ShellDialect> = {
  posix: 'posix',
  pwsh: 'powershell',
  'windows-powershell': 'powershell',
  cmd: 'cmd'
}

const SUGGESTION =
  'Choose Git Bash or PowerShell 7 under Settings → Preferences → Shell ' +
  '(install PowerShell 7 with `winget install Microsoft.PowerShell`).'

/**
 * Describes the shell a terminal runs: `configured` (Settings → Shell), else the platform default.
 * On macOS and Linux every shell other than pwsh is started exactly as it always has been (`-l`,
 * `-l -c`), so nothing there changes with this abstraction.
 */
export function resolveShell(
  configured: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): TerminalShell {
  const path = configured || defaultShell(env, platform)
  const kind = kindOf(path)
  const syntax = syntaxFor(DIALECTS[kind])
  const name = executableName(path)
  const windows = platform === 'win32'

  switch (kind) {
    case 'posix':
      return {
        path,
        label: windows && name === 'bash' ? 'Git Bash' : name,
        syntax,
        interactiveArgs: ['-l'],
        commandArgs: (line) => ['-l', '-c', line],
        // Git Bash's login profile changes to $HOME unless CHERE_INVOKING is set, which would drop
        // a task's worktree as the working directory.
        environment: windows ? { CHERE_INVOKING: '1' } : {}
      }
    case 'pwsh':
      return {
        path,
        label: 'PowerShell 7',
        syntax,
        // -Login is how pwsh reads a login profile on macOS and Linux; Windows has no such notion.
        interactiveArgs: windows ? ['-NoLogo'] : ['-Login', '-NoLogo'],
        commandArgs: (line) => [...(windows ? [] : ['-Login']), '-NoLogo', '-Command', line],
        environment: {}
      }
    case 'windows-powershell':
      return {
        path,
        label: 'Windows PowerShell',
        syntax,
        interactiveArgs: ['-NoLogo'],
        commandArgs: (line) => ['-NoLogo', '-Command', line],
        environment: {},
        unsupported:
          'Windows PowerShell 5.1 passes arguments that contain quotes to programs incorrectly, ' +
          `so an agent would receive a broken prompt. ${SUGGESTION}`
      }
    case 'cmd':
      return {
        path,
        label: 'Command Prompt',
        syntax,
        interactiveArgs: [],
        commandArgs: (line) => ['/d', '/s', '/c', line],
        environment: {},
        unsupported: `Command Prompt cannot pass a multi-line prompt to an agent. ${SUGGESTION}`
      }
  }
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

/**
 * PowerShell 7's `pwsh.exe`: its standard install folder, then PATH. Never Windows PowerShell 5.1
 * (`powershell.exe`), whose argument passing breaks agent prompts.
 */
export function findPwsh(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): string | undefined {
  const { join } = win32
  const candidates: string[] = []
  for (const root of [env.ProgramFiles, env.ProgramW6432]) {
    if (root) candidates.push(join(root, 'PowerShell', '7', 'pwsh.exe'))
  }
  for (const dir of pathEntries(env)) candidates.push(join(dir, 'pwsh.exe'))
  return candidates.find((path) => exists(path))
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  // Windows spells it `Path`; a spread of process.env keeps that spelling.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  return ((key && env[key]) || '').split(win32.delimiter).filter(Boolean)
}
