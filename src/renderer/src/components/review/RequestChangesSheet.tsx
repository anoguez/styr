import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MAX_PROMPT_CHARS } from '@core/agentPrompt.js'
import { commentRef, groupComments, plural, reviewMessage } from '@core/review.js'
import {
  AGENT_PROVIDER_SHORT_LABELS,
  TASK_STATUS_LABELS,
  type ReviewComment,
  type ReviewPreparation,
  type ReviewRoute,
  type ReviewSent,
  type Task
} from '@core/types.js'
import { describeBlockers, useOpenBlockers } from '../../lib/blockerContext.js'
import { ipcMessage } from '../../lib/ipcMessage.js'
import { Glyph } from '../changesParts.js'
import { Button, Chip, Field, inputBase } from '../ui.js'

/** The agent row's state chip and its one-line explanation, per delivery route. */
const ROUTES: Record<ReviewRoute, { label: string; tone: string; note: string }> = {
  queued: {
    label: 'Running',
    tone: 'col-progress',
    note: 'The comments are queued and delivered the next time it waits for input.'
  },
  now: { label: 'Waiting', tone: 'col-review', note: 'Delivered to its session now.' },
  resume: {
    label: 'Finished',
    tone: 'col-done',
    note: 'Its session resumes and works through each comment.'
  },
  fresh: { label: 'No chat yet', tone: 'faint', note: 'Starts the agent with the comments.' }
}

/**
 * The Request changes sheet, modal inside the Changes dialog: the pending comments grouped by file,
 * an optional overall note, the exact message the agent receives, and Send. The backdrop or Esc
 * closes the sheet only. On a failure the comments stay pending and the sheet stays open.
 */
export function RequestChangesSheet({
  task,
  pending,
  onClose,
  onJump,
  onSend
}: {
  task: Task
  pending: ReviewComment[]
  onClose: () => void
  /** Closes the sheet and jumps to the comment, which stays pending. */
  onJump: (comment: ReviewComment) => void
  /** Sends; on success the Changes dialog closes, taking the sheet with it. */
  onSend: (summary: string) => Promise<ReviewSent>
}): ReactNode {
  const [prep, setPrep] = useState<ReviewPreparation>()
  const [summary, setSummary] = useState('')
  const [preview, setPreview] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const blockers = useOpenBlockers(task)

  useEffect(() => {
    let cancelled = false
    void window.api.review.prepare(task.id).then(
      (next) => !cancelled && setPrep(next),
      (failure: unknown) => !cancelled && setError(ipcMessage(failure))
    )
    return () => {
      cancelled = true
    }
  }, [task.id])

  // App closes every dialog on Escape; while the sheet is open, Escape closes only the sheet.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  const outdated = useMemo(() => new Set(prep?.outdated ?? []), [prep])
  const groups = groupComments(pending)
  const message = prep ? reviewMessage(prep.target, pending, summary, outdated) : ''
  const tooLong = message.length > MAX_PROMPT_CHARS
  const where = prep
    ? prep.target.kind === 'branch'
      ? prep.target.branch
      : prep.target.repoName
    : (task.worktreePath ?? task.repoPath ?? '')
  const agent = prep ? AGENT_PROVIDER_SHORT_LABELS[prep.provider] : 'the agent'
  const route = prep ? ROUTES[prep.route] : undefined

  const send = (): void => {
    setSending(true)
    setError(undefined)
    onSend(summary).then(
      () => undefined,
      (failure: unknown) => {
        setSending(false)
        setError(ipcMessage(failure))
      }
    )
  }

  return (
    <div
      className="absolute inset-0 z-20 box-border flex items-center justify-center bg-black/55 p-6"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Request changes"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-full w-[min(600px,100%)] flex-col overflow-hidden rounded-[14px] border border-edge-strong bg-panel shadow-[0_24px_60px_-12px_rgba(0,0,0,0.8)]"
      >
        <div className="flex shrink-0 items-start gap-3 pb-3 pl-5 pr-3 pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <h3 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-ink">
              Request changes
            </h3>
            <span className="truncate text-[12px] text-faint">
              {plural(pending.length, 'comment')} in {plural(groups.length, 'file')}
              {where ? ` · ${where}` : ''}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex size-7 items-center justify-center rounded-lg text-dim hover:bg-raised hover:text-ink"
          >
            <Glyph name="close" size={14} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-4">
          <div className="flex items-center gap-2.5 rounded-[10px] border border-edge bg-chrome px-3 py-2.5">
            <span className="grid size-[26px] shrink-0 place-items-center rounded-lg bg-accent/25 text-[12px] font-bold text-[var(--color-accent-text)]">
              {agent.charAt(0).toUpperCase()}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="text-[12.5px] font-semibold text-ink">
                Send to {agent} on {task.id}
              </span>
              <span className="text-[11.5px] leading-[1.45] text-faint [text-wrap:pretty]">
                {route?.note ?? 'Checking the agent…'}
              </span>
            </div>
            {route ? (
              <span
                className="inline-flex h-5 shrink-0 items-center gap-[5px] rounded-md px-[7px] text-[11px] font-medium"
                style={{
                  background: `color-mix(in oklab, var(--color-${route.tone}) 15%, transparent)`,
                  color: `var(--color-${route.tone}${route.tone === 'faint' ? '' : '-text'})`
                }}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {route.label}
              </span>
            ) : null}
          </div>

          {blockers.length > 0 ? (
            <p className="m-0 text-[12px] leading-normal text-[var(--color-col-review-text)]">
              {task.id} is blocked by{' '}
              {describeBlockers(blockers, (blocker) => TASK_STATUS_LABELS[blocker.status])}. Sending
              starts the work anyway.
            </p>
          ) : null}

          <Field label="Overall note · optional">
            <textarea
              rows={2}
              value={summary}
              aria-label="Overall note"
              placeholder="Anything that applies to the whole change"
              onChange={(event) => setSummary(event.target.value)}
              className={`${inputBase} box-border w-full resize-y px-2.5 py-2 text-[12.5px] leading-normal`}
            />
          </Field>

          <div className="flex flex-col gap-2.5">
            {groups.map((group) => (
              <div
                key={group.path}
                className="flex flex-col overflow-hidden rounded-[10px] border border-edge"
              >
                <div className="flex h-[30px] items-center gap-2 bg-chrome px-3">
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-ink">
                    {group.path}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-faint">
                    {plural(group.comments.length, 'comment')}
                  </span>
                </div>
                {group.comments.map((comment) => (
                  <button
                    key={comment.id}
                    type="button"
                    title="Show in the diff"
                    onClick={() => onJump(comment)}
                    className="flex w-full flex-col gap-1 border-t border-edge px-3 py-[9px] text-left hover:bg-raised/55"
                  >
                    <span className="flex w-full min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-[10.5px] text-[var(--color-accent-text)]">
                        {commentRef(comment)}
                      </span>
                      {outdated.has(comment.id) ? <Chip>Outdated</Chip> : null}
                      <code
                        className="min-w-0 flex-1 truncate text-[11px] text-faint"
                        style={{ fontFamily: 'var(--font-terminal)' }}
                      >
                        {comment.text.trim()}
                      </code>
                      <span className="shrink-0 text-[11px] text-faint">Show</span>
                    </span>
                    <span className="m-0 whitespace-pre-wrap text-[12.5px] leading-normal text-ink [text-wrap:pretty]">
                      {comment.body}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <button
            type="button"
            aria-expanded={preview}
            onClick={() => setPreview((open) => !open)}
            className="inline-flex items-center gap-[5px] self-start text-[11.5px] font-medium text-dim hover:text-ink"
          >
            <span className={preview ? '' : '-rotate-90'}>
              <Glyph name="chevron" size={11} />
            </span>
            What the agent receives
          </button>
          {preview ? (
            <pre
              className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-chrome px-3 py-2.5 text-[11px] leading-[1.6] text-dim"
              style={{ fontFamily: 'var(--font-terminal)' }}
            >
              {message}
            </pre>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-edge bg-chrome/40 py-3 pl-5 pr-4">
          <span className="min-w-[160px] flex-1 text-[11.5px] text-faint">
            {error ? (
              <span role="alert" className="text-danger">
                {error}
              </span>
            ) : tooLong ? (
              <span className="text-danger">Too long to send: shorten or remove comments</span>
            ) : task.status !== 'in_progress' ? (
              `Closes this dialog and moves ${task.id} back to In Progress.`
            ) : (
              'Closes this dialog.'
            )}
          </span>
          <Button className="h-[30px]" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            className="h-[30px] text-[12.5px]"
            disabled={!prep || sending || tooLong || pending.length === 0}
            onClick={send}
          >
            <Glyph name="send" />
            {sending ? 'Sending…' : `Send ${plural(pending.length, 'comment')}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
