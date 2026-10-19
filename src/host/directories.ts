import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export interface DirectoryListing {
  path: string
  parent: string | null
  /** The sub-directories. */
  names: string[]
  /** The files, when they were asked for. */
  files?: string[]
}

/**
 * Sub-directories of `path`, and its files with `includeFiles`, for the in-app pickers: the
 * terminal's directory picker, and Browse on a remote workspace, where this runs on the server and
 * lists the host's folders. Hidden entries are left out; unreadable paths list nothing.
 */
export function listDirectories(path: string, includeFiles = false): DirectoryListing {
  const resolved = resolve(path === '~' ? homedir() : path)
  const parent = dirname(resolved)
  const names: string[] = []
  const files: string[] = []
  try {
    for (const entry of readdirSync(resolved, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) names.push(entry.name)
      else if (includeFiles && entry.isFile()) files.push(entry.name)
    }
  } catch {
    // Permission denied or the folder vanished: show an empty list rather than failing the picker.
  }
  const byName = (a: string, b: string): number => a.localeCompare(b)
  return {
    path: resolved,
    parent: parent === resolved ? null : parent,
    names: names.sort(byName),
    ...(includeFiles ? { files: files.sort(byName) } : {})
  }
}
