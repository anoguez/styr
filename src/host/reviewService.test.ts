import { describe, expect, it } from 'vitest'
import type { DiffResult } from '@core/diff.js'
import type { ReviewComment, Task, TaskReview } from '@core/types.js'
import { createReviewService, type ReviewServicePorts } from './reviewService.js'

const PATCH = ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three'].join('\n')

function comment(extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'c1',
    path: 'src/a.ts',
    side: 'new',
    line: 2,
    text: 'TWO',
    body: 'Lower case, please',
    createdAt: '2026-10-22T10:00:00.000Z',
    ...extra
  }
}

const DIFF: DiffResult = {
  kind: 'changes',
  baseName: 'main',
  branch: 'styr/TASK-1',
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      binary: false,
      uncommitted: false,
      origin: 'committed'
    }
  ],
  omitted: 0,
  totalFiles: 1,
  totalAdditions: 1,
  totalDeletions: 1
}

function harness(status: Task['status'] = 'in_review') {
  const files = new Map<string, unknown>()
  const calls: string[] = []
  const warnings: string[] = []
  const delivered: string[] = []
  const task = { id: 'TASK-1', status, repoPath: '/work/styr' } as Task
  const failure: { value?: Error } = {}
  const workspace = { active: 'ws-a', during: undefined as string | undefined }
  const ports: ReviewServicePorts = {
    broadcast: (channel, payload) => calls.push(`broadcast ${channel} ${JSON.stringify(payload)}`),
    store: {
      read: (id) => files.get(id),
      write: (id, review) => void files.set(id, structuredClone(review)),
      remove: (id) => void files.delete(id)
    },
    findTask: (id) => (id === task.id ? task : undefined),
    getTask: (id) => {
      calls.push(`read file ${id}`)
      return id === task.id ? task : undefined
    },
    activeWorkspace: () => workspace.active,
    pinWorkspace: (id, work) => {
      calls.push(`pin ${id}`)
      return work()
    },
    updateTask: (id, patch) => {
      calls.push(`update ${id} ${JSON.stringify(patch)}`)
      Object.assign(task, patch)
    },
    addNote: (id, author, message) => calls.push(`note ${id} ${author} ${message}`),
    notifyTasks: () => calls.push('notifyTasks'),
    diff: () => DIFF,
    patch: () => ({ patch: PATCH }),
    route: () => ({ route: 'now', provider: 'claude' }),
    deliver: async (_id, message) => {
      if (failure.value) throw failure.value
      delivered.push(message)
      if (workspace.during) workspace.active = workspace.during
      return { route: 'now', provider: 'claude' }
    },
    now: () => '2026-10-22T11:00:00.000Z',
    warn: (message) => warnings.push(message)
  }
  return { ports, files, calls, warnings, delivered, task, failure, workspace }
}

describe('reviewService', () => {
  it('reads a missing review as empty, and saves the whole pending list', () => {
    const h = harness()
    const service = createReviewService(h.ports)
    expect(service.get('TASK-1')).toEqual({ taskId: 'TASK-1', pending: [] })
    service.save('TASK-1', [comment()])
    expect(service.get('TASK-1').pending).toEqual([comment()])
    service.save('TASK-1', [])
    expect(service.get('TASK-1').pending).toEqual([])
  })

  it('ignores an invalid file without rewriting it, and refuses a bad task id or comment', () => {
    const h = harness()
    h.files.set('TASK-1', { taskId: 'TASK-1', pending: [{ nope: true }] })
    const service = createReviewService(h.ports)
    expect(service.get('TASK-1')).toEqual({ taskId: 'TASK-1', pending: [] })
    expect(h.warnings).toHaveLength(1)
    expect(h.files.get('TASK-1')).toEqual({ taskId: 'TASK-1', pending: [{ nope: true }] })
    expect(() => service.get('../etc/passwd')).toThrow()
    expect(() => service.save('TASK-1', [{ ...comment(), line: 0 }])).toThrow()
  })

  it('prepares the sheet: route, target and outdated comments', () => {
    const h = harness()
    const service = createReviewService(h.ports)
    service.save('TASK-1', [
      comment(),
      comment({ id: 'moved', text: 'gone' }),
      comment({ id: 'other', path: 'src/not-in-diff.ts' })
    ])
    expect(service.prepare('TASK-1')).toEqual({
      route: 'now',
      provider: 'claude',
      target: { kind: 'branch', branch: 'styr/TASK-1', base: 'main' },
      outdated: ['moved', 'other']
    })
  })

  it('sends the stored comments, then moves them to lastSent, the task and a note', async () => {
    const h = harness('in_review')
    const service = createReviewService(h.ports)
    service.save('TASK-1', [comment()])
    const sent = await service.requestChanges('TASK-1', 'Overall note')
    expect(sent).toEqual({
      route: 'now',
      provider: 'claude',
      count: 1,
      files: 1,
      movedToInProgress: true
    })
    expect(h.delivered).toEqual([
      [
        'Review of styr/TASK-1 against main: 1 comment in 1 file. Address each one, then reply with what you changed.',
        '',
        'Overall note',
        '',
        'src/a.ts',
        '- src/a.ts:2  TWO',
        '  Lower case, please'
      ].join('\n')
    ])
    expect(h.files.get('TASK-1')).toEqual({
      taskId: 'TASK-1',
      pending: [],
      lastSent: { at: '2026-10-22T11:00:00.000Z', comments: [comment()], summary: 'Overall note' }
    } satisfies TaskReview)
    expect(h.calls).toEqual([
      'update TASK-1 {"status":"in_progress"}',
      'note TASK-1 styr Requested changes: 1 comment in 1 file',
      'notifyTasks',
      'broadcast review:changed {"taskId":"TASK-1"}'
    ])
  })

  it('leaves an In progress task where it is', async () => {
    const h = harness('in_progress')
    const service = createReviewService(h.ports)
    service.save('TASK-1', [comment()])
    expect((await service.requestChanges('TASK-1', '')).movedToInProgress).toBe(false)
    expect(h.calls.some((call) => call.startsWith('update'))).toBe(false)
  })

  it('changes nothing when the delivery fails', async () => {
    const h = harness()
    const service = createReviewService(h.ports)
    service.save('TASK-1', [comment()])
    h.failure.value = new Error('The terminal closed')
    await expect(service.requestChanges('TASK-1', '')).rejects.toThrow('The terminal closed')
    expect(service.get('TASK-1').pending).toEqual([comment()])
    expect(h.calls).toEqual([])
    expect(h.task.status).toBe('in_review')
  })

  it('records the send in the workspace it came from when the board switched meanwhile', async () => {
    const h = harness('in_review')
    const service = createReviewService(h.ports)
    service.save('TASK-1', [comment()])
    h.workspace.during = 'ws-b'
    expect((await service.requestChanges('TASK-1', '')).movedToInProgress).toBe(true)
    expect(h.calls).toEqual([
      'pin ws-a',
      'read file TASK-1',
      'update TASK-1 {"status":"in_progress"}',
      'note TASK-1 styr Requested changes: 1 comment in 1 file',
      'read file TASK-1',
      'broadcast review:changed {"taskId":"TASK-1"}'
    ])
  })

  it('reports a delivered send whose record failed as sent, with a warning', async () => {
    const h = harness()
    const service = createReviewService(h.ports)
    service.save('TASK-1', [comment()])
    h.ports.store.write = () => {
      throw new Error('disk full')
    }
    const sent = await service.requestChanges('TASK-1', '')
    expect(sent.warning).toMatch(/could not record it/)
    expect(h.delivered).toHaveLength(1)
    expect(h.warnings.join('\n')).toContain('disk full')
  })

  it('refuses with nothing pending, or a message over the prompt limit', async () => {
    const h = harness()
    const service = createReviewService(h.ports)
    await expect(service.requestChanges('TASK-1', '')).rejects.toThrow(/no pending/)
    service.save(
      'TASK-1',
      Array.from({ length: 10 }, (_, at) => comment({ id: `c${at}`, body: 'x'.repeat(19_000) }))
    )
    await expect(service.requestChanges('TASK-1', '')).rejects.toThrow(/Too long/)
    expect(h.delivered).toEqual([])
  })
})
