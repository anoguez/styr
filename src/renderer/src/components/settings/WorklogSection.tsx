import type { ReactNode } from 'react'
import { formatHours } from '@core/worklog.js'
import type { TimesheetSettings } from '@core/types.js'
import { Card, CardRow, Hint, Segmented } from '../ui.js'
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
    </>
  )
}
