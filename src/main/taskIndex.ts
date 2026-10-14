/**
 * The host's task index (`src/host/taskIndex.ts`), as main binds it. `ipc.ts` and `index.ts` import
 * it through this path, which is the one the main-process ordering tests mock.
 */
export * from '@host/taskIndex.js'
