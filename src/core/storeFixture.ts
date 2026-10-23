import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

const directories: string[] = []

/** The task store pointed at a fresh temporary workspace; call `cleanStores` after each test. */
export async function storeInTemporaryWorkspace(): Promise<typeof import('./taskStore.js')> {
  const directory = mkdtempSync(join(tmpdir(), 'styr-store-test-'))
  directories.push(directory)
  vi.resetModules()
  vi.doMock('./settingsStore.js', () => ({
    tasksDir: () => {
      const path = join(directory, 'tasks')
      mkdirSync(path, { recursive: true })
      return path
    }
  }))
  return import('./taskStore.js')
}

export function cleanStores(): void {
  vi.doUnmock('./settingsStore.js')
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}
