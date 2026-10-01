import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const temporaryDirectories: string[] = []

async function taskStoreInTemporaryWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), 'styr-task-store-test-'))
  temporaryDirectories.push(directory)
  vi.resetModules()
  vi.doMock('./config.js', () => ({
    tasksDir: () => {
      const directoryPath = join(directory, 'tasks')
      mkdirSync(directoryPath, { recursive: true })
      return directoryPath
    }
  }))
  return import('./taskStore.js')
}

afterEach(() => {
  vi.doUnmock('./config.js')

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('task store', () => {
  it('creates, updates, annotates, filters, reorders and deletes tasks', async () => {
    const store = await taskStoreInTemporaryWorkspace()

    const first = store.createTask({
      title: 'Write release notes',
      description: 'Summarise the customer-facing changes.',
      project: 'styr',
      tags: ['release'],
      priority: 'high'
    })
    const second = store.createTask({ title: 'Check screenshots', project: 'styr' })

    const updated = store.updateTask(first.id, { status: 'in_review' })
    const annotated = store.addNote(updated.id, 'Alex', 'Ready for review.')
    const reordered = store.reorderTasks('in_review', [annotated.id])

    expect(first).toMatchObject({
      id: 'TASK-0001',
      status: 'backlog',
      priority: 'high',
      order: 0
    })
    expect(store.listTasks({ project: 'styr', tag: 'release', query: 'customer' })).toEqual([
      expect.objectContaining({ id: first.id, status: 'in_review', order: 0 })
    ])
    expect(reordered).toEqual([
      expect.objectContaining({ id: first.id, status: 'in_review', order: 0 })
    ])
    expect(store.getTask(first.id)).toEqual(
      expect.objectContaining({
        activity: [expect.objectContaining({ author: 'Alex', message: 'Ready for review.' })]
      })
    )

    store.deleteTask(second.id)

    expect(store.getTask(second.id)).toBeNull()
  })
})
