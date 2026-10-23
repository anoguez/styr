import { describe, expect, it } from 'vitest'
import { answerMessage, nextQuestionId, openQuestions, questionReason } from './questions.js'
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

  it('words the reason from the oldest open question', () => {
    expect(questionReason(task)).toBe('Question q1 (+1 more)')
    expect(questionReason({ questions: [q('q1', '2026-01-01T00:00:00Z')] })).toBe('Question q1')
  })

  it('allocates the next free id', () => {
    expect(nextQuestionId(task)).toBe('q4')
    expect(nextQuestionId({ questions: [] })).toBe('q1')
  })

  it('words the answer for the agent', () => {
    expect(answerMessage(q('q1', 'x', { text: 'Is X ok?' }), ' Yes ')).toContain(
      'Q: Is X ok?\nA: Yes'
    )
  })
})
