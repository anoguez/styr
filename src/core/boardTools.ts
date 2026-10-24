// How agents are told to use the intent-level tools on the styr MCP server. Pure text, like
// `activityNote.ts`: the tool comes first and the file edit is the fallback for an agent without it.

export const REVIEW_TOOL = '`request_review` on the styr MCP server'
export const ASK_TOOL = '`ask_owner`'
export const RESOLVE_TOOL = '`resolve_question`'
export const SPLIT_TOOL = '`split_task`'

/** Where a review request goes when the agent has no styr MCP server. */
export const REVIEW_FALLBACK =
  'write a `## Handoff` section above `## Activity` with those headings and set `status: in_review`'

/** The In Review line of the board protocol: the tool first, the file edit as the fallback. */
export const REVIEW_LINE = [
  `- When the work is ready for me to look at, call ${REVIEW_TOOL} with what changed, why, how to`,
  `  verify it and any open questions. Only if you do not have that tool, ${REVIEW_FALLBACK}.`
]

/** The same for a task with no repository: the deliverable has to be findable too. */
export const REVIEW_LINE_PLAIN = [
  ...REVIEW_LINE,
  '  Put the deliverable in the working directory, or give its path in the summary.'
]

export const ASK_LINE = [
  `- If you need a decision from me that you cannot make yourself, call ${ASK_TOOL} (it shows in my`,
  '  Inbox) and also put the same question to me in this conversation, in plain text, because I',
  '  usually work in the terminal and may not open the Inbox. Then carry on with whatever does not',
  '  depend on it, or stop and say you are waiting. If I answer in the terminal, call',
  `  ${RESOLVE_TOOL} with my answer so the Inbox entry closes. Only if you do not have the tools,`,
  '  add the question under `questions:` in the frontmatter.'
]

/** Offered only while the task is being specified, which is when a split is decided. */
export const SPLIT_LINE = [
  `- If the task is too big for one change, split it with ${SPLIT_TOOL}: children wired with \`after\`,`,
  '  the parent becomes their umbrella. Only if you do not have that tool, create the tasks and add',
  "  their ids to this task's `blockedBy`."
]
