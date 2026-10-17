import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

/** Sub-directories of `path` for the terminal's directory picker; unreadable paths list nothing. */
export function listDirectories(path: string): {
  path: string
  parent: string | null
  names: string[]
} {
  const resolved = resolve(path === '~' ? homedir() : path)
  const parent = dirname(resolved)
  let names: string[] = []
  try {
    names = readdirSync(resolved, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    // Permission denied or the folder vanished: show an empty list rather than failing the picker.
  }
  return { path: resolved, parent: parent === resolved ? null : parent, names }
}
