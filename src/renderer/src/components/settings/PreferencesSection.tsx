import type { ReactNode } from 'react'
import { Card, CardRow, Hint, Stepper, SwitchRow } from '../ui.js'
import type { SectionProps } from './sections.js'

export function PreferencesSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">New tasks start with</span>
        <Card>
          <CardRow>
            <SwitchRow
              checked={draft.taskDefaults.useWorktree}
              onChange={(useWorktree) =>
                patch({ taskDefaults: { ...draft.taskDefaults, useWorktree } })
              }
              label="Own git worktree"
              hint="Each agent gets a separate checkout on a styr/TASK-… branch, so parallel runs never collide."
            />
          </CardRow>
          <CardRow>
            <SwitchRow
              checked={draft.taskDefaults.orchestrate}
              onChange={(orchestrate) =>
                patch({ taskDefaults: { ...draft.taskDefaults, orchestrate } })
              }
              label="Dispatch can start it"
              hint="Dispatch may pick the task up when a slot is free."
            />
          </CardRow>
        </Card>
        <Hint>You can still change both on any task.</Hint>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">Done column shows</span>
        <Card>
          <CardRow>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
              <span className="flex flex-col gap-[3px]">
                <span className="text-[12.5px] text-ink">Most recent tasks</span>
                <Hint>How many finished tasks stay on the board. 0 shows them all.</Hint>
              </span>
              <Stepper
                label="Most recent tasks"
                value={draft.doneCap.maxCount}
                min={0}
                max={1000}
                onChange={(maxCount) => patch({ doneCap: { ...draft.doneCap, maxCount } })}
              />
            </div>
          </CardRow>
          <CardRow>
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
              <span className="flex flex-col gap-[3px]">
                <span className="text-[12.5px] text-ink">Finished within (days)</span>
                <Hint>Older tasks are hidden. 0 never hides by age.</Hint>
              </span>
              <Stepper
                label="Finished within (days)"
                value={draft.doneCap.maxAgeDays}
                min={0}
                max={365}
                onChange={(maxAgeDays) => patch({ doneCap: { ...draft.doneCap, maxAgeDays } })}
              />
            </div>
          </CardRow>
        </Card>
        <Hint>Hidden tasks are not archived — Show all in the Done column brings them back.</Hint>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">Ask agent</span>
        <Card>
          <CardRow>
            <SwitchRow
              checked={draft.autoArchiveAsk}
              onChange={(autoArchiveAsk) => patch({ autoArchiveAsk })}
              label="Archive Ask agent chats when they end"
              hint="Only while the task is still In Progress and tagged ask. Resume it from the Archive dialog; remove the tag to keep the card."
            />
          </CardRow>
        </Card>
      </div>
    </>
  )
}
