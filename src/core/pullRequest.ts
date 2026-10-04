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
    `frontmatter of \`${taskFile}\` and add a short note under \`## Activity\`. Leave the status as ` +
    'in_review.'
  )
}
