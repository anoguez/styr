// How agents are told to add to a task's `## Activity`. Pure text: `prompt.ts` (imported by the
// renderer), the shipped templates and the Create PR prompt all use it.

/** The tool on the styr MCP server that appends a note, stamped with the time and author. */
export const NOTE_TOOL = '`add_task_note` tool on the styr MCP server'

/** A hand-written note in the shape `markdown.ts` reads back with its time and author. */
export const NOTE_BULLET = '`` - `<ISO 8601 time>` **<your name>** — <note> ``'

/** Where a note goes when the agent has no styr MCP server (it is optional, and per host). */
export function noteFallback(file: string): string {
  return `append a bullet under \`## Activity\` at the end of ${file} as ${NOTE_BULLET}`
}
