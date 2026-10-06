import { createContext, useContext } from 'react'
import { indexTasks, openBlockers } from '@core/blocking.js'
import type { Task } from '@core/types.js'

const EMPTY: ReadonlyMap<string, Task> = new Map()

/** Every task in the workspace by id, whatever the search or the Done cap is hiding. */
export const TaskLookupContext = createContext<ReadonlyMap<string, Task>>(EMPTY)

export function taskLookup(tasks: readonly Task[]): ReadonlyMap<string, Task> {
  return indexTasks(tasks)
}

/** The blockers still holding `task` back, from the surrounding lookup. */
export function useOpenBlockers(task: Task): Task[] {
  return openBlockers(task, useContext(TaskLookupContext))
}

/** One line for a confirm dialog or a tooltip: `TASK-0012 (In Progress), TASK-0013 (Backlog)`. */
export function describeBlockers(blockers: readonly Task[], label: (task: Task) => string): string {
  return blockers.map((blocker) => `${blocker.id} (${label(blocker)})`).join(', ')
}
