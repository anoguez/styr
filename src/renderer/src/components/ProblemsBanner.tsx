import type { ReactNode } from 'react'
import type { TaskProblem } from '../hooks/useTasks.js'
import { fileName } from '../lib/terminalPath.js'

/** Task files that failed to parse: hidden from the board and never rewritten, so say which. */
export function ProblemsBanner({ problems }: { problems: TaskProblem[] }): ReactNode {
  if (problems.length === 0) return null
  const one = problems.length === 1
  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
      <p className="text-[12px] text-amber-200">
        {problems.length} task file{one ? '' : 's'} could not be read and {one ? 'is' : 'are'}{' '}
        hidden from the board. Nothing was changed on disk — fix the frontmatter and{' '}
        {one ? 'it' : 'they'} will reappear.
      </p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {problems.map((problem) => (
          <li key={problem.filePath} className="font-mono text-[10px] text-amber-200/70">
            {fileName(problem.filePath)} — {problem.reason.split('\n')[0]}
          </li>
        ))}
      </ul>
    </div>
  )
}
