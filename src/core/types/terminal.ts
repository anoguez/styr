/**
 * The syntax a terminal shell speaks (see `ShellSyntax` in shell.ts): `posix` is sh, bash, zsh and
 * Git Bash; `powershell` is PowerShell 7 and Windows PowerShell; `cmd` is the Command Prompt.
 */
export type ShellDialect = 'posix' | 'powershell' | 'cmd'

export interface TerminalSessionInfo {
  id: string
  /** The task's title when the session was started, or a plain label for a shell. */
  title: string
  cwd: string
  /** What the session's shell speaks, so the renderer types `cd` and dropped paths it understands. */
  dialect?: ShellDialect
  taskId?: string
  /** The workspace the task belongs to; task ids are only unique within one. */
  workspaceId?: string
  provider?: 'claude' | 'codex'
  /** A read-back of a past chat rather than the task's live session. */
  replay?: boolean
}

/**
 * Where a command began or ended in a terminal's output stream. `offset` counts characters into the
 * `data` it travels with, so the renderer can pause between writes and anchor a marker exactly
 * there; nothing about it reaches xterm itself.
 */
export interface TerminalMark {
  offset: number
  kind: 'start' | 'end'
  /** The runtime's id for the command, shared by its start and end marks. */
  id: string
  command?: string
  exitCode?: number
  /** Epoch milliseconds. */
  at: number
}

/** One piece of a terminal's output, with the command boundaries inside it. */
export interface TerminalOutput {
  data: string
  sequence: number
  marks: TerminalMark[]
}

/** A completed shell command. Additional terminal and agent metadata can be added over time. */
export interface TerminalCommand {
  id: string
  command: string
  cwd: string
  startedAt: number
  endedAt?: number
  exitCode?: number
  /** Output is capped by the main-process terminal runtime. */
  output?: string
}

/**
 * Main-process owned semantic state for a terminal session. Unlike `TerminalSessionInfo.cwd`,
 * `cwd` follows the shell as it changes directories.
 */
export interface TerminalRuntimeState {
  sessionId: string
  cwd: string
  promptReady: boolean
  runningCommand?: Pick<TerminalCommand, 'id' | 'command' | 'cwd' | 'startedAt'>
  lastCommand?: TerminalCommand
  lastExitCode?: number
  terminated?: boolean
}
