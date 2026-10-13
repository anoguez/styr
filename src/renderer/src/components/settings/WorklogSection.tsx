import { useRef, type ReactNode } from 'react'
import { formatHours } from '@core/worklog.js'
import type { TimesheetSettings } from '@core/types.js'
import { DEFAULT_WORKLOG_PROMPT, WORKLOG_PROMPT_PLACEHOLDERS } from '@core/worklogPrompt.js'
import { Button, Card, CardRow, Hint, Segmented, inputBase } from '../ui.js'
import { insertToken } from './draft.js'
import {
  HoursPerDayStepper,
  WorkingDaysPicker,
  weeklyTargetLabel
} from '../worklog/TimesheetControls.js'
import type { SectionProps } from './sections.js'

function SettingRow({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: ReactNode
}): ReactNode {
  return (
    <CardRow>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-3.5 py-3">
        <span className="flex flex-col gap-[3px]">
          <span className="text-[12.5px] text-ink">{label}</span>
          <Hint>{hint}</Hint>
        </span>
        {children}
      </div>
    </CardRow>
  )
}

/** The Suggest hours brief. Empty means the shipped prompt, which the box shows until edited. */
function SuggestPromptEditor({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const box = useRef<HTMLTextAreaElement>(null)
  const text = value || DEFAULT_WORKLOG_PROMPT
  const store = (next: string): void => onChange(next === DEFAULT_WORKLOG_PROMPT ? '' : next)

  function insert(token: string): void {
    const element = box.current
    if (!element) return
    const { text: next, caret } = insertToken(
      text,
      element.selectionStart,
      element.selectionEnd,
      token
    )
    store(next)
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(caret, caret)
    })
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-semibold text-dim">Suggest hours prompt</span>
        <Button
          variant="subtle"
          className="ml-auto h-6 px-2"
          disabled={!value}
          onClick={() => onChange('')}
        >
          Reset to default
        </Button>
      </div>
      <textarea
        ref={box}
        aria-label="Suggest hours prompt"
        className={`${inputBase} min-h-56 w-full resize-y px-3.5 py-3 font-mono text-[12px] leading-[1.65]`}
        value={text}
        onChange={(event) => store(event.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <Hint>
          What the agent started by Suggest hours in the Worklog is told. It submits hours per task
          per day through the styr MCP server, and the Worklog shows them under Suggested. Click to
          insert:
        </Hint>
        <div className="flex flex-wrap gap-1">
          {WORKLOG_PROMPT_PLACEHOLDERS.map(({ name, hint }) => (
            <button
              key={name}
              type="button"
              title={hint}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insert(`{{${name}}}`)}
              className="h-5 rounded-[5px] bg-raised px-1.5 font-mono text-[10.5px] text-dim transition-colors hover:bg-edge-strong hover:text-ink"
            >
              {`{{${name}}}`}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export function WorklogSection({ draft, patch }: SectionProps): ReactNode {
  const timesheet = draft.timesheet
  const set = (changes: Partial<TimesheetSettings>): void =>
    patch({ timesheet: { ...timesheet, ...changes } })
  const days = timesheet.workingDays.filter(Boolean).length

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">Working hours</span>
        <Card>
          <SettingRow label="Hours per day" hint="What a full working day counts as.">
            <HoursPerDayStepper
              timesheet={timesheet}
              onChange={(hoursPerDay) => set({ hoursPerDay })}
            />
          </SettingRow>
          <SettingRow
            label="Working days"
            hint="Other days have no target, but hours logged on them still count."
          >
            <WorkingDaysPicker
              timesheet={timesheet}
              onChange={(workingDays) => set({ workingDays })}
            />
          </SettingRow>
          <CardRow>
            <div className="flex items-baseline gap-2 rounded-b-[10px] bg-raised/30 px-3.5 py-2.5">
              <span className="text-[12px] text-dim">Weekly target</span>
              <span className="ml-auto font-mono text-[13px] font-semibold text-ink">
                {weeklyTargetLabel(timesheet)}
              </span>
              <span className="text-[11.5px] text-faint">
                {days} {days === 1 ? 'day' : 'days'} × {formatHours(timesheet.hoursPerDay)}h
              </span>
            </div>
          </CardRow>
        </Card>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="text-[12px] font-semibold text-dim">View</span>
        <Card>
          <SettingRow label="Week starts on" hint="First column of the weekly timesheet.">
            <Segmented
              label="Week starts on"
              value={timesheet.weekStart}
              options={[
                { value: 'mon', label: 'Monday' },
                { value: 'sun', label: 'Sunday' }
              ]}
              onChange={(weekStart) => set({ weekStart })}
            />
          </SettingRow>
          <SettingRow label="Opens on" hint="The period the Worklog shows first.">
            <Segmented
              label="Opens on"
              value={timesheet.period}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' }
              ]}
              onChange={(period) => set({ period })}
            />
          </SettingRow>
          <SettingRow
            label="Group timesheet by"
            hint="Use Project if you log hours per project rather than per task."
          >
            <Segmented
              label="Group timesheet by"
              value={timesheet.groupBy}
              options={[
                { value: 'task', label: 'Task' },
                { value: 'project', label: 'Project' }
              ]}
              onChange={(groupBy) => set({ groupBy })}
            />
          </SettingRow>
          <SettingRow label="Round entries to" hint="Applied per task per day, before totals.">
            <Segmented
              label="Round entries to"
              value={String(timesheet.roundMinutes) as '0' | '15' | '30'}
              options={[
                { value: '0', label: 'Exact' },
                { value: '15', label: '15 min' },
                { value: '30', label: '30 min' }
              ]}
              onChange={(minutes) =>
                set({ roundMinutes: Number(minutes) as TimesheetSettings['roundMinutes'] })
              }
            />
          </SettingRow>
          <SettingRow label="Copy format" hint="What Copy for timesheet puts on the clipboard.">
            <Segmented
              label="Copy format"
              value={timesheet.copyFormat}
              options={[
                { value: 'tsv', label: 'Spreadsheet' },
                { value: 'csv', label: 'CSV' }
              ]}
              onChange={(copyFormat) => set({ copyFormat })}
            />
          </SettingRow>
        </Card>
        <Hint>
          Hours come from agent sessions, activity notes and commits on each task. You can open
          these settings from the Worklog too.
        </Hint>
      </div>
      <SuggestPromptEditor
        value={timesheet.suggestPrompt}
        onChange={(suggestPrompt) => set({ suggestPrompt })}
      />
    </>
  )
}
