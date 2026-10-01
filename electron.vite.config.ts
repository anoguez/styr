import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const core = resolve('src/core')
const nodeExternals = ['electron', 'better-sqlite3', 'node-pty']

export default defineConfig({
  main: {
    resolve: { alias: { '@core': core } },
    build: {
      externalizeDeps: true,
      rollupOptions: {
        external: nodeExternals,
        input: {
          index: resolve('src/main/index.ts'),
          'mcp/index': resolve('src/mcp/index.ts')
        }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: { external: nodeExternals, input: resolve('src/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@core': core } },
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
