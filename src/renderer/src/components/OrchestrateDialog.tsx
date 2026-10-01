import type { ReactNode } from 'react'
import {
  ORCHESTRATION_LANES,
  ORCHESTRATION_LANE_LABELS,
  type OrchestrationSummary
} from '@core/types.js'
import { Button, Modal } from './ui.js'

export function OrchestrateDialog({
  summary,
  onConfirm,
  onClose
}: {
  summary: OrchestrationSummary
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  const count = summary.dispatch.length
  const notes = [
    summary.idleSessions > 0
      ? `${summary.idleSessions} skipped — a terminal tab is still open for them`
      : '',
    summary.optedOut > 0 ? `${summary.optedOut} opted out of Orchestrate` : '',
    summary.missingWorkingDir > 0
      ? `${summary.missingWorkingDir} skipped — no working directory`
      : ''
  ].filter(Boolean)

  return (
    <Modal
      title={`Start ${count} Claude session${count === 1 ? '' : 's'}?`}
      subtitle="Each one runs in that task's working directory and can change files."
      onClose={onClose}
      onSubmit={onConfirm}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={onConfirm}>
            Start {count} <kbd className="ml-0.5 font-mono text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ol className="flex flex-col divide-y divide-edge overflow-hidden rounded-lg border border-edge-strong bg-chrome">
          {summary.dispatch.map((entry, index) => (
            <li key={entry.taskId} className="flex items-center gap-3 px-3 py-2.5">
              <span className="grid size-[18px] shrink-0 place-items-center rounded-[5px] bg-accent font-mono text-[10px] font-semibold text-[var(--color-on-accent)]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-ink">{entry.title}</span>
                <span className="font-mono text-[10px] text-faint">{entry.taskId}</span>
              </span>
              <span className="shrink-0 rounded bg-raised px-1.5 py-[1px] text-[10.5px] text-dim">
                {ORCHESTRATION_LANE_LABELS[entry.lane]}
              </span>
            </li>
          ))}
        </ol>

        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] font-medium text-dim">Slots after this</p>
          <div className="flex gap-2">
            {ORCHESTRATION_LANES.map((lane) => {
              const starting = summary.dispatch.filter((entry) => entry.lane === lane).length
              return (
                <span
                  key={lane}
                  className="rounded-md border border-edge bg-chrome px-2 py-1 font-mono text-[10.5px] text-dim"
                >
                  {ORCHESTRATION_LANE_LABELS[lane]} {summary.occupied[lane] + starting}/
                  {summary.capacity[lane]}
                </span>
              )
            })}
          </div>
        </div>

        {notes.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {notes.map((note) => (
              <li key={note} className="text-[11.5px] text-faint">
                {note}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  )
}
