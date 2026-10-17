import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

/**
 * `styr serve` (`src/server/`), built to `out/server/` for plain Node, with the MCP server beside
 * it. Every JavaScript dependency is bundled in; only the two native modules stay external, and
 * Node resolves them from the `node_modules` next to `out/` — the repo's in development, the
 * server bundle's own Node-ABI builds in a release — never the desktop app's Electron-ABI copies.
 */
const NATIVE = ['node-pty', 'better-sqlite3']

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

/** Fails the build if anything the server bundles imports Electron. */
function noElectron(): Plugin {
  return {
    name: 'styr-server-no-electron',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'electron' || id.startsWith('electron/')) {
        this.error(`styr serve runs on plain Node and must never import electron (${importer})`)
      }
      return null
    }
  }
}

export default defineConfig({
  resolve: { alias: { '@core': resolve('src/core'), '@host': resolve('src/host') } },
  define: { __STYR_VERSION__: JSON.stringify(version) },
  plugins: [noElectron()],
  ssr: { noExternal: true },
  logLevel: 'warn',
  build: {
    ssr: true,
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      input: { index: resolve('src/server/index.ts'), 'mcp/index': resolve('src/mcp/index.ts') },
      external: NATIVE,
      // gray-matter's optional JavaScript front-matter engine uses `eval`; Styr never enables it.
      onLog(level, log, handler) {
        if (log.code === 'EVAL' && log.id?.includes('gray-matter')) return
        handler(level, log)
      },
      output: {
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: 'chunks/[name]-[hash].mjs'
      }
    }
  }
})
