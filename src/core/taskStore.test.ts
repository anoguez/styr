import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const temporaryDirectories: string[] = []

async function taskStoreInTemporaryWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), 'styr-task-store-test-'))
  temporaryDirectories.push(directory)
  vi.resetModules()
  vi.doMock('./settingsStore.js', () => ({
    tasksDir: () => {
      const directoryPath = join(directory, 'tasks')
      mkdirSync(directoryPath, { recursive: true })
      return directoryPath
    }
  }))
  return import('./taskStore.js')
}

afterEach(() => {
  vi.doUnmock('./settingsStore.js')
  vi.doUnmock('node:fs')

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

  it('retains a selected provider when creating a task', async () => {
    const store = await taskStoreInTemporaryWorkspace()

    const created = store.createTask({ title: 'Review with Codex', provider: 'codex' })

    expect(created.provider).toBe('codex')
    expect(store.getTask(created.id)).toMatchObject({ provider: 'codex' })
  })

  it('preserves a task file when its replacement write is interrupted', async () => {
    const store = await taskStoreInTemporaryWorkspace()
    const created = store.createTask({ title: 'Keep this task safe' })
    const originalContents = readFileSync(created.filePath, 'utf8')

    vi.resetModules()
    vi.doMock('./settingsStore.js', () => ({
      tasksDir: () => join(created.filePath, '..')
    }))
    vi.doMock('node:fs', async () => {
      const filesystem = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...filesystem,
        writeFileSync: (
          filePath: Parameters<typeof filesystem.writeFileSync>[0],
          ...args: Parameters<typeof filesystem.writeFileSync> extends [unknown, ...infer Rest]
            ? Rest
            : never
        ) => {
          if (filePath === created.filePath) throw new Error('simulated interrupted write')
          return filesystem.writeFileSync(filePath, ...args)
        }
      }
    })
    const interruptedStore = await import('./taskStore.js')

    expect(() => interruptedStore.updateTask(created.id, { status: 'in_review' })).not.toThrow()
    expect(readFileSync(created.filePath, 'utf8')).not.toBe(originalContents)
    expect(interruptedStore.getTask(created.id)).toMatchObject({ status: 'in_review' })
  })
})
