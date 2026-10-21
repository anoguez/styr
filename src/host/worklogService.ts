import { z } from 'zod'
import type { Task, WorklogData, WorklogTask } from '@core/types.js'
import { collectWorklog, type WorklogSourcePorts } from '@core/worklogSources.js'

export interface WorklogServicePorts {
  /** The active board, from the index. */
  query(): Task[]
  /** The transcripts the tokens are read from (`diskWorklogSources`). */
  sources: WorklogSourcePorts
  /** Lets IPC, the watcher and the terminals run between two tasks' transcript reads. */
  yieldTurn(): Promise<void>
}

const spanSchema = z.object({ from: z.number().finite(), to: z.number().finite() })

/**
 * The Worklog for `[from, to)`: each task's sessions and the tokens their transcripts record. On
 * demand only, never from `notifyTasksChanged`; the loop yields between tasks.
 */
export function createWorklogService(ports: WorklogServicePorts) {
  async function load(from: unknown, to: unknown): Promise<WorklogData> {
    const span = spanSchema.parse({ from, to })
    const tasks: WorklogTask[] = []
    for (const task of ports.query()) {
      await ports.yieldTurn()
      tasks.push(...collectWorklog([task], span.from, span.to, ports.sources))
    }
    return { tasks }
  }

  return { load }
}
