import type { ReactNode } from 'react'
import {
  ORCHESTRATION_LANE_LABELS,
  ORCHESTRATION_LANES,
  type AutoDispatchLimits
} from '@core/types.js'
import { Card, CardRow, Eyebrow, Hint, Stepper } from '../ui.js'
import { LANE_HINTS, LaneAgentSelect } from './parts.js'
import type { SectionProps } from './sections.js'

const LIMIT_ROWS: {
  key: keyof AutoDispatchLimits
  label: string
  hint: string
  max: number
}[] = [
  {
    key: 'launchesPerHour',
    label: 'Starts per hour',
    hint: 'Auto-run switches itself off after this many launches in a rolling hour.',
    max: 200
  },
  {
    key: 'failures',
    label: 'Failed starts in a row',
    hint: 'Auto-run switches itself off after this many launches fail one after another.',
    max: 20
  },
  {
    key: 'reviews',
    label: 'Failed reviews per task',
    hint: 'After this many failed reviews Auto-run leaves a task to you. Dispatch now still starts it.',
    max: 20
  }
]

export function DispatchSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <>
      <Card>
        <div className="grid grid-cols-[minmax(0,1fr)_150px_104px] items-center gap-3 border-b border-edge px-3.5 py-2">
          <Eyebrow>Lane</Eyebrow>
          <Eyebrow>Agent</Eyebrow>
          <span className="text-center">
            <Eyebrow>At once</Eyebrow>
          </span>
        </div>
        {ORCHESTRATION_LANES.map((lane) => (
          <CardRow
            key={lane}
            className={`grid grid-cols-[minmax(0,1fr)_150px_104px] items-center gap-3 px-3.5 py-2.5 ${
              draft.orchestration[lane] === 0 ? 'opacity-60' : ''
            }`}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-ink">
                {ORCHESTRATION_LANE_LABELS[lane]}
              </span>
              <span className="text-[11px] text-faint">
                {draft.orchestration[lane] === 0
                  ? 'Skipped — Dispatch leaves these alone'
                  : LANE_HINTS[lane]}
              </span>
            </span>
            <LaneAgentSelect lane={lane} draft={draft} patch={patch} />
            <Stepper
              label={ORCHESTRATION_LANE_LABELS[lane]}
              value={draft.orchestration[lane]}
              min={0}
              max={20}
              onChange={(value) =>
                patch({ orchestration: { ...draft.orchestration, [lane]: value } })
              }
            />
          </CardRow>
        ))}
      </Card>
      <Hint>
        Dispatch fills free slots with the highest-priority waiting task. A slot is busy while its
        session is live. Set a lane to 0 to skip it. Up to{' '}
        {ORCHESTRATION_LANES.reduce((sum, lane) => sum + draft.orchestration[lane], 0)} agents can
        run at once.
      </Hint>
      <Card>
        <CardRow className="px-3.5 py-2.5">
          <span className="text-[12.5px] font-medium text-ink">Auto-run safety limits</span>
        </CardRow>
        {LIMIT_ROWS.map(({ key, label, hint, max }) => (
          <CardRow
            key={key}
            className="grid grid-cols-[minmax(0,1fr)_104px] items-center gap-3 px-3.5 py-2.5"
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[12.5px] font-medium text-ink">{label}</span>
              <span className="text-[11px] text-faint">{hint}</span>
            </span>
            <Stepper
              label={label}
              value={draft.autoDispatchLimits[key]}
              min={1}
              max={max}
              onChange={(value) =>
                patch({ autoDispatchLimits: { ...draft.autoDispatchLimits, [key]: value } })
              }
            />
          </CardRow>
        ))}
      </Card>
      <Hint>
        Limits apply from Auto-run&apos;s next pass, to work already in the task files too: lowering
        the failed-review limit can newly hand tasks back to you, raising it releases them.
      </Hint>
    </>
  )
}
