// `request_review`: hand a task to the owner with a summary. Node-side (it writes through the
// store); the pure section helper lives in `sections.ts`. The file-only form is an agent writing a
// `## Handoff` section and setting `status: in_review` itself — `getSection` reads both alike.
import { openQuestions } from './questions.js'
import { getSection, setSection } from './sections.js'
import { mergeExtraPrUrls } from './taskPullRequests.js'
import { addNote, getTask, updateTask } from './taskStore.js'

export const HANDOFF_HEADING = 'Handoff'

export interface ReviewSummary {
  changed: string
  why?: string
  verify: string
  openQuestions?: string
  notes?: string
}

export interface ReviewRequest {
  id: string
  summary: ReviewSummary
  prUrl?: string
  /** A pull request per other repository of a multi-repo task, matched by `repoPath`. */
  extraRepos?: { repoPath: string; prUrl?: string }[]
  author: string
}

/** The section body for a summary; empty optional parts are left out. */
export function renderHandoffSection(summary: ReviewSummary, at: string, author: string): string {
  const part = (label: string, text: string | undefined): string[] =>
    text?.trim() ? [`**${label}** ${text.trim()}`] : []
  return [
    `_${at} · ${author}_`,
    '',
    [
      ...part('What changed', summary.changed),
      ...part('Why', summary.why),
      ...part('How to verify', summary.verify),
      ...part('Open questions', summary.openQuestions),
      ...part('Notes', summary.notes)
    ].join('\n\n')
  ].join('\n')
}

/** The handoff a task carries, from the tool or from a hand edit. */
export function taskHandoff(task: { description: string }): string | undefined {
  return getSection(task.description, HANDOFF_HEADING)
}

export function requestReview(request: ReviewRequest): {
  task: ReturnType<typeof getTask> & object
  openQuestions: number
} {
  const { id, summary, prUrl, extraRepos, author } = request
  if (!summary.changed.trim()) throw new Error('summary.changed is required: say what changed')
  if (!summary.verify.trim()) throw new Error('summary.verify is required: say how to check it')
  const task = getTask(id)
  if (!task) throw new Error(`Task ${id} not found`)
  const description = setSection(
    task.description,
    HANDOFF_HEADING,
    renderHandoffSection(summary, new Date().toISOString(), author)
  )
  updateTask(id, {
    status: 'in_review',
    description,
    ...(prUrl ? { prUrl } : {}),
    ...(extraRepos ? { extraRepos: mergeExtraPrUrls(task.extraRepos, extraRepos) } : {})
  })
  const open = openQuestions(task).length
  const first = summary.changed.trim().split('\n')[0]?.trim() ?? ''
  const saved = addNote(
    id,
    author,
    `Requested review: ${first}${open > 0 ? ` (${open} open question${open === 1 ? '' : 's'})` : ''}`
  )
  return { task: saved, openQuestions: open }
}
