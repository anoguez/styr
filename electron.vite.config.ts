import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const core = resolve('src/core')
const host = resolve('src/host')
const nodeExternals = ['electron', 'better-sqlite3', 'node-pty']

export default defineConfig({
  main: {
    resolve: { alias: { '@core': core, '@host': host } },
    build: {
      // The MCP server is launched by plain `node` from app.asar.unpacked (or the AppImage copy),
      // where node_modules inside the asar cannot be reached. Every package it imports is bundled.
      externalizeDeps: { exclude: ['@modelcontextprotocol/sdk', 'zod', 'gray-matter'] },
      rollupOptions: {
        external: nodeExternals,
        input: {
          index: resolve('src/main/index.ts'),
          'mcp/index': resolve('src/mcp/index.ts')
        },
        // electron-vite 6 (Vite 8) names ESM output `.js`; the entry points reference `.mjs`.
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: 'chunks/[name]-[hash].mjs'
        }
      }
    }
  },
  // The renderer is sandboxed (`sandbox: true`), and a sandboxed preload is a single CommonJS
  // script that may require only `electron`: everything else is bundled in, nothing externalised.
  preload: {
    build: {
      rollupOptions: {
        external: ['electron'],
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs', codeSplitting: false }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@renderer': resolve('src/renderer/src'), '@core': core } },
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
