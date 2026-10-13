import type { ReactNode } from 'react'
import { formatHours } from '@core/worklog.js'
import type { TimesheetSettings } from '@core/types.js'
import { Stepper } from '../ui.js'

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** `40.0h / week`: what the working days add up to. */
export function weeklyTargetLabel(timesheet: TimesheetSettings): string {
  const days = timesheet.workingDays.filter(Boolean).length
  return `${formatHours(timesheet.hoursPerDay * days)}h`
}

/** Hours per day, in half-hour steps. Shared by Settings → Timesheet and the Worklog popover. */
export function HoursPerDayStepper({
  timesheet,
  onChange,
  className = 'w-28'
}: {
  timesheet: TimesheetSettings
  onChange: (hoursPerDay: number) => void
  className?: string
}): ReactNode {
  return (
    <Stepper
      label="Hours per day"
      value={timesheet.hoursPerDay}
      min={0.5}
      max={16}
      step={0.5}
      format={(hours) => `${formatHours(hours)}h`}
      onChange={onChange}
      className={className}
    />
  )
}

/** Seven toggles, Monday first, for the days that carry a target. */
export function WorkingDaysPicker({
  timesheet,
  onChange,
  stretch = false
}: {
  timesheet: TimesheetSettings
  onChange: (workingDays: boolean[]) => void
  /** Fill the row rather than sit at a fixed width. */
  stretch?: boolean
}): ReactNode {
  return (
    <span role="group" aria-label="Working days" className="flex gap-1">
      {DAY_LETTERS.map((letter, index) => {
        const on = timesheet.workingDays[index] === true
        return (
          <button
            key={DAY_NAMES[index]}
            type="button"
            title={DAY_NAMES[index]}
            aria-label={DAY_NAMES[index]}
            aria-pressed={on}
            onClick={() =>
              onChange(timesheet.workingDays.map((day, other) => (other === index ? !day : day)))
            }
            className={`grid h-7 place-items-center rounded-[7px] border text-[11.5px] font-semibold transition-colors ${
              stretch ? 'flex-1' : 'w-7'
            } ${
              on
                ? 'border-accent bg-accent/20 text-ink'
                : 'border-edge-strong text-faint hover:text-ink'
            }`}
          >
            {letter}
          </button>
        )
      })}
    </span>
  )
}
