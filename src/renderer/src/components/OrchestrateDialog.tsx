import { useState, type ReactNode } from 'react'
import {
  ORCHESTRATION_LANES,
  ORCHESTRATION_LANE_LABELS,
  type AutoDispatchState,
  type OrchestrationSummary
} from '@core/types.js'
import { Button, Card, Modal, SwitchRow } from './ui.js'

export function OrchestrateDialog({
  summary,
  auto,
  onConfirm,
  onClose
}: {
  summary: OrchestrationSummary
  auto: AutoDispatchState
  /** Starts the listed tasks (if any) and applies the Auto-run choice made in the dialog. */
  onConfirm: (autoOn: boolean) => void
  onClose: () => void
}): ReactNode {
  // The switch is a draft: Auto-run changes only when the dialog is confirmed, never on toggle.
  const [autoOn, setAutoOn] = useState(auto.on)
  const count = summary.dispatch.length
  const autoChanged = autoOn !== auto.on
  const canConfirm = count > 0 || autoChanged
  const confirm = (): void => onConfirm(autoOn)
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
      onSubmit={canConfirm ? confirm : onClose}
      footer={
        <>
          <Button onClick={onClose}>{canConfirm ? 'Cancel' : 'Close'}</Button>
          <Button variant="primary" onClick={confirm} disabled={!canConfirm}>
            {count > 0 ? `Start ${count}` : 'Apply'}{' '}
            <kbd className="ml-0.5 font-mono text-[10px] opacity-70">⌘↵</kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <SwitchRow
            checked={autoOn}
            onChange={setAutoOn}
            label="Auto-run"
            hint="Start eligible tasks automatically as agents finish and new tasks become ready, while Styr is open. Turning it off starts nothing new; agents already running finish."
          />
        </Card>
        {auto.paused ? (
          <p className="text-[11.5px] text-danger">
            {auto.paused === 'limit'
              ? 'Paused: Auto-run started too many tasks in an hour.'
              : 'Paused: three launches in a row failed.'}
          </p>
        ) : null}
        {!autoOn && running > 0 ? (
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
