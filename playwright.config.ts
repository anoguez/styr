import { defineConfig } from '@playwright/test'

// The Electron smoke test (`yarn test:smoke`). It drives the built app in `out/`, so build first.
// See docs/architecture/testing.md.
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  // One app, one test, steps in order: nothing to parallelise, and a retry would hide flakiness.
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  outputDir: 'test-results'
})
