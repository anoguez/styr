/**
 * The host's file watchers (`src/host/watcher.ts`), as main binds them. `ipc.ts` and `index.ts`
 * import them through this path, which is the one the main-process ordering tests mock.
 */
export * from '@host/watcher.js'
