/** The segments of a path in either dialect, without a trailing separator. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean)
}

/**
 * Short names for a task's repositories, in the order given: the folder name, or `parent/folder`
 * when two repositories share one. Pure — the prompt and the renderer both use it.
 */
export function repoDisplayNames(repoPaths: readonly string[]): string[] {
  const parts = repoPaths.map(segments)
  const base = parts.map((segs) => segs[segs.length - 1] ?? '')
  return parts.map((segs, index) => {
    const name = base[index] as string
    const clash = base.some((other, at) => at !== index && other === name)
    const parent = segs[segs.length - 2]
    return clash && parent ? `${parent}/${name}` : name
  })
}
