import { syntaxFor } from './shell.js'
import type { RemoteWorkspaceLink } from './types.js'

/**
 * The pure rules of remote workspaces (`docs/architecture/remote.md`): what a host may be, the
 * `ssh` command line, the reconnect backoff and the VS Code Remote link. Shared by the main
 * process and the renderer, so nothing here imports `node:*`, touches the disk or resolves a
 * remote path.
 */

/**
 * The command that starts the server when the link names none: where setup and `install.sh`
 * install it (`~/.styr/server/current` points at the version that starts next).
 */
export const DEFAULT_SERVER_COMMAND = '~/.styr/server/current/bin/styr'

/**
 * A host as `ssh` takes it: an alias, `user@host`, an IPv4 or bracketed IPv6 address. It may not
 * start with `-`, which `ssh` would read as an option, and holds no spaces or shell characters.
 */
const HOST = /^[A-Za-z0-9_.%@:[\]][A-Za-z0-9_.%@:[\]-]*$/

export function isValidRemoteHost(host: string): boolean {
  return host.length <= 255 && HOST.test(host)
}

/**
 * What `ssh` runs on the host. The remote is Linux, so the line is built with the POSIX syntax
 * whatever shell this machine uses (a Windows client included). The server command is kept as
 * typed, like an agent CLI command in Settings, so it may be `~/…` or carry flags.
 */
export function remoteAttachCommand(link: Pick<RemoteWorkspaceLink, 'server'>): string {
  return `${syntaxFor('posix').invoke(link.server?.trim() || DEFAULT_SERVER_COMMAND)} serve attach`
}

/**
 * `ssh`'s arguments. Batch mode fails at once instead of prompting for a password or a new host
 * key; the keepalive lets `ssh` itself notice a connection that died while the laptop slept.
 * `ssh` is resolved from PATH by the caller (OpenSSH ships with Windows 10 and later).
 */
export function sshArgs(link: RemoteWorkspaceLink): string[] {
  return [
    ...sshCommandArgs(link.host),
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    link.host,
    remoteAttachCommand(link)
  ]
}

/**
 * `scp`'s arguments for the setup's upload fallback: batch mode too, and `remotePath` relative to
 * the home folder.
 */
export function scpArgs(host: string, file: string, remotePath: string): string[] {
  return ['-q', '-B', ...sshCommandArgs(host).slice(1), file, `${host}:${remotePath}`]
}

/**
 * The options every `ssh` Styr runs starts with: no tty, batch mode (a password or an unknown host
 * key fails at once with ssh's own message instead of prompting), a connect timeout. Host-key
 * checking stays ssh's default: never `StrictHostKeyChecking=no` or `accept-new`, and Styr never
 * writes `known_hosts`; the user accepts a key by running `ssh <host>` once (a test holds this).
 */
export function sshCommandArgs(host: string): string[] {
  if (!isValidRemoteHost(host)) throw new Error(`Not a host ssh can reach: ${host}`)
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']
}

export const RECONNECT_MIN_MS = 1_000
export const RECONNECT_MAX_MS = 30_000

/** How long to wait before attempt `failures` + 1: 1s, 2s, 4s … up to 30s. */
export function reconnectDelay(failures: number): number {
  return Math.min(RECONNECT_MIN_MS * 2 ** Math.max(0, failures), RECONNECT_MAX_MS)
}

export type RemoteEditor = 'vscode' | 'cursor'

/** The editors that open a file over ssh from a link: VS Code and Cursor. */
export function remoteEditorFor(openFilesWith: string): RemoteEditor | undefined {
  const name = openFilesWith.trim().toLowerCase()
  if (!name) return undefined
  if (/cursor/.test(name)) return 'cursor'
  if (/visual studio code|vscode|(^|[\\/])code(\.exe|\.cmd)?$/.test(name)) return 'vscode'
  return undefined
}

/** C0 and C1 controls, and the bidi overrides that could make a text read other than it is. */
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
/** Half of a surrogate pair standing alone, which `encodeURIComponent` refuses. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/**
 * `vscode://vscode-remote/ssh-remote+<host>/<path>`, or Cursor's equivalent. The host is used as
 * is (`isValidRemoteHost` admits nothing a URI needs escaped, and VS Code wants `user@host` raw).
 * The path comes from the server, so it is untrusted: it is normalised lexically (`.` and `..`
 * segments, never above `/`; nothing is resolved on any disk), stripped of control characters,
 * and each segment is escaped whole, so no `?`, `#`, `:` or `%` in it can end the path or start
 * another scheme. Whatever the path, the result is a link of this one form.
 */
export function remoteEditorUri(editor: RemoteEditor, host: string, path: string): string {
  if (!isValidRemoteHost(host)) throw new Error(`Not a host ssh can reach: ${host}`)
  const segments: string[] = []
  for (const raw of path.replace(UNSAFE_CHARS, '').replace(LONE_SURROGATE, '\uFFFD').split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') segments.pop()
    else segments.push(encodeURIComponent(raw))
  }
  return `${editor}://vscode-remote/ssh-remote+${host}/${segments.join('/')}`
}

/**
 * A server's notification text, made safe to show: controls and bidi overrides become spaces,
 * whitespace runs collapse, and it is cut to `max` characters.
 */
export function notificationText(text: string, max: number): string {
  const clean = text.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
