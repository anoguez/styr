import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { visibleSubagents, type SubagentStatus } from '@core/agentState.js'
import { AGENT_TONE } from '../lib/agentTone.js'

/**
 * A card's subagents on a tree line, oldest first. Rows sit inside the card's button and have no
 * hover or action of their own — clicking one is clicking the card. The only control is the
 * overflow toggle, a `span` because a button cannot nest in the card's button, and it stops the
 * click so expanding does not also focus the terminal.
 */
export function SubagentRows({ subagents }: { subagents: readonly SubagentStatus[] }): ReactNode {
  const [expanded, setExpanded] = useState(false)
  // Expanding is for this list: once it empties, the next one starts folded.
  if (subagents.length === 0 && expanded) setExpanded(false)
  if (subagents.length === 0) return null

  const { rows, toggle } = visibleSubagents(subagents, expanded)
  const flip = (event: MouseEvent | KeyboardEvent): void => {
    event.stopPropagation()
    event.preventDefault()
    setExpanded((open) => !open)
  }

  return (
    <span className="ml-0.5 flex flex-col gap-0.5 border-l border-edge-strong py-px pl-2.5">
      {rows.map((subagent) => {
        const done = subagent.state === 'done'
        return (
          <span
            key={subagent.id}
            title={
              done
                ? `Done · ${subagent.label}${subagent.lastMessage ? `\n${subagent.lastMessage}` : ''}`
                : `Running · ${subagent.label}`
            }
            className="flex h-[17px] min-w-0 items-center gap-1.5"
          >
            <span
              aria-hidden
              className={`size-[6px] shrink-0 rounded-full bg-current ${
                done ? AGENT_TONE.idle : `${AGENT_TONE.working} wd-pulse`
              }`}
            />
            <span
              className={`min-w-0 shrink truncate text-[11px] text-dim ${done ? 'max-w-[58%]' : ''}`}
            >
              {subagent.label}
            </span>
            {done && subagent.lastMessage ? (
              <span className="min-w-6 flex-1 basis-0 truncate text-[11px] text-faint">
                {subagent.lastMessage}
              </span>
            ) : null}
          </span>
        )
      })}
      {toggle ? (
        <span
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          className="flex h-[17px] items-center self-start text-[10.5px] text-dim hover:text-ink"
          onClick={flip}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') flip(event)
          }}
        >
          {toggle}
        </span>
      ) : null}
    </span>
  )
}
