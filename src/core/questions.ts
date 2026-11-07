// Questions for the owner in the task file (`questions:`). Pure: the prompt and the MCP server read them.
import type { Task, TaskQuestion } from './types.js'

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
