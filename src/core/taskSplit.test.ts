import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanStores, storeInTemporaryWorkspace } from './storeFixture.js'

afterEach(cleanStores)

async function setup() {
  const store = await storeInTemporaryWorkspace()
  const { splitTask } = await import('./taskSplit.js')
  const { getSection } = await import('./sections.js')
  const parent = store.createTask({
    title: 'Big thing',
    description: 'The spec.',
    project: 'styr',
    repoPath: '/repo',
    useWorktree: true,
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt',
    contextFiles: ['a.md'],
    readiness: 'needs_spec'
  })
  return { store, splitTask, getSection, parent }
}

describe('splitTask', () => {
  it('creates ordered children and turns the parent into a blocked umbrella', async () => {
    const { store, splitTask, getSection, parent } = await setup()
    const result = splitTask(
      parent.id,
      [{ title: 'One' }, { title: 'Two', after: [0], description: 'Details.' }, { title: 'Three' }],
      'claude'
    )
    const [one, two, three] = result.children
    expect(result.children.map((child) => child.status)).toEqual(['backlog', 'backlog', 'backlog'])
    expect(two?.blockedBy).toEqual([one?.id])
    expect(two?.description).toBe(`Part 2/3 of ${parent.id}: Big thing.\n\nDetails.`)
    for (const child of result.children) {
      expect(child).toMatchObject({
        project: 'styr',
        repoPath: '/repo',
        useWorktree: true,
        baseBranch: 'main',
        provider: 'codex',
        model: 'gpt',
        contextFiles: ['a.md'],
        readiness: 'ready'
      })
      expect(child.activity.at(-1)?.message).toBe(`Split from ${parent.id}`)
    }

    const saved = store.getTask(parent.id)!
    expect(saved.blockedBy).toEqual([one?.id, two?.id, three?.id])
    expect(saved.orchestrate).toBe(false)
    expect(saved.status).toBe('backlog')
    expect(getSection(saved.description, 'Split into')).toBe(
      [one, two, three].map((child) => `- ${child?.id} — ${child?.title}`).join('\n')
    )
    expect(saved.description.startsWith('The spec.')).toBe(true)
    expect(saved.activity.at(-1)?.message).toBe(`Split into ${one?.id}, ${two?.id}, ${three?.id}`)
  })

  it('adds to the list on a second split instead of repeating the section', async () => {
    const { store, splitTask, getSection, parent } = await setup()
    const first = splitTask(parent.id, [{ title: 'One' }], 'claude')
    const second = splitTask(parent.id, [{ title: 'Two' }], 'claude')
    const saved = store.getTask(parent.id)!
    expect(saved.description.match(/## Split into/g)).toHaveLength(1)
    expect(getSection(saved.description, 'Split into')?.split('\n')).toHaveLength(2)
    expect(saved.blockedBy).toEqual([first.children[0]?.id, second.children[0]?.id])
  })

  it('writes nothing for a forward reference, an unknown blocker or a finished parent', async () => {
    const { store, splitTask, parent } = await setup()
    const files = (): number => store.listTasks().length
    expect(() => splitTask(parent.id, [{ title: 'A', after: [1] }, { title: 'B' }], 'c')).toThrow(
      /earlier child/
    )
    expect(() => splitTask(parent.id, [{ title: 'A', after: [0] }], 'c')).toThrow(/earlier child/)
    expect(() => splitTask(parent.id, [{ title: 'A', blockedBy: ['TASK-0999'] }], 'c')).toThrow(
      /not a task/
    )
    expect(() => splitTask(parent.id, [], 'c')).toThrow(/1 to 20/)
    expect(() => splitTask('TASK-0999', [{ title: 'A' }], 'c')).toThrow(/not found/)
    expect(files()).toBe(1)
    expect(store.getTask(parent.id)?.blockedBy).toEqual([])

    store.updateTask(parent.id, { status: 'done' })
    expect(() => splitTask(parent.id, [{ title: 'A' }], 'c')).toThrow(/Done/)
    store.updateTask(parent.id, { status: 'backlog' })
    store.setArchived(parent.id, true)
    expect(() => splitTask(parent.id, [{ title: 'A' }], 'c')).toThrow(/archived/)
    expect(files()).toBe(1)
  })

  it('refuses a child blocked by a task that waits on the parent', async () => {
    const { store, splitTask, parent } = await setup()
    const waiting = store.createTask({ title: 'Waits', blockedBy: [parent.id] })
    expect(() => splitTask(parent.id, [{ title: 'A', blockedBy: [waiting.id] }], 'c')).toThrow(
      /waits on the children/
    )
    expect(store.listTasks()).toHaveLength(2)
  })

  it('rolls the created children back when a later create fails', async () => {
    const { store, parent } = await setup()
    const real = store.createTask
    let calls = 0
    vi.resetModules()
    vi.doMock('./taskStore.js', async () => ({
      ...store,
      createTask: (draft: Parameters<typeof real>[0]) => {
        if (++calls === 2) throw new Error('disk full')
        return real(draft)
      }
    }))
    const { splitTask } = await import('./taskSplit.js')
    expect(() => splitTask(parent.id, [{ title: 'A' }, { title: 'B' }], 'c')).toThrow('disk full')
    expect(store.listTasks().map((task) => task.id)).toEqual([parent.id])
    expect(store.getTask(parent.id)?.orchestrate).toBe(true)
    vi.doUnmock('./taskStore.js')
  })
})
