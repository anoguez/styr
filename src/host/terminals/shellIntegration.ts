import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TerminalShell } from '@core/platformShell.js'

/**
 * Styr's shell integration: hooks that report each prompt and command as private OSC records
 * (`OSC 777;STYR;<event>;<base64 fields>`, parsed by `terminalProtocol.ts`), which become the
 * command blocks and the native engine's block list. Each shell gets its hooks without anything
 * being typed into the terminal: zsh through a private startup directory, bash as its init file,
 * fish through `--init-command` and PowerShell through `-EncodedCommand`. The user's own startup
 * files are read as they would have been. A shell without an integration starts unchanged.
 */

export interface ShellLaunch {
  args: string[]
  /** Added to the terminal's environment. */
  env: Record<string, string>
}

let startupDirectory: string | undefined

/** How to start `shell` with Styr's hooks; any failure starts it exactly as configured. */
export function shellIntegrationLaunch(
  shell: Pick<TerminalShell, 'integration' | 'interactiveArgs'>,
  environment: Readonly<Record<string, string>>
): ShellLaunch {
  const plain = { args: shell.interactiveArgs, env: {} }
  try {
    switch (shell.integration) {
      case 'zsh':
        return {
          args: shell.interactiveArgs,
          env: {
            ZDOTDIR: zshStartupPath(),
            STYR_ORIGINAL_ZDOTDIR: environment.ZDOTDIR ?? homedir()
          }
        }
      case 'bash':
        // An init file replaces the login profile, so the script reads the profile itself.
        return {
          args: ['--init-file', startupFile('bash-integration.sh', bashIntegrationScript())],
          env: {}
        }
      case 'fish':
        return {
          args: [
            ...shell.interactiveArgs,
            '--init-command',
            `source ${fishQuote(startupFile('fish-integration.fish', fishIntegrationScript()))}`
          ],
          env: {}
        }
      case 'pwsh':
        // A command rather than a script file, so no execution policy can refuse it.
        return {
          args: [
            ...shell.interactiveArgs,
            '-NoExit',
            '-EncodedCommand',
            encodePowerShell(powershellIntegrationScript())
          ],
          env: {}
        }
      default:
        return plain
    }
  } catch {
    // A failed integration must leave the session as a completely normal terminal.
    return plain
  }
}

const EMIT_NOTE =
  '# Styr semantic terminal hooks. Records are OSC 777;STYR;<event>[;<base64 field>]...'

export function zshIntegrationScript(): string {
  return String.raw`# Styr semantic terminal hooks. This file is sourced into an interactive zsh session.
typeset -g __styr_command_active=0

__styr_base64() {
  print -rn -- "$1" | command base64 | tr -d '\n'
}

__styr_emit() {
  local event="$1"
  shift
  local fields=''
  local field
  for field in "$@"; do
    fields="${'${'}fields};$(__styr_base64 "$field")"
  done
  printf '\033]777;STYR;%s%s\033\\' "$event" "$fields"
}

__styr_preexec() {
  __styr_command_active=1
  __styr_emit COMMAND_STARTED "$PWD" "$1"
}

__styr_precmd() {
  local exit_code=$?
  if (( __styr_command_active )); then
    __styr_emit COMMAND_FINISHED "$exit_code"
    __styr_command_active=0
  fi
  __styr_emit CWD_CHANGED "$PWD"
  __styr_emit PROMPT_READY "$PWD"
}

__styr_chpwd() {
  __styr_emit CWD_CHANGED "$PWD"
}

typeset -ga preexec_functions precmd_functions chpwd_functions
preexec_functions+=(__styr_preexec)
precmd_functions+=(__styr_precmd)
chpwd_functions+=(__styr_chpwd)
`
}

/**
 * bash (3.2, as macOS ships it, and later), run as `--init-file`: it reads the login profile as a
 * login shell would, then marks commands with bash-preexec's hooks when the profile loaded it, or
 * else a DEBUG trap (chained to one the profile set) and `PROMPT_COMMAND`.
 */
export function bashIntegrationScript(): string {
  return String.raw`${EMIT_NOTE}
# Run as bash's --init-file, in place of the login profile, which it reads first.
if [ -r /etc/profile ]; then . /etc/profile; fi
for __styr_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__styr_profile" ]; then
    . "$__styr_profile"
    break
  fi
done
unset __styr_profile

__styr_base64() {
  printf '%s' "$1" | command base64 | command tr -d '\n'
}

__styr_emit() {
  local event="$1" fields='' field
  shift
  for field in "$@"; do
    fields="$fields;$(__styr_base64 "$field")"
  done
  printf '\033]777;STYR;%s%s\033\\' "$event" "$fields"
}

__styr_command_active=0
__styr_at_prompt=0
__styr_last_exit=0
__styr_history_number=''

# The newest history entry as "<number> <line>"; empty when history is off.
__styr_history_entry() {
  local entry
  entry=$(HISTTIMEFORMAT='' builtin history 1 2>/dev/null)
  entry="${'${'}entry#"${'${'}entry%%[![:space:]]*}"}"
  printf '%s' "$entry"
}

__styr_started() {
  __styr_command_active=1
  __styr_emit COMMAND_STARTED "$PWD" "$1"
}

__styr_finished() {
  if [ "$__styr_command_active" = 1 ]; then
    __styr_emit COMMAND_FINISHED "$1"
    __styr_command_active=0
  fi
  __styr_emit CWD_CHANGED "$PWD"
  __styr_emit PROMPT_READY "$PWD"
}

if declare -F __bp_install >/dev/null 2>&1 || [ -n "${'${'}bash_preexec_imported-}" ]; then
  # bash-preexec owns the DEBUG trap and PROMPT_COMMAND; use its hooks, as zsh's.
  __styr_bp_preexec() { __styr_started "$1"; }
  __styr_bp_precmd() { __styr_finished "$?"; }
  preexec_functions+=(__styr_bp_preexec)
  precmd_functions+=(__styr_bp_precmd)
else
  __styr_preexec() {
    # The DEBUG trap runs before every simple command; the first after a prompt is the typed line.
    [ "$__styr_at_prompt" = 1 ] || return 0
    [ -n "${'${'}COMP_LINE-}" ] && return 0
    case "$BASH_COMMAND" in __styr_*) return 0 ;; esac
    __styr_at_prompt=0
    local entry number line
    entry=$(__styr_history_entry)
    number="${'${'}entry%%[[:space:]]*}"
    line="${'${'}entry#"$number"}"
    line="${'${'}line#"${'${'}line%%[![:space:]]*}"}"
    # A line history did not record (ignorespace, history off): the first command is all there is.
    if [ -z "$number" ] || [ "$number" = "$__styr_history_number" ]; then line="$BASH_COMMAND"; fi
    __styr_started "$line"
  }

  __styr_precmd() {
    __styr_last_exit=$?
    # An empty line ran nothing, so the trap is still armed: disarm it for the prompt's commands.
    __styr_at_prompt=0
    __styr_finished "$__styr_last_exit"
    local entry
    entry=$(__styr_history_entry)
    __styr_history_number="${'${'}entry%%[[:space:]]*}"
    return "$__styr_last_exit"
  }

  # Runs last in PROMPT_COMMAND, so the profile's own prompt commands are not taken for the user's.
  __styr_armed() {
    __styr_at_prompt=1
    return "$__styr_last_exit"
  }

  __styr_debug_previous=$(trap -p DEBUG)
  __styr_debug_previous="${'${'}__styr_debug_previous#"trap -- '"}"
  __styr_debug_previous="${'${'}__styr_debug_previous%"' DEBUG"}"
  __styr_debug_previous="${'${'}__styr_debug_previous//"'\\''"/"'"}"
  if [ -n "$__styr_debug_previous" ]; then
    trap '__styr_preexec; eval "$__styr_debug_previous"' DEBUG
  else
    trap '__styr_preexec' DEBUG
  fi

  if declare -p PROMPT_COMMAND 2>/dev/null | command grep -q '^declare -a'; then
    PROMPT_COMMAND=(__styr_precmd "${'${'}PROMPT_COMMAND[@]}" __styr_armed)
  else
    PROMPT_COMMAND="__styr_precmd${'${'}PROMPT_COMMAND:+
$PROMPT_COMMAND}
__styr_armed"
  fi
fi
`
}

/** fish 3 and later, sourced by `--init-command` once its config is read. */
export function fishIntegrationScript(): string {
  return String.raw`${EMIT_NOTE}
function __styr_base64
    printf '%s' $argv[1] | command base64 | command tr -d '\n'
end

function __styr_emit
    set -l event $argv[1]
    set -e argv[1]
    set -l fields ''
    for field in $argv
        set fields "$fields;"(__styr_base64 $field)
    end
    printf '\e]777;STYR;%s%s\e\\' $event $fields
end

set -g __styr_command_active 0

function __styr_preexec --on-event fish_preexec
    set -g __styr_command_active 1
    __styr_emit COMMAND_STARTED $PWD $argv[1]
end

function __styr_postexec --on-event fish_postexec
    set -l exit_code $status
    if test $__styr_command_active = 1
        __styr_emit COMMAND_FINISHED $exit_code
        set -g __styr_command_active 0
    end
end

function __styr_prompt --on-event fish_prompt
    __styr_emit CWD_CHANGED $PWD
    __styr_emit PROMPT_READY $PWD
end
`
}

/**
 * PowerShell 7, run once the profile is loaded: wraps the prompt (finished command, prompt ready)
 * and PSReadLine's line reader (the command line, once its newline is written).
 */
export function powershellIntegrationScript(): string {
  return String.raw`${EMIT_NOTE}
$global:__StyrCommandActive = $false
$global:__StyrExitBefore = $null
function global:__StyrEmit([string]$Kind, [string[]]$Fields) {
  $record = $Kind
  foreach ($field in $Fields) {
    $record += ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($field))
  }
  [Console]::Write("$([char]27)]777;STYR;$record$([char]27)\")
}
$global:__StyrPrompt = $function:prompt
function global:prompt {
  $success = $?
  $code = $global:LASTEXITCODE
  if ($global:__StyrCommandActive) {
    # A failed cmdlet leaves $LASTEXITCODE as the last native command set it.
    $native = $code -ne $global:__StyrExitBefore
    $exitCode = if ($success) { 0 } elseif ($native -and $code) { $code } else { 1 }
    __StyrEmit 'COMMAND_FINISHED' @("$exitCode")
    $global:__StyrCommandActive = $false
  }
  $cwd = $executionContext.SessionState.Path.CurrentLocation.ProviderPath
  __StyrEmit 'CWD_CHANGED' @($cwd)
  __StyrEmit 'PROMPT_READY' @($cwd)
  $global:LASTEXITCODE = $code
  & $global:__StyrPrompt
}
if (Test-Path Function:\PSConsoleHostReadLine) {
  $global:__StyrReadLine = $function:PSConsoleHostReadLine
  function global:PSConsoleHostReadLine {
    $line = & $global:__StyrReadLine
    if ($line -and $line.Trim()) {
      $global:__StyrCommandActive = $true
      $global:__StyrExitBefore = $global:LASTEXITCODE
      $cwd = $executionContext.SessionState.Path.CurrentLocation.ProviderPath
      __StyrEmit 'COMMAND_STARTED' @($cwd, $line)
    }
    $line
  }
}
`
}

/** `-EncodedCommand`'s form: base64 of the script's UTF-16LE. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** A single-quoted fish string: only `\` and `'` are special inside one. */
export function fishQuote(text: string): string {
  return `'${text.replace(/[\\']/g, '\\$&')}'`
}

/** Styr's private startup directory, made once per run. */
function directory(): string {
  startupDirectory ??= mkdtempSync(join(tmpdir(), 'styr-terminal-'))
  return startupDirectory
}

function startupFile(name: string, contents: string): string {
  const path = join(directory(), name)
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 })
  return path
}

let zshReady = false

function zshStartupPath(): string {
  const root = directory()
  if (zshReady) return root
  const sourceUserFile = (
    fileName: string
  ): string => String.raw`typeset __styr_saved_zdotdir="$ZDOTDIR"
ZDOTDIR="$STYR_ORIGINAL_ZDOTDIR"
if [[ -f "$ZDOTDIR/${fileName}" ]]; then
  source "$ZDOTDIR/${fileName}"
fi
ZDOTDIR="$__styr_saved_zdotdir"
unset __styr_saved_zdotdir
`
  startupFile('.zshenv', sourceUserFile('.zshenv'))
  startupFile('.zprofile', sourceUserFile('.zprofile'))
  startupFile('.zshrc', sourceUserFile('.zshrc'))
  startupFile(
    '.zlogin',
    `${sourceUserFile('.zlogin')}\n${zshIntegrationScript()}\nZDOTDIR="$STYR_ORIGINAL_ZDOTDIR"\n`
  )
  startupFile('.zlogout', sourceUserFile('.zlogout'))
  zshReady = true
  return root
}
