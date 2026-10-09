import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer imports core values through this alias (electron-vite defines the same one).
  resolve: { alias: { '@core': fileURLToPath(new URL('./src/core', import.meta.url)) } },
  test: {
    // The Claude Code mod's own tests run under `claude plugin test`, against the engine's kit.
    exclude: [...configDefaults.exclude, 'resources/claude/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // A floor just under today's numbers: new code without tests that pulls coverage down fails CI.
      // Raise these as coverage grows; never lower them to make a PR pass.
      thresholds: { lines: 85, statements: 82, functions: 82, branches: 73 }
    }
  }
})
