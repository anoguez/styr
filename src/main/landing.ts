import { createLanding, diskLandingStore } from '@host/landing.js'
import { queryTasks } from './taskIndex.js'

/**
 * The host's landing (`src/host/landing.ts`), bound to the task files and main's index. `ipc.ts`
 * imports it through this path, which is the one the main-process ordering tests mock.
 */
export const { settleLandedTasks, fetchAndSettle } = createLanding({
  ...diskLandingStore,
  query: () => queryTasks()
})
