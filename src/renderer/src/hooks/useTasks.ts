import { useCallback, useEffect, useMemo, useState } from 'react'
import { applyDoneCap, sortDoneNewestFirst } from '@core/doneCap.js'
import { TASK_STATUSES, type DoneCap, type Task, type TaskStatus } from '@core/types.js'

export type TaskBoard = Record<TaskStatus, Task[]>

function emptyBoard(): TaskBoard {
  return { backlog: [], in_progress: [], in_review: [], done: [] }
}

export interface TaskProblem {
  filePath: string
  reason: string
}

export function useTasks(
  doneCap: DoneCap,
  showAllDone: boolean
): {
  tasks: Task[]
  /** Every task in the workspace — blockers are looked up here. */
  allTasks: Task[]
  board: TaskBoard
  /** Done tasks the cap is hiding from the board right now. */
  hiddenDone: number
  /** Archived tasks, newest first. They are not on the board. */
  archived: Task[]
  problems: TaskProblem[]
  loading: boolean
  refresh: () => Promise<void>
} {
  const [tasks, setTasks] = useState<Task[]>([])
  const [problems, setProblems] = useState<TaskProblem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [next, broken] = await Promise.all([
      window.api.tasks.list({}),
      window.api.tasks.problems()
    ])
    setTasks(next)
    setProblems(broken)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
    return window.api.tasks.onChanged(() => void refresh())
  }, [refresh])

  const archived = useMemo(
    () =>
      tasks
        .filter((task) => task.archivedAt)
        .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
    [tasks]
  )

  const { board, hiddenDone } = useMemo(() => {
    const grouped = emptyBoard()
    const active = tasks.filter((task) => !task.archivedAt)
    for (const status of TASK_STATUSES) {
      grouped[status] = active.filter((task) => task.status === status)
    }
    grouped.done = sortDoneNewestFirst(grouped.done)
    const { visible, hidden } = applyDoneCap(grouped.done, doneCap)
    if (!showAllDone) grouped.done = visible
    return { board: grouped, hiddenDone: hidden.length }
  }, [tasks, doneCap, showAllDone])

  return { tasks, allTasks: tasks, board, hiddenDone, archived, problems, loading, refresh }
}
