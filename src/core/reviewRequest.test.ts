import { afterEach, describe, expect, it } from 'vitest'
import { cleanStores, storeInTemporaryWorkspace } from './storeFixture.js'

afterEach(cleanStores)

const summary = { changed: 'Added X\nand Y', verify: 'Run the tests' }

async function setup() {
  const store = await storeInTemporaryWorkspace()
  const { requestReview, taskHandoff } = await import('./reviewRequest.js')
  const task = store.createTask({ title: 'T', description: 'The spec.', status: 'in_progress' })
  return { store, requestReview, taskHandoff, task }
}

describe('requestReview', () => {
  it('moves the task to In Review and writes the handoff, a note and the PR link', async () => {
    const { store, requestReview, taskHandoff, task } = await setup()
    const result = requestReview({
      id: task.id,
      summary: { ...summary, why: 'Because', notes: '  ' },
      prUrl: 'https://example.com/pr/1',
      author: 'claude'
    })
    const saved = store.getTask(task.id)!
    expect(saved).toMatchObject({ status: 'in_review', prUrl: 'https://example.com/pr/1' })
    expect(saved.description.startsWith('The spec.')).toBe(true)
    const handoff = taskHandoff(saved)!
    expect(handoff).toContain('**What changed** Added X\nand Y')
    expect(handoff).toContain('**Why** Because')
    expect(handoff).toContain('**How to verify** Run the tests')
    expect(handoff).not.toContain('Notes')
    expect(handoff).not.toContain('Open questions')
    expect(saved.activity.at(-1)?.message).toBe('Requested review: Added X')
    expect(result.openQuestions).toBe(0)
  })

  it('replaces the handoff on a second call and counts open questions', async () => {
    const { store, requestReview, taskHandoff, task } = await setup()
    store.askQuestion(task.id, 'claude', 'Is X ok?')
    requestReview({ id: task.id, summary, author: 'claude' })
    const second = requestReview({
      id: task.id,
      summary: { changed: 'Second', verify: 'Again' },
      author: 'claude'
    })
    const saved = store.getTask(task.id)!
    expect(saved.description.match(/## Handoff/g)).toHaveLength(1)
    expect(taskHandoff(saved)).toContain('Second')
    expect(taskHandoff(saved)).not.toContain('Added X')
    expect(second.openQuestions).toBe(1)
    expect(saved.activity.at(-1)?.message).toBe('Requested review: Second (1 open question)')
  })

  it('rejects an empty changed or verify and writes nothing', async () => {
    const { store, requestReview, task } = await setup()
    expect(() =>
      requestReview({ id: task.id, summary: { changed: ' ', verify: 'x' }, author: 'c' })
    ).toThrow(/changed/)
    expect(() =>
      requestReview({ id: task.id, summary: { changed: 'x', verify: '' }, author: 'c' })
    ).toThrow(/verify/)
    expect(store.getTask(task.id)?.status).toBe('in_progress')
  })

  it('reads a hand-written handoff the same way', async () => {
    const { store, taskHandoff, task } = await setup()
    store.updateTask(task.id, {
      status: 'in_review',
      description: 'The spec.\n\n## Handoff\n\n**What changed** by hand'
    })
    expect(taskHandoff(store.getTask(task.id)!)).toBe('**What changed** by hand')
  })
})
