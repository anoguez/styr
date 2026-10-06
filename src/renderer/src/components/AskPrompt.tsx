import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

/**
 * The question box behind "Ask agent". Nothing is created until it is sent: Enter submits (an empty
 * question is allowed), Shift+Enter adds a line, Esc cancels.
 */
export function AskPrompt({
  attached,
  forking,
  sendHint,
  onSubmit,
  onCancel
}: {
  /** What goes along with the question, for the chip. */
  attached: string
  /** The question continues a copy of this session's chat rather than creating a task from text. */
  forking: boolean
  sendHint: string
  onSubmit: (question: string) => void
  onCancel: () => void
}): ReactNode {
  const [question, setQuestion] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)

  useEffect(() => field.current?.focus(), [])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Never let a key reach the terminal underneath.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      onSubmit(question)
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Ask agent"
      className="pointer-events-auto absolute inset-x-3 bottom-3 z-30 mx-auto flex max-w-xl flex-col gap-1.5 rounded-lg border border-edge-strong bg-panel p-2 shadow-2xl"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onCancel()
      }}
    >
      <textarea
        ref={field}
        rows={Math.min(5, Math.max(1, question.split('\n').length))}
        value={question}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="What do you want to know?"
        aria-label="Question for the agent"
        className="w-full resize-none bg-transparent px-1 text-[12.5px] text-ink outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-2 text-[11px] text-faint">
        <span className="truncate rounded bg-raised px-1.5 py-0.5">
          {forking ? 'Forks this chat' : attached}
        </span>
        <span className="flex-1" />
        <span>Esc to cancel</span>
        <button
          type="button"
          className="rounded-md border border-accent/40 bg-accent/15 px-2 py-0.5 font-medium text-accent-ink hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => onSubmit(question)}
        >
          Ask <span className="font-mono text-[10px]">{sendHint}</span>
        </button>
      </div>
    </div>
  )
}
