import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

let zshStartupDirectory: string | undefined

/**
 * Runs Styr's hooks from a private zsh startup directory while sourcing the user's normal files.
 * This avoids visibly typing an implementation command into the terminal after it has opened.
 */
export function shellIntegrationEnvironment(
  shell: string,
  environment: Readonly<Record<string, string>>
): Record<string, string> | undefined {
  if (basename(shell) !== 'zsh') return undefined
  try {
    return {
      ZDOTDIR: zshStartupPath(),
      STYR_ORIGINAL_ZDOTDIR: environment.ZDOTDIR ?? homedir()
    }
  } catch {
    // A failed integration must leave the session as a completely normal terminal.
    return undefined
  }
}

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

function zshStartupPath(): string {
  if (zshStartupDirectory) return zshStartupDirectory
  const directory = mkdtempSync(join(tmpdir(), 'styr-terminal-'))
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
  writeFileSync(join(directory, '.zshenv'), sourceUserFile('.zshenv'), {
    encoding: 'utf8',
    mode: 0o600
  })
  writeFileSync(join(directory, '.zprofile'), sourceUserFile('.zprofile'), {
    encoding: 'utf8',
    mode: 0o600
  })
  writeFileSync(join(directory, '.zshrc'), sourceUserFile('.zshrc'), {
    encoding: 'utf8',
    mode: 0o600
  })
  writeFileSync(
    join(directory, '.zlogin'),
    `${sourceUserFile('.zlogin')}\n${zshIntegrationScript()}\nZDOTDIR="$STYR_ORIGINAL_ZDOTDIR"\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  writeFileSync(join(directory, '.zlogout'), sourceUserFile('.zlogout'), {
    encoding: 'utf8',
    mode: 0o600
  })
  zshStartupDirectory = directory
  return directory
}
