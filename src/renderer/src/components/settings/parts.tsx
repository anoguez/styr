import type { ReactNode } from 'react'
import {
  ORCHESTRATION_LANE_LABELS,
  type OrchestrationLane,
  type PromptTemplate
} from '@core/types.js'
import { Select } from '../ui.js'
import type { SectionProps } from './sections.js'

export const LANE_HINTS: Record<OrchestrationLane, string> = {
  spec: 'tasks flagged as needing a spec',
  implement: 'ready tasks in Backlog',
  review: 'tasks sitting in In Review'
}

/** The agent a Dispatch lane runs, from the enabled providers; shared by Routing and Dispatch. */
export function LaneAgentSelect({
  lane,
  draft,
  patch
}: SectionProps & { lane: OrchestrationLane }): ReactNode {
  return (
    <Select
      compact
      aria-label={`Agent for ${ORCHESTRATION_LANE_LABELS[lane]}`}
      value={draft.providerRouting[lane]}
      onChange={(event) =>
        patch({
          providerRouting: {
            ...draft.providerRouting,
            [lane]: event.target.value as 'claude' | 'codex'
          }
        })
      }
    >
      {draft.enabledProviders.includes('claude') ? (
        <option value="claude">Claude Code</option>
      ) : null}
      {draft.enabledProviders.includes('codex') ? <option value="codex">Codex</option> : null}
    </Select>
  )
}

export function TemplateSelect({
  label,
  templates,
  value,
  onChange
}: {
  label: string
  templates: PromptTemplate[]
  value: string
  onChange: (id: string) => void
}): ReactNode {
  return (
    <Select
      compact
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {templates.map((template) => (
        <option key={template.id} value={template.id}>
          {template.name}
        </option>
      ))}
    </Select>
  )
}
