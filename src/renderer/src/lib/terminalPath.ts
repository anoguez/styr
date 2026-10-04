export interface DisplayPath {
  name: string
  rest: string
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
export function displayPath(cwd: string, repoRoot?: string | null): DisplayPath {
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
