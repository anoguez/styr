import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer imports core values through this alias (electron-vite defines the same one).
  resolve: { alias: { '@core': fileURLToPath(new URL('./src/core', import.meta.url)) } },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // A floor just under today's numbers: new code without tests that pulls coverage down fails CI.
      // Raise these as coverage grows; never lower them to make a PR pass.
      thresholds: { lines: 85, statements: 82, functions: 82, branches: 73 }
    }
  }
})
