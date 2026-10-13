/**
 * Suggested timesheet hours, one file per day: `<workspace>/worklog/<YYYY-MM-DD>.json`. An agent
 * run by Suggest hours writes them through the MCP server's `suggest_worklog`; the Worklog reads
 * them beside the measured hours. A day's file is replaced whole, so a new suggestion never mixes
 * with an old one. Node-only.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { workspaceDir } from './config.js'
import { worklogDaySchema, worklogSuggestionSchema } from './taskSchema.js'
import type { Settings, WorklogDaySuggestions, WorklogSuggestion } from './types.js'

export function worklogDir(settings: Settings): string {
  return join(workspaceDir(settings), 'worklog')
}

/** Writes the suggested days, replacing each day's file; days not mentioned are left alone. */
export function writeWorklogSuggestions(
  settings: Settings,
  suggestions: readonly WorklogSuggestion[],
  now = new Date()
): WorklogDaySuggestions[] {
  const entries = suggestions.map((entry) => worklogSuggestionSchema.parse(entry))
  const byDay = new Map<string, WorklogDaySuggestions>()
  for (const { day, ...entry } of entries) {
    const file = byDay.get(day) ?? { day, generatedAt: now.toISOString(), entries: [] }
    file.entries.push(entry)
    byDay.set(day, file)
  }
  const dir = worklogDir(settings)
  mkdirSync(dir, { recursive: true })
  for (const file of byDay.values()) {
    const target = join(dir, `${file.day}.json`)
    // Write then rename, so the watcher never reads half a file.
    writeFileSync(`${target}.tmp`, `${JSON.stringify(file, null, 2)}\n`)
    renameSync(`${target}.tmp`, target)
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day))
}

/** The suggested days from `first` to `last` (`YYYY-MM-DD`, inclusive). A bad file is skipped. */
export function readWorklogSuggestions(
  settings: Settings,
  first: string,
  last: string
): WorklogDaySuggestions[] {
  const dir = worklogDir(settings)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .filter((day) => day >= first && day <= last)
    .sort()
    .flatMap((day) => {
      try {
        const parsed = worklogDaySchema.safeParse(
          JSON.parse(readFileSync(join(dir, `${day}.json`), 'utf8'))
        )
        return parsed.success && parsed.data.day === day ? [parsed.data] : []
      } catch {
        return []
      }
    })
}
