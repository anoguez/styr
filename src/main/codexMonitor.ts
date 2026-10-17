/**
 * The host's Codex app-server client (`src/host/codexMonitor.ts`), as main binds it. `ipc.ts`
 * imports it through this path, which is the one the main-process ordering tests mock.
 */
export * from '@host/codexMonitor.js'
