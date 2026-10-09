import { useState, type ReactNode } from 'react'
import {
  ORCHESTRATION_LANES,
  ORCHESTRATION_LANE_LABELS,
  type AutoDispatchState,
  type OrchestrationSummary
} from '@core/types.js'
import { Button, Card, CardRow, Modal, SwitchRow } from './ui.js'

export function OrchestrateDialog({
  summary,
  auto,
  onAutoChange,
  onConfirm,
  onClose
}: {
  summary: OrchestrationSummary
  auto: AutoDispatchState
  onAutoChange: (on: boolean) => void
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  const [confirmingStop, setConfirmingStop] = useState(false)
  const count = summary.dispatch.length
  const running = ORCHESTRATION_LANES.reduce((sum, lane) => sum + summary.occupied[lane], 0)
  const notes = [
    summary.idleSessions > 0
      ? `${summary.idleSessions} skipped — a terminal tab is still open for them`
      : '',
    summary.blocked > 0 ? `${summary.blocked} held back — waiting on other tasks` : '',
    summary.optedOut > 0 ? `${summary.optedOut} opted out of Dispatch` : '',
    summary.missingWorkingDir > 0
      ? `${summary.missingWorkingDir} skipped — no working directory`
      : ''
  ].filter(Boolean)

  return (
    <Modal
      title={count > 0 ? `Start ${count} Claude session${count === 1 ? '' : 's'}?` : 'Dispatch'}
      subtitle={
        count > 0
          ? "Each one runs in that task's working directory and can change files."
          : 'Nothing is ready to start right now.'
      }
      onClose={onClose}
      onSubmit={count > 0 ? onConfirm : onClose}
      footer={
        <>
          <Button onClick={onClose}>{count > 0 ? 'Cancel' : 'Close'}</Button>
          <Button variant="primary" onClick={onConfirm} disabled={count === 0}>
            Start {count} <kbd className="ml-0.5 font-mono text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <SwitchRow
            checked={auto.on && !confirmingStop}
            onChange={(on) => {
              if (!on) return setConfirmingStop(true)
              setConfirmingStop(false)
              if (!auto.on) onAutoChange(true)
            }}
            label={auto.on ? `Auto-run · ${running} running` : 'Auto-run'}
            hint="Start eligible tasks automatically as agents finish and new tasks become ready, while Styr is open. Turning it off starts nothing new; agents already running finish."
          />
          {confirmingStop && auto.on ? (
            <CardRow className="flex items-center justify-end gap-2 px-3.5 py-2.5">
              <span className="mr-auto text-[12px] text-dim">Stop Auto-run?</span>
              <Button onClick={() => setConfirmingStop(false)}>Keep running</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmingStop(false)
                  onAutoChange(false)
                }}
              >
                Stop Auto-run
              </Button>
            </CardRow>
          ) : null}
        </Card>
        {auto.paused ? (
          <p className="text-[11.5px] text-danger">
            {auto.paused === 'limit'
              ? 'Paused: Auto-run started too many tasks in an hour.'
              : 'Paused: three launches in a row failed.'}
          </p>
        ) : null}
        {!auto.on && running > 0 ? (
          <p className="text-[11.5px] text-faint">
            {running} dispatched task{running === 1 ? '' : 's'} still running — they will finish; no
            new ones start.
          </p>
        ) : null}
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
                {ORCHESTRATION_LANE_LABELS[entry.lane]} ·{' '}
                {entry.provider === 'codex' ? 'Codex' : 'Claude'}
              </span>
            </li>
          ))}
        </ol>

        {count > 0 ? (
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
        ) : null}

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

/** Stopping Auto-run is confirmed: it ends the workspace's only automatic run. */
export function StopAutoRunDialog({
  onConfirm,
  onClose
}: {
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  return (
    <Modal
      title="Stop Auto-run?"
      subtitle="No new tasks start in this workspace."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep running</Button>
          <Button variant="danger" onClick={onConfirm}>
            Stop Auto-run
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] text-dim">
        Agents already running finish their work. You can turn Auto-run back on from Dispatch.
      </p>
    </Modal>
  )
}
