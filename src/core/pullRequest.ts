import { NOTE_TOOL, noteFallback } from './activityNote.js'
export interface PullRequestRequest {
  /** Absolute path of the task's markdown file, where the PR's URL is recorded. */
  taskFile: string
  /** The branch the PR should target, when Styr can tell. */
  base?: string
}

/**
 * The one-line request typed into a task's running agent when the user asks for a pull request. One
 * line, because a newline in an agent's input box submits it. It never assumes a host: `gh` only
 * when there is a GitHub remote, matching the board protocol, and the agent is told to leave the
 * status alone — a task is Done when its work has landed, not when a PR is open.
 */
export function createPullRequestPrompt({ taskFile, base }: PullRequestRequest): string {
  const target = base ? `against \`${base}\`` : 'against the base branch'
  return (
    'Please create a pull request for this task. Make sure all of the work is committed, push the ' +
    `branch, and open the PR ${target} (use gh if the repo has a GitHub remote; otherwise tell me ` +
    `the branch is ready and what you could not do). Then set \`prUrl:\` to the PR's URL in the ` +
    `frontmatter of \`${taskFile}\` and add a short note with the ${NOTE_TOOL} (only if you do not ` +
    `have that tool, ${noteFallback(`\`${taskFile}\``)}). Leave the status as ` +
    'in_review.'
  )
}

/** One repository of a multi-repo task that gets its own pull request. */
export interface PullRequestRepo {
  name: string
  /** Where the work is: the repository's worktree. */
  path: string
  base?: string
  branch: string
  /** The primary repository's URL goes in top-level `prUrl:`, an extra's on its `extraRepos` entry. */
  primary: boolean
}

/**
 * The same request for a task that spans several repositories: one pull request per repository,
 * each against its own base from its own branch, each URL recorded where `prUrl` for that
 * repository lives. Still one line, for the same reason.
 */
export function createPullRequestsPrompt({
  taskFile,
  repos
}: {
  taskFile: string
  repos: readonly PullRequestRepo[]
}): string {
  const each = repos
    .map((repo) => {
      const target = repo.base ? `against \`${repo.base}\`` : 'against its base branch'
      const field = repo.primary
        ? 'the top-level `prUrl:`'
        : `\`prUrl:\` on its \`extraRepos\` entry (matching \`repoPath\`)`
      return `${repo.name} (in ${repo.path}, branch \`${repo.branch}\`, ${target}; record its URL as ${field})`
    })
    .join('; ')
  return (
    'Please create one pull request for each repository of this task, one at a time. In each, make ' +
    'sure all of the work is committed, push the branch and open the PR (use gh if the repo has a ' +
    `GitHub remote; otherwise tell me the branch is ready and what you could not do). The repositories: ${each}. ` +
    `Record the URLs in the frontmatter of \`${taskFile}\` and add a short note with the ${NOTE_TOOL} ` +
    `(only if you do not have that tool, ${noteFallback(`\`${taskFile}\``)}). Leave the status as ` +
    'in_review.'
  )
}
