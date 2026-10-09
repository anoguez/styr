export interface DisplayPath {
  name: string
  rest: string
}

/**
 * A Windows path (`C:\a\b`, `\\server\share`) spelled with forward slashes, so the same rules split
 * both kinds. Anything else is returned as is: a backslash is a legal character in a macOS name.
 */
export function withSlashes(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replace(/\\/g, '/') : path
}

/** The last segment of a file or folder path, on any platform. */
export function fileName(path: string): string {
  return leaf(withSlashes(path))
}

function leaf(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/**
 * How the terminal bar spells a directory. Inside a repository it reads from the repository's own
 * name down (`styr` then `/ src / renderer`), so the part that matters is not buried in a long home
 * path. Outside one it is the folder's name followed by where it lives.
 */
export function displayPath(rawCwd: string, rawRoot?: string | null): DisplayPath {
  const cwd = withSlashes(rawCwd)
  const repoRoot = rawRoot ? withSlashes(rawRoot) : rawRoot
  const trimmed = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  if (repoRoot) {
    const root = repoRoot.length > 1 ? repoRoot.replace(/\/+$/, '') : repoRoot
    if (trimmed === root) return { name: leaf(root), rest: '' }
    if (trimmed.startsWith(`${root}/`)) {
      const inside = trimmed
        .slice(root.length + 1)
        .split('/')
        .filter(Boolean)
      return { name: leaf(root), rest: `/ ${inside.join(' / ')}` }
    }
  }
  const cut = trimmed.lastIndexOf('/')
  if (cut < 0 || trimmed === '/') return { name: trimmed, rest: '' }
  return { name: trimmed.slice(cut + 1), rest: trimmed.slice(0, cut) }
}
