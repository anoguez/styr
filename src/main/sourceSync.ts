import { createSourceSync, diskSourceSyncStore } from '@host/sourceSync.js'

export { NO_REPOSITORIES } from '@host/sourceSync.js'

/**
 * The host's source sync (`src/host/sourceSync.ts`), over the task files and the real sources.
 * `ipc.ts` imports it through this path, which is the one the main-process ordering tests mock.
 */
export const {
  initSourceSync,
  sourceStates,
  targetsOf,
  listSourceTargets,
  previewSource,
  syncSource,
  applySource,
  linkTask,
  unlinkTask,
  refreshTask,
  observeTasks,
  resetSourceObserver,
  restartSourcePolling,
  stopSourcePolling,
  testRestSource,
  ghStatus
} = createSourceSync(diskSourceSyncStore)
