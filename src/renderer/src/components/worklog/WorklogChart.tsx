import type { ReactNode } from 'react'
import { formatHours, type Worklog, type WorklogBucket } from '@core/worklog.js'

/** The bar label: `Mon 12` for a day, `Oct 5` for a week of a month. */
function barLabel(bucket: WorklogBucket, period: Worklog['period']): string {
  return period === 'month' ? bucket.label : `${bucket.label} ${bucket.sub}`
}

/** Hours per day (or per week of a month), stacked by project, over a dashed target. */
export function WorklogChart({
  worklog,
  projects,
  colorOf
}: {
  worklog: Worklog
  projects: string[]
  colorOf: (project: string) => string
}): ReactNode {
  const top = Math.max(1, ...worklog.chart.map((bucket) => Math.max(bucket.total, bucket.target)))
  const scale = (hours: number): string => `${(hours / (top * 1.05)) * 100}%`
  const selected = (bucket: WorklogBucket): boolean =>
    worklog.selectedDay
      ? bucket.days[0] === worklog.selectedDay
      : bucket.hasToday && worklog.period !== 'month'

  return (
    <section className="flex min-w-0 flex-[2_1_480px] flex-col gap-3.5 rounded-xl border border-edge bg-panel/80 px-4 py-3.5">
      <header className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <h2 className="m-0 text-[12.5px] font-semibold text-ink">{worklog.chartTitle}</h2>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-[11.5px] text-dim">
          {projects.map((project) => (
            <span key={project} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: colorOf(project) }}
              />
              {project}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2 rounded-[2px] border border-dashed border-faint" />
            Target
          </span>
        </div>
      </header>
      <div className="flex h-[190px] items-stretch gap-2.5">
        {worklog.chart.map((bucket) => {
          const short = !bucket.hasToday && bucket.target > 0 && bucket.total < bucket.target
          const ring = selected(bucket)
          return (
            <div key={bucket.days[0]} className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="relative flex-1">
                {bucket.target > 0 ? (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 bottom-0 rounded-md border border-dashed border-edge-strong bg-raised/35"
                    style={{ height: scale(bucket.target) }}
                  />
                ) : null}
                <div
                  className={`absolute inset-x-0 bottom-0 flex flex-col-reverse overflow-hidden rounded-md ${
                    ring ? 'shadow-[0_0_0_1.5px_var(--color-ink)]' : ''
                  }`}
                  style={{ height: scale(bucket.total) }}
                >
                  {projects
                    .filter((project) => bucket.byProject[project])
                    .map((project) => (
                      <div
                        key={project}
                        title={`${project} · ${formatHours(bucket.byProject[project]!)}h`}
                        className="shrink-0 border-t border-card"
                        style={{
                          height: `${(bucket.byProject[project]! / bucket.total) * 100}%`,
                          background: colorOf(project)
                        }}
                      />
                    ))}
                </div>
              </div>
              <div className="flex flex-col items-center gap-px">
                <span
                  className={`font-mono text-[12px] font-semibold ${
                    bucket.future
                      ? 'text-faint/60'
                      : short
                        ? 'text-[var(--color-col-review-text)]'
                        : 'text-ink'
                  }`}
                >
                  {bucket.future ? '—' : formatHours(bucket.total)}
                </span>
                <span
                  className={`whitespace-nowrap text-[11px] ${ring ? 'text-ink' : 'text-faint'}`}
                >
                  {barLabel(bucket, worklog.period)}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Each project's share of the period, and the tasks that took longest. */
export function ProjectBreakdown({
  worklog,
  colorOf
}: {
  worklog: Worklog
  colorOf: (project: string) => string
}): ReactNode {
  const share = (hours: number): string =>
    `${worklog.logged ? Math.round((hours / worklog.logged) * 100) : 0}%`
  return (
    <section className="flex min-w-0 flex-[1_1_260px] flex-col gap-3 rounded-xl border border-edge bg-panel/80 px-4 py-3.5">
      <h2 className="m-0 text-[12.5px] font-semibold text-ink">By project</h2>
      {worklog.groups.length === 0 ? (
        <p className="m-0 text-[12px] text-faint">Nothing logged in this period.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {worklog.groups.map((group) => (
            <div key={group.project} className="flex flex-col gap-1.5">
              <span className="flex items-baseline gap-2 text-[12.5px] text-ink">
                <span
                  aria-hidden
                  className="size-[7px] shrink-0 rounded-full"
                  style={{ background: colorOf(group.project) }}
                />
                <span className="min-w-0 truncate">{group.project}</span>
                <span className="ml-auto font-mono text-[12px] font-semibold">
                  {formatHours(group.total)}h
                </span>
                <span className="w-[34px] text-right font-mono text-[11px] text-faint">
                  {share(group.total)}
                </span>
              </span>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full rounded-full"
                  style={{ width: share(group.total), background: colorOf(group.project) }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {worklog.rows.length > 0 ? (
        <div className="mt-auto flex flex-col gap-1.5 border-t border-edge pt-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">
            Top tasks
          </span>
          {worklog.rows.slice(0, 3).map((row) => (
            <span
              key={row.taskId}
              className="flex min-w-0 items-baseline gap-2 text-[12px] text-dim"
            >
              <span className="shrink-0 font-mono text-[10.5px] text-faint">{row.taskId}</span>
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="shrink-0 font-mono text-[12px] font-semibold text-ink">
                {formatHours(row.total)}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  )
}
