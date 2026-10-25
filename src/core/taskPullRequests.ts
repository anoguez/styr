import { repoDisplayNames } from './repoNames.js'
import type { Task } from './types.js'

type PullRequestTask = Pick<Task, 'repoPath' | 'prUrl' | 'useWorktree' | 'extraRepos'>

/**
 * The pull or merge requests recorded on a task, the primary repository's first, each with the
 * name of its repository. Extra repositories count only on a worktree task. Pure: the card, the
 * Inbox and the terminal all ask this, so they agree on what a task's pull requests are.
 */
export function taskPullRequests(task: PullRequestTask): { repo: string; url: string }[] {
  const extras = task.useWorktree ? task.extraRepos : []
  const names = repoDisplayNames([task.repoPath ?? '', ...extras.map((extra) => extra.repoPath)])
  return [
    ...(task.prUrl ? [{ repo: names[0] ?? '', url: task.prUrl }] : []),
    ...extras.flatMap((extra, index) =>
      extra.prUrl ? [{ repo: names[index + 1] ?? '', url: extra.prUrl }] : []
    )
  ]
}

/** Whether every repository of the task has a pull request, so there is none left to ask for. */
export function hasAllPullRequests(task: PullRequestTask): boolean {
  const extras = task.useWorktree ? task.extraRepos : []
  return Boolean(task.prUrl) && extras.every((extra) => Boolean(extra.prUrl))
}

/**
 * Applies each given `prUrl` to the existing extra repository with that `repoPath`; nothing else
 * changes, and an entry that names no repository of the task is ignored. An empty `prUrl` clears it.
 */
export function mergeExtraPrUrls(
  extraRepos: Task['extraRepos'],
  given: readonly { repoPath: string; prUrl?: string }[]
): Task['extraRepos'] {
  const same = (a: string, b: string): boolean =>
    a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '')
  return extraRepos.map((extra) => {
    const update = given.find((entry) => same(entry.repoPath, extra.repoPath))
    return update && update.prUrl !== undefined
      ? { ...extra, prUrl: update.prUrl || undefined }
      : extra
  })
}
