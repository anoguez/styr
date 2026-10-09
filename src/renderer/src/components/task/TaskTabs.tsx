import type { ReactNode } from 'react'
import type { Task } from '@core/types.js'
import { Chip } from '../ui.js'
import { GHOST_BTN } from './fields.js'

export type TabKey = 'brief' | 'chats' | 'activity' | 'prompt'

/** The dialog's tabs: chats and activity exist only once the task does. */
export function tabsFor(task: Task | null): { key: TabKey; label: string; count?: number }[] {
  return [
    { key: 'brief', label: 'Brief' },
    ...(task
      ? [
          { key: 'chats' as const, label: 'Agent chats', count: task.sessions.length },
          { key: 'activity' as const, label: 'Activity', count: task.activity.length }
        ]
      : []),
    { key: 'prompt', label: 'Prompt preview' }
  ]
}

export function TabNav({
  task,
  tab,
  onSelect
}: {
  task: Task | null
  tab: TabKey
  onSelect: (tab: TabKey) => void
}): ReactNode {
  return (
    <nav className="flex h-[38px] shrink-0 items-stretch gap-0.5 border-b border-edge px-3">
      {tabsFor(task).map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onSelect(item.key)}
          className={`flex items-center gap-1.5 border-b-2 px-2.5 text-[12.5px] font-medium transition-colors hover:text-ink ${tab === item.key ? 'border-accent text-ink' : 'border-transparent text-faint'}`}
        >
          {item.label}
          {item.count ? (
            <span className="inline-flex h-4 items-center rounded-[5px] bg-raised px-[5px] font-mono text-[10px] text-dim">
              {item.count}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}

/** Every agent run on the task, newest first; opening one resumes it. */
export function ChatsTab({
  task,
  onResume,
  onForget
}: {
  task: Task
  onResume: (sessionId: string) => void
  onForget: () => void
}): ReactNode {
  const sessions = [...task.sessions].reverse()
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pb-5 pt-4">
      <p className="m-0 text-[12px] leading-normal text-faint">
        Every run on this task, newest first. Opening one resumes it with its original provider.
      </p>
      {sessions.length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-edge overflow-hidden rounded-[10px] border border-edge bg-chrome p-0">
          {sessions.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-center gap-1.5 text-[12.5px] text-ink">
                  <span className="truncate">{entry.label}</span>
                  <Chip>{entry.provider === 'codex' ? 'Codex' : 'Claude'}</Chip>
                  {entry.id === task.agentSession?.id ? (
                    <Chip tone="accent">continues next</Chip>
                  ) : null}
                </span>
                <span className="font-mono text-[10.5px] text-faint" title={entry.id}>
                  {new Date(entry.startedAt).toLocaleString()} · {entry.id.slice(0, 8)}
                </span>
              </span>
              <button
                type="button"
                className="inline-flex h-[26px] shrink-0 items-center rounded-[7px] border border-edge-strong bg-raised/70 px-2.5 text-[12px] font-medium text-dim hover:bg-raised hover:text-ink"
                onClick={() => onResume(entry.id)}
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[12px] text-faint">No agent has run on this task yet.</p>
      )}
      {task.agentSession ? (
        <button
          type="button"
          className={`${GHOST_BTN} -ml-2 h-[26px] self-start`}
          onClick={onForget}
        >
          Forget current chat — next run starts fresh
        </button>
      ) : null}
    </div>
  )
}

/** The task's activity log as a timeline; agent entries are marked apart from yours. */
export function ActivityTab({ activity }: { activity: Task['activity'] }): ReactNode {
  return (
    <ol className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-5 pb-5 pt-4">
      {activity.length === 0 ? <li className="text-[12px] text-faint">No activity yet.</li> : null}
      {activity.map((entry, index) => (
        <li key={`${index}-${entry.at}`} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3">
          <span className="flex flex-col items-center">
            <span
              className={`mt-[5px] size-[7px] shrink-0 rounded-full ${entry.author === 'you' || !entry.author ? 'bg-dim' : 'bg-col-progress'}`}
            />
            {index < activity.length - 1 ? <span className="w-px flex-1 bg-edge" /> : null}
          </span>
          <div className="flex flex-col gap-[3px] pb-4">
            {entry.at ? (
              <span className="font-mono text-[10.5px] text-faint">
                {new Date(entry.at).toLocaleString()}
                {entry.author ? ` · ${entry.author}` : ''}
              </span>
            ) : null}
            <p className="m-0 whitespace-pre-wrap text-[12.5px] leading-normal text-ink">
              {entry.message}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** The exact prompt the agent receives, built from the saved task. */
export function PromptTab({
  agent,
  templateName,
  preview,
  failed
}: {
  /** The agent's short name, as the sentence uses it. */
  agent: string
  templateName: string
  preview: string | null
  /** The task could not be saved (no title), so there is nothing to build from. */
  failed: boolean
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-5 pb-5 pt-4">
      <div className="flex items-center gap-2 text-[12px] text-faint">
        <span>Exactly what {agent} receives, using</span>
        <Chip>{templateName}</Chip>
      </div>
      <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-[10px] border border-edge bg-chrome px-3.5 py-3 font-mono text-[11.5px] leading-[1.65] text-dim">
        {failed
          ? 'Give the task a title first — the preview is built from the saved task.'
          : (preview ?? 'Building preview…')}
      </pre>
    </div>
  )
}
