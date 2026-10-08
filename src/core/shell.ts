/**
 * What Styr types into a terminal, per shell dialect. Pure, so the renderer can quote a dropped path
 * or build a `cd` for the shell a session actually runs. Which dialect a shell speaks, and how it is
 * started, is decided in one place: `resolveShell` in platformShell.ts. Never branch on the shell
 * anywhere else; ask its syntax.
 */

import type { ShellDialect } from './types.js'

export type { ShellDialect }

export interface ShellSyntax {
  dialect: ShellDialect
  /** `value` as one literal argument. */
  quote(value: string): string
  /**
   * The start of a line that runs `command` — as configured in Settings, so it may carry flags or
   * be a quoted path. PowerShell treats a line that starts with a quoted string as a value, so it
   * needs the call operator; POSIX shells take the command as is.
   */
  invoke(command: string): string
  /** One argument holding the whole contents of the file at `path`, line breaks and quotes kept. */
  fileContents(path: string): string
  /** A command that makes `path`, taken literally, the shell's working directory. */
  cd(path: string): string
  /**
   * `line`, made to exit with 127 when its command does not exist. POSIX shells already do; in
   * PowerShell it is the command-not-found exception, caught by type rather than by its message,
   * which Windows translates.
   */
  exitIfNotFound(line: string): string
}

/** Exit status for "command not found", in every dialect (see `exitIfNotFound`). */
export const COMMAND_NOT_FOUND = 127

/** Wraps a value in single quotes for a POSIX shell, escaping any single quotes inside it. */
export function shellQuote(value: string): string {
  return value.replace(/'/g, "'\\''")
}

const posix: ShellSyntax = {
  dialect: 'posix',
  quote: (value) => `'${shellQuote(value)}'`,
  invoke: (command) => command,
  fileContents: (path) => `"$(cat ${posix.quote(path)})"`,
  cd: (path) => `cd -- ${posix.quote(path)}`,
  exitIfNotFound: (line) => line
}

const powershell: ShellSyntax = {
  dialect: 'powershell',
  // Inside single quotes PowerShell expands nothing; a quote is escaped by doubling it.
  quote: (value) => `'${value.replace(/'/g, "''")}'`,
  invoke: (command) => `& ${command}`,
  // -Raw reads the file as one string; without it the lines arrive joined by spaces.
  fileContents: (path) => `(Get-Content -Raw -LiteralPath ${powershell.quote(path)})`,
  cd: (path) => `Set-Location -LiteralPath ${powershell.quote(path)}`,
  exitIfNotFound: (line) =>
    `try { ${line}; exit $LASTEXITCODE } ` +
    `catch [System.Management.Automation.CommandNotFoundException] { exit ${COMMAND_NOT_FOUND} }`
}

const cmd: ShellSyntax = {
  dialect: 'cmd',
  // cmd has no escape for `"` inside quotes, and Windows paths cannot contain one.
  quote: (value) => `"${value}"`,
  invoke: (command) => command,
  fileContents: () => {
    throw new Error('cmd cannot pass a file’s contents as one argument; agents need another shell.')
  },
  cd: (path) => `cd /d ${cmd.quote(path)}`,
  exitIfNotFound: (line) => `${line} & if errorlevel 9009 exit /b ${COMMAND_NOT_FOUND}`
}

const SYNTAX: Record<ShellDialect, ShellSyntax> = { posix, powershell, cmd }

export function syntaxFor(dialect: ShellDialect | undefined): ShellSyntax {
  return SYNTAX[dialect ?? 'posix']
}
