import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The renderer runs with `sandbox: true`, where a preload may load only the sandbox-safe parts of
 * Electron and no Node built-in (`docs/architecture/remote.md`, Trust boundary). Anything else must
 * go behind IPC. Checked on the source, since the smoke test only shows the one the build made.
 */

const SANDBOX_SAFE = new Set(['contextBridge', 'ipcRenderer', 'webUtils', 'type IpcRendererEvent'])

const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

describe('the preload under the sandbox', () => {
  it('imports values from electron alone, and only its sandbox-safe modules', () => {
    const imports = [...source.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/gm)]
    expect(imports.length).toBeGreaterThan(0)
    for (const [, typeOnly, names, from] of imports) {
      if (typeOnly) continue
      expect(from).toBe('electron')
      for (const name of names!
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)) {
        expect(SANDBOX_SAFE.has(name), name).toBe(true)
      }
    }
    expect(source).not.toMatch(/^import\s+(?!type\b)[^{]/m)
    expect(source).not.toMatch(/\brequire\(|from 'node:|import\(/)
  })

  it('is loaded sandboxed, as one CommonJS script', () => {
    const main = read('../main/index.ts')
    expect(main).toMatch(/sandbox: true/)
    expect(main).toMatch(/preload\/index\.cjs/)
    expect(read('../../electron.vite.config.ts')).toMatch(
      /format: 'cjs', entryFileNames: '\[name\]\.cjs'/
    )
  })
})
