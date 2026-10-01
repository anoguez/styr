import { useCallback, useEffect, useMemo, useState } from 'react'
import { TASK_STATUSES, type Task, type TaskStatus } from '@core/types.js'

export type TaskBoard = Record<TaskStatus, Task[]>

function emptyBoard(): TaskBoard {
  return { backlog: [], in_progress: [], in_review: [], done: [] }
}

export interface TaskProblem {
  filePath: string
  reason: string
}

export function useTasks(query: string): {
  tasks: Task[]
  board: TaskBoard
  problems: TaskProblem[]
  loading: boolean
  refresh: () => Promise<void>
} {
  const [tasks, setTasks] = useState<Task[]>([])
  const [problems, setProblems] = useState<TaskProblem[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [next, broken] = await Promise.all([
      window.api.tasks.list(query ? { query } : {}),
      window.api.tasks.problems()
    ])
    setTasks(next)
    setProblems(broken)
    setLoading(false)
  }, [query])

  useEffect(() => {
    void refresh()
    return window.api.tasks.onChanged(() => void refresh())
  }, [refresh])

  const board = useMemo(() => {
    const grouped = emptyBoard()
    for (const status of TASK_STATUSES) {
      grouped[status] = tasks.filter((task) => task.status === status)
    }
    return grouped
  }, [tasks])

  return { tasks, board, problems, loading, refresh }
}
