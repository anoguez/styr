import { useMemo } from 'react'
import { shownAgents, type AgentStatus } from '@core/agentState.js'
import type { Task } from '@core/types.js'
import { taskLookup } from '../lib/blockerContext.js'
import { boardTasks, sortBoard, taskSummaries, type Board } from '../lib/boardView.js'

/**
 * The board as the views show it: columns sorted, the agents the views label, a lookup over every
 * task (for blockers), and the titles and states terminal tabs read.
 */
export function useBoardView(
  rawBoard: Board,
  allTasks: Task[],
  agents: ReadonlyMap<string, AgentStatus>
) {
  const board = useMemo(() => sortBoard(rawBoard, agents), [rawBoard, agents])
  const tasks = useMemo(() => boardTasks(board), [board])
  // What the views label each agent; Dispatch and the PR/review buttons keep the hook's `agents`.
  const shown = useMemo(() => shownAgents(agents, allTasks), [agents, allTasks])
  const lookup = useMemo(() => taskLookup(allTasks), [allTasks])
  const { titles, states } = useMemo(() => taskSummaries(tasks), [tasks])
  return { board, tasks, shown, lookup, taskTitles: titles, taskStates: states }
}
