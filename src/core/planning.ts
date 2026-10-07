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
 * The brief for a planning run: split a request into Styr tasks. The last paragraph is the
 * backstop for a missing MCP setup — nothing here detects it, so the agent has to say so.
 */
export function planningPrompt(request: string): string {
  return [
    'Turn the request below into one or more focused tasks on the Styr board.',
    '',
    'Request:',
    request.trim(),
    '',
    'Create each task with the Styr MCP task tools (never by writing task files by hand). Give each ' +
      'a clear title, a description and acceptance criteria. Split the request when it covers ' +
      'independent pieces; keep it as one task when it does not.',
    'Do not create a task for this planning run itself. If the request is genuinely ambiguous, ask ' +
      'a clarifying question before creating anything.',
    '',
    "If you cannot see Styr's task tools (create, list, update), do not try to emulate them. Say so " +
      'in your first message, print the tasks as a Markdown list the user can copy, and tell them ' +
      "to run the MCP setup command from Styr's Settings → Integrations."
  ].join('\n')
}
