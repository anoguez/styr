import { useState, type ReactNode } from 'react'
import { openQuestions } from '@core/questions.js'
import type { AnswerResult, Task } from '@core/types.js'
import { Button } from '../ui.js'

/**
 * The questions an agent put to the owner (`ask_owner`), each with a field and Send answer. The
 * answer is recorded in the task file and sent to the agent by the host; `onAnswered` reports how
 * it went. Shown in the Inbox for a `question` item and in the task dialog under the description.
 */
export function OpenQuestions({
  task,
  onAnswered
}: {
  task: Task
  onAnswered: (result: AnswerResult) => void
}): ReactNode {
  const open = openQuestions(task)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; message: string } | null>(null)
  if (open.length === 0) return null

  const send = async (questionId: string): Promise<void> => {
    const answer = (drafts[questionId] ?? '').trim()
    if (!answer) return
    setSending(questionId)
    setError(null)
    try {
      onAnswered(await window.api.tasks.answerQuestion(task.id, questionId, answer))
      setDrafts(({ [questionId]: _sent, ...rest }) => rest)
    } catch (failure) {
      // A stale list (answered elsewhere) throws here; nothing was sent.
      setError({
        id: questionId,
        message: failure instanceof Error ? failure.message : String(failure)
      })
    } finally {
      setSending(null)
    }
  }

  return (
    <section aria-label="Questions for you" className="flex flex-col gap-3">
      <h3 className="m-0 text-[12px] font-semibold text-dim">Questions from the agent</h3>
      {open.map((question) => {
        const draft = drafts[question.id] ?? ''
        return (
          <div
            key={question.id}
            className="flex flex-col gap-2 rounded-[10px] border border-edge bg-card p-3"
          >
            <p className="m-0 whitespace-pre-wrap text-[13px] leading-[1.5] text-ink">
              {question.text}
            </p>
            <textarea
              aria-label={`Answer to ${question.id}`}
              value={draft}
              rows={2}
              placeholder="Your answer"
              onChange={(event) => setDrafts({ ...drafts, [question.id]: event.target.value })}
              className="w-full resize-y rounded-lg border border-edge bg-chrome px-2.5 py-2 text-[12.5px] leading-[1.5] text-ink outline-none placeholder:text-faint focus:border-accent"
            />
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                disabled={!draft.trim() || sending !== null}
                onClick={() => void send(question.id)}
              >
                Send answer
              </Button>
              {error?.id === question.id ? (
                <span role="alert" className="text-[12px] text-danger">
                  {error.message}
                </span>
              ) : null}
            </div>
          </div>
        )
      })}
    </section>
  )
}
