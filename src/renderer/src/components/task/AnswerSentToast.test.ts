import { describe, expect, it } from 'vitest'
import type { AnswerResult, Task } from '@core/types.js'
import { answerToastText } from './AnswerSentToast.js'

const result = (delivery: AnswerResult['delivery'], error?: string): AnswerResult => ({
  task: { id: 'TASK-0001' } as Task,
  delivery,
  error
})

describe('answerToastText', () => {
  it('says where the answer went', () => {
    expect(answerToastText(result('queued')).body).toContain('next time it stops')
    expect(answerToastText(result('now')).body).toContain('its session')
    expect(answerToastText(result('resume')).body).toContain('resumed')
  })

  it('says the agent reads it on its next launch when there is no chat', () => {
    expect(answerToastText(result('recorded')).body).toContain('next launch')
  })

  it('warns that a failed delivery still kept the answer', () => {
    const text = answerToastText(result('failed', 'no terminal'))
    expect(text.title).toContain('not delivered')
    expect(text.body).toContain('no terminal')
  })
})
