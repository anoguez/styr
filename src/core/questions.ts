// Questions an agent put to the owner (`ask_owner`). Pure: the renderer, the prompt and the store use it.
import type { Task, TaskQuestion } from './types.js'

/** A task holds at most this many unanswered questions; the 21st is refused. */
export const MAX_OPEN_QUESTIONS = 20

type WithQuestions = Pick<Task, 'questions'>

export function isOpen(question: TaskQuestion): boolean {
  return question.answer === undefined
}

/** The unanswered questions, oldest first. */
export function openQuestions(task: WithQuestions): TaskQuestion[] {
  return task.questions
    .filter(isOpen)
    .sort(
      (a, b) =>
        a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id, 'en', { numeric: true })
    )
}

export function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.trim() ?? ''
}

/** The next free `qN`. */
export function nextQuestionId(task: WithQuestions): string {
  const highest = task.questions.reduce((max, question) => {
    const match = /^q(\d+)$/.exec(question.id)
    return match ? Math.max(max, Number(match[1])) : max
  }, 0)
  return `q${highest + 1}`
}

/** What the Inbox says: the oldest open question, and how many more follow it. */
export function questionReason(task: WithQuestions): string {
  const open = openQuestions(task)
  const head = firstLine(open[0]?.text ?? '')
  return open.length > 1 ? `${head} (+${open.length - 1} more)` : head
}

/** What the agent is told when the owner answers: one self-contained message. */
export function answerMessage(question: TaskQuestion, answer: string): string {
  return [
    `The owner answered your question ${question.id} (ask_owner):`,
    '',
    `Q: ${question.text.trim()}`,
    `A: ${answer.trim()}`
  ].join('\n')
}
