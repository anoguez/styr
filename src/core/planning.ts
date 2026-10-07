import { askTitle } from './askAgent.js'

/** Marks the throwaway task behind a ⌘↵ planning run; it is archived when the session ends. */
export const PLAN_RUN_TAG = 'quick-plan'

export function isPlanRun(task: { tags: readonly string[] }): boolean {
  return task.tags.includes(PLAN_RUN_TAG)
}

/** The task title for a planning run, from the first line of the request. */
export function planTitle(request: string): string {
  return askTitle(request, 'Plan tasks')
}

/**
 * The brief for a planning run: organise the Styr board for a request, which may mean creating
 * tasks, updating existing ones, or both. The last paragraph is the backstop for a missing MCP
 * setup — nothing here detects it, so the agent has to say so.
 */
export function planningPrompt(request: string): string {
  return [
    'Organise the Styr board for the request below, using the Styr MCP task tools. Depending on the ' +
      'request that can mean creating new tasks, reviewing and changing tasks that already exist, or both.',
    '',
    'Request:',
    request.trim(),
    '',
    'Before creating anything, call list_tasks (filter by status, readiness or query on a large ' +
      'board) and get_task where you need detail. If a task already covers part of the request, ' +
      'update it instead of creating a duplicate.',
    'Tools: create_task, update_task, set_task_status, add_task_note, list_tasks, get_task and ' +
      'list_sources (for tasks imported from an external source). Use comment_on_source_item only ' +
      'if the request asks for it and the source allows writes. Never write task files by hand.',
    'New tasks get a clear title, a description and acceptance criteria. Split the request when it ' +
      'covers independent pieces; keep it as one task when it does not.',
    'When you change an existing task, record why with add_task_note. Never delete a task unless ' +
      'the request explicitly says to.',
    'Do not implement anything: this run only organises the board, even if the request is phrased ' +
      'as work to do. You may check for open pull requests with read-only commands such as ' +
      '`gh pr list`; never push, merge or edit code.',
    'Do not create a task for this planning run itself. If the request is genuinely ambiguous, ask ' +
      'a clarifying question before changing anything.',
    '',
    "If you cannot see Styr's task tools (create, list, update), do not try to emulate them. Say so " +
      'in your first message, print the new tasks or intended changes as a Markdown list the user ' +
      "can copy, and tell them to run the MCP setup command from Styr's Settings → Integrations."
  ].join('\n')
}
