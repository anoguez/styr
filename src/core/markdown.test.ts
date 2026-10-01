import { describe, expect, it } from 'vitest'
import { parseTaskMarkdown, serialiseTask } from './markdown.js'
import type { Task } from './types.js'

const task: Task = {
  id: 'TASK-0042',
  title: 'Preserve a task',
  status: 'in_review',
  priority: 'high',
  readiness: 'ready',
  description: 'Check the release notes.',
  activity: [
    {
      at: '2026-10-01T09:00:00.000Z',
      author: 'Alex',
      message: 'Reviewed the changes.\nOne follow-up remains.'
    }
  ],
  project: 'styr',
  tags: ['release', 'quality'],
  repoPath: '/projects/styr',
  orchestrate: false,
  useWorktree: true,
  worktreePath: '/projects/styr.worktrees/TASK-0042',
  contextFiles: ['README.md'],
  promptTemplateId: 'code-review',
  provider: 'codex',
  agentSession: { provider: 'codex', id: 'session-42' },
  sessions: [
    { id: 'session-42', provider: 'codex', startedAt: '2026-10-01T08:00:00.000Z', label: 'Review' }
  ],
  externalRef: { provider: 'github', id: '42', url: 'https://github.com/anoguez/styr/issues/42' },
  order: 3,
  createdAt: '2026-10-01T07:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  filePath: '/workspace/tasks/TASK-0042-preserve-a-task.md',
  format: 'markdown'
}

describe('task Markdown', () => {
  it('preserves a managed task through serialisation and parsing', () => {
    expect(parseTaskMarkdown(serialiseTask(task), task.filePath)).toEqual(task)
  })

  it('normalises human-friendly frontmatter tokens', () => {
    const parsed = parseTaskMarkdown(
      [
        '---',
        'id: TASK-0043',
        'title: Normalise fields',
        'status: In Progress',
        'priority: HIGH',
        'readiness: needs-spec',
        'createdAt: 2026-10-01T07:00:00.000Z',
        'updatedAt: 2026-10-01T07:00:00.000Z',
        '---',
        '',
        'Ready for planning.'
      ].join('\n'),
      '/workspace/tasks/TASK-0043-normalise-fields.md'
    )

    expect(parsed).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      readiness: 'needs_spec',
      description: 'Ready for planning.'
    })
  })
})
