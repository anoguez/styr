import { describe, expect, it } from 'vitest'
import { openQuestions } from './questions.js'
import type { TaskQuestion } from './types.js'

const q = (id: string, askedAt: string, extra: Partial<TaskQuestion> = {}): TaskQuestion => ({
  id,
  askedAt,
  askedBy: 'claude',
  text: `Question ${id}\nmore`,
  ...extra
})

describe('questions', () => {
  const task = {
    questions: [
      q('q2', '2026-01-02T00:00:00Z'),
      q('q1', '2026-01-01T00:00:00Z'),
      q('q3', '2026-01-03T00:00:00Z', { answer: 'Yes' })
    ]
  }

  it('lists open questions oldest first, leaving answered ones out', () => {
    expect(openQuestions(task).map((question) => question.id)).toEqual(['q1', 'q2'])
  })
})
