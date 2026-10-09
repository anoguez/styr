import type { ReactNode } from 'react'
import {
  ORCHESTRATION_LANE_LABELS,
  ORCHESTRATION_LANES,
  TASK_STATUS_LABELS,
  TASK_STATUSES
} from '@core/types.js'
import { Card, CardRow, Chip, Eyebrow, Field, Hint } from '../ui.js'
import { LANE_HINTS, LaneAgentSelect, TemplateSelect } from './parts.js'
import type { SectionProps } from './sections.js'

const COLUMN_TOKENS = {
  backlog: 'backlog',
  in_progress: 'progress',
  in_review: 'review',
  done: 'done'
} as const

function RouteArrow(): ReactNode {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-faint"
    >
      <path d="M3 8h9.5M9 4.5 12.5 8 9 11.5" />
    </svg>
  )
}

export function RoutingSection({ draft, patch }: SectionProps): ReactNode {
  return (
    <>
      <Card>
        <div className="grid grid-cols-[minmax(0,1fr)_24px_200px] items-center gap-2.5 border-b border-edge px-3.5 py-2">
          <Eyebrow>When a task is</Eyebrow>
          <span />
          <Eyebrow>Run this template</Eyebrow>
        </div>
        <CardRow className="grid grid-cols-[minmax(0,1fr)_24px_200px] items-center gap-2.5 px-3.5 py-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span>
              <Chip tone="warn">
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  className="mr-1"
                >
                  <path d="M2.5 3.5v4l6 6 5-5-6-6h-4a1 1 0 0 0-1 1z" />
                  <circle cx="5.5" cy="5.5" r="0.9" fill="currentColor" />
                </svg>
                Needs spec
              </Chip>
            </span>
            <span className="text-[11px] text-faint">Any column</span>
          </span>
          <RouteArrow />
          <TemplateSelect
            label="Template for Needs spec"
            templates={draft.promptTemplates}
            value={draft.promptRouting.needsSpec}
            onChange={(needsSpec) =>
              patch({ promptRouting: { ...draft.promptRouting, needsSpec } })
            }
          />
        </CardRow>
        {TASK_STATUSES.map((status) => (
          <CardRow
            key={status}
            className="grid grid-cols-[minmax(0,1fr)_24px_200px] items-center gap-2.5 px-3.5 py-2"
          >
            <span className="flex items-center gap-2 text-[12.5px] text-ink">
              <span
                className="size-[7px] rounded-full"
                style={{ backgroundColor: `var(--color-col-${COLUMN_TOKENS[status]})` }}
              />
              {TASK_STATUS_LABELS[status]}
            </span>
            <RouteArrow />
            <TemplateSelect
              label={`Template for ${TASK_STATUS_LABELS[status]}`}
              templates={draft.promptTemplates}
              value={draft.promptRouting.byStatus[status]}
              onChange={(id) =>
                patch({
                  promptRouting: {
                    ...draft.promptRouting,
                    byStatus: { ...draft.promptRouting.byStatus, [status]: id }
                  }
                })
              }
            />
          </CardRow>
        ))}
      </Card>
      <Hint>
        The Needs spec tag wins over the column, so unspecified work is always specced first. A
        template pinned on a task overrides all of this.
      </Hint>
      <div className="flex flex-col gap-2.5">
        <Eyebrow>Agent for each lane</Eyebrow>
        <Card>
          {ORCHESTRATION_LANES.map((lane) => (
            <CardRow
              key={lane}
              className="grid grid-cols-[minmax(0,1fr)_200px] items-center gap-2.5 px-3.5 py-2"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[12.5px] text-ink">{ORCHESTRATION_LANE_LABELS[lane]}</span>
                <span className="text-[11px] text-faint">{LANE_HINTS[lane]}</span>
              </span>
              <LaneAgentSelect lane={lane} draft={draft} patch={patch} />
            </CardRow>
          ))}
        </Card>
        <Hint>
          Dispatch uses these providers. Claude remains the default until you opt a lane into Codex.
          The same choice is in the Dispatch section.
        </Hint>
      </div>
      <Field
        label="Fallback template"
        hint="Used only if a routing entry above points at a template that no longer exists."
      >
        <TemplateSelect
          label="Fallback template"
          templates={draft.promptTemplates}
          value={draft.defaultPromptTemplateId}
          onChange={(defaultPromptTemplateId) => patch({ defaultPromptTemplateId })}
        />
      </Field>
    </>
  )
}
