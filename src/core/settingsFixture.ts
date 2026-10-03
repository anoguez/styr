import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { vi } from 'vitest'

/** Where a test's app config lives under its temporary `home`; `STYR_HOME` points here. */
export function configHomeFor(home: string): string {
  return join(home, 'config')
}

/** Writes the app config a test reads, so nothing is ever read from the real `~/.styr`. */
export function writeTestConfig(home: string, value: Record<string, unknown>): void {
  mkdirSync(configHomeFor(home), { recursive: true })
  writeFileSync(join(configHomeFor(home), 'config.json'), JSON.stringify(value))
}

/**
 * Fresh `config` and `settingsStore` modules over `home`, merged into one namespace. Both read
 * `STYR_HOME` once at import, so each test needs its own instances.
 */
export async function importSettingsModules(home: string) {
  vi.resetModules()
  process.env.STYR_HOME = configHomeFor(home)
  return { ...(await import('./config.js')), ...(await import('./settingsStore.js')) }
}
