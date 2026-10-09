import { useEffect, useState } from 'react'

export interface BranchInfo {
  branches: string[]
  current?: string
}

/**
 * The branches of the repository at `repoPath`, for picking a worktree's base. Nothing loads while
 * `enabled` is off or the path is blank; `loaded` turns true once this path's answer is in.
 */
export function useBranches(
  repoPath: string,
  enabled: boolean
): { info: BranchInfo; loaded: boolean } {
  const [info, setInfo] = useState<BranchInfo>({ branches: [] })
  const [loaded, setLoaded] = useState(false)
  const path = repoPath.trim()
  useEffect(() => {
    setLoaded(false)
    if (!enabled || !path) return
    let cancelled = false
    void window.api.git.branches(path).then((next) => {
      if (cancelled) return
      setInfo(next)
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [enabled, path])
  return { info, loaded }
}
