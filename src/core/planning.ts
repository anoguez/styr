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
 * The brief for a planning run: do what the request says, with the Styr MCP tools available for
 * any board operation. Nothing here assumes the request is about creating tasks. The last
 * paragraph is the backstop for a missing MCP setup — nothing detects it, so the agent has to say so.
 */
export function planningPrompt(request: string): string {
  return [
    'Carry out the request below. You have the Styr MCP tools for working with the Styr board, ' +
      'so use them for anything the request needs there: list_tasks, get_task, create_task, ' +
      'update_task, set_task_status, add_task_note, list_sources and comment_on_source_item.',
    '',
    'Request:',
    request.trim(),
    '',
    'Do only what the request asks. Create tasks only if the request says to. Make every board ' +
      'change with the Styr tools, never by writing task files by hand. Do not create a task for ' +
      'this run itself. If the request is genuinely ambiguous, ask a clarifying question first.',
    '',
    "If the request needs Styr's tools and you cannot see them, do not try to emulate them. Say so " +
      'in your first message, print what you would have done as a Markdown list the user can ' +
      "copy, and tell them to run the MCP setup command from Styr's Settings → Integrations."
  ].join('\n')
}
