import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import {
  ORCHESTRATION_LANES,
  ORCHESTRATION_LANE_LABELS,
  type AutoDispatchState,
  type OrchestrationSummary
} from '@core/types.js'
import { Button, Card, CardRow, Modal, SwitchRow } from './ui.js'
import { formatAccelerator } from '@core/shortcuts.js'
import {
  checkedIds,
  initialSelection,
  mergeSelection,
  orderDiffers,
  type DispatchSelection
} from '../lib/dispatchSelection.js'
import { DispatchRow } from './DispatchRow.js'

export function OrchestrateDialog({
  summary,
  reviewLimit,
  auto,
  remoteHost,
  onAutoStop,
  onConfirm,
  onClose
}: {
  summary: OrchestrationSummary
  /** The workspace's failed-review cap (`autoDispatchLimits.reviews`). */
  reviewLimit: number
  auto: AutoDispatchState
  /** Set for a remote workspace: Auto-run runs on that host, for the workspace it shows. */
  remoteHost?: string
  /** Stops a running Auto-run once the user confirms; switching it on waits for `onConfirm`. */
  onAutoStop: () => void
  /** Starts the checked tasks, in the order shown, and applies the Auto-run choice made here. */
  onConfirm: (autoOn: boolean, taskIds: string[]) => void
  onClose: () => void
}): ReactNode {
  // Switching Auto-run on is a draft, applied only when the dialog is confirmed. Stopping a running
  // Auto-run is its own explicit action behind an inline confirmation.
  const [autoOn, setAutoOn] = useState(auto.on)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const planIds = useMemo(() => summary.dispatch.map((entry) => entry.taskId), [summary.dispatch])
  const planKey = planIds.join('\n')
  // The order and unchecked rows are a one-run override, never stored: closing discards them.
  const [selection, setSelection] = useState<DispatchSelection>(() => initialSelection(planIds))
  const [dragging, setDragging] = useState(false)
  // A refresh of the plan is applied once the drop lands, never mid-drag.
  useEffect(() => {
    if (!dragging) setSelection((previous) => mergeSelection(previous, planIds))
    // planKey stands for planIds' content; the array identity changes on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, dragging])
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const byId = new Map(summary.dispatch.map((entry) => [entry.taskId, entry]))
  const rows = selection.order.flatMap((id) => {
    const entry = byId.get(id)
    return entry ? [entry] : []
  })
  const skipped = new Set(selection.skipped)
  const checked = checkedIds(selection)
    .map((id) => byId.get(id))
    .filter((entry) => entry !== undefined)
  const count = checked.length
  const skippedCount = rows.length - count
  const handleDragEnd = (event: DragEndEvent): void => {
    setDragging(false)
    const { active, over } = event
    if (!over || active.id === over.id) return
    setSelection((previous) => {
      const from = previous.order.indexOf(String(active.id))
      const to = previous.order.indexOf(String(over.id))
      return from < 0 || to < 0
        ? previous
        : { ...previous, order: arrayMove(previous.order, from, to) }
    })
  }
  const toggle = (id: string, on: boolean): void =>
    setSelection((previous) => ({
      ...previous,
      skipped: on ? previous.skipped.filter((s) => s !== id) : [...previous.skipped, id]
    }))
  const autoChanged = autoOn !== auto.on
  // While the stop question is open the switch reads off but Auto-run is still on; confirming then
  // would start tasks with Auto-run left running, so the question must be answered first.
  const canConfirm = (count > 0 || autoChanged) && !confirmingStop
  const confirm = (): void =>
    onConfirm(
      autoOn,
      checked.map((entry) => entry.taskId)
    )
  const running = ORCHESTRATION_LANES.reduce((sum, lane) => sum + summary.occupied[lane], 0)
  const notes = [
    summary.idleSessions > 0
      ? `${summary.idleSessions} skipped — a terminal tab is still open for them`
      : '',
    summary.blocked > 0 ? `${summary.blocked} held back — waiting on other tasks` : '',
    summary.optedOut > 0 ? `${summary.optedOut} opted out of Dispatch` : '',
    summary.missingWorkingDir > 0
      ? `${summary.missingWorkingDir} skipped — no working directory`
      : '',
    summary.reworkHeld.length > 0
      ? `${summary.reworkHeld.join(', ')} failed review ${reviewLimit} times — Auto-run leaves ${summary.reworkHeld.length === 1 ? 'it' : 'them'} to you; this run starts ${summary.reworkHeld.length === 1 ? 'it' : 'them'} anyway`
      : ''
  ].filter(Boolean)

  return (
    <Modal
      title={count > 0 ? `Start ${count} Claude session${count === 1 ? '' : 's'}?` : 'Dispatch'}
      subtitle={
        count > 0
          ? "Each one runs in that task's working directory and can change files."
          : rows.length > 0
            ? 'Nothing is checked to start.'
            : 'Nothing is ready to start right now.'
      }
      onClose={onClose}
      onSubmit={canConfirm ? confirm : confirmingStop ? undefined : onClose}
      footer={
        <>
          <Button onClick={onClose}>{canConfirm ? 'Cancel' : 'Close'}</Button>
          <Button variant="primary" onClick={confirm} disabled={!canConfirm}>
            {count > 0 ? `Start ${count}` : 'Apply'}{' '}
            <kbd className="ml-0.5 font-mono text-[10px] opacity-70">
              {formatAccelerator('mod+enter')}
            </kbd>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Card>
          <SwitchRow
            checked={autoOn && !confirmingStop}
            onChange={(on) => {
              if (!on && auto.on) return setConfirmingStop(true)
              setConfirmingStop(false)
              setAutoOn(on)
            }}
            label={auto.on ? `Auto-run · ${running} running` : 'Auto-run'}
            hint={
              remoteHost
                ? `Start eligible tasks automatically as agents finish and new tasks become ready. It runs on ${remoteHost}, so it keeps going while this computer is closed — but only for the workspace that server is showing. If another computer switches it to a different workspace, Auto-run follows that one. Turning it off starts nothing new; agents already running finish.`
                : 'Start eligible tasks automatically as agents finish and new tasks become ready, while Styr is open. Turning it off starts nothing new; agents already running finish.'
            }
          />
          {confirmingStop && auto.on ? (
            <CardRow className="flex items-center justify-end gap-2 px-3.5 py-2.5">
              <span className="mr-auto text-[12px] text-dim">Stop Auto-run?</span>
              <Button onClick={() => setConfirmingStop(false)}>Keep running</Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmingStop(false)
                  setAutoOn(false)
                  onAutoStop()
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
        {!autoOn && running > 0 ? (
          <p className="text-[11.5px] text-faint">
            {running} dispatched task{running === 1 ? '' : 's'} still running — they will finish; no
            new ones start.
          </p>
        ) : null}
        {rows.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline gap-2 text-[11px] text-faint">
              <span className="min-w-0 flex-1">
                Order follows priority, then board order. Reordering only changes the sequence they
                launch in and their tab order — not which tasks start.
              </span>
              {orderDiffers(selection, planIds) ? (
                <button
                  type="button"
                  className="shrink-0 text-accent hover:underline"
                  onClick={() => setSelection((previous) => ({ ...previous, order: [...planIds] }))}
                >
                  Reset order
                </button>
              ) : null}
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={() => setDragging(true)}
              onDragCancel={() => setDragging(false)}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={selection.order} strategy={verticalListSortingStrategy}>
                <ol className="flex flex-col divide-y divide-edge overflow-hidden rounded-lg border border-edge-strong bg-chrome">
                  {rows.map((entry) => {
                    const on = !skipped.has(entry.taskId)
                    return (
                      <DispatchRow
                        key={entry.taskId}
                        entry={entry}
                        checked={on}
                        position={on ? checked.indexOf(entry) + 1 : null}
                        onToggle={(value) => toggle(entry.taskId, value)}
                      />
                    )
                  })}
                </ol>
              </SortableContext>
            </DndContext>
          </div>
        ) : null}
        {autoOn && skippedCount > 0 ? (
          <p className="text-[11.5px] text-faint">
            Auto-run will still pick the {skippedCount} skipped task{skippedCount === 1 ? '' : 's'}{' '}
            up on its next pass.
          </p>
        ) : null}

        {count > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium text-dim">Slots after this</p>
            <div className="flex gap-2">
              {ORCHESTRATION_LANES.map((lane) => {
                const starting = checked.filter((entry) => entry.lane === lane).length
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
