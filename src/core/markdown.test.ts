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
  blockedBy: ['TASK-0007'],
  contextFiles: ['README.md'],
  promptTemplateId: 'code-review',
  provider: 'codex',
  model: 'gpt-6.1-sol',
  agentSession: { provider: 'codex', id: 'session-42' },
  sessions: [
    { id: 'session-42', provider: 'codex', startedAt: '2026-10-01T08:00:00.000Z', label: 'Review' }
  ],
  externalRef: {
    provider: 'github',
    id: '42',
    url: 'https://github.com/anoguez/styr/issues/42',
    sourceId: 'github-abc',
    remoteUpdatedAt: '2026-01-01T00:00:00Z',
    syncedHash: 'deadbeef'
  },
  prUrl: 'https://gitlab.com/anoguez/styr/-/merge_requests/7',
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

  it('tidies a hand-written blockedBy and drops entries that are not task ids', () => {
    const front = (blockedBy: string): string =>
      [
        '---',
        'id: TASK-0044',
        'title: Blocked',
        `blockedBy: ${blockedBy}`,
        'createdAt: 2026-10-01T07:00:00.000Z',
        'updatedAt: 2026-10-01T07:00:00.000Z',
        '---',
        ''
      ].join('\n')
    const read = (blockedBy: string): string[] =>
      parseTaskMarkdown(front(blockedBy), '/t/TASK-0044.md').blockedBy

    expect(read('[task-0012, " TASK-0013 ", TASK-0012, nonsense, 7]')).toEqual([
      'TASK-0012',
      'TASK-0013'
    ])
    expect(read('task-0009')).toEqual(['TASK-0009'])
    expect(read('')).toEqual([])
  })

  it('reads a hand-written model, trimmed, with a blank one as unset', () => {
    const read = (model: string): string | undefined =>
      parseTaskMarkdown(
        [
          '---',
          'id: TASK-0045',
          'title: Model',
          `model: ${model}`,
          'createdAt: 2026-10-01T07:00:00.000Z',
          'updatedAt: 2026-10-01T07:00:00.000Z',
          '---',
          ''
        ].join('\n'),
        '/t/TASK-0045.md'
      ).model

    expect(read('"  opus "')).toBe('opus')
    expect(read('4')).toBe('4')
    expect(read('""')).toBeUndefined()
    expect(serialiseTask({ ...task, model: undefined })).not.toContain('model:')
  })

  it('writes no blockedBy key when there are none', () => {
    expect(serialiseTask({ ...task, blockedBy: [] })).not.toContain('blockedBy')
  })

  it('reads an Activity heading without the marker as activity', () => {
    const raw = [
      '---',
      'id: TASK-0044',
      'title: Bare heading',
      'status: backlog',
      'priority: low',
      'readiness: ready',
      'createdAt: 2026-10-01T07:00:00.000Z',
      'updatedAt: 2026-10-01T07:00:00.000Z',
      '---',
      '',
      'Do the thing.',
      '',
      '## Activity',
      '',
      '- Started work',
      '- `2026-10-01T08:00:00.000Z` **claude** — Done'
    ].join('\n')
    const parsed = parseTaskMarkdown(raw, '/workspace/tasks/TASK-0044-bare-heading.md')

    expect(parsed.description).toBe('Do the thing.')
    expect(parsed.activity).toHaveLength(2)
    expect(parseTaskMarkdown(serialiseTask(parsed), parsed.filePath).activity).toEqual(
      parsed.activity
    )
  })

  it('prefers the marker over an earlier Activity heading in the description', () => {
    const raw = [
      '---',
      'id: TASK-0045',
      'title: Marker wins',
      'status: backlog',
      'priority: low',
      'readiness: ready',
      'createdAt: 2026-10-01T07:00:00.000Z',
      'updatedAt: 2026-10-01T07:00:00.000Z',
      '---',
      '',
      '## Activity',
      '',
      'Explain the section.',
      '',
      '<!-- styr:activity -->',
      '## Activity',
      '',
      '- Note'
    ].join('\n')
    const parsed = parseTaskMarkdown(raw, '/workspace/tasks/TASK-0045-marker-wins.md')

    expect(parsed.description).toContain('Explain the section.')
    expect(parsed.activity).toHaveLength(1)
  })

  const front = [
    '---',
    'id: TASK-0046',
    'title: Spec below Activity',
    'status: backlog',
    'priority: low',
    'readiness: ready',
    'createdAt: 2026-10-01T07:00:00.000Z',
    'updatedAt: 2026-10-01T07:00:00.000Z',
    '---',
    '',
    'Build the review UI.',
    '',
    '<!-- styr:activity -->',
    '## Activity',
    ''
  ]

  it('moves content appended below Activity back into the description, not into notes', () => {
    // What a spec agent did with `cat >>`: the spec landed after the notes.
    const raw = [
      ...front,
      '- `2026-10-01T08:00:00.000Z` **claude** — Speccing.',
      '',
      '---',
      '',
      '# Spec',
      '',
      '## Goal',
      '',
      'Review a diff like a PR.',
      '',
      '- In scope: comments.',
      '',
      '1. Hovering a row shows a button.',
      '   Clicking it opens the composer.'
    ].join('\n')
    const parsed = parseTaskMarkdown(raw, '/workspace/tasks/TASK-0046-spec.md')

    expect(parsed.activity).toEqual([
      { at: '2026-10-01T08:00:00.000Z', author: 'claude', message: 'Speccing.' }
    ])
    expect(parsed.description).toBe(
      [
        'Build the review UI.',
        '',
        '---',
        '',
        '# Spec',
        '',
        '## Goal',
        '',
        'Review a diff like a PR.',
        '',
        '- In scope: comments.',
        '',
        '1. Hovering a row shows a button.',
        '   Clicking it opens the composer.'
      ].join('\n')
    )
    // A rewrite (any add_task_note) puts the spec above Activity and keeps every line.
    const rewritten = parseTaskMarkdown(serialiseTask(parsed), parsed.filePath)
    expect(rewritten.description).toBe(parsed.description)
    expect(rewritten.activity).toEqual(parsed.activity)
  })

  it('keeps lines under Activity that are not notes, through a rewrite', () => {
    const raw = [
      ...front,
      'A paragraph before any note.',
      '- `2026-10-01T08:00:00.000Z` **claude** — Plan:',
      '1. First step',
      '   still the first step',
      '  ',
      'Plain line.'
    ].join('\n')
    const parsed = parseTaskMarkdown(raw, '/workspace/tasks/TASK-0046-spec.md')

    expect(parsed.activity).toEqual([
      { at: '', author: '', message: 'A paragraph before any note.' },
      {
        at: '2026-10-01T08:00:00.000Z',
        author: 'claude',
        message: 'Plan:\n1. First step\n still the first step\n\nPlain line.'
      }
    ])
    const again = parseTaskMarkdown(serialiseTask(parsed), parsed.filePath)
    expect(again.activity).toEqual(parsed.activity)
    expect(serialiseTask(again)).toBe(serialiseTask(parsed))
  })
})
