import type { ReactNode } from 'react'

/**
 * An agent tab's Chat switch: on shows the conversation as a chat, off the CLI's own terminal. A
 * word and a small track in one control, slim enough for the bar (the phone's design, styr-app #40).
 */
export function ChatSwitch({
  on,
  hint,
  onToggle
}: {
  on: boolean
  /** The shortcut that toggles it, shown in its title. */
  hint: string
  onToggle: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Chat"
      title={`${on ? 'Showing the chat — switch to the terminal' : 'Showing the terminal — switch to the chat'}${hint ? ` (${hint})` : ''}`}
      className={`pointer-events-auto inline-flex items-center rounded-md border border-transparent font-medium text-dim hover:bg-raised/70 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent h-[22px] shrink-0 gap-1.5 px-[7px] text-[11.5px] ${on ? 'text-ink' : ''}`}
      onClick={onToggle}
    >
      Chat
      <span
        aria-hidden
        className={`relative block h-3 w-[22px] shrink-0 rounded-full transition-colors duration-150 ${
          on ? 'bg-accent' : 'bg-edge-strong'
        }`}
      >
        <span
          className={`bg-ink absolute top-0.5 size-2 rounded-full transition-[left] duration-150 ${
            on ? 'left-3' : 'left-0.5'
          }`}
        />
      </span>
    </button>
  )
}
