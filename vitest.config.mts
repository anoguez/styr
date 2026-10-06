import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The renderer imports core values through this alias (electron-vite defines the same one).
  resolve: { alias: { '@core': fileURLToPath(new URL('./src/core', import.meta.url)) } },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov']
    }
  }
})
