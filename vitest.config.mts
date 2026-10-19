import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer imports core values through `@core`, and main the host layer through `@host`
  // (electron-vite defines the same aliases).
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('./src/core', import.meta.url)),
      '@host': fileURLToPath(new URL('./src/host', import.meta.url))
    }
  },
  test: {
    // The Claude Code mod's own tests run under `claude plugin test`, against the engine's kit.
    // `.styr/` holds Styr's task worktrees: other checkouts of this repo, not tests of this one.
    exclude: [...configDefaults.exclude, 'resources/claude/**', '.styr/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // The Electron entry points are loaded only by the ordering tests, which pin call order, not
      // every handler. Counting them would measure the handler table; they were never counted before.
      // `electronHost.ts` is the Electron half of the host ports, moved out of `ipc.ts`, and
      // `remote.ts` binds the remote router (tested in `src/host/remote/`) to Electron the same way.
      exclude: [
        'src/main/ipc.ts',
        'src/main/index.ts',
        'src/main/electronHost.ts',
        'src/main/remote.ts'
      ],
      // A floor just under today's numbers: new code without tests that pulls coverage down fails CI.
      // Raise these as coverage grows; never lower them to make a PR pass.
      thresholds: { lines: 85, statements: 82, functions: 82, branches: 73 }
    }
  }
})
